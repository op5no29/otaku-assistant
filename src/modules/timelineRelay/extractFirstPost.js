const { setTimeout: sleep } = require('node:timers/promises');
const { getMessageJumpUrl } = require('../../services/discordLinks');
const {
  findImageAttachments,
  findFirstImageAttachment,
  findFirstVideoAttachment,
  normalizeAttachments,
  parseBotHashtagRoutes,
  parseGlobalHashtagRoutes,
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
    if (/tenor|giphy|twimg|twitter|x\.com|discordapp|discord\.com|odesli/i.test(parsed.hostname)) {
      parsed.search = '';
    }
    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

function getPreviewProvider(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function extractTwitterStatusId(url) {
  const match = String(url || '').match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i);
  return match?.[1] || null;
}

function inferCandidateKind(url, source) {
  const value = String(url || '');
  if (/\.mp4(?:[?#].*)?$/i.test(value) || /\.webm(?:[?#].*)?$/i.test(value)) {
    return 'video';
  }
  if (/\.gif(?:[?#].*)?$/i.test(value)) {
    return 'image';
  }
  if (/thumbnail/i.test(source)) {
    return 'thumbnail';
  }
  if (/image/i.test(source)) {
    return 'image';
  }
  if (/video|media/i.test(source)) {
    return 'poster';
  }
  return 'unknown';
}

function inferCandidatePriority(candidate) {
  if (candidate.kind === 'video') {
    return 100;
  }
  if (candidate.kind === 'image') {
    return 80;
  }
  if (candidate.kind === 'poster') {
    return 60;
  }
  if (candidate.kind === 'thumbnail') {
    return 40;
  }
  if (candidate.kind === 'logo') {
    return 10;
  }
  return 20;
}

function looksLikeLogoCandidate(url) {
  const value = String(url || '');
  return /abs\.twimg\.com|favicon|icon|logo|profile_images/i.test(value);
}

function buildPreviewCandidate(url, source, sourceUrl) {
  if (!url) {
    return null;
  }

  const provider = getPreviewProvider(url || sourceUrl);
  const kind = looksLikeLogoCandidate(url) ? 'logo' : inferCandidateKind(url, source);
  return {
    url,
    normalizedUrl: normalizeMediaUrl(url),
    kind,
    source,
    provider,
    priority: inferCandidatePriority({ kind }),
    twitterStatusId: extractTwitterStatusId(sourceUrl)
  };
}

function collectPreviewMediaCandidates(embeds, sourceUrl = null) {
  const candidates = [];

  for (const embed of embeds || []) {
    const pushCandidate = (url, source) => {
      const candidate = buildPreviewCandidate(url, source, sourceUrl || embed.url || null);
      if (candidate) {
        candidates.push(candidate);
      }
    };

    if (embed.image?.url) {
      pushCandidate(embed.image.url, 'embed.image');
    }
    if (embed.thumbnail?.url) {
      pushCandidate(embed.thumbnail.url, 'embed.thumbnail');
    }
    if (embed.video?.url) {
      pushCandidate(embed.video.url, 'embed.video');
    }

    const rawMediaUrls = new Set();
    collectPreviewMediaUrlsFromRawEmbed(embed.data || embed, rawMediaUrls);
    for (const url of rawMediaUrls) {
      pushCandidate(url, 'socialPreview');
    }
  }

  return candidates;
}

function selectPreviewMediaForComponentsV2(candidates, sourceUrl, logger = null, messageId = null) {
  const rejected = [];
  const deduped = [];
  const seenNormalized = new Set();

  for (const candidate of candidates) {
    if (!candidate?.url) {
      continue;
    }

    if (seenNormalized.has(candidate.normalizedUrl)) {
      rejected.push({ ...candidate, reason: 'duplicate_normalized_url' });
      continue;
    }

    seenNormalized.add(candidate.normalizedUrl);
    deduped.push(candidate);
  }

  const isTwitterStatus = Boolean(extractTwitterStatusId(sourceUrl));
  const nonLogo = deduped.filter((candidate) => candidate.kind !== 'logo');
  const selected = [];

  if (isTwitterStatus) {
    const groupedByPath = new Map();
    for (const candidate of nonLogo) {
      const key = candidate.normalizedUrl;
      const existing = groupedByPath.get(key);
      if (!existing || candidate.priority > existing.priority) {
        if (existing) {
          rejected.push({ ...existing, reason: 'twitter_lower_priority_duplicate' });
        }
        groupedByPath.set(key, candidate);
      } else {
        rejected.push({ ...candidate, reason: 'twitter_lower_priority_duplicate' });
      }
    }

    const values = Array.from(groupedByPath.values());
    const playableVideo = values.find((candidate) => candidate.kind === 'video');
    const twitterThumbs = values.filter((candidate) => /twimg\.com/i.test(candidate.provider));
    const uniqueTwitterBases = new Map();

    for (const candidate of twitterThumbs) {
      let baseKey = candidate.normalizedUrl;
      try {
        const parsed = new URL(candidate.normalizedUrl);
        baseKey = `${parsed.hostname}${parsed.pathname}`;
      } catch {}

      const existing = uniqueTwitterBases.get(baseKey);
      if (!existing || candidate.priority > existing.priority) {
        if (existing) {
          rejected.push({ ...existing, reason: 'twitter_duplicate_thumbnail_suppressed' });
        }
        uniqueTwitterBases.set(baseKey, candidate);
      } else {
        rejected.push({ ...candidate, reason: 'twitter_duplicate_thumbnail_suppressed' });
      }
    }

    if (playableVideo) {
      selected.push(playableVideo);
      logger?.info?.('twitter playable video unavailable fallback', {
        sourceMessageId: messageId,
        twitterVideoCandidateFound: true,
        twitterSelectedMediaKind: 'video'
      });
    } else {
      const twitterCandidates = Array.from(uniqueTwitterBases.values()).sort((left, right) => right.priority - left.priority);
      const mediaStyleCandidates = twitterCandidates.filter((candidate) => /\/media\//i.test(candidate.normalizedUrl));
      const thumbStyleCandidates = twitterCandidates.filter((candidate) => !/\/media\//i.test(candidate.normalizedUrl));
      const finalTwitterSelection = mediaStyleCandidates.length ? mediaStyleCandidates : thumbStyleCandidates.slice(0, 1);
      selected.push(...finalTwitterSelection);
      logger?.info?.('twitter playable video unavailable fallback', {
        sourceMessageId: messageId,
        twitterVideoCandidateFound: false,
        twitterSelectedMediaKind: finalTwitterSelection.length > 1 ? 'images' : finalTwitterSelection[0]?.kind || 'none'
      });
    }
  } else if (getGifProviderName(sourceUrl)) {
    const bestGifCandidate = [...nonLogo].sort((left, right) => right.priority - left.priority)[0];
    if (bestGifCandidate) {
      selected.push(bestGifCandidate);
    }
  } else {
    const bestCandidate = [...nonLogo].sort((left, right) => right.priority - left.priority)[0];
    if (bestCandidate) {
      selected.push(bestCandidate);
    }
  }

  logger?.info?.('preview media candidates collected', {
    sourceMessageId: messageId,
    sourceUrl,
    candidates: candidates.map((candidate) => ({
      url: candidate.url,
      source: candidate.source,
      kind: candidate.kind,
      priority: candidate.priority
    })),
    rejected: rejected.map((candidate) => ({
      url: candidate.url,
      source: candidate.source,
      kind: candidate.kind,
      reason: candidate.reason
    })),
    selectedMediaCount: selected.length,
    selectedUrls: selected.map((candidate) => candidate.url)
  });

  if (isTwitterStatus) {
    logger?.info?.('twitter media candidates grouped', {
      sourceMessageId: messageId,
      statusId: extractTwitterStatusId(sourceUrl),
      candidateCount: candidates.length,
      selectedMediaCount: selected.length
    });
    if (rejected.some((candidate) => candidate.reason === 'twitter_duplicate_thumbnail_suppressed')) {
      logger?.info?.('twitter duplicate thumbnail suppressed', {
        sourceMessageId: messageId,
        suppressedCount: rejected.filter((candidate) => candidate.reason === 'twitter_duplicate_thumbnail_suppressed').length
      });
    }
    if (rejected.some((candidate) => candidate.kind === 'logo')) {
      logger?.info?.('twitter logo suppressed', {
        sourceMessageId: messageId,
        suppressedCount: rejected.filter((candidate) => candidate.kind === 'logo').length
      });
    }
  }

  return selected;
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

function extractSocialPreviewFromEmbeds(embeds, sourceUrl = null, logger = null, messageId = null) {
  let primaryPreview = null;
  const gifProvider = getGifProviderName(sourceUrl);
  const candidates = collectPreviewMediaCandidates(embeds, sourceUrl);
  const selectedCandidates = selectPreviewMediaForComponentsV2(candidates, sourceUrl, logger, messageId);

  for (const embed of embeds || []) {
    const imageUrl = pickPreviewImage(embed);
    const description = embed.description?.trim() || null;
    const title = embed.title?.trim() || embed.author?.name?.trim() || null;
    const embedSourceUrl = embed.url || null;
    const siteName = embed.provider?.name || embed.author?.name || null;

    if (!primaryPreview && (title || description || selectedCandidates.length)) {
      primaryPreview = {
        title,
        description,
        imageUrl: imageUrl || selectedCandidates.find((candidate) => candidate.kind !== 'video')?.url || null,
        imageUrls: [],
        sourceUrl: embedSourceUrl,
        siteName
      };
    }
  }

  if (!primaryPreview && !selectedCandidates.length) {
    return null;
  }

  const finalMediaUrls = selectedCandidates.map((candidate) => candidate.url);
  const finalImageUrls = selectedCandidates
    .filter((candidate) => candidate.kind !== 'video')
    .map((candidate) => candidate.url);

  return {
    title: primaryPreview?.title || null,
    description: primaryPreview?.description || null,
    imageUrl: primaryPreview?.imageUrl || finalImageUrls[0] || null,
    imageUrls: finalImageUrls,
    mediaUrls: finalMediaUrls,
    sourceUrl: primaryPreview?.sourceUrl || null,
    siteName: primaryPreview?.siteName || null,
    isGifShare: isGifProviderUrl(sourceUrl) || finalMediaUrls.some((url) => looksLikeAnimatedMediaUrl(url)),
    gifProvider,
    duplicateCount: Math.max(0, candidates.length - selectedCandidates.length)
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
      const preview = extractSocialPreviewFromEmbeds(workingMessage.embeds, socialLink, logger, message.id);

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
        logger.info('twitter status detected', {
          sourceMessageId: message.id,
          statusId: extractTwitterStatusId(socialLink),
          selectedMediaKind: preview.mediaUrls?.length ? (/\.(mp4|webm)(?:[?#].*)?$/i.test(preview.mediaUrls[0]) ? 'video' : 'image') : 'none'
        });
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

function extractCustomEmojiMedia(content) {
  const rawContent = String(content || '');
  const tokenPattern = /<(?:(a)?):([A-Za-z0-9_]{2,32}):(\d+)>/g;
  const tokens = [];
  const seenIds = new Set();

  let match;
  while ((match = tokenPattern.exec(rawContent)) !== null) {
    const [, animatedFlag, name, id] = match;
    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    tokens.push({
      token: match[0],
      name,
      id,
      animated: Boolean(animatedFlag),
      url: `https://cdn.discordapp.com/emojis/${id}.${animatedFlag ? 'gif' : 'png'}`
    });
  }

  if (!tokens.length) {
    return {
      content: rawContent,
      mediaItems: [],
      tokens,
      hasNonEmojiText: Boolean(rawContent.trim())
    };
  }

  const strippedContent = rawContent
    .replace(tokenPattern, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return {
    content: strippedContent,
    mediaItems: tokens.map((token) => ({
      url: token.url,
      description: `${token.name} emoji`
    })),
    tokens,
    hasNonEmojiText: Boolean(strippedContent)
  };
}

function logAttachmentMetadata(logger, messageId, label, attachment, messageJsonAttachments = null) {
  const attachmentJson = typeof attachment?.toJSON === 'function' ? attachment.toJSON() : null;

  logger?.info?.('Attachment raw metadata observed', {
    sourceMessageId: messageId,
    metadataLabel: label,
    attachmentId: String(attachment?.id || ''),
    attachmentName: attachment?.name || null,
    attachmentFilename: attachment?.filename || null,
    attachmentTitle: attachment?.title || null,
    attachmentDescription: attachment?.description || null,
    attachmentUrl: attachment?.url ? String(attachment.url).slice(0, 240) : null,
    attachmentProxyUrl: attachment?.proxyURL ? String(attachment.proxyURL).slice(0, 240) : null,
    contentType: attachment?.contentType || null,
    size: Number(attachment?.size || 0),
    attachmentKeys: attachment ? Object.keys(attachment) : [],
    attachmentJson,
    messageJsonAttachment: messageJsonAttachments?.find?.((entry) => String(entry?.id || '') === String(attachment?.id || '')) || null
  });
}

async function fetchCanonicalMessage(message, logger) {
  try {
    return await message.channel.messages.fetch(message.id, { force: true });
  } catch (error) {
    logger?.info?.('Canonical message fetch failed; using gateway message snapshot', {
      sourceMessageId: message.id,
      error: error.message
    });
    return message;
  }
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

async function extractFirstPost(thread, config, logger, options = {}) {
  const starterMessage = await getStarterMessage(thread, logger);

  if (!starterMessage) {
    return null;
  }

  const fetchedStarterMessage = await fetchCanonicalMessage(starterMessage, logger);
  const guildMember =
    fetchedStarterMessage.member ||
    (fetchedStarterMessage.author
      ? await thread.guild.members.fetch(fetchedStarterMessage.author.id).catch(() => null)
      : null);
  const normalizedTitle = normalizeQuestionTitle(
    thread.name || '',
    config.questions?.resolvedPrefix
  );
  const explicitQuestionStatus = options.questionStatusOverride || null;
  const explicitResolved =
    explicitQuestionStatus === 'resolved'
      ? true
      : explicitQuestionStatus === 'open'
        ? false
        : normalizedTitle.isResolved;
  const imageAttachments = config.timeline.includeFirstImage
    ? findImageAttachments(fetchedStarterMessage.attachments)
    : [];
  const attachments = normalizeAttachments(fetchedStarterMessage.attachments, {
    sourceContent: fetchedStarterMessage.content || starterMessage.content || '',
    logger,
    sourceMessageId: fetchedStarterMessage.id
  });
  const firstImage = config.timeline.includeFirstImage
    ? findFirstImageAttachment(fetchedStarterMessage.attachments)
    : null;
  const firstVideo = findFirstVideoAttachment(fetchedStarterMessage.attachments);
  const socialPreview = await getSocialPreviewData(fetchedStarterMessage, logger);
  const knowledgeTagLabels = getKnowledgeTagLabels(thread);

  const starterMessageJsonAttachments = typeof starterMessage.toJSON === 'function'
    ? starterMessage.toJSON()?.attachments || []
    : [];
  const fetchedStarterMessageJsonAttachments = typeof fetchedStarterMessage.toJSON === 'function'
    ? fetchedStarterMessage.toJSON()?.attachments || []
    : [];

  for (const attachment of starterMessage.attachments.values()) {
    logAttachmentMetadata(logger, starterMessage.id, 'gateway', attachment, starterMessageJsonAttachments);
  }

  for (const attachment of fetchedStarterMessage.attachments.values()) {
    logAttachmentMetadata(logger, starterMessage.id, 'fetched', attachment, fetchedStarterMessageJsonAttachments);
  }

  return {
    message: fetchedStarterMessage,
    messageId: fetchedStarterMessage.id,
    createdAt: fetchedStarterMessage.createdAt || starterMessage.createdAt || new Date(),
    author: fetchedStarterMessage.author || starterMessage.author || null,
    displayName:
      guildMember?.displayName ||
      fetchedStarterMessage.author?.globalName ||
      fetchedStarterMessage.author?.username ||
      '不明なユーザー',
    avatarUrl:
      guildMember?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      fetchedStarterMessage.author?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      null,
    rawTitle: thread.name || '',
    title: normalizedTitle.title || '',
    isResolved: explicitResolved,
    content: fetchedStarterMessage.content || starterMessage.content || '',
    jumpUrl: getMessageJumpUrl({
      guildId: thread.guildId,
      channelId: thread.id,
      messageId: fetchedStarterMessage.id
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
  const canonicalMessage = await fetchCanonicalMessage(message, logger);
  const thread = canonicalMessage.channel;
  const guildMember =
    canonicalMessage.member ||
    (canonicalMessage.author ? await thread.guild.members.fetch(canonicalMessage.author.id).catch(() => null) : null);
  const imageAttachments = config.timeline.includeFirstImage
    ? findImageAttachments(canonicalMessage.attachments)
    : [];
  const attachments = normalizeAttachments(canonicalMessage.attachments, {
    sourceContent: canonicalMessage.content || message.content || '',
    logger,
    sourceMessageId: canonicalMessage.id
  });
  const firstImage = config.timeline.includeFirstImage
    ? findFirstImageAttachment(canonicalMessage.attachments)
    : null;
  const firstVideo = findFirstVideoAttachment(canonicalMessage.attachments);
  const gatewayMessageJsonAttachments = typeof message.toJSON === 'function'
    ? message.toJSON()?.attachments || []
    : [];
  const fetchedMessageJsonAttachments = typeof canonicalMessage.toJSON === 'function'
    ? canonicalMessage.toJSON()?.attachments || []
    : [];

  for (const attachment of message.attachments.values()) {
    logAttachmentMetadata(logger, message.id, 'gateway', attachment, gatewayMessageJsonAttachments);
  }
  for (const attachment of canonicalMessage.attachments.values()) {
    logAttachmentMetadata(logger, message.id, 'fetched', attachment, fetchedMessageJsonAttachments);
  }

  const socialPreview = logger ? await getSocialPreviewData(canonicalMessage, logger) : null;
  const threadOwnerInfo = await getThreadOwnerInfo(thread, logger);
  const restoredContent = restoreCustomEmojiTokens(canonicalMessage.content || message.content || '', thread.guild);
  const hashtagRouting = parseBotHashtagRoutes(restoredContent, config.botHashtagRoutes);
  const strippedContent = stripPreviewedGifLinks(hashtagRouting.content, socialPreview);
  const customEmojiMedia = extractCustomEmojiMedia(strippedContent.content);
  const { referencedSourceMessageId, replyContext } = await getReplyContext(message, logger);
  const displayName =
    guildMember?.displayName ||
    canonicalMessage.author?.globalName ||
    canonicalMessage.author?.username ||
    '不明なユーザー';

  logger?.info?.('Message content prepared for relay', {
    sourceMessageId: message.id,
    contentSource: 'message.content',
    rawContent: String(canonicalMessage.content || message.content || '').slice(0, 500),
    cleanContent: String(canonicalMessage.cleanContent || message.cleanContent || '').slice(0, 500),
    extractedBodyText: String(hashtagRouting.content || '').slice(0, 500),
    finalBodyText: String(strippedContent.content || '').slice(0, 500),
    finalBodyTextAfterEmojiProcessing: String(customEmojiMedia.content || '').slice(0, 500),
    bodyUrlHidden: strippedContent.bodyUrlHidden,
    customEmojiTokensFound: customEmojiMedia.tokens.map((token) => token.token),
    customEmojiIds: customEmojiMedia.tokens.map((token) => token.id),
    generatedEmojiMediaUrls: customEmojiMedia.mediaItems.map((item) => item.url),
    hasNonEmojiText: customEmojiMedia.hasNonEmojiText,
    emojiOnly: customEmojiMedia.tokens.length > 0 && !customEmojiMedia.hasNonEmojiText,
    emojiMediaFallbackEnabled: customEmojiMedia.tokens.length > 0,
    removedEmojiTokensFromBody: customEmojiMedia.tokens.length > 0,
    customEmojiTokensPreserved: /<a?:\w+:\d+>/.test(strippedContent.content || ''),
    originalContentHadCustomEmojiToken: /<a?:\w+:\d+>/.test(canonicalMessage.content || message.content || ''),
    usedCleanContent: false
  });

  return {
    message: canonicalMessage,
    messageId: canonicalMessage.id,
    createdAt: canonicalMessage.createdAt || message.createdAt || new Date(),
    author: canonicalMessage.author || message.author || null,
    displayName,
    avatarUrl:
      guildMember?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      canonicalMessage.author?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      null,
    timelineHeadline: buildTweetHeadline(displayName, threadOwnerInfo, canonicalMessage.author?.id || null, {
      isReply: Boolean(referencedSourceMessageId)
    }),
    threadOwnerId: threadOwnerInfo?.id || null,
    threadOwnerDisplayName: threadOwnerInfo?.displayName || null,
    referencedSourceMessageId,
    replyContext,
    title: '',
    rawTitle: thread.name || '',
    isResolved: false,
    content: customEmojiMedia.content,
    customEmojiMediaItems: customEmojiMedia.mediaItems,
    matchedBotHashtagRoutes: hashtagRouting.matchedRoutes,
    displayBotHashtags: hashtagRouting.displayTags,
    jumpUrl: getMessageJumpUrl({
      guildId: thread.guildId,
      channelId: thread.id,
      messageId: canonicalMessage.id
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

async function extractPlainMessagePost(message, config, logger = null) {
  const canonicalMessage = await fetchCanonicalMessage(message, logger);
  const guild = canonicalMessage.guild || message.guild;
  const guildMember =
    canonicalMessage.member ||
    (canonicalMessage.author && guild
      ? await guild.members.fetch(canonicalMessage.author.id).catch(() => null)
      : null);
  const imageAttachments = config.timeline.includeFirstImage
    ? findImageAttachments(canonicalMessage.attachments)
    : [];
  const attachments = normalizeAttachments(canonicalMessage.attachments, {
    sourceContent: canonicalMessage.content || message.content || '',
    logger,
    sourceMessageId: canonicalMessage.id
  });
  const firstImage = config.timeline.includeFirstImage
    ? findFirstImageAttachment(canonicalMessage.attachments)
    : null;
  const firstVideo = findFirstVideoAttachment(canonicalMessage.attachments);
  const socialPreview = logger ? await getSocialPreviewData(canonicalMessage, logger) : null;
  const restoredContent = restoreCustomEmojiTokens(canonicalMessage.content || message.content || '', guild);
  const globalRouting = parseGlobalHashtagRoutes(restoredContent, config.globalHashtagRoutes);
  const hashtagRouting = parseBotHashtagRoutes(globalRouting.content, config.botHashtagRoutes);
  const strippedContent = stripPreviewedGifLinks(hashtagRouting.content, socialPreview);
  const customEmojiMedia = extractCustomEmojiMedia(strippedContent.content);
  const displayName =
    guildMember?.displayName ||
    canonicalMessage.author?.globalName ||
    canonicalMessage.author?.username ||
    '不明なユーザー';

  const displayBotHashtags = [...new Set([...(globalRouting.displayTags || []), ...(hashtagRouting.displayTags || [])])];
  if (logger && globalRouting.displayTags.length) {
    logger.info('route display tag resolved', {
      sourceMessageId: canonicalMessage.id,
      detectedTags: globalRouting.detectedTags,
      normalizedDisplayTags: globalRouting.displayTags,
      displayMode: Array.from(new Set(globalRouting.matchedRoutes.map((routeKey) => config.globalHashtagRoutes?.[routeKey]?.displayMode || 'displayTag'))),
      rawPrefixRemoved: globalRouting.content !== restoredContent,
      normalizedHashtagInserted: true,
      finalBodyText: String(customEmojiMedia.content || '').slice(0, 500),
      finalDisplayBotHashtags: displayBotHashtags
    });
  }

  return {
    message: canonicalMessage,
    messageId: canonicalMessage.id,
    createdAt: canonicalMessage.createdAt || message.createdAt || new Date(),
    author: canonicalMessage.author || message.author || null,
    displayName,
    avatarUrl:
      guildMember?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      canonicalMessage.author?.displayAvatarURL?.({ extension: 'png', size: 128 }) ||
      null,
    timelineHeadline: `${displayName} さんが投稿しました`,
    referencedSourceMessageId: null,
    replyContext: null,
    title: '',
    rawTitle: '',
    isResolved: false,
    content: customEmojiMedia.content,
    customEmojiMediaItems: customEmojiMedia.mediaItems,
    matchedBotHashtagRoutes: hashtagRouting.matchedRoutes,
    displayBotHashtags,
    jumpUrl: getMessageJumpUrl({
      guildId: canonicalMessage.guildId || (guild ? guild.id : ''),
      channelId: canonicalMessage.channelId,
      messageId: canonicalMessage.id
    }),
    attachments,
    imageUrls: imageAttachments.map((attachment) => attachment.url),
    firstImageUrl: firstImage?.url || null,
    firstVideoUrl: firstVideo?.url || null,
    firstVideoName: firstVideo?.name || null,
    socialPreview,
    threadId: null,
    parentChannelId: null,
    forumName: canonicalMessage.channel?.name || 'チャンネル',
    parentChannelName: null
  };
}

module.exports = {
  extractFirstPost,
  extractThreadMessagePost,
  extractPlainMessagePost
};
