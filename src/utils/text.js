const { MessageFlags } = require('discord.js');

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

const SILENT_CONTROL_TOKEN_PATTERN = /(^|[\s　])@silent(?=$|[\s　])/u;
const SILENT_CONTROL_TOKEN_GLOBAL_PATTERN = /(^|[\s　])@silent(?=$|[\s　])/gu;
const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;

function hasSilentControlToken(content) {
  return SILENT_CONTROL_TOKEN_PATTERN.test(String(content || ''));
}

function getMessageFlagsBitfield(message) {
  const rawFlags = message?.flags;
  const rawBitfield = rawFlags?.bitfield ?? rawFlags ?? 0;
  const bitfield = Number(rawBitfield);
  return Number.isFinite(bitfield) ? bitfield : 0;
}

function hasSilentMessageFlag(message) {
  if (!message) {
    return false;
  }

  if (typeof message.flags?.has === 'function' && MessageFlags?.SuppressNotifications != null) {
    try {
      if (message.flags.has(MessageFlags.SuppressNotifications)) {
        return true;
      }
    } catch {
      // Fall through to the raw bitfield check below.
    }
  }

  const bitfield = getMessageFlagsBitfield(message);
  return (bitfield & SUPPRESS_NOTIFICATIONS_FLAG) === SUPPRESS_NOTIFICATIONS_FLAG;
}

function getSilentRelayControl(messageOrContent) {
  const isMessageLike = messageOrContent && typeof messageOrContent === 'object';
  const content = isMessageLike ? messageOrContent.content : messageOrContent;
  const token = hasSilentControlToken(content || '');
  const flag = isMessageLike ? hasSilentMessageFlag(messageOrContent) : false;
  const flagsBitfield = isMessageLike ? getMessageFlagsBitfield(messageOrContent) : 0;

  return {
    silent: token || flag,
    token,
    flag,
    flagsBitfield
  };
}

function hasSilentRelayControl(messageOrContent) {
  return getSilentRelayControl(messageOrContent).silent;
}

