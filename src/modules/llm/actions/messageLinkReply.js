const { requestOllamaChat } = require('../ollamaClient');
const { splitResponseIntoChunks } = require('../responseFormatter');

const MESSAGE_LINK_PATTERN = /https?:\/\/(?:discord(?:app)?\.com)\/channels\/(\d+)\/(\d+)\/(\d+)/iu;
const ACTION_REQUEST_PATTERN = /(リプして|返信して|コメントして|質問して|質問をして|このリンクの投稿に|この投稿に|このメッセージに|リンク先)/u;

function parseMessageLinkTarget(message) {
  const content = String(message.content || '');
  const linkMatch = content.match(MESSAGE_LINK_PATTERN);
  if (linkMatch) {
    return {
      guildId: linkMatch[1],
      channelId: linkMatch[2],
      messageId: linkMatch[3],
      source: 'message_link'
    };
  }

  if (message.reference?.messageId && message.reference?.channelId) {
    return {
      guildId: message.guildId,
      channelId: message.reference.channelId,
      messageId: message.reference.messageId,
      source: 'message_reference'
    };
  }

  if (message.reference?.messageId) {
    return {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.reference.messageId,
      source: 'message_reference'
    };
  }

  return null;
}

function shouldHandleMessageLinkAction(message, client) {
  if (!message.inGuild?.() || message.author?.bot) {
    return false;
  }

  if (!message.mentions.has(client.user)) {
    return false;
  }

  return ACTION_REQUEST_PATTERN.test(String(message.content || '')) && Boolean(parseMessageLinkTarget(message));
}

