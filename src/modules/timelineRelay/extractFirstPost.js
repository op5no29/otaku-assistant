const { setTimeout: sleep } = require('node:timers/promises');
const { getMessageJumpUrl } = require('../../services/discordLinks');
const {
  findImageAttachments,
  findFirstImageAttachment,
  findFirstVideoAttachment,
  normalizeAttachments,
  parseBotHashtagRoutes,
  restoreCustomEmojiTokens
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

function getGifProviderName(url) {
  if (/tenor\.com|media\.tenor\.com/i.test(String(url || ''))) {
    return 'tenor';
  }

  if (/giphy\.com|media\d*\.giphy\.com/i.test(String(url || ''))) {
    return 'giphy';
  }

  if (/cdn\.discordapp\.com/i.test(String(url || '')) && /\.gif/i.test(String(url || ''))) {
    return 'discord-cdn';
  }

  return null;
}

function isGifProviderUrl(url) {
  return /https?:\/\/(?:www\.)?(?:tenor\.com|media\.tenor\.com|giphy\.com|media\d*\.giphy\.com)\//i.test(String(url || ''));
}

function looksLikeAnimatedMediaUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) &&
    (/\.(gif|mp4|webm)(?:[?#].*)?$/i.test(url) || /tenor|giphy/i.test(url));
}

function normalizeMediaUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.hash = '';
    if (/tenor|giphy/i.test(parsed.hostname)) {
      parsed.search = '';
    }
    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

function scoreGifMediaCandidate(url) {
  if (/\.gif(?:[?#].*)?$/i.test(url)) {
    return 3;
  }

  if (/\.mp4(?:[?#].*)?$/i.test(url)) {
    return 2;
  }

  if (/\.webm(?:[?#].*)?$/i.test(url)) {
    return 1;
  }

  return 0;
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

function collectPreviewMediaUrlsFromRawEmbed(value, collector, context = { key: '' }) {
  if (!value) {
    return;
  }

  if (typeof value === 'string') {
    if (
      /(image|images|thumbnail|thumbnails|photo|photos|media|video|videos|gif|gifs|proxy)/i.test(context.key) &&
      (looksLikePreviewImageUrl(value) || looksLikeAnimatedMediaUrl(value))
    ) {
      collector.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPreviewMediaUrlsFromRawEmbed(entry, collector, context);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectPreviewMediaUrlsFromRawEmbed(entry, collector, {
        key: `${context.key}.${key}`
      });
    }
  }
}

function extractSocialPreviewFromEmbeds(embeds, sourceUrl = null) {
  const imageUrls = [];
  const mediaUrls = [];
  let primaryPreview = null;
  let duplicateCount = 0;
  const seenNormalized = new Set();
  const gifProvider = getGifProviderName(sourceUrl);

  for (const embed of embeds || []) {
    const rawImageUrls = new Set();
    const rawMediaUrls = new Set();
    const imageUrl = pickPreviewImage(embed);
    const description = embed.description?.trim() || null;
    const title = embed.title?.trim() || embed.author?.name?.trim() || null;
    const embedSourceUrl = embed.url || null;
    const siteName = embed.provider?.name || embed.author?.name || null;

    if (imageUrl) {
      rawImageUrls.add(imageUrl);
    }

    collectPreviewImageUrlsFromRawEmbed(embed.data || embed, rawImageUrls);
    collectPreviewMediaUrlsFromRawEmbed(embed.data || embed, rawMediaUrls);

    for (const collectedImageUrl of rawImageUrls) {
      const normalized = normalizeMediaUrl(collectedImageUrl);
      if (collectedImageUrl && !seenNormalized.has(normalized)) {
        seenNormalized.add(normalized);
        imageUrls.push(collectedImageUrl);
        mediaUrls.push(collectedImageUrl);
      } else if (collectedImageUrl) {
        duplicateCount += 1;
      }
    }

    for (const collectedMediaUrl of rawMediaUrls) {
      const normalized = normalizeMediaUrl(collectedMediaUrl);
      if (collectedMediaUrl && !seenNormalized.has(normalized)) {
        seenNormalized.add(normalized);
        mediaUrls.push(collectedMediaUrl);
      } else if (collectedMediaUrl) {
        duplicateCount += 1;
      }
    }

    if (!primaryPreview && (title || description || mediaUrls.length)) {
      primaryPreview = {
        title,
        description,
        imageUrl: imageUrl || imageUrls[0] || null,
        imageUrls: [],
        sourceUrl: embedSourceUrl,
        siteName
      };
    }
  }

  if (!primaryPreview && !mediaUrls.length) {
    return null;
  }

  let finalMediaUrls = mediaUrls;
  if (gifProvider && finalMediaUrls.length) {
    finalMediaUrls = [...finalMediaUrls]
      .sort((left, right) => scoreGifMediaCandidate(right) - scoreGifMediaCandidate(left))
      .slice(0, 1);
  }

  return {
    title: primaryPreview?.title || null,
    description: primaryPreview?.description || null,
    imageUrl: primaryPreview?.imageUrl || imageUrls[0] || null,
    imageUrls,
    mediaUrls: finalMediaUrls,
    sourceUrl: primaryPreview?.sourceUrl || null,
    siteName: primaryPreview?.siteName || null,
    isGifShare: isGifProviderUrl(sourceUrl) || mediaUrls.some((url) => looksLikeAnimatedMediaUrl(url)),
    gifProvider,
    duplicateCount: duplicateCount + Math.max(0, mediaUrls.length - finalMediaUrls.length)
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
    const preview = extractSocialPreviewFromEmbeds(workingMessage.embeds, socialLink);

    if (preview) {
      logger.info('Link preview embed data found', {
        messageId: message.id,
        attempt,
        hasImage: Boolean(preview.imageUrl),
        imageCount: Array.isArray(preview.imageUrls) ? preview.imageUrls.length : 0,
        mediaCount: Array.isArray(preview.mediaUrls) ? preview.mediaUrls.length : 0,
        hasTitle: Boolean(preview.title),
        hasDescription: Boolean(preview.description)
      });

      if (preview.isGifShare) {
        logger.info('GIF preview extracted', {
          sourceMessageId: message.id,
          detectedGifProvider: preview.gifProvider || getGifProviderName(socialLink),
          originalLink: socialLink,
          extractedMediaUrl: preview.mediaUrls?.[0] || preview.imageUrls?.[0] || null,
          mediaCandidates: preview.mediaUrls || [],
          acceptedMediaCount: preview.mediaUrls?.length || 0,
          rejectedDuplicateCount: preview.duplicateCount || 0
        });
      }

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
    mediaUrls: [],
    sourceUrl: socialLink,
    siteName: null,
    isGifShare: isGifProviderUrl(socialLink),
    duplicateCount: 0
  };
}

function stripPreviewedGifLinks(content, socialPreview) {
  const rawContent = String(content || '');
  if (!rawContent || !socialPreview?.isGifShare) {
    return {
      content: rawContent,
      bodyUrlHidden: false
    };
  }

  const lines = rawContent.split(/\r?\n/);
  const keptLines = lines.filter((line) => !isGifProviderUrl(line.trim()));
  const bodyUrlHidden = keptLines.length !== lines.length;

  return {
    content: keptLines.join('\n').trim(),
    bodyUrlHidden
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

  for (const attachment of starterMessage.attachments.values()) {
    logger.info('Attachment raw metadata observed', {
      sourceMessageId: starterMessage.id,
      attachmentId: String(attachment.id || ''),
      attachmentName: attachment.name || null,
      attachmentFilename: attachment.filename || null,
      attachmentTitle: attachment.title || null,
      attachmentDescription: attachment.description || null,
      attachmentUrl: attachment.url ? String(attachment.url).slice(0, 240) : null,
      attachmentProxyUrl: attachment.proxyURL ? String(attachment.proxyURL).slice(0, 240) : null,
      contentType: attachment.contentType || null,
      size: Number(attachment.size || 0),
      attachmentKeys: Object.keys(attachment)
    });
  }

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
  for (const attachment of message.attachments.values()) {
    logger?.info?.('Attachment raw metadata observed', {
      sourceMessageId: message.id,
      attachmentId: String(attachment.id || ''),
      attachmentName: attachment.name || null,
      attachmentFilename: attachment.filename || null,
      attachmentTitle: attachment.title || null,
      attachmentDescription: attachment.description || null,
      attachmentUrl: attachment.url ? String(attachment.url).slice(0, 240) : null,
      attachmentProxyUrl: attachment.proxyURL ? String(attachment.proxyURL).slice(0, 240) : null,
      contentType: attachment.contentType || null,
      size: Number(attachment.size || 0),
      attachmentKeys: Object.keys(attachment)
    });
  }

  const socialPreview = logger ? await getSocialPreviewData(message, logger) : null;
  const threadOwnerInfo = await getThreadOwnerInfo(thread, logger);
  const restoredContent = restoreCustomEmojiTokens(message.content || '', thread.guild);
  const hashtagRouting = parseBotHashtagRoutes(restoredContent, config.botHashtagRoutes);
  const strippedContent = stripPreviewedGifLinks(hashtagRouting.content, socialPreview);
  const { referencedSourceMessageId, replyContext } = await getReplyContext(message, logger);
  const displayName =
    guildMember?.displayName ||
    message.author?.globalName ||
    message.author?.username ||
    '不明なユーザー';

  logger?.info?.('Message content prepared for relay', {
    sourceMessageId: message.id,
    contentSource: 'message.content',
    rawContent: String(message.content || '').slice(0, 500),
    cleanContent: String(message.cleanContent || '').slice(0, 500),
    extractedBodyText: String(hashtagRouting.content || '').slice(0, 500),
    finalBodyText: String(strippedContent.content || '').slice(0, 500),
    bodyUrlHidden: strippedContent.bodyUrlHidden,
    customEmojiTokensPreserved: /<a?:\w+:\d+>/.test(strippedContent.content || ''),
    originalContentHadCustomEmojiToken: /<a?:\w+:\d+>/.test(message.content || ''),
    usedCleanContent: false
  });

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
    content: strippedContent.content,
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
