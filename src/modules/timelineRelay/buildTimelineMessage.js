const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder
} = require('discord.js');
const { truncateText } = require('../../utils/text');
const { ACCENT_COLORS } = require('../../utils/accentColors');
const MAX_MEDIA_ITEMS = 10;
const MAX_DOWNLOAD_BUTTONS = 4;
const REPLY_CONTEXT_MAX_LENGTH = 160;

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

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAttachmentUrl(url) {
  return /^attachment:\/\//i.test(String(url || ''));
}

function isSoundCloudUrl(url) {
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

function isImageOrVideoMediaUrl(url) {
  const value = String(url || '');
  if (isAttachmentUrl(value)) {
    return true;
  }
  if (!isValidHttpUrl(value)) {
    return false;
  }
  if (isSoundCloudPlayerUrl(value)) {
    return false;
  }
  return (
    /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(value) ||
    /[?&]format=(png|jpe?g|webp|gif)\b/i.test(value) ||
    /images-ext-\d+\.discordapp\.net\/external\/.+\/https\/.+\.(png|jpe?g|webp|gif)(?:[?#/]|$)/i.test(value) ||
    /i\d*\.sndcdn\.com\/artworks-/i.test(value)
  );
}

function hasUploadedMediaAttachments(post) {
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  return attachments.some((attachment) =>
    attachment?.isImage === true ||
    attachment?.isGif === true ||
    attachment?.isVideo === true ||
    String(attachment?.contentType || '').startsWith('image/') ||
    String(attachment?.contentType || '').startsWith('video/')
  );
}

function hasUploadedVideoAttachments(post) {
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  return attachments.some((attachment) =>
    attachment?.isVideo === true ||
    String(attachment?.contentType || '').startsWith('video/')
  );
}

function isYouTubePreviewMediaUrl(url) {
  return /(?:youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com)/i.test(String(url || ''));
}

function isYouTubeSourceUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function getSocialPreviewMediaItems(socialPreview) {
  if (!socialPreview) {
    return [];
  }
  if (Array.isArray(socialPreview.mediaItems) && socialPreview.mediaItems.length) {
    return socialPreview.mediaItems
      .filter((item) => item?.url)
      .map((item) => ({
        ...item,
        source: item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image')
      }));
  }

  const previewMediaUrls = Array.isArray(socialPreview.mediaUrls) && socialPreview.mediaUrls.length
    ? socialPreview.mediaUrls
    : Array.isArray(socialPreview.imageUrls)
      ? socialPreview.imageUrls
      : [socialPreview.imageUrl].filter(Boolean);

  return previewMediaUrls
    .filter(Boolean)
    .map((url) => ({
      url,
      source: isYouTubePreviewMediaUrl(url) ? 'youtube_thumbnail' : 'link_preview_image',
      validated: false
    }));
}

function isRenderableMediaGalleryItem(item) {
  return item?.validated === true || isImageOrVideoMediaUrl(item?.url);
}

function getAttachmentSourceForUrl(post, url) {
  const value = String(url || '');
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  const matchedAttachment = attachments.find((attachment) => {
    const candidates = [
      attachment?.url,
      attachment?.attachmentUrl,
      attachment?.proxyUrl,
      attachment?.uploadFileName ? `attachment://${attachment.uploadFileName}` : null,
      attachment?.name ? `attachment://${attachment.name}` : null,
      attachment?.displayName ? `attachment://${attachment.displayName}` : null
    ].filter(Boolean);
    return candidates.some((candidate) => normalizeMediaUrl(candidate) === normalizeMediaUrl(value));
  });

  if (matchedAttachment?.isVideo) {
    return 'uploaded_video_playable';
  }
  if (matchedAttachment?.isImage || matchedAttachment?.isGif) {
    return 'uploaded_image';
  }
  if (/\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i.test(value)) {
    return 'uploaded_video_playable';
  }
  if (/\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(value)) {
    return 'uploaded_image';
  }
  return 'uploaded_media';
}

function createBaseContainer(accentColor) {
  return new ContainerBuilder().setAccentColor(accentColor);
}

function buildHeaderSection({ title, subtitle, jumpUrl }) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${title}`)
  );

  if (subtitle) {
    section.addTextDisplayComponents(new TextDisplayBuilder().setContent(subtitle));
  }

  if (jumpUrl) {
    section.setButtonAccessory(
      new ButtonBuilder()
        .setLabel('メッセージに飛ぶ')
        .setStyle(ButtonStyle.Link)
        .setURL(jumpUrl)
    );
  }

  return section;
}

function addQuestionHeader(container, { title, subtitle }) {
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));

  if (subtitle) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(subtitle));
  }
}

function buildTweetBodySection({ body, avatarUrl, avatarDescription }) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(body)
  );

  if (avatarUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(avatarUrl)
        .setDescription(avatarDescription || '投稿者のアイコン')
    );
  }

  return section;
}

function buildTweetAvatarOnlySection({ avatarUrl, avatarDescription }) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent('\u200B')
  );

  if (avatarUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(avatarUrl)
        .setDescription(avatarDescription || '投稿者のアイコン')
    );
  }

  return section;
}

function normalizePosthocTagLabel(label) {
  const value = String(label || '').trim();
  if (!value) {
    return null;
  }
  if (value.startsWith('##')) {
    return `#${value.replace(/^#+/u, '')}`;
  }
  if (value.startsWith('#')) {
    return `#${value.replace(/^#+/u, '')}`;
  }
  return `#${value}`;
}

function buildPosthocHashtagHeadline(post) {
  if (post.relayOrigin !== 'posthoc_hashtag') {
    return null;
  }

  const originalAuthorName = post.originalAuthorDisplayName || post.displayName || '不明なユーザー';
  const taggerName = post.taggerDisplayName || '不明なユーザー';
  const tagLabels = [...new Set((Array.isArray(post.posthocDisplayTags) ? post.posthocDisplayTags : [])
    .map(normalizePosthocTagLabel)
    .filter(Boolean))];
  const tagText = tagLabels.length ? tagLabels.join(' / ') : 'タグ';

  return `${originalAuthorName} さんの投稿を ${taggerName} さんが${tagText}にタグ付けしました`;
}

function buildAuthorSection({ displayName, avatarUrl }) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${displayName}`)
  );

  if (avatarUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(avatarUrl)
        .setDescription(`${displayName} のアイコン`)
    );
  }

  return section;
}

function buildMetadataSection({ lines, avatarUrl, avatarDescription }) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n'))
  );

  if (avatarUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(avatarUrl)
        .setDescription(avatarDescription || 'アイコン')
    );
  }

  return section;
}

function addImageIfPresent(container, firstImageUrl) {
  if (!firstImageUrl) {
    return;
  }

  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(firstImageUrl)
    )
  );
}

function buildMediaGalleryItem(item, logger = null, context = {}) {
  const mediaItem = new MediaGalleryItemBuilder().setURL(item.url);
  const suppressDescriptionForSource = new Set([
    'uploaded_image',
    'uploaded_video_playable',
    'uploaded_media',
    'uploaded_video_thumbnail_static'
  ]);
  if (item.description && !suppressDescriptionForSource.has(item.source)) {
    mediaItem.setDescription(item.description);
  } else if (item.description && suppressDescriptionForSource.has(item.source)) {
    logger?.info?.('attachment filename text suppressed', {
      ...context,
      mediaUrl: item.url,
      source: item.source,
      source_type: item.source,
      suppressedDescription: item.description
    });
  }

  if (item.spoiler === true || item.isSpoiler === true) {
    const supportsSpoiler = typeof mediaItem.setSpoiler === 'function';
    logger?.info?.('media gallery spoiler capability detected', {
      ...context,
      mediaUrl: item.url,
      supportsSetSpoiler: supportsSpoiler
    });

    if (supportsSpoiler) {
      mediaItem.setSpoiler(true);
      const payload = mediaItem.toJSON();
      logger?.info?.('media gallery spoiler item payload', {
        ...context,
        mediaUrl: item.url,
        payload
      });
      logger?.info?.('spoiler media gallery item marked spoiler', {
        ...context,
        mediaUrl: item.url,
        spoiler: payload.spoiler === true
      });
    } else {
      logger?.warn?.('spoiler media gallery unsupported fallback', {
        ...context,
        mediaUrl: item.url,
        fallback: 'media_gallery_item_without_spoiler_setter'
      });
    }
  }

  return mediaItem;
}

function addMediaIfPresent(container, post, logger = null) {
  const sourceMessageId = post.messageId || null;
  const uploadedMediaPresent = hasUploadedMediaAttachments(post);
  const uploadedVideoPresent = hasUploadedVideoAttachments(post);
  const explicitMediaGalleryItems = Array.isArray(post.mediaGalleryItems)
    ? post.mediaGalleryItems
      .filter((item) => item?.url)
      .map((item) => ({
        ...item,
        source: item.source || getAttachmentSourceForUrl(post, item.url)
      }))
    : [];
  const customEmojiMediaItems = Array.isArray(post.customEmojiMediaItems)
    ? post.customEmojiMediaItems
      .filter((item) => item?.url)
      .map((item) => ({
        ...item,
        source: item.source || 'custom_emoji'
      }))
    : [];
  const imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : [];
  const socialPreviewMediaItems = post.musicLink
    ? getSocialPreviewMediaItems(post.socialPreview)
    : [];
  const socialPreviewMediaUrls = socialPreviewMediaItems.map((item) => item.url);
  const primaryImageUrls = imageUrls.length
    ? imageUrls
    : [post.firstImageUrl].filter(Boolean);
  const musicArtworkUrls = socialPreviewMediaUrls.length
    ? []
    : [post.musicLink?.artworkUrl].filter(Boolean);
  const uploadedImageItems = primaryImageUrls.map((url) => ({
    url,
    source: getAttachmentSourceForUrl(post, url) || 'uploaded_image'
  }));
  const generatedVideoThumbnailItems = [post.generatedVideoThumbnailUrl]
    .filter(Boolean)
    .map((url) => ({
      url,
      source: 'uploaded_video_thumbnail_static'
    }));
  const linkPreviewItems = socialPreviewMediaItems.length
    ? socialPreviewMediaItems
    : musicArtworkUrls
      .filter(Boolean)
      .map((url) => ({
        url,
        source: isYouTubePreviewMediaUrl(url) ? 'youtube_thumbnail' : 'link_preview_image',
        validated: false
      }));
  if (
    post.musicLink &&
    post.socialPreview?.description &&
    isYouTubeSourceUrl(post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl)
  ) {
    logger?.info?.('youtube description suppressed', {
      sourceMessageId,
      sourceUrl: post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl || null
    });
  }
  const hasPreviewMediaCandidate = Boolean(linkPreviewItems.length);
  const activeGeneratedVideoThumbnailItems = uploadedVideoPresent ? [] : generatedVideoThumbnailItems;
  if (uploadedVideoPresent && generatedVideoThumbnailItems.length) {
    logger?.info?.('uploaded video static thumbnail suppressed', {
      sourceMessageId,
      suppressedUrls: generatedVideoThumbnailItems.map((item) => item.url),
      source_type: 'uploaded_video_thumbnail_static'
    });
  }
  const activeLinkPreviewItems = uploadedMediaPresent
    ? linkPreviewItems.filter((item) => uploadedVideoPresent && item.source === 'youtube_thumbnail')
    : linkPreviewItems;
  const suppressedLinkPreviewItems = linkPreviewItems.filter(
    (item) => !activeLinkPreviewItems.includes(item)
  );
  if (uploadedVideoPresent && activeLinkPreviewItems.some((item) => item.source === 'youtube_thumbnail')) {
    logger?.info?.('youtube thumbnail retained with uploaded video', {
      sourceMessageId,
      retainedUrls: activeLinkPreviewItems
        .filter((item) => item.source === 'youtube_thumbnail')
        .map((item) => item.url),
      source_type: 'youtube_thumbnail'
    });
  }
  if (uploadedMediaPresent && suppressedLinkPreviewItems.length) {
    logger?.info?.('relay uploaded media present; suppressing link preview media', {
      sourceMessageId,
      suppressedCount: suppressedLinkPreviewItems.length,
      suppressedUrls: suppressedLinkPreviewItems.map((item) => item.url)
    });
    if (suppressedLinkPreviewItems.some((item) => item.source === 'youtube_thumbnail')) {
      logger?.info?.('youtube thumbnail suppressed due to uploaded media', {
        sourceMessageId,
        suppressedUrls: suppressedLinkPreviewItems
          .filter((item) => item.source === 'youtube_thumbnail')
          .map((item) => item.url)
      });
    }
    logger?.info?.('link preview media suppressed due to attachment priority', {
      sourceMessageId,
      suppressedUrls: suppressedLinkPreviewItems.map((item) => item.url)
    });
  }
  const galleryItemCandidates = uploadedVideoPresent
    ? [
      ...activeLinkPreviewItems,
      ...explicitMediaGalleryItems,
      ...customEmojiMediaItems,
      ...uploadedImageItems,
      ...activeGeneratedVideoThumbnailItems
    ]
    : [
      ...explicitMediaGalleryItems,
      ...customEmojiMediaItems,
      ...uploadedImageItems,
      ...activeGeneratedVideoThumbnailItems,
      ...activeLinkPreviewItems
    ];
  const galleryItems = galleryItemCandidates.filter((item, index, array) => {
    if (!item.url) {
      return false;
    }

    if (isSoundCloudPlayerUrl(item.url)) {
      logger?.info?.('relay link preview image candidate rejected soundcloud_player', {
        sourceMessageId,
        imageUrl: item.url
      });
      return false;
    }

    if (!isRenderableMediaGalleryItem(item)) {
      logger?.info?.('relay link preview image validation failed', {
        sourceMessageId,
        imageUrl: item.url,
        reason: isValidHttpUrl(item.url) ? 'non_image_url' : 'invalid_url'
      });
      logger?.info?.('relay link preview image candidate rejected non_image_url', {
        sourceMessageId,
        imageUrl: item.url
      });
      if (item.source === 'link_preview_image' || item.source === 'youtube_thumbnail') {
        logger?.warn?.('media gallery item skipped broken_preview_image', {
          sourceMessageId,
          mediaUrl: item.url,
          source_type: item.source,
          failureReason: 'unvalidated_or_invalid_preview_media'
        });
      }
      return false;
    }

    const normalized = normalizeMediaUrl(item.url);
    return array.findIndex((other) => normalizeMediaUrl(other.url) === normalized) === index;
  });

  if (!galleryItems.length) {
    if (hasPreviewMediaCandidate) {
      logger?.info?.('relay link preview image omitted', {
        sourceMessageId,
        sourceUrl: post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl || null,
        reason: 'no_valid_gallery_items'
      });
      logger?.info?.('relay link preview image omitted no_valid_image', {
        sourceMessageId,
        sourceUrl: post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl || null
      });
    }
    return;
  }

  const selectedLinkPreviewItems = galleryItems.filter(
    (item) => item.source === 'link_preview_image' || item.source === 'youtube_thumbnail'
  );
  if (selectedLinkPreviewItems.length) {
    logger?.info?.('relay link preview image selected', {
      sourceMessageId,
      sourceUrl: post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl || null,
      imageUrls: selectedLinkPreviewItems.map((item) => item.url),
      sourceTypes: selectedLinkPreviewItems.map((item) => item.source || 'unknown')
    });
    if (selectedLinkPreviewItems.some((item) => item.source === 'youtube_thumbnail')) {
      logger?.info?.('youtube thumbnail selected', {
        sourceMessageId,
        sourceUrl: post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl || null,
        imageUrl: selectedLinkPreviewItems.find((item) => item.source === 'youtube_thumbnail')?.url || null,
        source_type: 'youtube_thumbnail'
      });
    }
    if (isSoundCloudUrl(post.socialPreview?.sourceUrl) || isSoundCloudUrl(post.musicLink?.sourceUrl)) {
      logger?.info?.('soundcloud preview image selected', {
        sourceMessageId,
        sourceUrl: post.socialPreview?.sourceUrl || post.musicLink?.sourceUrl || null,
        imageUrl: selectedLinkPreviewItems[0]?.url || null
      });
    }
  }

  logger?.info?.('media gallery final item order', {
    sourceMessageId,
    items: galleryItems.map((item, index) => ({
      index,
      url: item.url,
      source: item.source || 'unknown',
      source_type: item.source || 'unknown'
    }))
  });

  const gallery = new MediaGalleryBuilder();
  const limitedItems = galleryItems.slice(0, MAX_MEDIA_ITEMS);

  for (const [index, item] of limitedItems.entries()) {
    logger?.info?.('media gallery item source', {
      sourceMessageId,
      index,
      mediaUrl: item.url,
      source: item.source || 'unknown',
      source_type: item.source || 'unknown'
    });
    if (item.source === 'uploaded_video_playable') {
      logger?.info?.('uploaded video playable item retained', {
        sourceMessageId,
        index,
        mediaUrl: item.url,
        source_type: 'uploaded_video_playable'
      });
    }
    if (item.source === 'link_preview_image' || item.source === 'youtube_thumbnail') {
      logger?.info?.('media gallery item added source_type=link_preview_image', {
        sourceMessageId,
        index,
        mediaUrl: item.url,
        source_type: item.source
      });
    }
    gallery.addItems(buildMediaGalleryItem(item, logger, {
      sourceMessageId
    }));
  }

  container.addMediaGalleryComponents(gallery);

  if (galleryItems.length > MAX_MEDIA_ITEMS) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付があります')
    );
  }
}

function addFileComponentsIfPresent(container, post, logger = null) {
  const fileComponentUrls = Array.isArray(post.fileComponentUrls) ? post.fileComponentUrls : [];

  for (const fileEntry of fileComponentUrls) {
    const fileUrl = typeof fileEntry === 'string' ? fileEntry : fileEntry?.url;
    if (!fileUrl) {
      continue;
    }

    const file = new FileBuilder().setURL(fileUrl);
    if (fileEntry?.spoiler === true && typeof file.setSpoiler === 'function') {
      file.setSpoiler(true);
      logger?.info?.('spoiler attachment standard file fallback', {
        sourceMessageId: post.messageId || null,
        fileUrl,
        name: fileEntry.name || null,
        payload: file.toJSON()
      });
    }
    container.addFileComponents(file);
  }
}

function buildBottomActionRows(post, options = {}) {
  const rows = [];
  const supplementalButtons = [];
  const externalButtons = [];
  const jumpLabel = options.jumpLabel || 'メッセージに飛ぶ';
  const logger = options.logger || null;

  if (post.jumpUrl) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(jumpLabel)
          .setStyle(ButtonStyle.Link)
          .setURL(post.jumpUrl)
      )
    );
  }

  if (post.musicLink?.universalUrl || post.musicLink?.sourceUrl) {
    supplementalButtons.push(
      new ButtonBuilder()
        .setLabel('音楽リンクを開く')
        .setStyle(ButtonStyle.Link)
        .setURL(post.musicLink.universalUrl || post.musicLink.sourceUrl)
    );
  }

  const downloadableAttachments = options.includeDownloadButtons === false
    ? []
    : Array.isArray(post.downloadableAttachments)
      ? post.downloadableAttachments.slice(0, MAX_DOWNLOAD_BUTTONS)
      : [];

  for (const attachment of downloadableAttachments) {
    supplementalButtons.push(
      new ButtonBuilder()
        .setLabel(attachment.label)
        .setStyle(ButtonStyle.Link)
        .setURL(attachment.url)
    );
  }

  const extraLinkButtons = Array.isArray(post.extraLinkButtons) ? post.extraLinkButtons : [];
  for (const button of extraLinkButtons) {
    if (!button?.label || !button?.url) {
      continue;
    }
    externalButtons.push(
      new ButtonBuilder()
        .setLabel(button.label)
        .setStyle(ButtonStyle.Link)
        .setURL(button.url)
    );
  }

  for (let index = 0; index < supplementalButtons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(...supplementalButtons.slice(index, index + 5)));
  }

  if (externalButtons.length) {
    for (let index = 0; index < externalButtons.length; index += 5) {
      rows.push(new ActionRowBuilder().addComponents(...externalButtons.slice(index, index + 5)));
    }
    logger?.info?.('relay link buttons placed separate row', {
      sourceMessageId: post.messageId || null,
      externalButtonCount: externalButtons.length,
      hasJumpButton: Boolean(post.jumpUrl)
    });
  }

  return rows;
}

function addSocialPreviewIfPresent(container, socialPreview, existingMediaUrls = [], options = {}) {
  if (!socialPreview) {
    return;
  }
  const logger = options.logger || null;
  const sourceMessageId = options.sourceMessageId || null;
  const suppressMedia = options.suppressMedia === true;
  const isYouTubePreview = isYouTubeSourceUrl(socialPreview.sourceUrl);

  const previewMediaItems = getSocialPreviewMediaItems(socialPreview);
  const existingNormalized = new Set(existingMediaUrls.map((url) => normalizeMediaUrl(url)));
  const dedupedPreviewItems = previewMediaItems.filter((item, index, array) => {
    if (!item?.url) {
      return false;
    }

    const normalized = normalizeMediaUrl(item.url);
    return (
      array.findIndex((entry) => normalizeMediaUrl(entry.url) === normalized) === index &&
      !existingNormalized.has(normalized)
    );
  });
  const renderablePreviewItems = dedupedPreviewItems.filter((item) => {
    const renderable = isRenderableMediaGalleryItem(item);
    if (!renderable) {
      logger?.warn?.('media gallery item skipped broken_preview_image', {
        sourceMessageId,
        sourceUrl: socialPreview.sourceUrl || null,
        mediaUrl: item.url,
        source_type: item.source || 'link_preview_image',
        failureReason: 'unvalidated_or_invalid_preview_media'
      });
    }
    return renderable;
  });

  if (socialPreview.isGifShare) {
    if (suppressMedia && renderablePreviewItems.length) {
      logger?.info?.('relay uploaded media present; suppressing link preview media', {
        sourceMessageId,
        sourceUrl: socialPreview.sourceUrl || null,
        suppressedCount: renderablePreviewItems.length,
        suppressedUrls: renderablePreviewItems.map((item) => item.url)
      });
      if (renderablePreviewItems.some((item) => isYouTubePreviewMediaUrl(item.url))) {
        logger?.info?.('youtube thumbnail suppressed due to uploaded media', {
          sourceMessageId,
          sourceUrl: socialPreview.sourceUrl || null,
          suppressedUrls: renderablePreviewItems.map((item) => item.url).filter(isYouTubePreviewMediaUrl)
        });
      }
      logger?.info?.('link preview media suppressed due to attachment priority', {
        sourceMessageId,
        sourceUrl: socialPreview.sourceUrl || null,
        suppressedUrls: renderablePreviewItems.map((item) => item.url)
      });
      return;
    }
    if (renderablePreviewItems.length) {
      const gallery = new MediaGalleryBuilder();

      const limitedImages = renderablePreviewItems.slice(0, MAX_MEDIA_ITEMS);
      logger?.info?.('media gallery final item order', {
        sourceMessageId,
        items: limitedImages.map((item, index) => ({
          index,
          url: item.url,
          source: item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image'),
          source_type: item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image')
        }))
      });
      for (const [index, item] of limitedImages.entries()) {
        const sourceType = item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image');
        logger?.info?.('media gallery item source', {
          sourceMessageId,
          index,
          mediaUrl: item.url,
          source: sourceType,
          source_type: sourceType
        });
        logger?.info?.('media gallery item added source_type=link_preview_image', {
          sourceMessageId,
          sourceUrl: socialPreview.sourceUrl || null,
          mediaUrl: item.url,
          source_type: sourceType
        });
        gallery.addItems(buildMediaGalleryItem(item, logger, { sourceMessageId }));
      }

      container.addMediaGalleryComponents(gallery);
    }
    return;
  }

  const lines = [];
  lines.push('**リンクプレビュー**');

  if (socialPreview.title) {
    lines.push(`**${socialPreview.title}**`);
  }

  if (socialPreview.description && isYouTubePreview) {
    logger?.info?.('youtube description suppressed', {
      sourceMessageId,
      sourceUrl: socialPreview.sourceUrl || null
    });
  } else if (socialPreview.description) {
    lines.push(truncateText(socialPreview.description, 240));
  }

  if (socialPreview.sourceUrl) {
    lines.push(socialPreview.sourceUrl);
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

  if (suppressMedia && renderablePreviewItems.length) {
    logger?.info?.('relay uploaded media present; suppressing link preview media', {
      sourceMessageId,
      sourceUrl: socialPreview.sourceUrl || null,
      suppressedCount: renderablePreviewItems.length,
      suppressedUrls: renderablePreviewItems.map((item) => item.url)
    });
    if (renderablePreviewItems.some((item) => isYouTubePreviewMediaUrl(item.url))) {
      logger?.info?.('youtube thumbnail suppressed due to uploaded media', {
        sourceMessageId,
        sourceUrl: socialPreview.sourceUrl || null,
        suppressedUrls: renderablePreviewItems.map((item) => item.url).filter(isYouTubePreviewMediaUrl)
      });
    }
    logger?.info?.('link preview media suppressed due to attachment priority', {
      sourceMessageId,
      sourceUrl: socialPreview.sourceUrl || null,
      suppressedUrls: renderablePreviewItems.map((item) => item.url)
    });
    return;
  }

  if (renderablePreviewItems.length) {
    const gallery = new MediaGalleryBuilder();

    const limitedImages = renderablePreviewItems.slice(0, MAX_MEDIA_ITEMS);
    logger?.info?.('media gallery final item order', {
      sourceMessageId,
      items: limitedImages.map((item, index) => ({
        index,
        url: item.url,
        source: item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image'),
        source_type: item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image')
      }))
    });
    for (const [index, item] of limitedImages.entries()) {
      const sourceType = item.source || (isYouTubePreviewMediaUrl(item.url) ? 'youtube_thumbnail' : 'link_preview_image');
      logger?.info?.('media gallery item source', {
        sourceMessageId,
        index,
        mediaUrl: item.url,
        source: sourceType,
        source_type: sourceType
      });
      logger?.info?.('media gallery item added source_type=link_preview_image', {
        sourceMessageId,
        sourceUrl: socialPreview.sourceUrl || null,
        mediaUrl: item.url,
        source_type: sourceType
      });
      gallery.addItems(buildMediaGalleryItem(item, logger, { sourceMessageId }));
    }

    container.addMediaGalleryComponents(gallery);
  } else if (dedupedPreviewItems.length) {
    logger?.info?.('preview image omitted no valid candidate', {
      sourceMessageId,
      sourceUrl: socialPreview.sourceUrl || null,
      candidateCount: dedupedPreviewItems.length
    });
  }
}

function addMusicLinkPreviewIfPresent(container, post) {
  if (!post.musicLink?.universalUrl && !post.musicLink?.sourceUrl) {
    return;
  }

  const lines = ['**音楽リンク**'];

  if (post.musicLink.title) {
    lines.push(`🎵 **${post.musicLink.title}**`);
  } else {
    lines.push('🎵 **楽曲リンク**');
  }

  if (post.musicLink.artist) {
    lines.push(post.musicLink.artist);
  }

  const serviceNames = Array.isArray(post.musicLink.platformNames)
    ? post.musicLink.platformNames.filter(Boolean)
    : [];

  if (serviceNames.length) {
    lines.push('');
    lines.push(`開けるサービス:\n${serviceNames.join(' / ')}`);
  }

  const targetUrl = post.musicLink.universalUrl || post.musicLink.sourceUrl;
  if (targetUrl) {
    lines.push('');
    lines.push(targetUrl);
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n'))
  );
}

function formatPrimaryTweetBody(content) {
  const trimmed = (content || '').trim();

  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function addBotHashtagSection(container, post) {
  const displayTags = Array.isArray(post.displayBotHashtags)
    ? post.displayBotHashtags.filter(Boolean)
    : [];

  if (!displayTags.length) {
    return;
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      displayTags.map((tag) => `**${tag}**`).join('\n')
    )
  );
}

function addReplyContextIfPresent(container, post) {
  if (!post.replyContext) {
    return;
  }

  const previewText = truncateText(post.replyContext.content || '', REPLY_CONTEXT_MAX_LENGTH) || '（本文はまだありません）';
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `> **${post.replyContext.displayName}**\n> ${previewText.replace(/\n/g, '\n> ')}`
    )
  );
}

function buildAttachmentFileNameBlock(post) {
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  if (!attachments.length) {
    return null;
  }

  return attachments
    .map((attachment) => attachment.displayLine || attachment.displayName || attachment.name)
    .filter(Boolean)
    .join('\n');
}

function addAttachmentNamesSection(container, post, { showOnlyAsFallback = false } = {}) {
  const namesBlock = buildAttachmentFileNameBlock(post);
  if (!namesBlock) {
    return false;
  }

  if (showOnlyAsFallback) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(namesBlock));
    return true;
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**添付ファイル**\n${namesBlock}`)
  );
  return true;
}

