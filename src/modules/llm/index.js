const { collectContextForMessage } = require('./contextCollector');
const { buildOllamaMessages } = require('./promptBuilder');
const { requestOllamaChat } = require('./ollamaClient');
const { splitResponseIntoChunks } = require('./responseFormatter');

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
      chosenThinkingMessage
    });

    const context = collectContextForMessage(client, message);
    const messages = buildOllamaMessages({ message, context });
    const finalText = await requestOllamaChat({
      baseUrl: process.env.OLLAMA_BASE_URL || client.appConfig.llm.baseUrl,
      model: process.env.OLLAMA_MODEL || client.appConfig.llm.model,
      messages,
      timeoutMs: client.appConfig.llm.timeoutMs,
      logger,
      sourceMessageId: message.id
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
