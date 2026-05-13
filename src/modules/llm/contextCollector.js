const {
  getRecentArchivedMessages,
  getRecentArchivedMessagesByAuthor,
  getThreadStarterArchivedMessage
} = require('../messageArchive');

function summarizeAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return [];
  }

  return attachments.slice(0, 4).map((attachment) => {
    const fileName = attachment.title || attachment.filename || attachment.name || 'attachment';
    const contentType = attachment.contentType ? ` [${attachment.contentType}]` : '';
    const url = attachment.url ? ` (${attachment.url})` : '';
    return `${fileName}${contentType}${url}`;
  });
}

function summarizeEmbeds(embeds) {
  if (!Array.isArray(embeds) || !embeds.length) {
    return [];
  }

  return embeds.slice(0, 3).flatMap((embed) => {
    const lines = ['[link preview]'];
    if (embed.title) {
      lines.push(`title: ${embed.title}`);
    }
    if (embed.description) {
      lines.push(`description: ${String(embed.description).slice(0, 280)}`);
    }
    if (embed.url) {
      lines.push(`url: ${embed.url}`);
    }
    if (embed.provider?.name) {
      lines.push(`provider: ${embed.provider.name}`);
    }
    const imageUrl = embed.image?.url || embed.thumbnail?.url || null;
    if (imageUrl) {
      lines.push(`image: ${imageUrl}`);
    }
    const videoUrl = embed.video?.url || null;
    if (videoUrl) {
      lines.push(`video: ${videoUrl}`);
    }
    return lines;
  });
}

async function resolveDiscordTokens(client, guild, content) {
  const raw = String(content || '');
  if (!raw) {
    return {
      content: '',
      mentionsResolvedCount: 0,
      channelMentionsResolvedCount: 0
    };
  }

  let mentionsResolvedCount = 0;
  let channelMentionsResolvedCount = 0;
  let resolved = raw;

  resolved = resolved.replace(/<@!?(\d+)>/g, (match, userId) => {
    const member = guild?.members?.cache?.get(userId);
    const user = guild?.client?.users?.cache?.get(userId);
    const displayName = member?.displayName || user?.globalName || user?.username;
    if (!displayName) {
      return match;
    }
    mentionsResolvedCount += 1;
    return `@${displayName} (userId:${userId})`;
  });

  resolved = resolved.replace(/<#(\d+)>/g, (match, channelId) => {
    const channel = guild?.channels?.cache?.get(channelId);
    if (!channel?.name) {
      return match;
    }
    channelMentionsResolvedCount += 1;
    return `#${channel.name} (channelId:${channelId})`;
  });

  resolved = resolved.replace(/<@&(\d+)>/g, (match, roleId) => {
    const role = guild?.roles?.cache?.get(roleId);
    if (!role?.name) {
      return match;
    }
    return `@${role.name} (roleId:${roleId})`;
  });

  resolved = resolved.replace(/<a?:([A-Za-z0-9_]{2,32}):\d+>/g, ':$1:');

  return {
    content: resolved,
    mentionsResolvedCount,
    channelMentionsResolvedCount
  };
}

function formatContextMessage(message) {
  const timestamp = message.createdAt ? new Date(message.createdAt).toLocaleString('ja-JP', { hour12: false }) : 'unknown';
  const author = message.authorName || message.authorId || '不明';
  const lines = [`[${timestamp}] ${author}:`];

  if (message.resolvedContent) {
    lines.push(message.resolvedContent);
  }

  const attachmentLines = summarizeAttachments(message.attachments);
  if (attachmentLines.length) {
    lines.push(`添付: ${attachmentLines.join(', ')}`);
  }

  const embedLines = summarizeEmbeds(message.embeds);
  if (embedLines.length) {
    lines.push(...embedLines);
  }

  return lines.join('\n');
}

function getChannelTypeName(channel) {
  if (channel?.isThread?.()) {
    return 'thread';
  }
  if (channel?.isVoiceBased?.()) {
    return 'voice';
  }
  if (channel?.isTextBased?.()) {
    return 'text';
  }
  return channel?.type ? String(channel.type) : 'unknown';
}

