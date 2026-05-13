const { collectContextForMessage } = require('./contextCollector');
const { buildOllamaMessages, buildCasualOllamaMessages } = require('./promptBuilder');
const { requestOllamaChat } = require('./ollamaClient');
const { splitResponseIntoChunks } = require('./responseFormatter');
const { handleMessageLinkReplyAction } = require('./actions/messageLinkReply');
const {
  detectMemoryRequest,
  inferMemoryKey,
  extractMemoryText,
  saveUserMemory,
  deleteAllUserMemories
} = require('../userMemory');

const CASUAL_INHIBIT_PATTERN = /(まとめて|要約して|整理して|教えて|について|調べて|スレッドを|チャンネルを|どうすれ|どうすれば|なんで|なぜ|どうして|どんな|どうやっ|質問|どこ)/u;

const CASUAL_DETECT_PATTERN = /お風呂|ふろ|風呂|ご飯|ごはん|飯食|寝る|寝ます|いってきます|ただいま|おかえり|かわいい|可愛い/u;

const CASUAL_DETERMINISTIC_RULES = [
  { pattern: /^(?:お?風呂|ふろ)[にへ]?(?:入っ|はいっ)てくる[ね〜!！]*$/u, reply: 'いってらっしゃい！' },
  { pattern: /^(?:ご飯|飯|ごはん)[を]?(?:食べ|たべ|食っ|くっ)てくる[ね〜!！]*$/u, reply: 'いってらっしゃい！' },
  { pattern: /^(?:飯|めし)(?:食っ|くっ)てくる[ね〜!！]*$/u, reply: 'いってらっしゃい！' },
  { pattern: /^(?:寝る|ねる|寝ます|ねます)[〜!！]*$/u, reply: 'おやすみ！' },
  { pattern: /^おやすみ(?:なさい)?[〜!！]*$/u, reply: 'おやすみなさい！' },
  { pattern: /^(?:いって|行って)きます[〜!！]*$/u, reply: 'いってらっしゃい！' },
  { pattern: /^(?:ただいま|戻った|もどった)[〜!！]*$/u, reply: 'おかえり！' },
  { pattern: /^(?:ありがとう|ありがとうございます|ありがとございます|ありがと|サンキュ|サンキュー|thx|thanks)[〜!！]*$/iu, reply: 'どういたしまして！' },
  { pattern: /^(?:かわいい|可愛い)[〜!！]*$/u, reply: 'うれしいです！' },
  { pattern: /^(?:了解|りょうかい|了解です|りょ|ok|ｏｋ)[〜!！]*$/iu, reply: '了解です！' },
  { pattern: /^(?:うん|うんうん|そうですね|そうだね|そっか|そか|なるほど|なるほどね)[〜!！]*$/u, reply: 'うん！' }
];

function detectCasualDeterministicReply(requestText) {
  const text = String(requestText || '').trim();
  if (!text || CASUAL_INHIBIT_PATTERN.test(text)) {
    return null;
  }

  for (const { pattern, reply } of CASUAL_DETERMINISTIC_RULES) {
    if (pattern.test(text)) {
      return reply;
    }
  }

  return null;
}

function isCasualLlmRequest(requestText) {
  const text = String(requestText || '').trim();
  return Boolean(text) && CASUAL_DETECT_PATTERN.test(text) && !CASUAL_INHIBIT_PATTERN.test(text);
}

function pickRandomMessage(candidates, fallback) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) {
    return fallback;
  }

  return list[Math.floor(Math.random() * list.length)] || fallback;
}

function isLlmReplyTrigger(message, client) {
  const referencedMessageId = message.reference?.messageId;
  if (!referencedMessageId) {
    return false;
  }

  return Boolean(client.db.llmResponses.get(referencedMessageId));
}

