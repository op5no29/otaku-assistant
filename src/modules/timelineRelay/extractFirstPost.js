const { setTimeout: sleep } = require('node:timers/promises');
const { getMessageJumpUrl } = require('../../services/discordLinks');
const {
  findImageAttachments,
  findFirstImageAttachment,
  findFirstVideoAttachment,
  normalizeAttachments,
  parseBotHashtagRoutes
} = require('../../utils/text');

const QUESTION_FORUM_LABELS = {
  '1224771331623485440': '映像制作全般',
  '1230488742737875005': 'DTM',
  '1230488769145081916': 'メディアアート',
  '1230488840444186714': 'CG',
  '1230488869519229009': 'ゲーム'
};

const KNOWLEDGE_FORUM_TAG_LABELS = {
  '1503794375451476118': '技術',
  '1503794402730967182': 'アート',
  '1503794414189940776': '健康',
  '1503794425132748810': 'その他',
  '1503794443793334404': '食事',
  '1503794456082776095': '読書',
  '1503794484843122718': '科学',
  '1503971430713524254': '勉強会',
  '1503971533016666133': 'アニメ',
  '1503971568370585670': 'エロ'
};

function normalizeQuestionTitle(rawTitle, resolvedPrefix) {
  const normalizedPrefix = resolvedPrefix || '[解決済]';
  const isResolved = rawTitle.startsWith(normalizedPrefix);
  return {
    isResolved,
    title: isResolved ? rawTitle.slice(normalizedPrefix.length).trimStart() : rawTitle
  };
}

function getForumLabel(thread) {
  const categoryName = thread.parent?.parent?.name?.trim();

  if (categoryName && !categoryName.includes('質問場所')) {
    return categoryName;
  }

  return QUESTION_FORUM_LABELS[String(thread.parentId)] || '質問フォーラム';
}

function getKnowledgeTagLabels(thread) {
  const appliedTagIds = Array.isArray(thread.appliedTags) ? thread.appliedTags : [];
  if (!appliedTagIds.length) {
    return [];
  }

  const availableTagMap = new Map(
    Array.isArray(thread.parent?.availableTags)
      ? thread.parent.availableTags.map((tag) => [String(tag.id), tag.name])
      : []
  );

  return appliedTagIds
    .map((tagId) => availableTagMap.get(String(tagId)) || KNOWLEDGE_FORUM_TAG_LABELS[String(tagId)] || null)
    .filter(Boolean);
}

function detectSocialLink(content) {
  if (!content) {
    return null;
  }

  const match = content.match(/https?:\/\/\S+/i);
  return match?.[0] || null;
}

function pickPreviewImage(embed) {
  return embed.image?.url || embed.thumbnail?.url || null;
}

function looksLikePreviewImageUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    return false;
  }

  return (
    /pbs\.twimg\.com|video\.twimg\.com|instagram\./i.test(url) ||
    /[?&]format=(jpg|jpeg|png|webp|gif)\b/i.test(url) ||
    /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(url)
  );
}

function collectPreviewImageUrlsFromRawEmbed(value, collector, context = { key: '' }) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    if (
      /(image|images|thumbnail|thumbnails|photo|photos|media|video|videos|proxy)/i.test(context.key) &&
      looksLikePreviewImageUrl(value)
    ) {
      collector.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPreviewImageUrlsFromRawEmbed(entry, collector, context);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectPreviewImageUrlsFromRawEmbed(entry, collector, {
        key: `${context.key}.${key}`
      });
    }
  }
}

