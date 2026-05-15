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

function buildTweetHeaderSection({ title, avatarUrl }) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${title}`)
  );

  if (avatarUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(avatarUrl)
        .setDescription(`${title} のアイコン`)
    );
  }

  return section;
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

function addMediaIfPresent(container, post) {
  const explicitMediaGalleryItems = Array.isArray(post.mediaGalleryItems)
    ? post.mediaGalleryItems.filter((item) => item?.url)
    : [];
  const customEmojiMediaItems = Array.isArray(post.customEmojiMediaItems)
    ? post.customEmojiMediaItems.filter((item) => item?.url)
    : [];
  const imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : [];
  const primaryImageUrls = imageUrls.length
    ? imageUrls
    : [post.firstImageUrl].filter(Boolean);
  const mediaUrls = [...new Set([
    ...primaryImageUrls,
    post.generatedVideoThumbnailUrl,
    post.musicLink?.artworkUrl
  ].filter(Boolean))];
  const galleryItems = [
    ...explicitMediaGalleryItems,
    ...customEmojiMediaItems,
    ...mediaUrls.map((url) => ({ url }))
  ].filter((item, index, array) => {
    if (!item.url) {
      return false;
    }

    const normalized = normalizeMediaUrl(item.url);
    return array.findIndex((other) => normalizeMediaUrl(other.url) === normalized) === index;
  });

  if (!galleryItems.length) {
    return;
  }

  const gallery = new MediaGalleryBuilder();
  const limitedItems = galleryItems.slice(0, MAX_MEDIA_ITEMS);

  for (const item of limitedItems) {
    const mediaItem = new MediaGalleryItemBuilder().setURL(item.url);
    if (item.description) {
      mediaItem.setDescription(item.description);
    }
    gallery.addItems(mediaItem);
  }

  container.addMediaGalleryComponents(gallery);

  if (galleryItems.length > MAX_MEDIA_ITEMS) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付があります')
    );
  }
}

function addFileComponentsIfPresent(container, post) {
  const fileComponentUrls = Array.isArray(post.fileComponentUrls) ? post.fileComponentUrls : [];

  for (const fileUrl of fileComponentUrls) {
    container.addFileComponents(new FileBuilder().setURL(fileUrl));
  }
}

function buildBottomActionRows(post, options = {}) {
  const buttons = [];
  const jumpLabel = options.jumpLabel || 'メッセージに飛ぶ';

  if (post.jumpUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel(jumpLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(post.jumpUrl)
    );
  }

  if (post.musicLink?.universalUrl || post.musicLink?.sourceUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('音楽リンクを開く')
        .setStyle(ButtonStyle.Link)
        .setURL(post.musicLink.universalUrl || post.musicLink.sourceUrl)
    );
  }

  const downloadableAttachments = Array.isArray(post.downloadableAttachments)
    ? post.downloadableAttachments.slice(0, MAX_DOWNLOAD_BUTTONS)
    : [];

  for (const attachment of downloadableAttachments) {
    buttons.push(
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
    buttons.push(
      new ButtonBuilder()
        .setLabel(button.label)
        .setStyle(ButtonStyle.Link)
        .setURL(button.url)
    );
  }

  if (!buttons.length) {
    return [];
  }

  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(index, index + 5)));
  }

  return rows;
}

function addSocialPreviewIfPresent(container, socialPreview, existingMediaUrls = []) {
  if (!socialPreview) {
    return;
  }

  const previewMediaUrls = Array.isArray(socialPreview.mediaUrls) && socialPreview.mediaUrls.length
    ? socialPreview.mediaUrls
    : Array.isArray(socialPreview.imageUrls)
      ? socialPreview.imageUrls
      : [socialPreview.imageUrl].filter(Boolean);
  const existingNormalized = new Set(existingMediaUrls.map((url) => normalizeMediaUrl(url)));
  const dedupedPreviewImages = previewMediaUrls.filter((imageUrl, index, array) => {
    if (!imageUrl) {
      return false;
    }

    const normalized = normalizeMediaUrl(imageUrl);
    return (
      array.findIndex((entry) => normalizeMediaUrl(entry) === normalized) === index &&
      !existingNormalized.has(normalized)
    );
  });

  if (socialPreview.isGifShare) {
    if (dedupedPreviewImages.length) {
      const gallery = new MediaGalleryBuilder();

      for (const mediaUrl of dedupedPreviewImages.slice(0, MAX_MEDIA_ITEMS)) {
        gallery.addItems(new MediaGalleryItemBuilder().setURL(mediaUrl));
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

  if (socialPreview.description) {
    lines.push(truncateText(socialPreview.description, 240));
  }

  if (socialPreview.sourceUrl) {
    lines.push(socialPreview.sourceUrl);
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

  if (dedupedPreviewImages.length) {
    const gallery = new MediaGalleryBuilder();

    for (const mediaUrl of dedupedPreviewImages.slice(0, MAX_MEDIA_ITEMS)) {
      gallery.addItems(new MediaGalleryItemBuilder().setURL(mediaUrl));
    }

    container.addMediaGalleryComponents(gallery);
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

function buildTweetTimelineMessage({ post, config }) {
  const container = createBaseContainer(post.accentColor || ACCENT_COLORS.timeline);
  const trimmedContent = truncateText(post.content || '', config.timeline.maxContentLength)?.trim();
  const body = formatPrimaryTweetBody(trimmedContent);
  const primaryMediaUrls = [...new Set([
    ...(Array.isArray(post.imageUrls) ? post.imageUrls : []),
    post.firstImageUrl,
    post.generatedVideoThumbnailUrl,
    post.musicLink?.artworkUrl,
    ...(Array.isArray(post.mediaGalleryItems) ? post.mediaGalleryItems.map((item) => item.url) : []),
    ...(Array.isArray(post.customEmojiMediaItems) ? post.customEmojiMediaItems.map((item) => item.url) : [])
  ].filter(Boolean))];

  container.addSectionComponents(
    buildTweetHeaderSection({
      title: post.timelineHeadline || `${post.displayName} さんが投稿しました`,
      avatarUrl: post.avatarUrl
    })
  );
  addReplyContextIfPresent(container, post);
  if (body) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  } else if (
    !addAttachmentNamesSection(container, post, { showOnlyAsFallback: true }) &&
    !post.socialPreview?.isGifShare &&
    !(Array.isArray(post.customEmojiMediaItems) && post.customEmojiMediaItems.length)
  ) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('（本文はまだありません）'));
  }
  addBotHashtagSection(container, post);
  addMediaIfPresent(container, post);
  addMusicLinkPreviewIfPresent(container, post);
  if (!post.musicLink) {
    addSocialPreviewIfPresent(
      container,
      post.socialPreview,
      primaryMediaUrls
    );
  }
  addFileComponentsIfPresent(container, post);
  if (post.hasMoreDownloadableAttachments) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付ファイルがあります')
    );
  }
  for (const row of buildBottomActionRows(post)) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: post.componentFiles?.length ? post.componentFiles : undefined,
    allowedMentions: { parse: [] }
  };
}

function buildQuestionTimelineMessage({ post, config }) {
  const accentColor = post.isResolved ? ACCENT_COLORS.questionResolved : ACCENT_COLORS.question;
  const container = createBaseContainer(accentColor);
  const trimmedContent = truncateText(post.content || '', config.timeline.maxContentLength)?.trim();
  const body = trimmedContent || null;
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
  addMediaIfPresent(container, post);
  addSocialPreviewIfPresent(
    container,
    post.socialPreview,
    primaryMediaUrls
  );
  addFileComponentsIfPresent(container, post);
  if (post.hasMoreDownloadableAttachments) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付ファイルがあります')
    );
  }
  for (const row of buildBottomActionRows(post, { jumpLabel: '質問フォーラムへ飛ぶ' })) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: post.componentFiles?.length ? post.componentFiles : undefined,
    allowedMentions: { parse: [] }
  };
}

function buildKnowledgeTimelineMessage({ post, config }) {
  const container = createBaseContainer(ACCENT_COLORS.knowledge);
  const trimmedContent = truncateText(post.content || '', config.timeline.maxContentLength)?.trim();
  const body = trimmedContent || null;
  const title = post.title?.trim() || 'タイトルなし';
  const tagLine = Array.isArray(post.knowledgeTagLabels) && post.knowledgeTagLabels.length
    ? post.knowledgeTagLabels.join(' / ')
    : null;
  const primaryMediaUrls = [...new Set([
    ...(Array.isArray(post.imageUrls) ? post.imageUrls : []),
    post.firstImageUrl,
    post.generatedVideoThumbnailUrl
  ].filter(Boolean))];

  addQuestionHeader(container, {
    title: '知りたいことに新しいスレッドが作成されました',
    subtitle: null
  });
  container.addSectionComponents(
    buildAuthorSection({
      displayName: post.displayName,
      avatarUrl: post.avatarUrl
    })
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`)
  );
  if (tagLine) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**タグ**\n${tagLine}`)
    );
  }
  if (body) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  } else if (!addAttachmentNamesSection(container, post, { showOnlyAsFallback: true })) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('（本文はまだありません）'));
  }
  if (body && buildAttachmentFileNameBlock(post)) {
    addAttachmentNamesSection(container, post);
  }
  addMediaIfPresent(container, post);
  addSocialPreviewIfPresent(container, post.socialPreview, primaryMediaUrls);
  addFileComponentsIfPresent(container, post);
  if (post.hasMoreDownloadableAttachments) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('他にも添付ファイルがあります')
    );
  }
  for (const row of buildBottomActionRows(post)) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: post.componentFiles?.length ? post.componentFiles : undefined,
    allowedMentions: { parse: [] }
  };
}

function buildTimelineMessage({ post, config, forumType }) {
  if (forumType === 'question') {
    return buildQuestionTimelineMessage({ post, config });
  }

  if (forumType === 'knowledge') {
    return buildKnowledgeTimelineMessage({ post, config });
  }

  return {
    ...buildTweetTimelineMessage({ post, config })
  };
}

module.exports = {
  buildTimelineMessage
};