function hasNormalTimelineFallbackContent(post) {
  return Boolean(
    post.firstImageUrl ||
    post.generatedVideoThumbnailUrl ||
    post.musicLink?.artworkUrl ||
    post.socialPreview ||
    (Array.isArray(post.imageUrls) && post.imageUrls.length) ||
    (Array.isArray(post.mediaGalleryItems) && post.mediaGalleryItems.length) ||
    (Array.isArray(post.customEmojiMediaItems) && post.customEmojiMediaItems.length) ||
    (Array.isArray(post.fileComponentUrls) && post.fileComponentUrls.length) ||
    (Array.isArray(post.downloadableAttachments) && post.downloadableAttachments.length)
  );
}

function normalizeRoleMentionIds(roleIds) {
  return [...new Set((Array.isArray(roleIds) ? roleIds : [])
    .map((roleId) => String(roleId || '').trim())
    .filter(Boolean))];
}

function buildRoleMentionContent(label, roleIds) {
  const normalizedRoleIds = normalizeRoleMentionIds(roleIds);
  if (!normalizedRoleIds.length) {
    return null;
  }

  return [
    `**${label}**`,
    normalizedRoleIds.map((roleId) => `<@&${roleId}>`).join(' ')
  ].join('\n');
}

function buildAllowedMentionsForPost(post) {
  const roleIds = normalizeRoleMentionIds(post.allowedMentionRoleIds);
  if (!roleIds.length) {
    return { parse: [] };
  }

  return {
    parse: [],
    users: [],
    roles: roleIds
  };
}