async function buildDiscordMetadata(client, message) {
  const guild = message.guild;
  const channel = message.channel;
  const parent = channel?.parent || null;
  const lines = ['現在のDiscord上の場所:'];

  if (guild?.name) {
    lines.push(`- サーバー: ${guild.name}`);
  }

  lines.push(`- 現在のチャンネルID: ${message.channelId}`);

  if (channel?.name) {
    lines.push(`- 現在のチャンネル名: ${channel.name}`);
  }

  lines.push(`- 現在のチャンネル種別: ${getChannelTypeName(channel)}`);

  if (channel?.isThread?.()) {
    lines.push(`- 現在のスレッドID: ${channel.id}`);
    lines.push(`- 現在のスレッド: ${channel.name}`);

    if (parent?.id) {
      lines.push(`- 親チャンネルID: ${parent.id}`);
    }
    if (parent?.name) {
      lines.push(`- 親チャンネル名: ${parent.name}`);
    }
    if (parent) {
      lines.push(`- 親チャンネル種別: ${getChannelTypeName(parent)}`);
    }
    if (parent?.availableTags?.length) {
      lines.push(`- 親フォーラム: ${parent.name}`);
    }

    if (parent?.availableTags?.length && Array.isArray(channel.appliedTags) && channel.appliedTags.length) {
      const tagMap = new Map(parent.availableTags.map((tag) => [String(tag.id), tag.name]));
      const applied = channel.appliedTags.map((tagId) => `${tagMap.get(String(tagId)) || tagId} (${tagId})`);
      lines.push(`- 適用タグ: ${applied.join(', ')}`);
    }
  }

  const authorName = message.member?.displayName || message.author?.globalName || message.author?.username;
  if (authorName) {
    lines.push(`- ユーザー: ${authorName}`);
  }
  if (message.author?.id) {
    lines.push(`- ユーザーID: ${message.author.id}`);
  }
  lines.push(`- リクエストメッセージID: ${message.id}`);

  client.logger.info('LLM discord metadata included', {
    sourceMessageId: message.id,
    channelId: message.channelId,
    inThread: Boolean(channel?.isThread?.())
  });

  return lines;
}

async function getThreadStarterContext(client, message) {
  const channel = message.channel;
  if (!channel?.isThread?.()) {
    return null;
  }

  let starter = null;

  client.logger.info('LLM thread starter lookup started', {
    sourceMessageId: message.id,
    threadId: channel.id
  });

  try {
    if (typeof getThreadStarterArchivedMessage === 'function') {
      starter = getThreadStarterArchivedMessage(client, { channelId: channel.id });
      client.logger.info('LLM thread starter archived lookup result', {
        sourceMessageId: message.id,
        threadId: channel.id,
        hit: Boolean(starter),
        threadStarterMessageId: starter?.messageId || null
      });
    } else {
      client.logger.warn('LLM thread starter archive lookup failed', {
        sourceMessageId: message.id,
        threadId: channel.id,
        reason: 'missing_function'
      });
    }
  } catch (error) {
    client.logger.warn('LLM thread starter archive lookup failed', {
      sourceMessageId: message.id,
      threadId: channel.id,
      reason: error.message
    });
  }

  if (!starter && typeof channel.fetchStarterMessage === 'function') {
    const starterMessage = await channel.fetchStarterMessage().catch((error) => {
      client.logger.warn('LLM thread starter fetch fallback failed', {
        sourceMessageId: message.id,
        threadId: channel.id,
        reason: error.message
      });
      return null;
    });

    client.logger.info('LLM thread starter fetch fallback result', {
      sourceMessageId: message.id,
      threadId: channel.id,
      hit: Boolean(starterMessage),
      threadStarterMessageId: starterMessage?.id || null
    });

    if (starterMessage) {
      const resolved = await resolveDiscordTokens(client, message.guild, starterMessage.content || starterMessage.cleanContent || '');
      starter = {
        messageId: starterMessage.id,
        authorName:
          starterMessage.member?.displayName ||
          starterMessage.author?.globalName ||
          starterMessage.author?.username ||
          '不明なユーザー',
        resolvedContent: resolved.content,
        attachments: Array.from(starterMessage.attachments.values()),
        embeds: starterMessage.embeds.map((embed) => (typeof embed.toJSON === 'function' ? embed.toJSON() : embed.data || {})),
        createdAt: starterMessage.createdAt?.toISOString?.() || null
      };
    }
  }

  client.logger.info('LLM thread starter inspected', {
    sourceMessageId: message.id,
    threadStarterIncluded: Boolean(starter),
    threadStarterMessageId: starter?.messageId || null,
    starterContentLength: String(starter?.resolvedContent || starter?.content || '').length
  });

  return starter;
}