function stripBotMentions(content, clientUserId) {
  const raw = String(content || '');
  return raw
    .replace(new RegExp(`<@!?${clientUserId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeSummaryRequest(content) {
  const text = String(content || '');
  return /(まとめて|要約して|この辺|直近|会話|整理して)/u.test(text);
}

function requiresRichContext(content) {
  const text = String(content || '');
  return /(このスレッド|このチャンネル|このユーザー|この人|過去の発言|おすすめ|関連|書籍|本|資料|参考|教えて|最新|いま|今|現在|web|ウェブ|検索|調べて|ニュース|最近の情報)/iu.test(text);
}

function isShortRequestText(content) {
  const text = String(content || '').trim();
  if (!text) {
    return false;
  }

  if (looksLikeSummaryRequest(text) || requiresRichContext(text)) {
    return false;
  }

  if (text.length <= 24) {
    return true;
  }

  return /^(こんにちは|こんばんは|やあ|ありがとう|ありがと|これは何[？?]?|ok[？?]?|OK[？?]?|何これ[？?]?|おはよう)$/iu.test(text);
}

function getShortModeDisabledReason(content) {
  const text = String(content || '').trim();
  if (!text) {
    return 'empty';
  }
  if (looksLikeSummaryRequest(text)) {
    return 'summary_request';
  }
  if (requiresRichContext(text)) {
    return 'rich_context_keywords';
  }
  if (text.length > 24) {
    return 'long_request';
  }
  return null;
}

function shouldTriggerLlm(message, client) {
  if (!client.appConfig.llm.enabled) {
    return false;
  }

  if (!message.inGuild?.() || message.author?.bot) {
    return false;
  }

  const directlyMentioned = message.mentions.users.has(client.user.id);
  return directlyMentioned || isLlmReplyTrigger(message, client);
}

function getBusyReason(client, userId) {
  if (client.activeLlmUsers?.has(userId)) {
    return 'user_busy';
  }

  if (client.llmGlobalRequestActive) {
    return 'global_busy';
  }

  return null;
}

async function sendBusyReply(message, busyMessage, busyReason) {
  message.client.logger.warn('LLM busy reply sent', {
    sourceMessageId: message.id,
    authorId: message.author.id,
    busyReason,
    chosenBusyMessage: busyMessage
  });

  await message.reply({
    content: busyMessage,
    allowedMentions: {
      repliedUser: false,
      parse: []
    }
  });
}

async function persistResponseMappings(client, responseMessages, requestMessage) {
  for (const responseMessage of responseMessages) {
    client.db.llmResponses.insert({
      responseMessageId: responseMessage.id,
      requestMessageId: requestMessage.id,
      channelId: requestMessage.channelId,
      authorId: requestMessage.author.id
    });
  }
}

async function handleLlmMessage(message) {
  const client = message.client;
  const logger = client.logger;

  if (!shouldTriggerLlm(message, client)) {
    return false;
  }

  logger.info('LLM trigger detected', {
    sourceMessageId: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    triggerType: message.mentions.users.has(client.user.id) ? 'mention' : 'reply'
  });

  const busyReason = getBusyReason(client, message.author.id);
  if (busyReason) {
    const chosenBusyMessage = pickRandomMessage(
      client.appConfig.llm.busyMessages,
      '回線が混雑しています。少し待ってからもう一度試してください。'
    );
    logger.warn('LLM request skipped due to busy state', {
      sourceMessageId: message.id,
      authorId: message.author.id,
      reason: busyReason,
      chosenBusyMessage
    });
    await sendBusyReply(message, chosenBusyMessage, busyReason);
    return true;
  }

  client.activeLlmUsers.add(message.author.id);
  client.llmGlobalRequestActive = true;

  let tempReply = null;

  try {
    const handledAction = await handleMessageLinkReplyAction(message, client);
    if (handledAction) {
      return true;
    }

    const requestText = stripBotMentions(message.content || '', client.user.id);

    const deterministicReply = detectCasualDeterministicReply(requestText);
    if (deterministicReply) {
      logger.info('Casual intent detected: deterministic casual reply used', {
        sourceMessageId: message.id,
        requestText,
        reply: deterministicReply
      });
      const sentReply = await message.reply({
        content: deterministicReply,
        allowedMentions: { repliedUser: false, parse: [] }
      });
      await persistResponseMappings(client, [sentReply], message);
      return true;
    }

    const casualLlmMode = isCasualLlmRequest(requestText);
    const shortRequestMode = casualLlmMode ? true : isShortRequestText(requestText);
    const shortModeDisabledReason = shortRequestMode ? (casualLlmMode ? 'casual_llm' : null) : getShortModeDisabledReason(requestText);
    const contextLimit = casualLlmMode
      ? 2
      : shortRequestMode
        ? Number(client.appConfig.llm.shortRequestContextLimit || 2)
        : Number(client.appConfig.llm.contextMessageLimit || 50);
    const numPredict = casualLlmMode
      ? 48
      : shortRequestMode
        ? Number(client.appConfig.llm.numPredictShort || 48)
        : Number(client.appConfig.llm.numPredict || 160);

    if (casualLlmMode) {
      logger.info('Casual intent detected: casual LLM mode', {
        sourceMessageId: message.id,
        requestText: requestText.slice(0, 100)
      });
    }

    const chosenThinkingMessage = pickRandomMessage(
      client.appConfig.llm.thinkingMessages,
      client.appConfig.llm.thinkingMessage
    );

    tempReply = await message.reply({
      content: chosenThinkingMessage,
      allowedMentions: {
        repliedUser: false,
        parse: []
      }
    });

    logger.info('LLM temporary reply sent', {
      sourceMessageId: message.id,
      temporaryReplyMessageId: tempReply.id,
      chosenThinkingMessage,
      shortRequestMode,
      shortModeDisabledReason,
      casualLlmMode
    });

    const memoryRequestType = detectMemoryRequest(requestText);
    let memoryNote = null;

    if (memoryRequestType === 'save') {
      const memoryText = extractMemoryText(requestText);
      if (memoryText) {
        const memoryKey = inferMemoryKey(memoryText);
        const saved = saveUserMemory(client, message.guildId, message.author.id, memoryKey, memoryText);
        memoryNote = saved
          ? `ユーザーがメモリ保存を要求しました。保存しました。キー: ${memoryKey}、内容: ${memoryText.slice(0, 60)}`
          : 'ユーザーがメモリ保存を要求しましたが、センシティブな内容のためスキップしました。';
      }
    } else if (memoryRequestType === 'delete') {
      deleteAllUserMemories(client, message.guildId, message.author.id);
      memoryNote = 'ユーザーがメモリ削除を要求しました。全メモリを削除しました。';
    }

    const promptMessage = {
      ...message,
      content: requestText || message.content || ''
    };

    let ollamaMessages;
    if (casualLlmMode) {
      logger.info('Skipped heavy context for casual reply', {
        sourceMessageId: message.id
      });
      ollamaMessages = buildCasualOllamaMessages({ message: promptMessage });
    } else {
      const context = await collectContextForMessage(client, message, {
        limit: contextLimit,
        requestText
      });
      context.memoryNote = memoryNote;
      ollamaMessages = buildOllamaMessages({
        message: promptMessage,
        context,
        shortRequestMode
      });
    }

    const finalPromptCharCount = ollamaMessages.reduce((total, entry) => total + String(entry?.content || '').length, 0);
    logger.info('LLM prompt prepared', {
      sourceMessageId: message.id,
      shortRequestMode,
      shortModeDisabledReason,
      casualLlmMode,
      finalPromptCharCount
    });
    const finalText = await requestOllamaChat({
      baseUrl: process.env.OLLAMA_BASE_URL || client.appConfig.llm.baseUrl,
      model: process.env.OLLAMA_MODEL || client.appConfig.llm.model,
      messages: ollamaMessages,
      timeoutMs: client.appConfig.llm.timeoutMs,
      logger,
      sourceMessageId: message.id,
      shortRequestMode,
      numPredict,
      numCtx: casualLlmMode ? 256 : Number(client.appConfig.llm.numCtx || 1024),
      temperature: Number(client.appConfig.llm.temperature ?? 0.3),
      topP: Number(client.appConfig.llm.topP ?? 0.9),
      keepAlive: String(client.appConfig.llm.keepAlive || '30m')
    });

    const chunks = splitResponseIntoChunks(finalText, client.appConfig.llm.maxReplyChars);
    const firstChunk = chunks.shift() || '返答を生成できませんでした。';

    await tempReply.edit({
      content: firstChunk,
      allowedMentions: {
        parse: []
      }
    });

    if (casualLlmMode) {
      logger.info('Casual LLM reply used', {
        sourceMessageId: message.id,
        responseMessageId: tempReply.id
      });
    }

    logger.info('LLM final reply edited', {
      sourceMessageId: message.id,
      responseMessageId: tempReply.id,
      responseSplitCount: 1 + chunks.length
    });

    const responseMessages = [tempReply];
    for (const chunk of chunks) {
      const followUp = await message.channel.send({
        content: chunk,
        reply: {
          messageReference: tempReply.id,
          failIfNotExists: false
        },
        allowedMentions: {
          repliedUser: false,
          parse: []
        }
      });
      responseMessages.push(followUp);
    }

    await persistResponseMappings(client, responseMessages, message);

    logger.info('LLM response persisted', {
      sourceMessageId: message.id,
      responseSplitCount: responseMessages.length
    });

    return true;
  } catch (error) {
    if (tempReply) {
      await tempReply.edit({
        content: '返答の生成に失敗しました。少し時間をおいてからもう一度試してください。',
        allowedMentions: {
          parse: []
        }
      }).catch(() => null);
    }

    logger.error('LLM request handling failed', {
      sourceMessageId: message.id,
      error: error.message
    });
    return true;
  } finally {
    client.activeLlmUsers.delete(message.author.id);
    client.llmGlobalRequestActive = false;
  }
}

module.exports = {
  handleLlmMessage
};