function buildTweetTimelineMessage({ post, config, logger = null }) {
  const container = createBaseContainer(post.accentColor || ACCENT_COLORS.timeline);
  const trimmedContent = truncateText(post.content || '', config.timeline.maxContentLength)?.trim();
  const body = formatPrimaryTweetBody(trimmedContent);
  const uploadedMediaPresent = hasUploadedMediaAttachments(post);
  const uploadedVideoPresent = hasUploadedVideoAttachments(post);
  const primaryMediaUrls = [...new Set([
    ...(Array.isArray(post.imageUrls) ? post.imageUrls : []),
    post.firstImageUrl,
    post.generatedVideoThumbnailUrl,
    post.musicLink?.artworkUrl,
    ...(Array.isArray(post.mediaGalleryItems) ? post.mediaGalleryItems.map((item) => item.url) : []),
    ...(Array.isArray(post.customEmojiMediaItems) ? post.customEmojiMediaItems.map((item) => item.url) : [])
  ].filter(Boolean))];

  const headline = buildPosthocHashtagHeadline(post) || post.timelineHeadline || `${post.displayName} さんが投稿しました`;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**${headline}**`)
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  if (body) {
    container.addSectionComponents(
      buildTweetBodySection({
        body,
        avatarUrl: post.avatarUrl,
        avatarDescription: `${post.displayName || '投稿者'} のアイコン`
      })
    );
    if (post.avatarUrl) {
      logger?.info?.('timeline avatar attached to body section', {
        sourceMessageId: post.messageId || null
      });
    }
  } else if (post.avatarUrl && hasNormalTimelineFallbackContent(post)) {
    container.addSectionComponents(
      buildTweetAvatarOnlySection({
        avatarUrl: post.avatarUrl,
        avatarDescription: `${post.displayName || '投稿者'} のアイコン`
      })
    );
    logger?.info?.('timeline avatar section added for media-only card', {
      sourceMessageId: post.messageId || null
    });
  } else if (!hasNormalTimelineFallbackContent(post)) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('（本文はまだありません）'));
  }
  addReplyContextIfPresent(container, post);
  addBotHashtagSection(container, post);
  addMediaIfPresent(container, post, logger);
  addMusicLinkPreviewIfPresent(container, post);
  if (!post.musicLink) {
    addSocialPreviewIfPresent(
      container,
      post.socialPreview,
      primaryMediaUrls,
      {
        logger,
        sourceMessageId: post.messageId || null,
        suppressMedia: uploadedMediaPresent && !(uploadedVideoPresent && isYouTubeSourceUrl(post.socialPreview?.sourceUrl))
      }
    );
  }
  addFileComponentsIfPresent(container, post, logger);
  if (post.hasMoreDownloadableAttachments) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付ファイルがあります')
    );
  }
  for (const row of buildBottomActionRows(post, { logger })) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: post.componentFiles?.length ? post.componentFiles : undefined,
    allowedMentions: { parse: [] }
  };
}

function buildQuestionTimelineMessage({ post, config, logger = null }) {
  const accentColor = post.isResolved ? ACCENT_COLORS.questionResolved : ACCENT_COLORS.question;
  const container = createBaseContainer(accentColor);
  const trimmedContent = truncateText(post.content || '', config.timeline.maxContentLength)?.trim();
  const body = trimmedContent || null;
  const uploadedMediaPresent = hasUploadedMediaAttachments(post);
  const uploadedVideoPresent = hasUploadedVideoAttachments(post);
  const questionTitle = post.title?.trim() || 'タイトルなし';
  const statusLabel = post.isResolved ? '解決済み' : '受付中';
  const attachmentNamesBlock = buildAttachmentFileNameBlock(post);
  const primaryMediaUrls = [...new Set([
    ...(Array.isArray(post.imageUrls) ? post.imageUrls : []),
    post.firstImageUrl,
    post.generatedVideoThumbnailUrl
  ].filter(Boolean))];

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${questionTitle}`)
  );
  if (body) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(body)
    );
  }
  container.addSectionComponents(
    buildMetadataSection({
      lines: [
        `**質問作成者**: ${post.displayName || '不明'}`,
        `**カテゴリ**: ${post.forumName}`,
        `**ステータス**: ${statusLabel}`
      ],
      avatarUrl: post.avatarUrl
        || null,
      avatarDescription: `${post.displayName || '質問作成者'} のアイコン`
    })
  );
  const questionRoleMentions = buildRoleMentionContent(
    post.roleMentionLabel || 'この質問に関係ありそうな人',
    post.roleMentionIds
  );
  if (questionRoleMentions) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(questionRoleMentions));
  }
  if (!body && !attachmentNamesBlock) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('（本文はまだありません）')
    );
  }
  if (attachmentNamesBlock) {
    addAttachmentNamesSection(container, post);
  }
  if (!body) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
  }
  addMediaIfPresent(container, post, logger);
  addSocialPreviewIfPresent(
    container,
    post.socialPreview,
    primaryMediaUrls,
    {
      logger,
      sourceMessageId: post.messageId || null,
      suppressMedia: uploadedMediaPresent && !(uploadedVideoPresent && isYouTubeSourceUrl(post.socialPreview?.sourceUrl))
    }
  );
  addFileComponentsIfPresent(container, post, logger);
  if (post.hasMoreDownloadableAttachments) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付ファイルがあります')
    );
  }
  for (const row of buildBottomActionRows(post, { jumpLabel: '質問フォーラムへ飛ぶ', logger })) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: post.componentFiles?.length ? post.componentFiles : undefined,
    allowedMentions: buildAllowedMentionsForPost(post)
  };
}