function extractSocialPreviewFromEmbeds(embeds) {
  const imageUrls = [];
  let primaryPreview = null;

  for (const embed of embeds || []) {
    const rawImageUrls = new Set();
    const imageUrl = pickPreviewImage(embed);
    const description = embed.description?.trim() || null;
    const title = embed.title?.trim() || embed.author?.name?.trim() || null;
    const sourceUrl = embed.url || null;
    const siteName = embed.provider?.name || embed.author?.name || null;

    if (imageUrl) {
      rawImageUrls.add(imageUrl);
    }

    collectPreviewImageUrlsFromRawEmbed(embed.data || embed, rawImageUrls);

    for (const collectedImageUrl of rawImageUrls) {
      if (collectedImageUrl && !imageUrls.includes(collectedImageUrl)) {
        imageUrls.push(collectedImageUrl);
      }
    }

    if (!primaryPreview && (title || description || imageUrls.length)) {
      primaryPreview = {
        title,
        description,
        imageUrl: imageUrl || imageUrls[0] || null,
        imageUrls: [],
        sourceUrl,
        siteName
      };
    }
  }

  if (!primaryPreview && !imageUrls.length) {
    return null;
  }

  return {
    title: primaryPreview?.title || null,
    description: primaryPreview?.description || null,
    imageUrl: primaryPreview?.imageUrl || imageUrls[0] || null,
    imageUrls,
    sourceUrl: primaryPreview?.sourceUrl || null,
    siteName: primaryPreview?.siteName || null
  };
}

async function getSocialPreviewData(message, logger, attempts = 3, retryDelayMs = 800) {
  const socialLink = detectSocialLink(message.content || '');

  if (!socialLink) {
    return null;
  }

  logger.info('Link detected in message for preview extraction', {
    messageId: message.id,
    link: socialLink
  });

  let workingMessage = message;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const preview = extractSocialPreviewFromEmbeds(workingMessage.embeds);

    if (preview) {
      logger.info('Link preview embed data found', {
        messageId: message.id,
        attempt,
        hasImage: Boolean(preview.imageUrl),
        imageCount: Array.isArray(preview.imageUrls) ? preview.imageUrls.length : 0,
        hasTitle: Boolean(preview.title),
        hasDescription: Boolean(preview.description)
      });

      if (/https?:\/\/(?:www\.)?(x\.com|twitter\.com)\//i.test(socialLink)) {
        if ((preview.imageUrls || []).length <= 1) {
          logger.info('Twitter/X preview only exposed one image', {
            messageId: message.id,
            link: socialLink,
            imageCount: Array.isArray(preview.imageUrls) ? preview.imageUrls.length : 0
          });
        }

        if (!(preview.imageUrls || []).length) {
          logger.info('Quoted media was not available from Discord embeds', {
            messageId: message.id,
            link: socialLink
          });
        }
      }

      if (/https?:\/\/(?:www\.)?(x\.com|twitter\.com)\//i.test(socialLink) && !(preview.imageUrls || []).length) {
        logger.info('Twitter/X preview fallback has no exposed images', {
          messageId: message.id,
          link: socialLink
        });
      }

      return {
        ...preview,
        sourceUrl: preview.sourceUrl || socialLink
      };
    }

    logger.info('Link preview embed data not available yet', {
      messageId: message.id,
      attempt
    });

    if (attempt < attempts) {
      await sleep(retryDelayMs);
      workingMessage = await message.channel.messages.fetch(message.id).catch(() => workingMessage);
    }
  }

  logger.info('Link preview fallback used', {
    messageId: message.id,
    link: socialLink
  });

  return {
    title: null,
    description: null,
    imageUrl: null,
    imageUrls: [],
    sourceUrl: socialLink,
    siteName: null
  };
}

async function getStarterMessage(thread, logger, attempts = 4, retryDelayMs = 750) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const starterMessage = await thread.fetchStarterMessage();
      if (starterMessage) {
        if (attempt > 1) {
          logger.info('Starter message fetch recovered', {
            threadId: thread.id,
            attempt
          });
        }

        return starterMessage;
      }
    } catch (error) {
      lastError = error;
      logger.warn('Starter message fetch failed', {
        threadId: thread.id,
        attempt,
        error: error.message,
        code: error.code || null
      });

      if (error.code !== 10008 && error.code !== 50083) {
        throw error;
      }
    }

    try {
      const fetched = await thread.messages.fetch({ limit: 5 });
      const firstMessage = fetched
        .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
        .first();

      if (firstMessage) {
        if (attempt > 1) {
          logger.info('Starter message fallback fetch recovered', {
            threadId: thread.id,
            attempt
          });
        }

        return firstMessage;
      }
    } catch (fallbackError) {
      lastError = fallbackError;
      logger.warn('Starter message fallback fetch failed', {
        threadId: thread.id,
        attempt,
        error: fallbackError.message,
        code: fallbackError.code || null
      });
    }

    if (attempt < attempts) {
      await sleep(retryDelayMs);
    }
  }

  if (lastError) {
    logger.error('Starter message fetch exhausted retries', {
      threadId: thread.id,
      error: lastError.message,
      code: lastError.code || null
    });
  }

  return null;
}

