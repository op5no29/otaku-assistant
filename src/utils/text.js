function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
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
    const matchedRoute = aliasMap.get(line.trim());

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
  }

  return {
    content: remainingLines.join('\n'),
    matchedRoutes,
    displayTags
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
    .replace(/[\/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || 'attachment';
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
  const extension = splitFileName(
    attachment?.name ||
    attachment?.filename ||
    attachment?.title ||
    attachment?.description ||
    decodeUrlFileName(attachment?.url) ||
    'attachment'
  ).extension;
  const candidates = [
    attachment?.title,
    attachment?.filename,
    attachment?.name,
    attachment?.description,
    decodeUrlFileName(attachment?.url),
    decodeUrlFileName(attachment?.proxyURL || attachment?.proxyUrl),
    findFileNameInText(options.sourceContent, extension)
  ].filter(Boolean);

  const meaningful = candidates.find((candidate) => isMeaningfulFileName(candidate));
  const fallback = candidates.find(Boolean);

  return sanitizeDisplayFileName(meaningful || fallback || 'attachment');
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

  return {
    id: String(attachment.id || ''),
    attachmentId: String(attachment.id || ''),
    originalDiscordNameRaw,
    originalName: originalFileName,
    originalFileName,
    displayFileName: originalFileName,
    uploadFileName: originalFileName,
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

      return {
        id: String(attachment.id || ''),
        attachmentId: String(attachment.id || ''),
        originalDiscordNameRaw,
        originalName: originalFileName,
        originalFileName,
        displayFileName: originalFileName,
        uploadFileName: originalFileName,
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
  parseBotHashtagRoutes,
  sanitizeDisplayFileName,
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