async function getReferencedContext(client, message) {
  const referencedMessageId = message.reference?.messageId;
  if (!referencedMessageId) {
    return null;
  }

  let referenced = client.db.archives.getMessage(referencedMessageId);
  if (!referenced && typeof message.fetchReference === 'function') {
    const referencedMessage = await message.fetchReference().catch(() => null);
    if (referencedMessage) {
      referenced = {
        messageId: referencedMessage.id,
        authorName:
          referencedMessage.member?.displayName ||
          referencedMessage.author?.globalName ||
          referencedMessage.author?.username ||
          '不明なユーザー',
        content: referencedMessage.content || referencedMessage.cleanContent || '',
        attachments: Array.from(referencedMessage.attachments.values()),
        embeds: referencedMessage.embeds.map((embed) => (typeof embed.toJSON === 'function' ? embed.toJSON() : embed.data || {})),
        createdAt: referencedMessage.createdAt?.toISOString?.() || null
      };
    }
  }

  if (!referenced) {
    return null;
  }

  const resolved = await resolveDiscordTokens(client, message.guild, referenced.content || referenced.cleanContent || '');
  referenced.resolvedContent = resolved.content;
  referenced.attachments = referenced.attachments || [];
  referenced.embeds = referenced.embeds || [];
  return referenced;
}

function shouldIncludeMentionedUserContext(content) {
  return /(このユーザー|この人|過去の発言|発言から|どんな人|レベル|推測)/u.test(String(content || ''));
}

function extractMentionedUserIds(content) {
  return Array.from(String(content || '').matchAll(/<@!?(\d+)>/g)).map((match) => match[1]);
}

async function getMentionedUserContext(client, message, requestText) {
  const mentionedUserIds = extractMentionedUserIds(requestText);
  if (!mentionedUserIds.length || !shouldIncludeMentionedUserContext(requestText)) {
    return [];
  }

  const limit = Number(client.appConfig.llm.mentionedUserMessageLimit || 30);
  const blocks = [];

  for (const userId of [...new Set(mentionedUserIds)]) {
    const recent = getRecentArchivedMessagesByAuthor(client, {
      guildId: message.guildId,
      authorId: userId,
      limit
    });

    if (!recent.length) {
      continue;
    }

    const formatted = [];
    for (const entry of recent) {
        const resolved = await resolveDiscordTokens(client, message.guild, entry.content || entry.cleanContent || '');
      const channelName = message.guild?.channels?.cache?.get(entry.channelId)?.name || entry.channelId;
      formatted.push(
        `[${new Date(entry.createdAt).toLocaleString('ja-JP', { hour12: false })}] #${channelName} ${entry.authorName}: ${resolved.content || '(本文なし)'}`
      );
    }

    blocks.push({
      userId,
      lines: formatted
    });
  }

  client.logger.info('LLM mentioned user context included', {
    sourceMessageId: message.id,
    mentionedUserContextCount: blocks.length
  });

  return blocks;
}

async function collectContextForMessage(client, message, options = {}) {
  const channelId = message.channelId;
  const guild = message.guild;
  const limit = Number(options.limit || client.appConfig.llm.contextMessageLimit || 50);
  const recentMessages = getRecentArchivedMessages(client, {
    channelId,
    limit
  });

  let mentionsResolvedCount = 0;
  let channelMentionsResolvedCount = 0;
  let attachmentSummariesCount = 0;
  let embedSummariesCount = 0;

  for (const entry of recentMessages) {
    const resolved = await resolveDiscordTokens(client, guild, entry.content || entry.cleanContent || '');
    entry.resolvedContent = resolved.content;
    mentionsResolvedCount += resolved.mentionsResolvedCount;
    channelMentionsResolvedCount += resolved.channelMentionsResolvedCount;
    attachmentSummariesCount += Array.isArray(entry.attachments) ? Math.min(entry.attachments.length, 4) : 0;
    embedSummariesCount += Array.isArray(entry.embeds) ? Math.min(entry.embeds.length, 3) : 0;
  }

  const discordMetadataLines = await buildDiscordMetadata(client, message);
  const threadStarter = await getThreadStarterContext(client, message);
  const referencedMessage = await getReferencedContext(client, message);
  const requestResolved = await resolveDiscordTokens(client, guild, options.requestText || message.content || '');
  const mentionedUserContext = await getMentionedUserContext(client, message, options.requestText || message.content || '');

  client.logger.info('LLM context collected', {
    sourceMessageId: message.id,
    channelId,
    contextCount: recentMessages.length,
    requestedLimit: limit,
    attachmentSummariesCount,
    embedSummariesCount,
    mentionsResolvedCount,
    channelMentionsResolvedCount,
    threadStarterIncluded: Boolean(threadStarter),
    mentionedUserContextIncluded: mentionedUserContext.length > 0
  });

  return {
    channelId,
    messages: recentMessages,
    formattedMessages: recentMessages.map(formatContextMessage),
    discordMetadataLines,
    threadStarter,
    referencedMessage,
    requestResolvedText: requestResolved.content,
    mentionedUserContext
  };
}

module.exports = {
  collectContextForMessage
};