async function resolveMemberDisplayName(guild, userId) {
  if (!guild || !userId) {
    return null;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (member?.displayName) {
    return member.displayName;
  }

  const user = await guild.client.users.fetch(userId).catch(() => null);
  return user?.globalName || user?.username || null;
}

async function getThreadOwnerInfo(thread, logger) {
  if (thread.ownerId) {
    const displayName = await resolveMemberDisplayName(thread.guild, thread.ownerId);
    return {
      id: thread.ownerId,
      displayName
    };
  }

  const starterMessage = await getStarterMessage(thread, logger);
  if (!starterMessage?.author) {
    return null;
  }

  const member =
    starterMessage.member ||
    (starterMessage.author
      ? await thread.guild.members.fetch(starterMessage.author.id).catch(() => null)
      : null);

  return {
    id: starterMessage.author.id,
    displayName:
      member?.displayName ||
      starterMessage.author.globalName ||
      starterMessage.author.username ||
      null
  };
}

function buildTweetHeadline(displayName, threadOwnerInfo, authorId, { isReply = false } = {}) {
  const action = isReply ? '返信しました' : '投稿しました';

  if (threadOwnerInfo?.id && authorId && threadOwnerInfo.id === authorId) {
    return `${displayName} さんが${isReply ? '返信しました' : '投稿しました'}`;
  }

  if (threadOwnerInfo?.displayName) {
    return `${displayName} さんが ${threadOwnerInfo.displayName} さんのスレッドで${action}`;
  }

  return `${displayName} さんがこのスレッドで${action}`;
}

function buildReplyContextPreview(referencedMessage) {
  if (!referencedMessage) {
    return null;
  }

  const attachmentNames = normalizeAttachments(referencedMessage.attachments)
    .map((attachment) => attachment.name)
    .filter(Boolean)
    .join('\n');
  const text = String(referencedMessage.content || '').trim() || attachmentNames || '（本文はまだありません）';

  return {
    sourceMessageId: referencedMessage.id,
    authorId: referencedMessage.author?.id || null,
    displayName:
      referencedMessage.member?.displayName ||
      referencedMessage.author?.globalName ||
      referencedMessage.author?.username ||
      '不明なユーザー',
    content: text
  };
}

async function getReplyContext(message, logger) {
  const referencedSourceMessageId = message.reference?.messageId || null;
  if (!referencedSourceMessageId) {
    return {
      referencedSourceMessageId: null,
      replyContext: null
    };
  }

  try {
    const referencedMessage = await message.fetchReference();
    return {
      referencedSourceMessageId,
      replyContext: buildReplyContextPreview(referencedMessage)
    };
  } catch (error) {
    logger?.info?.('Reply context fetch failed; continuing without compact context', {
      sourceMessageId: message.id,
      referencedSourceMessageId,
      error: error.message
    });
    return {
      referencedSourceMessageId,
      replyContext: null
    };
  }
}

async function extractFirstPost(thread, config, logger) {
  const starterMessage = await getStarterMessage(thread, logger);

  if (!starterMessage) {
    return null;
  }

  const guildMember =
    starterMessage.member ||
    (starterMessage.author
      ? await thread.guild.members.fetch(starterMessage.author.id).catch(() => null)
      : null);
  const normalizedTitle = normalizeQuestionTitle(
    thread.name || '',
    config.questions?.resolvedPrefix
  );
  const imageAttachments = config.timeline.includeFirstImage
    ? findImageAttachments(starterMessage.attachments)
    : [];
  const attachments = normalizeAttachments(starterMessage.attachments);
  const firstImage = config.timeline.includeFirstImage
    ? findFirstImageAttachment(starterMessage.attachments)
    : null;
  const firstVideo = findFirstVideoAttachment(starterMessage.attachments);
  const socialPreview = await getSocialPreviewData(starterMessage, logger);
  const knowledgeTagLabels = getKnowledgeTagLabels(thread);

  return {
    message: starterMessage,
    messageId: starterMessage.id,
    createdAt: starterMessage.createdAt || new Date(),
    author: starterMessage.author || null,
    displayName:
      guildMember?.displayName ||
      starterMessage.author?.globalName ||
      starterMessage.author?.username ||
      '不明なユーザー',
    avatarUrl:
      guildMember?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      starterMessage.author?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      null,
    rawTitle: thread.name || '',
    title: normalizedTitle.title || '',
    isResolved: normalizedTitle.isResolved,
    content: starterMessage.content || '',
    jumpUrl: getMessageJumpUrl({
      guildId: thread.guildId,
      channelId: thread.id,
      messageId: starterMessage.id
    }),
    attachments,
    imageUrls: imageAttachments.map((attachment) => attachment.url),
    firstImageUrl: firstImage?.url || null,
    firstVideoUrl: firstVideo?.url || null,
    firstVideoName: firstVideo?.name || null,
    socialPreview,
    knowledgeTagLabels,
    threadId: thread.id,
    parentChannelId: String(thread.parentId || ''),
    forumName: getForumLabel(thread),
    parentChannelName: thread.parent?.name || null
  };
}

async function extractThreadMessagePost(message, config, logger = null) {
  const thread = message.channel;
  const guildMember =
    message.member ||
    (message.author ? await thread.guild.members.fetch(message.author.id).catch(() => null) : null);
  const imageAttachments = config.timeline.includeFirstImage
    ? findImageAttachments(message.attachments)
    : [];
  const attachments = normalizeAttachments(message.attachments);
  const firstImage = config.timeline.includeFirstImage
    ? findFirstImageAttachment(message.attachments)
    : null;
  const firstVideo = findFirstVideoAttachment(message.attachments);
  const socialPreview = logger ? await getSocialPreviewData(message, logger) : null;
  const threadOwnerInfo = await getThreadOwnerInfo(thread, logger);
  const hashtagRouting = parseBotHashtagRoutes(message.content || '', config.botHashtagRoutes);
  const { referencedSourceMessageId, replyContext } = await getReplyContext(message, logger);
  const displayName =
    guildMember?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    '不明なユーザー';

  return {
    message,
    messageId: message.id,
    createdAt: message.createdAt || new Date(),
    author: message.author || null,
    displayName,
    avatarUrl:
      guildMember?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      message.author?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      null,
    timelineHeadline: buildTweetHeadline(displayName, threadOwnerInfo, message.author?.id || null, {
      isReply: Boolean(referencedSourceMessageId)
    }),
    threadOwnerId: threadOwnerInfo?.id || null,
    threadOwnerDisplayName: threadOwnerInfo?.displayName || null,
    referencedSourceMessageId,
    replyContext,
    title: '',
    rawTitle: thread.name || '',
    isResolved: false,
    content: hashtagRouting.content,
    matchedBotHashtagRoutes: hashtagRouting.matchedRoutes,
    displayBotHashtags: hashtagRouting.displayTags,
    jumpUrl: getMessageJumpUrl({
      guildId: thread.guildId,
      channelId: thread.id,
      messageId: message.id
    }),
    attachments,
    imageUrls: imageAttachments.map((attachment) => attachment.url),
    firstImageUrl: firstImage?.url || null,
    firstVideoUrl: firstVideo?.url || null,
    firstVideoName: firstVideo?.name || null,
    socialPreview,
    threadId: thread.id,
    parentChannelId: String(thread.parentId || ''),
    forumName: thread.parent?.name || 'つぶやき',
    parentChannelName: thread.parent?.name || null
  };
}

module.exports = {
  extractFirstPost,
  extractThreadMessagePost
};
