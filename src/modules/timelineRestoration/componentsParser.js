function toRawComponents(messageOrPayload) {
  const components = Array.isArray(messageOrPayload?.components) ? messageOrPayload.components : [];
  return components.map((component) => {
    if (typeof component?.toJSON === 'function') return component.toJSON();
    if (component?.data) return component.data;
    return component;
  }).filter(Boolean);
}

function walkComponents(value, visitor, path = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkComponents(entry, visitor, [...path, index]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visitor(value, path);
  for (const [key, child] of Object.entries(value)) {
    if (['components', 'items', 'accessory', 'media'].includes(key) || Array.isArray(child)) {
      walkComponents(child, visitor, [...path, key]);
    }
  }
}

function componentType(value) {
  return String(value?.type ?? '').toUpperCase();
}

function mediaUrl(value) {
  if (typeof value === 'string') return value;
  return value?.url || value?.proxy_url || value?.proxyUrl || null;
}

function extractTimelineComponentData(messageOrPayload) {
  const rawComponents = toRawComponents(messageOrPayload);
  const textBlocks = [];
  const mediaItems = [];
  const fileItems = [];
  const thumbnailItems = [];
  const attachmentReferences = [];

  walkComponents(rawComponents, (component, path) => {
    const type = componentType(component);
    if ((type === '10' || type === 'TEXT_DISPLAY') && typeof component.content === 'string') {
      textBlocks.push({ content: component.content, path });
    }

    const looksLikeThumbnail = type === '11' || type === 'THUMBNAIL';
    if (looksLikeThumbnail) {
      const url = mediaUrl(component.media || component);
      if (url) thumbnailItems.push({ url, description: component.description || null, path });
    }

    const looksLikeGallery = type === '12' || type === 'MEDIA_GALLERY';
    if (looksLikeGallery && Array.isArray(component.items)) {
      for (const [index, item] of component.items.entries()) {
        const url = mediaUrl(item.media || item);
        if (!url) continue;
        mediaItems.push({
          url,
          description: item.description || null,
          spoiler: item.spoiler === true,
          path: [...path, 'items', index]
        });
      }
    }

    const looksLikeFile = type === '13' || type === 'FILE';
    if (looksLikeFile) {
      const url = mediaUrl(component.file || component.media || component);
      if (url) fileItems.push({ url, spoiler: component.spoiler === true, path });
    }
  });

  for (const entry of [...thumbnailItems, ...mediaItems, ...fileItems]) {
    if (String(entry.url).startsWith('attachment://')) {
      attachmentReferences.push({
        ...entry,
        filename: decodeURIComponent(String(entry.url).slice('attachment://'.length))
      });
    }
  }

  const authorThumbnail = thumbnailItems.find((entry) => /アイコン|avatar|author|投稿者/iu.test(String(entry.description || '')))
    || thumbnailItems[0]
    || null;
  const headline = textBlocks[0]?.content || '';
  const authorNameMatch = headline.match(/^\*\*(.+?)\s+さん(?:が|の|へ)/u)
    || headline.match(/^(.+?)\s+さん(?:が|の|へ)/u);

  return {
    rawComponents,
    textBlocks,
    mediaItems,
    fileItems,
    thumbnailItems,
    attachmentReferences,
    authorAvatarUrl: authorThumbnail?.url || null,
    authorName: authorNameMatch?.[1]?.replace(/^\*\*|\*\*$/g, '').trim() || null,
    bodyText: textBlocks.find((entry, index) => index > 0 && entry.content && !/^(#|\*\*添付ファイル)/u.test(entry.content))?.content || null
  };
}

function collectAttachmentUrls(message) {
  return Array.from(message?.attachments?.values?.() || []).map((attachment) => ({
    id: String(attachment.id || ''),
    name: attachment.name || attachment.filename || null,
    url: attachment.url || null,
    proxyUrl: attachment.proxyURL || attachment.proxyUrl || null,
    contentType: attachment.contentType || null,
    size: Number(attachment.size || 0),
    description: attachment.description || null,
    width: attachment.width || null,
    height: attachment.height || null,
    spoiler: Boolean(attachment.spoiler || /^SPOILER_/u.test(String(attachment.name || '')))
  }));
}

module.exports = {
  toRawComponents,
  walkComponents,
  extractTimelineComponentData,
  collectAttachmentUrls
};
