const { collectContextForMessage } = require('./contextCollector');
const { buildOllamaMessages } = require('./promptBuilder');
const { requestOllamaChat } = require('./ollamaClient');
const { splitResponseIntoChunks } = require('./responseFormatter');
const { handleMessageLinkReplyAction } = require('./actions/messageLinkReply');

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

  return message.mentions.has(client.user) || isLlmReplyTrigger(message, client);
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
    triggerType: message.mentions.has(client.user) ? 'mention' : 'reply'
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
    const shortRequestMode = isShortRequestText(requestText);
    const shortModeDisabledReason = shortRequestMode ? null : getShortModeDisabledReason(requestText);
    const contextLimit = shortRequestMode
      ? Number(client.appConfig.llm.shortRequestContextLimit || 2)
      : Number(client.appConfig.llm.contextMessageLimit || 50);
    const numPredict = shortRequestMode
      ? Number(client.appConfig.llm.numPredictShort || 48)
      : Number(client.appConfig.llm.numPredict || 160);
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
      shortModeDisabledReason
    });

    const context = await collectContextForMessage(client, message, {
      limit: contextLimit,
      requestText
    });
    const promptMessage = {
      ...message,
      content: requestText || message.content || ''
    };
    const messages = buildOllamaMessages({
      message: promptMessage,
      context,
      shortRequestMode
    });
    const finalPromptCharCount = messages.reduce((total, entry) => total + String(entry?.content || '').length, 0);
    logger.info('LLM prompt prepared', {
      sourceMessageId: message.id,
      shortRequestMode,
      shortModeDisabledReason,
      finalPromptCharCount
    });
    const finalText = await requestOllamaChat({
      baseUrl: process.env.OLLAMA_BASE_URL || client.appConfig.llm.baseUrl,
      model: process.env.OLLAMA_MODEL || client.appConfig.llm.model,
      messages,
      timeoutMs: client.appConfig.llm.timeoutMs,
      logger,
      sourceMessageId: message.id,
      shortRequestMode,
      numPredict,
      numCtx: Number(client.appConfig.llm.numCtx || 1024),
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