function stripBotMentions(content, clientUserId) {
  return String(content || '')
    .replace(new RegExp(`<@!?${clientUserId}>`, 'g'), ' ')
    .replace(MESSAGE_LINK_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRequestedReplyText(message, client) {
  const content = stripBotMentions(message.content || '', client.user.id);
  const patterns = [
    /(?:このリンクの投稿|この投稿|このメッセージ|リンク先)(?:に対して|に)?[、,:：]?\s*([\s\S]{1,500}?)\s*と(?:リプ|返信|コメント|質問)(?:して|をして)$/u,
    /(?:に対して|に)[、,:：]?\s*([\s\S]{1,500}?)\s*と(?:リプ|返信|コメント|質問)(?:して|をして)$/u,
    /^([\s\S]{1,500}?)\s*と(?:リプ|返信|コメント|質問)(?:して|をして)$/u
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    const extracted = match?.[1]?.trim();
    if (extracted) {
      return extracted.replace(/^["「『]|["」』]$/g, '').trim();
    }
  }

  return null;
}

function isPermissionError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '50013' || code === '50001' || /Missing Permissions|Missing Access/i.test(message);
}

function summarizeAttachments(attachments) {
  return Array.from(attachments?.values?.() || []).slice(0, 4).map((attachment) => {
    const fileName = attachment.title || attachment.filename || attachment.name || 'attachment';
    return `${fileName}${attachment.contentType ? ` [${attachment.contentType}]` : ''}${attachment.url ? ` (${attachment.url})` : ''}`;
  });
}

function summarizeEmbeds(embeds) {
  return (Array.isArray(embeds) ? embeds : []).slice(0, 3).flatMap((embed) => {
    const lines = [];
    const json = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed?.data || embed || {};
    if (json.title) {
      lines.push(`title: ${json.title}`);
    }
    if (json.description) {
      lines.push(`description: ${String(json.description).slice(0, 280)}`);
    }
    if (json.url) {
      lines.push(`url: ${json.url}`);
    }
    if (json.provider?.name) {
      lines.push(`provider: ${json.provider.name}`);
    }
    const imageUrl = json.image?.url || json.thumbnail?.url || null;
    if (imageUrl) {
      lines.push(`image: ${imageUrl}`);
    }
    const videoUrl = json.video?.url || null;
    if (videoUrl) {
      lines.push(`video: ${videoUrl}`);
    }
    return lines;
  });
}

function buildTargetPrompt({ requesterName, requestText, targetMessage, targetChannel }) {
  const targetAuthor =
    targetMessage.member?.displayName ||
    targetMessage.author?.globalName ||
    targetMessage.author?.username ||
    '不明なユーザー';
  const attachmentLines = summarizeAttachments(targetMessage.attachments);
  const embedLines = summarizeEmbeds(targetMessage.embeds);

  return [
    'あなたは Otaku Assistant です。',
    'Discord上の既存メッセージに対して、自然な返信文または質問文を1件だけ日本語で作成してください。',
    '外部Web検索はできません。与えられた対象メッセージの内容だけを使ってください。',
    '相手に失礼でない短めの文にしてください。',
    '必要以上の前置きや説明は不要です。投稿する本文だけを返してください。',
    '',
    `依頼者: ${requesterName}`,
    `依頼内容: ${requestText}`,
    `対象チャンネル: ${targetChannel.name || targetChannel.id}`,
    `対象投稿者: ${targetAuthor}`,
    `対象本文: ${targetMessage.content || targetMessage.cleanContent || '(本文なし)'}`,
    ...(attachmentLines.length ? ['対象添付:', ...attachmentLines] : []),
    ...(embedLines.length ? ['対象リンクプレビュー:', ...embedLines] : [])
  ].join('\n');
}

async function handleMessageLinkReplyAction(message, client) {
  if (!shouldHandleMessageLinkAction(message, client)) {
    return false;
  }

  const logger = client.logger;
  const target = parseMessageLinkTarget(message);
  logger.info('LLM message link detected', {
    sourceMessageId: message.id,
    target
  });

  if (!target || String(target.guildId) !== String(message.guildId)) {
    await message.reply({
      content: '同じサーバー内のメッセージリンクだけ対応できます。',
      allowedMentions: { repliedUser: false, parse: [] }
    });
    return true;
  }

  let tempReply = null;
  try {
    logger.info('LLM target identifiers resolved', {
      sourceMessageId: message.id,
      targetGuildId: target.guildId,
      targetChannelId: target.channelId,
      targetMessageId: target.messageId,
      targetSource: target.source
    });

    const targetChannel = await client.channels.fetch(target.channelId).catch(() => null);
    logger.info('LLM target channel fetched', {
      sourceMessageId: message.id,
      targetChannelId: target.channelId,
      fetched: Boolean(targetChannel)
    });
    if (!targetChannel?.isTextBased?.()) {
      await message.reply({
        content: 'リンク先のチャンネルを開けませんでした。',
        allowedMentions: { repliedUser: false, parse: [] }
      });
      return true;
    }

    const targetMessage = await targetChannel.messages.fetch(target.messageId).catch(() => null);
    logger.info('LLM target message fetched', {
      sourceMessageId: message.id,
      targetMessageFetched: Boolean(targetMessage),
      targetChannelId: target.channelId,
      targetMessageId: target.messageId
    });

    if (!targetMessage) {
      await message.reply({
        content: 'リンク先のメッセージを取得できませんでした。',
        allowedMentions: { repliedUser: false, parse: [] }
      });
      return true;
    }

    const extractedReplyText = extractRequestedReplyText(message, client);
    logger.info('LLM target reply text extracted', {
      sourceMessageId: message.id,
      extracted: Boolean(extractedReplyText),
      replyText: extractedReplyText || null
    });

    let firstChunk = extractedReplyText;
    let chunks = [];

    if (!firstChunk) {
      const chosenThinkingMessage =
        client.appConfig.llm.thinkingMessages?.[Math.floor(Math.random() * client.appConfig.llm.thinkingMessages.length)] ||
        client.appConfig.llm.thinkingMessage;

      tempReply = await message.reply({
        content: chosenThinkingMessage,
        allowedMentions: { repliedUser: false, parse: [] }
      });

      logger.info('LLM target reply generation started', {
        sourceMessageId: message.id,
        targetChannelId: target.channelId,
        targetMessageId: target.messageId
      });

      const requesterName =
        message.member?.displayName ||
        message.author?.globalName ||
        message.author?.username ||
        '不明なユーザー';
      const requestText = stripBotMentions(message.content || '', client.user.id);
      const prompt = buildTargetPrompt({ requesterName, requestText, targetMessage, targetChannel });
      const finalText = await requestOllamaChat({
        baseUrl: process.env.OLLAMA_BASE_URL || client.appConfig.llm.baseUrl,
        model: process.env.OLLAMA_MODEL || client.appConfig.llm.model,
        timeoutMs: client.appConfig.llm.timeoutMs,
        logger,
        sourceMessageId: message.id,
        shortRequestMode: false,
        numPredict: Number(client.appConfig.llm.numPredict || 160),
        numCtx: Number(client.appConfig.llm.numCtx || 1024),
        temperature: Number(client.appConfig.llm.temperature ?? 0.3),
        topP: Number(client.appConfig.llm.topP ?? 0.9),
        keepAlive: String(client.appConfig.llm.keepAlive || '30m'),
        messages: [
          {
            role: 'system',
            content: 'あなたは Otaku Assistant です。Botコードが指定したリンク先投稿への返信本文だけを作成してください。リンクを実際に開いたふりはせず、与えられた対象投稿情報だけを使ってください。'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      const generatedChunks = splitResponseIntoChunks(finalText, client.appConfig.llm.maxReplyChars);
      firstChunk = generatedChunks.shift() || '気になったので、もう少し詳しく教えてもらえますか？';
      chunks = generatedChunks;
    }

    if (!firstChunk) {
      firstChunk = '気になったので、もう少し詳しく教えてもらえますか？';
    }

    logger.info('LLM target reply send started', {
      sourceMessageId: message.id,
      targetChannelId: target.channelId,
      targetMessageId: target.messageId
    });
    const posted = await targetMessage.reply({
      content: firstChunk,
      allowedMentions: { repliedUser: false, parse: [] }
    });
    logger.info('LLM target reply send finished', {
      sourceMessageId: message.id,
      targetChannelId: target.channelId,
      targetMessageId: target.messageId,
      returnedMessageId: posted.id
    });
    const responseMessages = [posted];

    for (const chunk of chunks) {
      const followUp = await targetChannel.send({
        content: chunk,
        reply: {
          messageReference: posted.id,
          failIfNotExists: false
        },
        allowedMentions: { repliedUser: false, parse: [] }
      });
      responseMessages.push(followUp);
    }

    for (const responseMessage of responseMessages) {
      client.db.llmResponses.insert({
        responseMessageId: responseMessage.id,
        requestMessageId: message.id,
        channelId: responseMessage.channelId,
        authorId: message.author.id
      });
    }

    if (tempReply) {
      await tempReply.edit({
        content: 'リンク先の投稿に返信しました。',
        allowedMentions: { parse: [] }
      }).catch(() => null);
      logger.info('LLM target reply confirmation sent', {
        sourceMessageId: message.id,
        confirmationMessageId: tempReply.id
      });
    } else if (String(message.channelId) !== String(target.channelId)) {
      await message.reply({
        content: 'リンク先の投稿に返信しました。',
        allowedMentions: { repliedUser: false, parse: [] }
      }).catch(() => null);
      logger.info('LLM target reply confirmation sent', {
        sourceMessageId: message.id,
        confirmationMessageId: null
      });
    } else {
      logger.info('LLM target reply confirmation skipped', {
        sourceMessageId: message.id,
        reason: 'same_channel_target'
      });
    }

    logger.info('LLM target reply posted', {
      sourceMessageId: message.id,
      targetChannelId: target.channelId,
      targetMessageId: target.messageId,
      postedMessageId: posted.id
    });
    return true;
  } catch (error) {
    const failureMessage = isPermissionError(error)
      ? 'リンク先に返信する権限がありません。'
      : 'リンク先の投稿を取得できませんでした。';
    if (tempReply) {
      await tempReply.edit({
        content: failureMessage,
        allowedMentions: { parse: [] }
      }).catch(() => null);
    } else {
      await message.reply({
        content: failureMessage,
        allowedMentions: { repliedUser: false, parse: [] }
      }).catch(() => null);
    }
    logger.error('LLM target reply failed', {
      sourceMessageId: message.id,
      target,
      error: error.message
    });
    return true;
  }
}

module.exports = {
  handleMessageLinkReplyAction,
  shouldHandleMessageLinkAction
};
