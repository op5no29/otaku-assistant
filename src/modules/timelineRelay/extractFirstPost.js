const { setTimeout: sleep } = require('node:timers/promises');
const { getMessageJumpUrl } = require('../../services/discordLinks');
const {
  findImageAttachments,
  findFirstImageAttachment,
  findFirstVideoAttachment,
  normalizeAttachments,
  parseRelayHashtagPrefixes,
  restoreCustomEmojiTokens
} = require('../../utils/text');

const QUESTION_FORUM_LABELS = {
  '1224771331623485440': '映像制作全般',
  '1230488742737875005': 'DTM',
  '1230488769145081916': 'メディアアート',
  '1230488840444186714': 'CG',
  '1230488869519229009': '個人開発'
};

const QUESTION_CATEGORY_LABELS = {
  '1230488177232445550': '個人開発'
};

const PREVIEW_IMAGE_VALIDATION_TIMEOUT_MS = 6_000;
const PREVIEW_IMAGE_VALIDATION_PREFIX_BYTES = 4_096;
const MAX_PREVIEW_IMAGE_VALIDATION_CANDIDATES = 8;
const YOUTUBE_OEMBED_TIMEOUT_MS = 4_000;
const PREVIEW_IMAGE_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 compatible preview fetcher',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8'
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
  const categoryId = String(thread.parent?.parentId || thread.parent?.parent?.id || '');
  if (QUESTION_CATEGORY_LABELS[categoryId]) {
    return QUESTION_CATEGORY_LABELS[categoryId];
  }

  const categoryName = thread.parent?.parent?.name?.trim();

  if (categoryName && !categoryName.includes('質問場所')) {
    return categoryName.replace(/ゲーム開発/gu, '個人開発');
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

function isYoutubeLikeUrl(url) {
  return /(?:youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com)/i.test(String(url || ''));
}

function cleanUrlToken(value) {
  return String(value || '')
    .trim()
    .replace(/[.,、。!?！？;；]+$/u, '');
}

function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(cleanUrlToken(value));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = null;
    if (host === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || null;
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host.endsWith('.youtube.com')) {
      if (parsed.pathname === '/watch') {
        videoId = parsed.searchParams.get('v') || null;
      } else {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live'].includes(parts[0])) {
          videoId = parts[1] || null;
        }
      }
    }

    if (!videoId || !/^[A-Za-z0-9_-]{6,64}$/u.test(videoId)) {
      return null;
    }
    return videoId;
  } catch {
    return null;
  }
}

function getYouTubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function isWeakYouTubeTitle(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    !normalized ||
    normalized === 'youtube' ||
    normalized === 'youtube.com' ||
    normalized === 'youtu.be' ||
    /^[-–—|•\s]*youtube$/u.test(normalized)
  );
}

function isSoundCloudSourceUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'on.soundcloud.com' || host.endsWith('soundcloud.com');
  } catch {
    return false;
  }
}

function isSoundCloudPlayerUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'w.soundcloud.com' ||
      (host.endsWith('soundcloud.com') && /\/player\b/i.test(parsed.pathname)) ||
      (host.endsWith('soundcloud.com') && /\/player[/?#]/i.test(String(url || '')))
    );
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizePreviewImageUrl(rawUrl, baseUrl = null) {
  const rawValue = String(rawUrl || '');
  const decoded = decodeHtmlEntities(rawValue).trim().replace(/^["']|["']$/g, '');
  if (!decoded) {
    return {
      rawUrl: rawValue,
      normalizedUrl: null,
      urlShape: 'empty',
      absolute: false,
      rejectionReason: 'empty_url'
    };
  }

  let candidate = decoded;
  let urlShape = 'absolute';

  try {
    if (/^\/\//u.test(candidate)) {
      candidate = `https:${candidate}`;
      urlShape = 'protocol_relative';
    } else if (/^\//u.test(candidate)) {
      urlShape = 'relative';
      if (!baseUrl) {
        return {
          rawUrl: rawValue,
          normalizedUrl: null,
          urlShape,
          absolute: false,
          rejectionReason: 'relative_url_without_base'
        };
      }
      candidate = new URL(candidate, baseUrl).toString();
    } else if (!/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) {
      urlShape = 'relative';
      if (!baseUrl) {
        return {
          rawUrl: rawValue,
          normalizedUrl: null,
          urlShape,
          absolute: false,
          rejectionReason: 'relative_url_without_base'
        };
      }
      candidate = new URL(candidate, baseUrl).toString();
    }

    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        rawUrl: rawValue,
        normalizedUrl: null,
        urlShape,
        absolute: false,
        rejectionReason: 'invalid_scheme',
        scheme: parsed.protocol
      };
    }
    parsed.hash = '';

    return {
      rawUrl: rawValue,
      normalizedUrl: parsed.toString(),
      urlShape,
      absolute: true,
      rejectionReason: null,
      scheme: parsed.protocol
    };
  } catch (error) {
    return {
      rawUrl: rawValue,
      normalizedUrl: null,
      urlShape,
      absolute: false,
      rejectionReason: 'invalid_url',
      error: error.message
    };
  }
}

function isPreviewMediaUrl(url) {
  return looksLikePreviewImageUrl(url) || looksLikeAnimatedMediaUrl(url);
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLikelyDiscordEmbedImageCandidate(candidate) {
  if (!candidate?.url || !isHttpUrl(candidate.url)) {
    return false;
  }
  if (isSoundCloudPlayerUrl(candidate.url)) {
    return false;
  }
  return /embed\.(?:image|thumbnail)$/i.test(String(candidate.source || ''));
}

function isPreviewCandidateUsableAsMedia(candidate) {
  if (!candidate?.url || isSoundCloudPlayerUrl(candidate.url)) {
    return false;
  }
  if (isPreviewMediaUrl(candidate.url)) {
    return true;
  }
  if (/(?:^|\.)(?:image|thumbnail|photo|og:image|twitter:image|image:secure_url)(?:$|\.)/i.test(String(candidate.source || '')) && isHttpUrl(candidate.url)) {
    return true;
  }
  return isLikelyDiscordEmbedImageCandidate(candidate);
}

function hasPreviewMediaExtension(url) {
  return /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v|svg)(?:[?#].*)?$/i.test(String(url || ''));
}

function isDiscordProxyImageUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'media.discordapp.net' || /^images-ext-\d+\.discordapp\.net$/i.test(host);
  } catch {
    return false;
  }
}

function inferContentTypeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return null;
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && /^GIF8[79]a/u.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const asciiPrefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart().toLowerCase();
  if (asciiPrefix.startsWith('<svg') || asciiPrefix.startsWith('<?xml')) {
    return 'image/svg+xml';
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'video/mp4';
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'video/webm';
  }
  return null;
}

function extensionForContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'video/mp4') return 'mp4';
  if (normalized === 'video/webm') return 'webm';
  return null;
}

function isRenderablePreviewContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  return normalized.startsWith('image/') || normalized.startsWith('video/');
}

function shouldReuploadPreviewCandidate(candidate, validation) {
  const finalUrl = validation?.finalUrl || candidate?.url;
  const contentType = String(validation?.contentType || '').toLowerCase();
  if (!String(contentType).startsWith('image/')) {
    return false;
  }
  if (isDiscordProxyImageUrl(finalUrl)) {
    return false;
  }
  return !hasPreviewMediaExtension(finalUrl);
}

async function readResponsePrefix(response, maxBytes = PREVIEW_IMAGE_VALIDATION_PREFIX_BYTES) {
  if (!response?.body?.getReader) {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).subarray(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const buffer = Buffer.from(value);
      chunks.push(buffer);
      total += buffer.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).subarray(0, maxBytes);
}

async function fetchPreviewImageCandidate(url, method) {
  const headers = {
    ...PREVIEW_IMAGE_FETCH_HEADERS
  };
  if (method === 'GET') {
    headers.Range = `bytes=0-${PREVIEW_IMAGE_VALIDATION_PREFIX_BYTES - 1}`;
  }

  return fetch(url, {
    method,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(PREVIEW_IMAGE_VALIDATION_TIMEOUT_MS)
  });
}

function buildValidationResultFromResponse(candidate, response, method, prefixBuffer = null) {
  const headerContentType = response.headers.get('content-type') || null;
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  const magicContentType = prefixBuffer ? inferContentTypeFromMagic(prefixBuffer) : null;
  const contentType = headerContentType || magicContentType;
  const finalUrl = response.url || candidate.url;

  if (!response.ok && response.status !== 206) {
    return {
      ok: false,
      method,
      httpStatus: response.status,
      finalUrl,
      contentType,
      contentLength,
      redirected: finalUrl !== candidate.url,
      failureReason: 'http_status'
    };
  }

  if (!isRenderablePreviewContentType(contentType)) {
    return {
      ok: false,
      method,
      httpStatus: response.status,
      finalUrl,
      contentType,
      contentLength,
      redirected: finalUrl !== candidate.url,
      failureReason: String(contentType || '').toLowerCase().startsWith('text/html')
        ? 'html_content'
        : 'unsupported_content_type'
    };
  }

  return {
    ok: true,
    method,
    httpStatus: response.status,
    finalUrl,
    contentType,
    headerContentType,
    magicContentType,
    contentLength,
    redirected: finalUrl !== candidate.url,
    extension: extensionForContentType(contentType),
    requiresReupload: shouldReuploadPreviewCandidate(candidate, {
      finalUrl,
      contentType
    })
  };
}