function stripSilentControlToken(content) {
  const rawContent = String(content || '');
  if (!rawContent) {
    return rawContent;
  }

  return rawContent
    .split(/\r?\n/u)
    .map((line) => line
      .replace(SILENT_CONTROL_TOKEN_GLOBAL_PATTERN, (match, prefix) => prefix || '')
      .replace(/[ \t　]{2,}/gu, ' ')
      .trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function parseBotHashtagRoutes(content, routeConfig = {}) {
  const rawContent = String(content || '');
  if (!rawContent) {
    return {
      content: rawContent,
      matchedRoutes: [],
      displayTags: []
    };
  }

  const aliasMap = new Map();
  for (const [routeKey, route] of Object.entries(routeConfig)) {
    const aliases = Array.isArray(route.aliases) ? route.aliases.filter(Boolean) : [];
    const normalizedDisplay = String(route.display || `#${routeKey}`);

    for (const alias of aliases) {
      aliasMap.set(`##${String(alias).trim()}`, {
        routeKey,
        display: normalizedDisplay
      });
    }
  }

  const remainingLines = [];
  const matchedRoutes = [];
  const displayTags = [];
  const seenRoutes = new Set();
  const seenDisplays = new Set();

  for (const line of rawContent.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    let matchedRoute = null;
    let remainingContent = '';

    for (const [prefix, route] of aliasMap.entries()) {
      const normalizedPrefix = prefix.trim();
      const normalizedLine = trimmedLine.toLowerCase();
      const normalizedPrefixLower = normalizedPrefix.toLowerCase();
      if (normalizedLine === normalizedPrefixLower) {
        matchedRoute = route;
        remainingContent = '';
        break;
      }

      if (normalizedLine.startsWith(`${normalizedPrefixLower} `) || normalizedLine.startsWith(`${normalizedPrefixLower}\t`)) {
        matchedRoute = route;
        remainingContent = trimmedLine.slice(normalizedPrefix.length).trimStart();
        break;
      }
    }

    if (!matchedRoute) {
      remainingLines.push(line);
      continue;
    }

    if (!seenRoutes.has(matchedRoute.routeKey)) {
      matchedRoutes.push(matchedRoute.routeKey);
      seenRoutes.add(matchedRoute.routeKey);
    }

    if (!seenDisplays.has(matchedRoute.display)) {
      displayTags.push(matchedRoute.display);
      seenDisplays.add(matchedRoute.display);
    }

    if (remainingContent) {
      remainingLines.push(remainingContent);
    }
  }

  return {
    content: remainingLines.join('\n'),
    matchedRoutes,
    displayTags
  };
}

function parseGlobalHashtagRoutes(content, routeConfig = {}) {
  const rawContent = String(content || '');
  if (!rawContent) {
    return {
      content: rawContent,
      matchedRoutes: [],
      displayTags: [],
      detectedTags: []
    };
  }

  const routeEntries = Object.entries(routeConfig).map(([routeKey, route]) => ({
    routeKey,
    route,
    tags: Array.isArray(route?.tags) ? route.tags.filter(Boolean) : [],
    displayMode: String(route?.displayMode || 'displayTag'),
    display: `#${String(route?.displayTag || route?.display || route?.tags?.[0] || routeKey).trim()}`
  }));

  const remainingLines = [];
  const matchedRoutes = [];
  const displayTags = [];
  const detectedTags = [];
  const seenRoutes = new Set();
  const seenDisplays = new Set();

  for (const line of rawContent.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    let matchedRoute = null;
    let detectedTag = null;
    let matchedTagToken = null;
    let remainingContent = '';

    for (const routeEntry of routeEntries) {
      for (const tag of routeEntry.tags) {
        const normalizedPrefix = `##${String(tag).trim()}`;
        const normalizedPrefixLower = normalizedPrefix.toLowerCase();
        const normalizedLine = trimmedLine.toLowerCase();

        if (normalizedLine === normalizedPrefixLower) {
          matchedRoute = routeEntry;
          matchedTagToken = trimmedLine.slice(2).trim();
          detectedTag = matchedTagToken || String(tag).trim();
          break;
        }

        if (normalizedLine.startsWith(`${normalizedPrefixLower} `) || normalizedLine.startsWith(`${normalizedPrefixLower}\t`)) {
          matchedRoute = routeEntry;
          matchedTagToken = trimmedLine.slice(2).split(/\s+/, 1)[0]?.trim() || String(tag).trim();
          detectedTag = matchedTagToken;
          remainingContent = trimmedLine.slice(normalizedPrefix.length).trimStart();
          break;
        }
      }

      if (matchedRoute) {
        break;
      }
    }

    if (!matchedRoute) {
      remainingLines.push(line);
      continue;
    }

    if (!seenRoutes.has(matchedRoute.routeKey)) {
      matchedRoutes.push(matchedRoute.routeKey);
      seenRoutes.add(matchedRoute.routeKey);
    }

    const finalDisplayTag = matchedRoute.displayMode === 'matchedTag'
      ? `#${detectedTag}`
      : matchedRoute.display;

    if (!seenDisplays.has(finalDisplayTag)) {
      displayTags.push(finalDisplayTag);
      seenDisplays.add(finalDisplayTag);
    }

    if (detectedTag) {
      detectedTags.push(detectedTag);
    }

    if (remainingContent) {
      remainingLines.push(remainingContent);
    }
  }

  return {
    content: remainingLines.join('\n'),
    matchedRoutes,
    displayTags,
    detectedTags
  };
}

function parseRelayHashtagPrefixes(content, options = {}) {
  const rawContent = String(content || '');
  const globalRouting = parseGlobalHashtagRoutes(rawContent, options.globalRoutes || {});
  const botRouting = parseBotHashtagRoutes(globalRouting.content, options.botRoutes || {});

  return {
    rawContent,
    content: stripSilentControlToken(botRouting.content),
    globalMatchedRoutes: globalRouting.matchedRoutes,
    globalDetectedTags: globalRouting.detectedTags,
    botMatchedRoutes: botRouting.matchedRoutes,
    displayTags: [...new Set([...(globalRouting.displayTags || []), ...(botRouting.displayTags || [])])]
  };
}

function splitFileName(fileName) {
  const value = String(fileName || 'attachment');
  const extensionIndex = value.lastIndexOf('.');

  if (extensionIndex <= 0) {
    return {
      base: value,
      extension: ''
    };
  }

  return {
    base: value.slice(0, extensionIndex),
    extension: value.slice(extensionIndex)
  };
}

function sanitizeDisplayFileName(value) {
  const normalized = String(value || 'attachment')
    .normalize('NFC')
    .replace(/[\/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || 'attachment';
}

function hasSpoilerPrefix(value) {
  return /^SPOILER_/iu.test(String(value || ''));
}

function stripSpoilerPrefix(value) {
  return String(value || '').replace(/^SPOILER_/iu, '');
}

function ensureSpoilerFileName(value) {
  const sanitized = sanitizeDisplayFileName(value);
  if (!sanitized) {
    return 'SPOILER_attachment';
  }
  if (hasSpoilerPrefix(sanitized)) {
    return sanitized;
  }
  return `SPOILER_${sanitized}`;
}

function decodeUrlFileName(url) {
  try {
    const parsed = new URL(String(url || ''));
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (!lastSegment) {
      return null;
    }

    return sanitizeDisplayFileName(decodeURIComponent(lastSegment));
  } catch {
    return null;
  }
}

function isMeaningfulFileName(candidate) {
  if (!candidate) {
    return false;
  }

  const safeName = sanitizeDisplayFileName(candidate);
  const { base, extension } = splitFileName(safeName);

  if (!extension) {
    return false;
  }

  if (/^\d+$/.test(base.trim())) {
    return false;
  }

  if (/^[\d_-]{1,8}$/.test(base.trim())) {
    return false;
  }

  return true;
}

function containsJapaneseOrKana(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(String(value || ''));
}

function looksLikeDegradedFileName(candidate) {
  if (!candidate) {
    return true;
  }

  const safeName = sanitizeDisplayFileName(candidate);
  const { base, extension } = splitFileName(safeName);

  if (!extension) {
    return true;
  }

  const trimmedBase = base.trim();
  if (/^\d+$/.test(trimmedBase)) {
    return true;
  }

  if (/^[\d_-]{1,8}$/.test(trimmedBase)) {
    return true;
  }

  if (/_$/.test(trimmedBase)) {
    return true;
  }

  return false;
}

function chooseExtension(attachment) {
  const extensionCandidates = [
    splitFileName(attachment?.name).extension,
    splitFileName(attachment?.filename).extension,
    splitFileName(attachment?.title).extension,
    splitFileName(attachment?.description).extension,
    splitFileName(decodeUrlFileName(attachment?.url)).extension,
    splitFileName(decodeUrlFileName(attachment?.proxyURL || attachment?.proxyUrl)).extension
  ].filter(Boolean);

  return extensionCandidates[0] || '';
}

function findFileNameInText(content, extension = '') {
  const text = String(content || '');
  if (!text) {
    return null;
  }

  const escapedExtension = extension ? extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const pattern = escapedExtension
    ? new RegExp(`([^\\s<>\"']+${escapedExtension})`, 'iu')
    : /([^\s<>"']+\.[A-Za-z0-9]{1,8})/iu;
  const match = text.match(pattern);

  if (!match?.[1]) {
    return null;
  }

  return sanitizeDisplayFileName(match[1]);
}

function resolveBestAttachmentFileName(attachment, options = {}) {
  const extension = chooseExtension(attachment);
  const titleCandidate = sanitizeDisplayFileName(attachment?.title || '');
  const filenameCandidate = sanitizeDisplayFileName(attachment?.filename || '');
  const nameCandidate = sanitizeDisplayFileName(attachment?.name || '');
  const descriptionCandidate = sanitizeDisplayFileName(attachment?.description || '');
  const urlCandidate = decodeUrlFileName(attachment?.url);
  const proxyCandidate = decodeUrlFileName(attachment?.proxyURL || attachment?.proxyUrl);
  const contentCandidate = findFileNameInText(options.sourceContent, extension);

  const titleBase = splitFileName(titleCandidate).base;
  const titleWithExtension = titleCandidate
    ? sanitizeDisplayFileName(splitFileName(titleCandidate).extension ? titleCandidate : `${titleBase}${extension}`)
    : '';

  let chosen = '';
  let chosenSource = 'fallback';

  if (
    titleCandidate &&
    containsJapaneseOrKana(titleCandidate) &&
    (looksLikeDegradedFileName(nameCandidate) || !containsJapaneseOrKana(nameCandidate))
  ) {
    chosen = titleWithExtension;
    chosenSource = 'attachment.title+extension';
  } else {
    const candidates = [
      { value: titleWithExtension, source: splitFileName(titleCandidate).extension ? 'attachment.title' : 'attachment.title+extension' },
      { value: filenameCandidate, source: 'attachment.filename' },
      { value: nameCandidate, source: 'attachment.name' },
      { value: descriptionCandidate, source: 'attachment.description' },
      { value: urlCandidate, source: 'attachment.url' },
      { value: proxyCandidate, source: 'attachment.proxyURL' },
      { value: contentCandidate, source: 'message.content' }
    ].filter((candidate) => candidate.value);

    const meaningful = candidates.find((candidate) => isMeaningfulFileName(candidate.value) && !looksLikeDegradedFileName(candidate.value));
    const fallback = candidates.find((candidate) => isMeaningfulFileName(candidate.value)) || candidates[0];

    chosen = meaningful?.value || fallback?.value || 'attachment';
    chosenSource = meaningful?.source || fallback?.source || 'fallback';
  }

  const finalDisplayFileName = sanitizeDisplayFileName(chosen || 'attachment');

  if (options.logger) {
    options.logger.info('Attachment filename resolved', {
      sourceMessageId: options.sourceMessageId || null,
      attachmentId: String(attachment?.id || ''),
      titleCandidate,
      nameCandidate,
      filenameCandidate,
      extensionSource: extension || null,
      chosenFileNameSource: chosenSource,
      finalDisplayFileName
    });
  }

  return finalDisplayFileName;
}

function createUniqueDisplayFileName(originalName, usedNames) {
  const safeName = sanitizeDisplayFileName(originalName);
  const { base, extension } = splitFileName(safeName);
  let candidate = safeName;
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = `${base}-${suffix}${extension}`;
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function addPrefix(value, prefix) {
  return value.startsWith(prefix) ? value : `${prefix}${value}`;
}

function removePrefix(value, prefix) {
  return value.startsWith(prefix) ? value.slice(prefix.length).trimStart() : value;
}

function isImageAttachment(attachment) {
  if (!attachment) {
    return false;
  }

  if (attachment.contentType?.startsWith('image/')) {
    return true;
  }

  const lowerName = attachment.name?.toLowerCase() || '';
  return /\.(png|jpe?g|gif|webp)$/i.test(lowerName);
}

function isGifAttachment(attachment) {
  if (!attachment) {
    return false;
  }

  if (attachment.contentType === 'image/gif') {
    return true;
  }

  const lowerName = attachment.name?.toLowerCase() || '';
  return /\.gif$/i.test(lowerName);
}

function findImageAttachments(attachments) {
  if (!attachments) {
    return [];
  }

  return Array.from(attachments.values()).filter((attachment) => isImageAttachment(attachment));
}

function findFirstImageAttachment(attachments) {
  return findImageAttachments(attachments)[0] || null;
}

function isVideoAttachment(attachment) {
  if (!attachment) {
    return false;
  }

  if (attachment.contentType?.startsWith('video/')) {
    return true;
  }

  const lowerName = attachment.name?.toLowerCase() || '';
  return /\.(mp4|mov|webm|m4v)$/i.test(lowerName);
}

function isAudioAttachment(attachment) {
  if (!attachment) {
    return false;
  }

  if (attachment.contentType?.startsWith('audio/')) {
    return true;
  }

  const lowerName = attachment.name?.toLowerCase() || '';
  return /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(lowerName);
}

function isPdfAttachment(attachment) {
  if (!attachment) {
    return false;
  }

  if (attachment.contentType === 'application/pdf') {
    return true;
  }

  const lowerName = attachment.name?.toLowerCase() || '';
  return /\.pdf$/i.test(lowerName);
}

function findFirstVideoAttachment(attachments) {
  if (!attachments) {
    return null;
  }

  for (const attachment of attachments.values()) {
    if (isVideoAttachment(attachment)) {
      return attachment;
    }
  }

  return null;
}

function normalizeAttachment(attachment) {
  if (!attachment) {
    return null;
  }

  const lowerName = attachment.name?.toLowerCase() || '';
  const isImage = isImageAttachment(attachment);
  const isGif = isGifAttachment(attachment);
  const isVideo = isVideoAttachment(attachment);
  const isAudio = isAudioAttachment(attachment);
  const isPdf = isPdfAttachment(attachment);

  const originalDiscordNameRaw = String(attachment.name || attachment.filename || '');
  const originalFileName = resolveBestAttachmentFileName(attachment);
  const isSpoiler = Boolean(
    attachment.spoiler ||
    hasSpoilerPrefix(originalDiscordNameRaw) ||
    hasSpoilerPrefix(originalFileName)
  );

  return {
    id: String(attachment.id || ''),
    attachmentId: String(attachment.id || ''),
    originalDiscordNameRaw,
    originalName: originalFileName,
    originalFileName,
    displayFileName: originalFileName,
    uploadFileName: isSpoiler ? ensureSpoilerFileName(originalFileName) : originalFileName,
    name: originalFileName,
    lowerName,
    url: attachment.url,
    attachmentUrl: attachment.url,
    proxyUrl: attachment.proxyURL || attachment.proxyUrl || null,
    contentType: attachment.contentType || null,
    size: Number(attachment.size || 0),
    extension: splitFileName(originalFileName).extension,
    metadata: {
      filename: attachment.filename || null,
      title: attachment.title || null,
      description: attachment.description || null
    },
    isImage,
    isGif,
    isVideo,
    isAudio,
    isPdf,
    isSpoiler,
    isPreviewableUpload: true
  };
}

function normalizeAttachments(attachments) {
  const options = arguments[1] || {};
  if (!attachments) {
    return [];
  }

  return Array.from(attachments.values())
    .map((attachment) => {
      if (!attachment) {
        return null;
      }

      const lowerName = attachment.name?.toLowerCase() || '';
      const isImage = isImageAttachment(attachment);
      const isGif = isGifAttachment(attachment);
      const isVideo = isVideoAttachment(attachment);
      const isAudio = isAudioAttachment(attachment);
      const isPdf = isPdfAttachment(attachment);
      const originalDiscordNameRaw = String(attachment.name || attachment.filename || '');
      const originalFileName = resolveBestAttachmentFileName(attachment, options);
      const isSpoiler = Boolean(
        attachment.spoiler ||
        hasSpoilerPrefix(originalDiscordNameRaw) ||
        hasSpoilerPrefix(originalFileName)
      );

      return {
        id: String(attachment.id || ''),
        attachmentId: String(attachment.id || ''),
        originalDiscordNameRaw,
        originalName: originalFileName,
        originalFileName,
        displayFileName: originalFileName,
        uploadFileName: isSpoiler ? ensureSpoilerFileName(originalFileName) : originalFileName,
        name: originalFileName,
        lowerName,
        url: attachment.url,
        attachmentUrl: attachment.url,
        proxyUrl: attachment.proxyURL || attachment.proxyUrl || null,
        contentType: attachment.contentType || null,
        size: Number(attachment.size || 0),
        extension: splitFileName(originalFileName).extension,
        metadata: {
          filename: attachment.filename || null,
          title: attachment.title || null,
          description: attachment.description || null
        },
        isImage,
        isGif,
        isVideo,
        isAudio,
        isPdf,
        isSpoiler,
        isPreviewableUpload: true
      };
    })
    .filter(Boolean);
}

function restoreCustomEmojiTokens(content, guild) {
  const rawContent = String(content || '');
  if (!rawContent || /<a?:\w+:\d+>/.test(rawContent) || !guild?.emojis?.cache) {
    return rawContent;
  }

  return rawContent.replace(/(^|[\s(])\:([A-Za-z0-9_]{2,32})\:(?=[$\s)!,.!?])/g, (match, prefix, emojiName) => {
    const emoji = guild.emojis.cache.find((entry) => entry.name === emojiName);
    if (!emoji) {
      return match;
    }

    return `${prefix}<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
  });
}

module.exports = {
  truncateText,
  hasSilentControlToken,
  hasSilentMessageFlag,
  hasSilentRelayControl,
  getSilentRelayControl,
  getMessageFlagsBitfield,
  stripSilentControlToken,
  parseBotHashtagRoutes,
  parseGlobalHashtagRoutes,
  parseRelayHashtagPrefixes,
  sanitizeDisplayFileName,
  hasSpoilerPrefix,
  stripSpoilerPrefix,
  ensureSpoilerFileName,
  resolveBestAttachmentFileName,
  createUniqueDisplayFileName,
  addPrefix,
  removePrefix,
  findImageAttachments,
  findFirstImageAttachment,
  findFirstVideoAttachment,
  isGifAttachment,
  isAudioAttachment,
  isPdfAttachment,
  normalizeAttachments,
  restoreCustomEmojiTokens
};
