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
    .trim();

  return normalized || 'attachment';
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
  const isVideo = isVideoAttachment(attachment);
  const isAudio = isAudioAttachment(attachment);
  const isPdf = isPdfAttachment(attachment);

  return {
    id: String(attachment.id || ''),
    originalName: String(attachment.name || 'attachment'),
    name: sanitizeDisplayFileName(attachment.name || 'attachment'),
    lowerName,
    url: attachment.url,
    contentType: attachment.contentType || null,
    size: Number(attachment.size || 0),
    isImage,
    isVideo,
    isAudio,
    isPdf,
    isPreviewableUpload: isVideo || isAudio || isPdf
  };
}

function normalizeAttachments(attachments) {
  if (!attachments) {
    return [];
  }

  return Array.from(attachments.values())
    .map((attachment) => normalizeAttachment(attachment))
    .filter(Boolean);
}

module.exports = {
  truncateText,
  parseBotHashtagRoutes,
  sanitizeDisplayFileName,
  createUniqueDisplayFileName,
  addPrefix,
  removePrefix,
  findImageAttachments,
  findFirstImageAttachment,
  findFirstVideoAttachment,
  isAudioAttachment,
  isPdfAttachment,
  normalizeAttachments
};