async function validatePreviewImageCandidate(candidate, logger = null, context = {}) {
  const logBase = {
    sourceMessageId: context.messageId || null,
    sourceUrl: context.sourceUrl || candidate.sourceUrl || null,
    rawUrl: candidate.rawUrl || candidate.url || null,
    normalizedUrl: candidate.url || null,
    sourceType: candidate.source,
    priority: candidate.priority
  };

  logger?.info?.('preview image candidate validation started', logBase);

  let headResult = null;
  try {
    const headResponse = await fetchPreviewImageCandidate(candidate.url, 'HEAD');
    headResult = buildValidationResultFromResponse(candidate, headResponse, 'HEAD');
    if (headResult.ok && headResult.contentType) {
      const result = {
        ...headResult,
        requiresReupload: shouldReuploadPreviewCandidate(candidate, headResult)
      };
      logger?.info?.('preview image candidate validation succeeded', {
        ...logBase,
        finalUrl: result.finalUrl,
        httpStatus: result.httpStatus,
        contentType: result.contentType,
        contentLength: result.contentLength,
        validationMethod: result.method,
        requiresReupload: result.requiresReupload,
        selected: false
      });
      return result;
    }
  } catch (error) {
    headResult = {
      ok: false,
      method: 'HEAD',
      failureReason: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'request_failed',
      error: error.message
    };
  }

  try {
    const getResponse = await fetchPreviewImageCandidate(candidate.url, 'GET');
    const prefix = await readResponsePrefix(getResponse);
    const getResult = buildValidationResultFromResponse(candidate, getResponse, 'GET', prefix);
    if (getResult.ok) {
      const result = {
        ...getResult,
        requiresReupload: shouldReuploadPreviewCandidate(candidate, getResult)
      };
      logger?.info?.('preview image candidate validation succeeded', {
        ...logBase,
        finalUrl: result.finalUrl,
        httpStatus: result.httpStatus,
        contentType: result.contentType,
        contentLength: result.contentLength,
        validationMethod: result.method,
        requiresReupload: result.requiresReupload,
        selected: false
      });
      return result;
    }

    logger?.info?.('preview image candidate validation failed', {
      ...logBase,
      finalUrl: getResult.finalUrl,
      httpStatus: getResult.httpStatus,
      contentType: getResult.contentType,
      contentLength: getResult.contentLength,
      validationMethod: getResult.method,
      failureReason: getResult.failureReason,
      headFailureReason: headResult?.failureReason || null,
      selected: false
    });
    return getResult;
  } catch (error) {
    const failureReason = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'request_failed';
    logger?.info?.('preview image candidate validation failed', {
      ...logBase,
      finalUrl: null,
      httpStatus: null,
      contentType: null,
      contentLength: null,
      validationMethod: 'GET',
      failureReason,
      headFailureReason: headResult?.failureReason || null,
      error: error.message,
      selected: false
    });
    return {
      ok: false,
      method: 'GET',
      failureReason,
      error: error.message
    };
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
  if (isYoutubeLikeUrl(candidate.url || candidate.sourceUrl) && (candidate.kind === 'image' || candidate.kind === 'thumbnail')) {
    return 85;
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
  if (isYoutubeLikeUrl(value)) {
    return false;
  }
  return /abs\.twimg\.com|favicon|icon|logo|profile_images/i.test(value);
}

function buildPreviewCandidate(url, source, sourceUrl) {
  if (!url) {
    return null;
  }

  const normalized = normalizePreviewImageUrl(url, sourceUrl);
  if (!normalized.normalizedUrl) {
    return {
      rawUrl: url,
      url: null,
      normalizedUrl: null,
      kind: 'invalid',
      source,
      provider: '',
      sourceUrl: sourceUrl || null,
      priority: 0,
      twitterStatusId: extractTwitterStatusId(sourceUrl),
      urlShape: normalized.urlShape,
      absolute: normalized.absolute,
      normalizationError: normalized.rejectionReason,
      normalizationErrorDetail: normalized.error || null
    };
  }

  const normalizedUrl = normalized.normalizedUrl;
  const provider = getPreviewProvider(normalizedUrl || sourceUrl);
  const kind = looksLikeLogoCandidate(normalizedUrl) ? 'logo' : inferCandidateKind(normalizedUrl, source);
  let priority = inferCandidatePriority({ kind, url: normalizedUrl, sourceUrl });
  if (/embed\.image$/i.test(source)) {
    priority = Math.max(priority, 95);
  } else if (/embed\.thumbnail$/i.test(source)) {
    priority = Math.max(priority, 88);
  } else if (/twitter:image|og:image|image:secure_url/i.test(source)) {
    priority = Math.max(priority, 92);
  }
  if (/proxy/i.test(source) || isDiscordProxyImageUrl(normalizedUrl)) {
    priority -= 8;
  }

  return {
    rawUrl: url,
    url: normalizedUrl,
    normalizedUrl: normalizeMediaUrl(normalizedUrl),
    kind,
    source,
    provider,
    sourceUrl: sourceUrl || null,
    priority,
    twitterStatusId: extractTwitterStatusId(sourceUrl),
    urlShape: normalized.urlShape,
    absolute: normalized.absolute,
    normalizationError: null
  };
}

function buildYouTubeThumbnailCandidates(sourceUrl, logger = null, messageId = null) {
  const videoId = extractYouTubeVideoId(sourceUrl);
  if (!videoId) {
    return [];
  }

  logger?.info?.('youtube video id extracted', {
    sourceMessageId: messageId,
    originalUrl: sourceUrl,
    videoId
  });

  const variants = [
    ['maxresdefault', 120],
    ['sddefault', 119],
    ['hqdefault', 118],
    ['mqdefault', 117],
    ['default', 116]
  ];
  const watchUrl = getYouTubeWatchUrl(videoId);
  return variants.map(([variant, priority]) => {
    const thumbnailUrl = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${variant}.jpg`;
    const candidate = buildPreviewCandidate(thumbnailUrl, `youtube.thumbnail.${variant}`, watchUrl);
    if (!candidate) {
      return null;
    }
    candidate.priority = priority;
    candidate.kind = 'thumbnail';
    candidate.videoId = videoId;
    logger?.info?.('link preview image candidate found', {
      sourceMessageId: messageId,
      sourceUrl,
      rawUrl: thumbnailUrl,
      normalizedUrl: candidate.url,
      sourceType: candidate.source,
      priority: candidate.priority,
      videoId
    });
    return candidate;
  }).filter(Boolean);
}

function collectPreviewMediaCandidates(embeds, sourceUrl = null) {
  const candidates = [];

  for (const embed of embeds || []) {
    const pushCandidate = (url, source) => {
      const candidate = buildPreviewCandidate(url, source, sourceUrl || embed.url || null);
      if (candidate) {
        if (isYoutubeLikeUrl(sourceUrl || embed.url || url)) {
          candidate.priority = Math.max(candidate.priority, candidate.kind === 'video' ? 100 : 85);
        }
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

    const rawMediaUrls = [];
    collectPreviewMediaUrlsFromRawEmbed(embed.data || embed, rawMediaUrls);
    const seenRawMediaUrls = new Set();
    for (const entry of rawMediaUrls) {
      const rawUrl = typeof entry === 'string' ? entry : entry?.url;
      if (!rawUrl || seenRawMediaUrls.has(rawUrl)) {
        continue;
      }
      seenRawMediaUrls.add(rawUrl);
      const key = typeof entry === 'object' ? entry.key : '';
      pushCandidate(rawUrl, key ? `socialPreview.${key.replace(/^\./u, '')}` : 'socialPreview');
    }
  }

  return candidates;
}

async function selectPreviewMediaForComponentsV2(candidates, sourceUrl, logger = null, messageId = null) {
  const rejected = [];
  const deduped = [];
  const seenNormalized = new Set();

  for (const candidate of candidates) {
    logger?.info?.('preview image candidate normalized', {
      sourceMessageId: messageId,
      sourceUrl,
      rawUrl: candidate?.rawUrl || candidate?.url || null,
      normalizedUrl: candidate?.url || null,
      sourceType: candidate?.source || null,
      urlShape: candidate?.urlShape || null,
      absolute: candidate?.absolute === true,
      failureReason: candidate?.normalizationError || null,
      priority: candidate?.priority || 0
    });

    if (!candidate?.url) {
      rejected.push({ ...candidate, reason: candidate?.normalizationError || 'invalid_url' });
      logger?.info?.('preview image candidate rejected', {
        sourceMessageId: messageId,
        sourceUrl,
        rawUrl: candidate?.rawUrl || null,
        normalizedUrl: null,
        sourceType: candidate?.source || null,
        failureReason: candidate?.normalizationError || 'invalid_url',
        selected: false
      });
      continue;
    }

    if (isSoundCloudPlayerUrl(candidate.url)) {
      rejected.push({ ...candidate, reason: 'soundcloud_player' });
      logger?.info?.('relay link preview image candidate rejected soundcloud_player', {
        sourceMessageId: messageId,
        sourceUrl,
        imageUrl: candidate.url,
        source: candidate.source,
        kind: candidate.kind
      });
      continue;
    }

    if (!isPreviewCandidateUsableAsMedia(candidate)) {
      rejected.push({ ...candidate, reason: 'non_image_url' });
      logger?.info?.('relay link preview image candidate rejected non_image_url', {
        sourceMessageId: messageId,
        sourceUrl,
        imageUrl: candidate.url,
        source: candidate.source,
        kind: candidate.kind
      });
      continue;
    }

    if (seenNormalized.has(candidate.normalizedUrl)) {
      rejected.push({ ...candidate, reason: 'duplicate_normalized_url' });
      logger?.info?.('preview image candidate rejected', {
        sourceMessageId: messageId,
        sourceUrl,
        rawUrl: candidate.rawUrl || candidate.url,
        normalizedUrl: candidate.url,
        sourceType: candidate.source,
        failureReason: 'duplicate_normalized_url',
        selected: false
      });
      continue;
    }

    seenNormalized.add(candidate.normalizedUrl);
    deduped.push(candidate);
  }

  const validationCandidates = [...deduped]
    .sort((left, right) => right.priority - left.priority)
    .slice(0, MAX_PREVIEW_IMAGE_VALIDATION_CANDIDATES);
  const validationCandidateKeys = new Set(validationCandidates.map((candidate) => candidate.normalizedUrl));
  const validatedDeduped = [];
  const isTwitterStatus = Boolean(extractTwitterStatusId(sourceUrl));
  const isYoutubeSource = isYoutubeLikeUrl(sourceUrl);

  const validationResults = await Promise.all(validationCandidates.map(async (candidate) => ({
    candidate,
    validation: await validatePreviewImageCandidate(candidate, logger, {
      messageId,
      sourceUrl
    })
  })));

  for (const { candidate, validation } of validationResults) {
    if (!validation.ok) {
      rejected.push({
        ...candidate,
        reason: validation.failureReason || 'validation_failed',
        validation
      });
      logger?.info?.('preview image candidate rejected', {
        sourceMessageId: messageId,
        sourceUrl,
        rawUrl: candidate.rawUrl || candidate.url,
        normalizedUrl: candidate.url,
        finalUrl: validation.finalUrl || null,
        sourceType: candidate.source,
        httpStatus: validation.httpStatus || null,
        contentType: validation.contentType || null,
        contentLength: validation.contentLength || null,
        failureReason: validation.failureReason || 'validation_failed',
        selected: false
      });
      if (isYoutubeSource && /^youtube\.thumbnail\./i.test(String(candidate.source || ''))) {
        logger?.info?.('youtube thumbnail candidate rejected', {
          sourceMessageId: messageId,
          originalUrl: sourceUrl,
          videoId: candidate.videoId || extractYouTubeVideoId(sourceUrl),
          thumbnailUrl: candidate.url,
          reason: validation.failureReason || 'validation_failed',
          httpStatus: validation.httpStatus || null,
          contentType: validation.contentType || null
        });
      }
      continue;
    }

    validatedDeduped.push({
      ...candidate,
      url: validation.finalUrl || candidate.url,
      normalizedUrl: normalizeMediaUrl(validation.finalUrl || candidate.url),
      validation,
      requiresReupload: validation.requiresReupload === true,
      extension: validation.extension || null
    });
  }

  for (const candidate of deduped) {
    if (!validationCandidateKeys.has(candidate.normalizedUrl)) {
      rejected.push({ ...candidate, reason: 'validation_candidate_limit' });
      logger?.info?.('preview image candidate rejected', {
        sourceMessageId: messageId,
        sourceUrl,
        rawUrl: candidate.rawUrl || candidate.url,
        normalizedUrl: candidate.url,
        sourceType: candidate.source,
        failureReason: 'validation_candidate_limit',
        selected: false
      });
    }
  }

  const nonLogo = validatedDeduped.filter((candidate) => candidate.kind !== 'logo');
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
  } else if (isSoundCloudSourceUrl(sourceUrl)) {
    const soundCloudArtwork = [...nonLogo]
      .filter((candidate) => !isSoundCloudPlayerUrl(candidate.url) && isPreviewMediaUrl(candidate.url))
      .sort((left, right) => right.priority - left.priority)[0];
    if (soundCloudArtwork) {
      selected.push(soundCloudArtwork);
      logger?.info?.('soundcloud artwork thumbnail selected', {
        sourceMessageId: messageId,
        sourceUrl,
        selectedUrl: soundCloudArtwork.url,
        selectedSource: soundCloudArtwork.source,
        selectedKind: soundCloudArtwork.kind
      });
    }
  } else if (isYoutubeSource) {
    const youtubeCandidates = [...nonLogo].filter((candidate) => isYoutubeLikeUrl(candidate.url) || isYoutubeLikeUrl(candidate.sourceUrl));
    const bestYoutubeCandidate = youtubeCandidates.sort((left, right) => right.priority - left.priority)[0]
      || [...nonLogo].sort((left, right) => right.priority - left.priority)[0];
    if (bestYoutubeCandidate) {
      selected.push(bestYoutubeCandidate);
      logger?.info?.('youtube thumbnail selected', {
        sourceMessageId: messageId,
        sourceUrl,
        selectedUrl: bestYoutubeCandidate.url,
        selectedKind: bestYoutubeCandidate.kind
      });
      logger?.info?.('youtube thumbnail candidate selected', {
        sourceMessageId: messageId,
        originalUrl: sourceUrl,
        videoId: bestYoutubeCandidate.videoId || extractYouTubeVideoId(sourceUrl),
        selectedThumbnailUrl: bestYoutubeCandidate.url,
        sourceType: bestYoutubeCandidate.source,
        reason: 'validated_candidate'
      });
    } else {
      logger?.info?.('youtube preview skipped reason', {
        sourceMessageId: messageId,
        sourceUrl,
        reason: 'no_candidate'
      });
      logger?.info?.('youtube thumbnail fallback exhausted', {
        sourceMessageId: messageId,
        originalUrl: sourceUrl,
        videoId: extractYouTubeVideoId(sourceUrl),
        reason: candidates.length ? 'no_valid_candidate' : 'no_candidate'
      });
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
      rawUrl: candidate.rawUrl || candidate.url,
      url: candidate.url,
      normalizedUrl: candidate.normalizedUrl,
      source: candidate.source,
      kind: candidate.kind,
      priority: candidate.priority,
      urlShape: candidate.urlShape,
      absolute: candidate.absolute === true
    })),
    rejected: rejected.map((candidate) => ({
      rawUrl: candidate.rawUrl || candidate.url,
      url: candidate.url,
      source: candidate.source,
      kind: candidate.kind,
      reason: candidate.reason,
      httpStatus: candidate.validation?.httpStatus || null,
      contentType: candidate.validation?.contentType || null
    })),
    selectedMediaCount: selected.length,
    selectedUrls: selected.map((candidate) => candidate.url)
  });

  for (const candidate of selected) {
    logger?.info?.('preview image candidate selected', {
      sourceMessageId: messageId,
      sourceUrl,
      rawUrl: candidate.rawUrl || candidate.url,
      normalizedUrl: candidate.normalizedUrl || candidate.url,
      finalUrl: candidate.validation?.finalUrl || candidate.url,
      sourceType: candidate.source,
      httpStatus: candidate.validation?.httpStatus || null,
      contentType: candidate.validation?.contentType || null,
      contentLength: candidate.validation?.contentLength || null,
      selected: true,
      requiresReupload: candidate.requiresReupload === true
    });
  }

  if (!selected.length && candidates.length) {
    logger?.info?.('preview image omitted no valid candidate', {
      sourceMessageId: messageId,
      sourceUrl,
      candidateCount: candidates.length,
      rejectedCount: rejected.length
    });
  }

  if (isYoutubeSource) {
    logger?.info?.('youtube embed preview candidate extracted', {
      sourceMessageId: messageId,
      sourceUrl,
      candidateCount: candidates.length,
      selectedMediaCount: selected.length
    });
  }

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

function looksLikeRawPreviewMediaValue(value) {
  const text = decodeHtmlEntities(String(value || '')).trim();
  if (!text || text.length > 2_000) {
    return false;
  }
  return (
    /^https?:\/\//i.test(text) ||
    /^\/\//u.test(text) ||
    /^\//u.test(text) ||
    /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v|svg)(?:[?#].*)?$/i.test(text) ||
    /[?&]format=(jpg|jpeg|png|webp|gif)\b/i.test(text)
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
      (looksLikeRawPreviewMediaValue(value) || looksLikePreviewImageUrl(value) || looksLikeAnimatedMediaUrl(value))
    ) {
      collector.push({
        url: value,
        key: context.key
      });
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

function extractHtmlAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  let match;
  while ((match = pattern.exec(String(tag || ''))) !== null) {
    attributes[String(match[1] || '').toLowerCase()] = decodeHtmlEntities(match[2] || match[3] || match[4] || '');
  }
  return attributes;
}

function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
  return match ? decodeHtmlEntities(match[1]).replace(/\s+/gu, ' ').trim() : null;
}

function collectHtmlPreviewMetadata(html, sourceUrl) {
  const metadata = {
    title: extractHtmlTitle(html),
    description: null,
    siteName: null,
    candidates: []
  };
  const imageMetaNames = new Set([
    'og:image',
    'og:image:url',
    'og:image:secure_url',
    'twitter:image',
    'twitter:image:src',
    'thumbnail',
    'image'
  ]);
  const titleMetaNames = new Set(['og:title', 'twitter:title']);
  const descriptionMetaNames = new Set(['description', 'og:description', 'twitter:description']);
  const siteNameMetaNames = new Set(['og:site_name', 'application-name']);
  const seenImageUrls = new Set();

  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = extractHtmlAttributes(match[0]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content || '';
    if (!key || !content) {
      continue;
    }

    if (titleMetaNames.has(key) && !metadata.title) {
      metadata.title = content.trim();
    }
    if (descriptionMetaNames.has(key) && !metadata.description) {
      metadata.description = content.trim();
    }
    if (siteNameMetaNames.has(key) && !metadata.siteName) {
      metadata.siteName = content.trim();
    }
    if (imageMetaNames.has(key) && !seenImageUrls.has(content)) {
      seenImageUrls.add(content);
      metadata.candidates.push(buildPreviewCandidate(content, `html.${key}`, sourceUrl));
    }
  }

  return metadata;
}

async function fetchHtmlPreviewMetadata(sourceUrl, logger = null, messageId = null) {
  if (!isHttpUrl(sourceUrl)) {
    return null;
  }

  try {
    const response = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 compatible preview fetcher',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PREVIEW_IMAGE_VALIDATION_TIMEOUT_MS)
    });
    const contentType = response.headers.get('content-type') || null;
    if (!response.ok) {
      logger?.info?.('preview html metadata fetch failed', {
        sourceMessageId: messageId,
        sourceUrl,
        httpStatus: response.status,
        contentType,
        failureReason: 'http_status'
      });
      return null;
    }
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      logger?.info?.('preview html metadata fetch failed', {
        sourceMessageId: messageId,
        sourceUrl,
        httpStatus: response.status,
        contentType,
        failureReason: 'non_html_content_type'
      });
      return null;
    }

    const html = await response.text();
    const metadata = collectHtmlPreviewMetadata(html, response.url || sourceUrl);
    logger?.info?.('preview html metadata fetched', {
      sourceMessageId: messageId,
      sourceUrl,
      finalUrl: response.url || sourceUrl,
      httpStatus: response.status,
      contentType,
      candidateCount: metadata.candidates.filter(Boolean).length,
      hasTitle: Boolean(metadata.title),
      hasDescription: Boolean(metadata.description),
      siteName: metadata.siteName || null
    });
    return {
      ...metadata,
      sourceUrl: response.url || sourceUrl
    };
  } catch (error) {
    logger?.info?.('preview html metadata fetch failed', {
      sourceMessageId: messageId,
      sourceUrl,
      failureReason: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'request_failed',
      error: error.message
    });
    return null;
  }
}

async function fetchYouTubeOEmbedMetadata(videoId, originalUrl, logger = null, messageId = null) {
  if (!videoId) {
    return null;
  }

  const watchUrl = getYouTubeWatchUrl(videoId);
  const requestUrl = new URL('https://www.youtube.com/oembed');
  requestUrl.searchParams.set('url', watchUrl);
  requestUrl.searchParams.set('format', 'json');

  try {
    const response = await fetch(requestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 compatible preview fetcher',
        Accept: 'application/json,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(YOUTUBE_OEMBED_TIMEOUT_MS)
    });
    const contentType = response.headers.get('content-type') || null;
    if (!response.ok) {
      logger?.info?.('youtube oembed failed', {
        sourceMessageId: messageId,
        originalUrl,
        videoId,
        httpStatus: response.status,
        contentType,
        reason: 'http_status'
      });
      return null;
    }

    const payload = await response.json();
    const title = String(payload?.title || '').trim() || null;
    logger?.info?.('youtube oembed title fetched', {
      sourceMessageId: messageId,
      originalUrl,
      videoId,
      title,
      authorName: payload?.author_name || null,
      providerName: payload?.provider_name || null
    });
    return {
      title,
      authorName: payload?.author_name || null,
      providerName: payload?.provider_name || 'YouTube',
      sourceUrl: watchUrl
    };
  } catch (error) {
    logger?.info?.('youtube oembed failed', {
      sourceMessageId: messageId,
      originalUrl,
      videoId,
      reason: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'request_failed',
      error: error.message
    });
    return null;
  }
}

function buildSocialPreviewMediaItem(candidate) {
  return {
    url: candidate.url,
    source: isYoutubeLikeUrl(candidate.url) || isYoutubeLikeUrl(candidate.sourceUrl)
      ? 'youtube_thumbnail'
      : 'link_preview_image',
    sourceType: candidate.source,
    kind: candidate.kind,
    rawUrl: candidate.rawUrl || candidate.url,
    normalizedUrl: candidate.normalizedUrl || candidate.url,
    finalUrl: candidate.validation?.finalUrl || candidate.url,
    validated: true,
    httpStatus: candidate.validation?.httpStatus || null,
    contentType: candidate.validation?.contentType || null,
    contentLength: candidate.validation?.contentLength || null,
    requiresReupload: candidate.requiresReupload === true,
    extension: candidate.extension || candidate.validation?.extension || null
  };
}

async function extractSocialPreviewFromEmbeds(embeds, sourceUrl = null, logger = null, messageId = null) {
  let primaryPreview = null;
  const gifProvider = getGifProviderName(sourceUrl);
  const youtubeVideoId = extractYouTubeVideoId(sourceUrl);
  const youtubeWatchUrl = youtubeVideoId ? getYouTubeWatchUrl(youtubeVideoId) : null;
  const youtubeThumbnailCandidates = buildYouTubeThumbnailCandidates(sourceUrl, logger, messageId);
  let candidates = [
    ...youtubeThumbnailCandidates,
    ...collectPreviewMediaCandidates(embeds, sourceUrl)
  ];
  for (const candidate of candidates) {
    logger?.info?.('relay link preview image candidate found', {
      sourceMessageId: messageId,
      sourceUrl,
      rawUrl: candidate.rawUrl || candidate.url,
      imageUrl: candidate.url,
      normalizedUrl: candidate.normalizedUrl,
      source: candidate.source,
      sourceType: candidate.source,
      kind: candidate.kind,
      priority: candidate.priority,
      absolute: candidate.absolute === true,
      urlShape: candidate.urlShape
    });
  }
  let selectedCandidates = await selectPreviewMediaForComponentsV2(candidates, sourceUrl, logger, messageId);
  let htmlMetadata = null;
  if (!selectedCandidates.length && sourceUrl) {
    htmlMetadata = await fetchHtmlPreviewMetadata(sourceUrl, logger, messageId);
    const htmlCandidates = (htmlMetadata?.candidates || []).filter(Boolean);
    for (const candidate of htmlCandidates) {
      logger?.info?.('preview image candidate found', {
        sourceMessageId: messageId,
        sourceUrl,
        rawUrl: candidate.rawUrl || candidate.url,
        normalizedUrl: candidate.url,
        sourceType: candidate.source,
        priority: candidate.priority,
        urlShape: candidate.urlShape,
        absolute: candidate.absolute === true
      });
    }
    if (htmlCandidates.length) {
      candidates = [...candidates, ...htmlCandidates];
      selectedCandidates = await selectPreviewMediaForComponentsV2(htmlCandidates, htmlMetadata.sourceUrl || sourceUrl, logger, messageId);
      if (selectedCandidates.length) {
        logger?.info?.('preview image candidate fallback selected', {
          sourceMessageId: messageId,
          sourceUrl,
          fallbackSourceUrl: htmlMetadata.sourceUrl || null,
          imageUrls: selectedCandidates.map((candidate) => candidate.url)
        });
      }
    }
  }
  if (selectedCandidates.length) {
    logger?.info?.('relay link preview image selected', {
      sourceMessageId: messageId,
      sourceUrl,
      imageUrls: selectedCandidates.map((candidate) => candidate.url),
      sourceTypes: selectedCandidates.map((candidate) => candidate.source)
    });
    if (/^https?:\/\/(?:on\.)?soundcloud\.com\//i.test(String(sourceUrl || '')) || /\/\/[^/]*soundcloud\.com\//i.test(String(sourceUrl || ''))) {
      logger?.info?.('soundcloud preview image selected', {
        sourceMessageId: messageId,
        sourceUrl,
        imageUrl: selectedCandidates[0]?.url || null
      });
    }
  }

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
        imageUrl: selectedCandidates.find((candidate) => candidate.kind !== 'video')?.url || null,
        imageUrls: [],
        sourceUrl: embedSourceUrl,
        siteName
      };
    }
  }

  if (!primaryPreview && htmlMetadata && (htmlMetadata.title || htmlMetadata.description || selectedCandidates.length)) {
    primaryPreview = {
      title: htmlMetadata.title || null,
      description: htmlMetadata.description || null,
      imageUrl: selectedCandidates.find((candidate) => candidate.kind !== 'video')?.url || null,
      imageUrls: [],
      sourceUrl: htmlMetadata.sourceUrl || sourceUrl,
      siteName: htmlMetadata.siteName || null
    };
  } else if (primaryPreview && htmlMetadata) {
    primaryPreview.title ||= htmlMetadata.title || null;
    primaryPreview.description ||= htmlMetadata.description || null;
    primaryPreview.siteName ||= htmlMetadata.siteName || null;
  }

  let youtubeOEmbed = null;
  if (youtubeVideoId && (!primaryPreview?.title || isWeakYouTubeTitle(primaryPreview.title))) {
    youtubeOEmbed = await fetchYouTubeOEmbedMetadata(youtubeVideoId, sourceUrl, logger, messageId);
  }

  if (youtubeVideoId && !primaryPreview && (youtubeOEmbed?.title || selectedCandidates.length)) {
    primaryPreview = {
      title: youtubeOEmbed?.title || 'YouTube',
      description: null,
      imageUrl: selectedCandidates.find((candidate) => candidate.kind !== 'video')?.url || null,
      imageUrls: [],
      sourceUrl: youtubeWatchUrl,
      siteName: youtubeOEmbed?.providerName || 'YouTube'
    };
  } else if (youtubeVideoId && primaryPreview) {
    if (youtubeOEmbed?.title && isWeakYouTubeTitle(primaryPreview.title)) {
      primaryPreview.title = youtubeOEmbed.title;
    } else if (isWeakYouTubeTitle(primaryPreview.title)) {
      primaryPreview.title = 'YouTube';
    }
    primaryPreview.siteName ||= youtubeOEmbed?.providerName || 'YouTube';
    primaryPreview.sourceUrl = youtubeWatchUrl || primaryPreview.sourceUrl || sourceUrl;
  }

  if (!primaryPreview && !selectedCandidates.length) {
    if (youtubeVideoId) {
      logger?.info?.('youtube preview rendered without thumbnail', {
        sourceMessageId: messageId,
        originalUrl: sourceUrl,
        videoId: youtubeVideoId,
        reason: 'no_primary_preview_no_thumbnail'
      });
    }
    return null;
  }

  if (youtubeVideoId && !selectedCandidates.length) {
    logger?.info?.('youtube preview rendered without thumbnail', {
      sourceMessageId: messageId,
      originalUrl: sourceUrl,
      videoId: youtubeVideoId,
      reason: 'thumbnail_fallback_exhausted'
    });
  }

  const finalMediaItems = selectedCandidates.map(buildSocialPreviewMediaItem);
  const finalMediaUrls = finalMediaItems.map((item) => item.url);
  const finalImageUrls = selectedCandidates
    .filter((candidate) => candidate.kind !== 'video')
    .map((candidate) => candidate.url);

  if (logger && messageId) {
    for (const candidate of finalMediaItems) {
      logger.info('media gallery item added', {
        sourceMessageId: messageId,
        sourceUrl,
        url: candidate.url,
        kind: candidate.kind,
        source_type: candidate.source
      });
    }
    if (candidates.length !== selectedCandidates.length) {
      logger.info('media gallery deduped', {
        sourceMessageId: messageId,
        sourceUrl,
        originalCount: candidates.length,
        selectedCount: selectedCandidates.length
      });
    }
  }

  return {
    title: primaryPreview?.title || null,
    description: primaryPreview?.description || null,
    imageUrl: primaryPreview?.imageUrl || finalImageUrls[0] || null,
    imageUrls: finalImageUrls,
    mediaUrls: finalMediaUrls,
    mediaItems: finalMediaItems,
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
      const preview = await extractSocialPreviewFromEmbeds(workingMessage.embeds, socialLink, logger, message.id);

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
  const relayHashtagRouting = parseRelayHashtagPrefixes(restoredContent, {
    globalRoutes: config.globalHashtagRoutes,
    botRoutes: config.botHashtagRoutes
  });
  const strippedContent = stripPreviewedGifLinks(relayHashtagRouting.content, socialPreview);
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
      extractedBodyText: String(relayHashtagRouting.content || '').slice(0, 500),
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

  logger?.info?.('relay hashtag transform applied', {
    sourceMessageId: canonicalMessage.id,
    rawContent: String(restoredContent || '').slice(0, 500),
    cleanedContent: String(customEmojiMedia.content || '').slice(0, 500),
    displayHashtags: relayHashtagRouting.displayTags,
    relayKind: 'tweet_thread_extract',
    rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(customEmojiMedia.content || ''))
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
    matchedBotHashtagRoutes: relayHashtagRouting.botMatchedRoutes,
    matchedGlobalHashtagRoutes: relayHashtagRouting.globalMatchedRoutes,
    detectedGlobalHashtags: relayHashtagRouting.globalDetectedTags,
    displayBotHashtags: relayHashtagRouting.displayTags,
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
  const relayHashtagRouting = parseRelayHashtagPrefixes(restoredContent, {
    globalRoutes: config.globalHashtagRoutes,
    botRoutes: config.botHashtagRoutes
  });
  const strippedContent = stripPreviewedGifLinks(relayHashtagRouting.content, socialPreview);
  const customEmojiMedia = extractCustomEmojiMedia(strippedContent.content);
  const displayName =
    guildMember?.displayName ||
    canonicalMessage.author?.globalName ||
    canonicalMessage.author?.username ||
    '不明なユーザー';

  const displayBotHashtags = relayHashtagRouting.displayTags;
  if (logger && displayBotHashtags.length) {
    logger.info('route display tag resolved', {
      sourceMessageId: canonicalMessage.id,
      detectedTags: relayHashtagRouting.globalDetectedTags,
      normalizedDisplayTags: displayBotHashtags,
      displayMode: Array.from(new Set(relayHashtagRouting.globalMatchedRoutes.map((routeKey) => config.globalHashtagRoutes?.[routeKey]?.displayMode || 'displayTag'))),
      rawPrefixRemoved: relayHashtagRouting.content !== restoredContent,
      normalizedHashtagInserted: true,
      finalBodyText: String(customEmojiMedia.content || '').slice(0, 500),
      finalDisplayBotHashtags: displayBotHashtags
    });
  }

  logger?.info?.('relay hashtag transform applied', {
    sourceMessageId: canonicalMessage.id,
    rawContent: String(restoredContent || '').slice(0, 500),
    cleanedContent: String(customEmojiMedia.content || '').slice(0, 500),
    displayHashtags: displayBotHashtags,
    relayKind: 'plain_extract',
    rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(customEmojiMedia.content || ''))
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
    timelineHeadline: `${displayName} さんが投稿しました`,
    referencedSourceMessageId: null,
    replyContext: null,
    title: '',
    rawTitle: '',
    isResolved: false,
    content: customEmojiMedia.content,
    customEmojiMediaItems: customEmojiMedia.mediaItems,
    matchedBotHashtagRoutes: relayHashtagRouting.botMatchedRoutes,
    matchedGlobalHashtagRoutes: relayHashtagRouting.globalMatchedRoutes,
    detectedGlobalHashtags: relayHashtagRouting.globalDetectedTags,
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