function buildKnowledgeTimelineMessage({ post, config, logger = null }) {
  const container = createBaseContainer(ACCENT_COLORS.knowledge);
  const trimmedContent = truncateText(post.content || '', config.timeline.maxContentLength)?.trim();
  const body = trimmedContent || null;
  const uploadedMediaPresent = hasUploadedMediaAttachments(post);
  const uploadedVideoPresent = hasUploadedVideoAttachments(post);
  const title = post.title?.trim() || 'タイトルなし';
  const tagLine = Array.isArray(post.knowledgeTagLabels) && post.knowledgeTagLabels.length
    ? post.knowledgeTagLabels.join(' / ')
    : null;
  const primaryMediaUrls = [...new Set([
    ...(Array.isArray(post.imageUrls) ? post.imageUrls : []),
    post.firstImageUrl,
    post.generatedVideoThumbnailUrl
  ].filter(Boolean))];

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('### 知りたいことに新しいスレッドが作成されました'),
    new TextDisplayBuilder().setContent(`## ${title}`)
  );
  container.addSectionComponents(
    buildMetadataSection({
      lines: [`**作成者**: ${post.displayName || '不明'}`],
      avatarUrl: post.avatarUrl
        || null,
      avatarDescription: `${post.displayName || '作成者'} のアイコン`
    })
  );
  if (tagLine) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**タグ**\n${tagLine}`)
    );
  }
  const roleMentions = buildRoleMentionContent(
    post.roleMentionLabel || 'この投稿に興味がありそうな人',
    post.roleMentionIds
  );
  if (roleMentions) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(roleMentions));
  }
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  if (body) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('（本文はまだありません）'));
  }
  addMediaIfPresent(container, post, logger);
  addSocialPreviewIfPresent(container, post.socialPreview, primaryMediaUrls, {
    logger,
    sourceMessageId: post.messageId || null,
    suppressMedia: uploadedMediaPresent && !(uploadedVideoPresent && isYouTubeSourceUrl(post.socialPreview?.sourceUrl))
  });
  addFileComponentsIfPresent(container, post, logger);
  if (post.hasMoreDownloadableAttachments) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付ファイルがあります')
    );
  }
  for (const row of buildBottomActionRows(post, { logger, includeDownloadButtons: false })) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: post.componentFiles?.length ? post.componentFiles : undefined,
    allowedMentions: buildAllowedMentionsForPost(post)
  };
}

function buildTimelineMessage({ post, config, forumType, logger = null }) {
  if (forumType === 'question') {
    return buildQuestionTimelineMessage({ post, config, logger });
  }

  if (forumType === 'knowledge') {
    return buildKnowledgeTimelineMessage({ post, config, logger });
  }

  return {
    ...buildTweetTimelineMessage({ post, config, logger })
  };
}

module.exports = {
  buildTimelineMessage
};
