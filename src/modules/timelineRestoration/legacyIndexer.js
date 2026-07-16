const { SnowflakeUtil } = require('discord.js');
const { extractTimelineComponentData, collectAttachmentUrls } = require('./componentsParser');
const { mirrorSnapshotCandidates, stableUploadName } = require('./mediaMirror');
const { urlAccessible } = require('./mediaAudit');

function parseJson(value, fallback = []) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function snowflakeIso(id) {
  try {
    return new Date(Number(SnowflakeUtil.timestampFrom(id))).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function indexLegacyTimelineRestore(client, { apply = false } = {}) {
  const mappings = client.db.timelineRestoration.snapshots.listRelayMappings()
    .filter((mapping) => !mapping.destinationChannelId
      || String(mapping.destinationChannelId) === String(client.appConfig.timelineChannelId));
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    timelineMessagesScanned: 0,
    historicalOwnerIdsFound: 0,
    sourceThreadsFound: 0,
    deletedMissingThreadsFound: 0,
    messagesRecoverable: 0,
    exactAuthorIdsFound: 0,
    avatarsRecoveredFromComponentsV2: 0,
    avatarsRequiringFallback: 0,
    textRecovered: 0,
    repliesRecovered: 0,
    imagesRecovered: 0,
    videosRecovered: 0,
    filesRecovered: 0,
    inaccessibleMedia: 0,
    duplicateSourceIds: 0,
    missingMappings: 0,
    estimatedPermanentDiskBytes: 0,
    estimatedPermanentDiskBytesIsLowerBound: false,
    unknownSizeMediaCount: 0,
    expectedRestorationMessageCount: 0,
    limitations: []
  };
  const seenSource = new Set();
  const timelineMessageCache = new Map();
  const threadCache = new Map();
  const ownerIds = new Set();
  const sourceThreads = new Set();
  const mediaUrlsForAudit = new Set();
  const unknownSizeUrls = new Set();

  for (const mapping of mappings) {
    if (seenSource.has(mapping.sourceMessageId)) {
      report.duplicateSourceIds += 1;
      continue;
    }
    seenSource.add(mapping.sourceMessageId);
    sourceThreads.add(mapping.threadId);
    const guildId = process.env.GUILD_ID || client.guilds.cache.first()?.id;
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      report.missingMappings += 1;
      continue;
    }
    let timelineMessage = timelineMessageCache.get(mapping.relayedMessageId);
    if (timelineMessage === undefined) {
      const destinationId = mapping.destinationChannelId || client.appConfig.timelineChannelId;
      const channel = await guild.channels.fetch(destinationId).catch(() => null);
      timelineMessage = channel?.isTextBased?.()
        ? await channel.messages.fetch(mapping.relayedMessageId).catch(() => null)
        : null;
      timelineMessageCache.set(mapping.relayedMessageId, timelineMessage);
      if (timelineMessage) report.timelineMessagesScanned += 1;
    }
    if (!timelineMessage) {
      report.missingMappings += 1;
      continue;
    }

    let sourceThread = threadCache.get(mapping.threadId);
    if (sourceThread === undefined) {
      sourceThread = await guild.channels.fetch(mapping.threadId).catch(() => null);
      threadCache.set(mapping.threadId, sourceThread);
      if (!sourceThread) report.deletedMissingThreadsFound += 1;
    }
    const threadRelay = client.db.relays.getThreadRelay(mapping.threadId);
    const archived = client.db.archives.getMessage(mapping.sourceMessageId);
    const existingBinding = client.db.timelineRestoration.userThreads.get(guild.id, mapping.threadId);
    const ownerUserId = sourceThread?.ownerId
      || threadRelay?.authorId
      || (threadRelay?.starterMessageId === mapping.sourceMessageId ? mapping.authorId : null)
      || existingBinding?.ownerUserId;
    if (!ownerUserId) {
      report.missingMappings += 1;
      continue;
    }
    ownerIds.add(ownerUserId);
    const components = extractTimelineComponentData(timelineMessage);
    const timelineAttachments = collectAttachmentUrls(timelineMessage);
    const componentAvatarUrl = String(components.authorAvatarUrl || '').startsWith('attachment://')
      ? timelineAttachments.find((attachment) => attachment.name === decodeURIComponent(components.authorAvatarUrl.slice('attachment://'.length)))?.url || null
      : components.authorAvatarUrl;
    const authorUserId = mapping.authorId || archived?.authorId || null;
    if (authorUserId) report.exactAuthorIdsFound += 1;
    const historicalIdentity = authorUserId
      ? client.db.timelineRestoration.identities.nearest(guild.id, authorUserId, archived?.createdAt || snowflakeIso(mapping.sourceMessageId))
      : null;
    const currentUser = authorUserId ? await client.users.fetch(authorUserId).catch(() => null) : null;
    const avatarUrl = componentAvatarUrl || historicalIdentity?.avatarUrl
      || currentUser?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null;
    const avatarSource = componentAvatarUrl
      ? 'timeline_component_thumbnail'
      : historicalIdentity?.avatarUrl
        ? 'membership_history'
        : currentUser
          ? (currentUser.avatar ? 'current_discord_profile' : 'default_avatar')
          : 'generic_fallback';
    if (componentAvatarUrl) report.avatarsRecoveredFromComponentsV2 += 1;
    else report.avatarsRequiringFallback += 1;
    const content = archived?.content || components.bodyText || '';
    if (content) report.textRecovered += 1;
    const replyText = components.textBlocks.find((block) => /返信|への返信/u.test(block.content))?.content || null;
    const referencedMessageId = archived?.referencedMessageId || null;
    if (referencedMessageId || replyText) report.repliesRecovered += 1;
    const attachments = timelineAttachments;
    const componentMedia = [...components.mediaItems, ...components.fileItems];
    for (const attachment of attachments) {
      report.estimatedPermanentDiskBytes += attachment.size;
      if (!attachment.size && attachment.url) unknownSizeUrls.add(attachment.url);
      if (/^https?:\/\//iu.test(String(attachment.url || ''))) mediaUrlsForAudit.add(attachment.url);
      if (attachment.contentType?.startsWith('image/')) report.imagesRecovered += 1;
      else if (attachment.contentType?.startsWith('video/')) report.videosRecovered += 1;
      else report.filesRecovered += 1;
    }
    for (const component of componentMedia) {
      if (/^https?:\/\//iu.test(String(component.url || ''))) {
        mediaUrlsForAudit.add(component.url);
        unknownSizeUrls.add(component.url);
      }
      if (components.fileItems.includes(component)) report.filesRecovered += 1;
      else if (isLikelyVideoUrl(component.url)) report.videosRecovered += 1;
      else report.imagesRecovered += 1;
    }

    report.messagesRecoverable += 1;
    report.expectedRestorationMessageCount += 1;
    if (!apply) continue;
    const now = new Date().toISOString();
    const threadCreatedAt = sourceThread?.createdAt?.toISOString?.() || snowflakeIso(mapping.threadId);
    client.db.timelineRestoration.userThreads.upsert({
      guildId: guild.id,
      ownerUserId,
      forumChannelId: mapping.parentChannelId,
      threadId: mapping.threadId,
      threadName: sourceThread?.name || null,
      starterMessageId: threadRelay?.starterMessageId || null,
      status: sourceThread ? 'active' : 'legacy_missing',
      deletionReason: sourceThread ? null : 'legacy_missing',
      createdAt: threadCreatedAt,
      archivedAt: sourceThread?.archived ? now : null,
      lockedAt: sourceThread?.locked ? now : null,
      membershipEpisodeId: null,
      updatedAt: now
    });
    if (!sourceThread) {
      client.db.timelineRestoration.userThreads.markDeleted(guild.id, mapping.threadId, 'legacy_missing', now, 'legacy_missing');
    }
    const existing = client.db.timelineRestoration.snapshots.get(guild.id, mapping.sourceMessageId);
    const snapshot = client.db.timelineRestoration.snapshots.upsert({
      guildId: guild.id,
      sourceForumId: mapping.parentChannelId,
      sourceThreadId: mapping.threadId,
      sourceMessageId: mapping.sourceMessageId,
      threadOwnerUserId: ownerUserId,
      authorUserId,
      authorUsernameSnapshot: historicalIdentity?.username || currentUser?.username || null,
      authorGlobalNameSnapshot: historicalIdentity?.globalName || currentUser?.globalName || null,
      authorDisplayNameSnapshot: archived?.authorName || components.authorName || historicalIdentity?.displayName || currentUser?.globalName || currentUser?.username || '不明なユーザー',
      authorNicknameSnapshot: historicalIdentity?.nickname || null,
      authorAvatarUrlSnapshot: avatarUrl,
      authorAvatarHashSnapshot: historicalIdentity?.avatarHash || currentUser?.avatar || null,
      authorAvatarSource: avatarSource,
      authorIsBot: archived?.authorIsBot ? 1 : 0,
      content,
      cleanContent: archived?.cleanContent || content,
      attachmentsJson: archived?.attachmentsJson || JSON.stringify(attachments),
      embedsJson: archived?.embedsJson || '[]',
      componentsJson: '[]',
      stickersJson: '[]',
      reactionsJson: '[]',
      referencedSourceMessageId: referencedMessageId,
      referencedAuthorUserId: null,
      referencedAuthorNameSnapshot: replyText ? replyText.slice(0, 100) : null,
      referencedContentSnapshot: replyText,
      replyKind: referencedMessageId || replyText ? 'legacy_visual_context' : 'not_a_reply',
      messageType: archived?.messageType || 0,
      sequenceSnowflake: mapping.sourceMessageId,
      sourceCreatedAt: archived?.createdAt || snowflakeIso(mapping.sourceMessageId),
      sourceEditedAt: archived?.editedAt || null,
      sourceDeletedAt: sourceThread ? null : now,
      timelineMessageId: timelineMessage.id,
      timelineChannelId: timelineMessage.channelId,
      timelineCardPayloadJson: JSON.stringify({ flags: Number(timelineMessage.flags?.bitfield || 0), components: components.rawComponents }),
      timelineCardAuthorAvatarUrl: componentAvatarUrl,
      snapshotSource: archived ? 'legacy_archive_and_timeline_card' : 'legacy_timeline_component_card',
      restorationFidelity: archived ? 'exact_archive_with_card_identity' : 'reconstructed_from_timeline_card',
      restoreEligible: archived?.authorIsBot ? 0 : 1,
      qualityJson: JSON.stringify({ text: archived ? 'exact' : 'reconstructed', identity: authorUserId ? 'exact_id' : 'unknown_id', avatar: avatarSource, reply: referencedMessageId ? 'exact_id' : replyText ? 'excerpt_only' : 'not_applicable' }),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    const mediaCandidates = attachments.map((attachment, index) => ({
      index,
      url: attachment.url,
      proxyUrl: attachment.proxyUrl,
      timelineMessageId: timelineMessage.id,
      timelineAttachmentId: attachment.id,
      timelineAttachmentUrl: attachment.url,
      originalFilename: attachment.name,
      safeFilename: stableUploadName(mapping.sourceMessageId, index, attachment.name, attachment.spoiler),
      contentType: attachment.contentType,
      byteSize: attachment.size,
      mediaKind: attachment.contentType?.startsWith('image/') ? 'image' : attachment.contentType?.startsWith('video/') ? 'video' : 'file',
      sourceKind: 'timeline_attachment',
      spoiler: attachment.spoiler
    }));
    for (const [index, component] of componentMedia.entries()) {
      if (component.url.startsWith('attachment://')) continue;
      mediaCandidates.push({
        index: attachments.length + index,
        url: component.url,
        componentMediaUrl: component.url,
        originalFilename: `timeline-component-${index + 1}`,
        mediaKind: components.mediaItems.includes(component) ? 'image' : 'file',
        sourceKind: 'timeline_component_media',
        spoiler: component.spoiler
      });
    }
    if (componentAvatarUrl) {
      mediaUrlsForAudit.add(componentAvatarUrl);
      unknownSizeUrls.add(componentAvatarUrl);
      mediaCandidates.push({
        index: mediaCandidates.length,
        url: componentAvatarUrl,
        originalFilename: `avatar-${authorUserId || 'unknown'}.png`,
        mediaKind: 'avatar',
        sourceKind: 'timeline_component_thumbnail',
        spoiler: false
      });
    }
    const mirrored = await mirrorSnapshotCandidates(client, snapshot, mediaCandidates);
    report.inaccessibleMedia += mirrored.filter((row) => row.downloadStatus !== 'complete').length;
  }

  report.historicalOwnerIdsFound = ownerIds.size;
  report.sourceThreadsFound = sourceThreads.size;
  report.expectedFidelityPercentages = {
    authorId: percent(report.exactAuthorIdsFound, report.messagesRecoverable),
    avatar: percent(report.avatarsRecoveredFromComponentsV2, report.messagesRecoverable),
    text: percent(report.textRecovered, report.messagesRecoverable),
    replies: report.repliesRecovered ? 'legacy excerpts may be incomplete' : 'no recoverable reply metadata found'
  };
  report.unknownSizeMediaCount = unknownSizeUrls.size;
  report.estimatedPermanentDiskBytesIsLowerBound = report.unknownSizeMediaCount > 0;
  if (!apply && mediaUrlsForAudit.size) {
    const urls = [...mediaUrlsForAudit];
    const timeoutMs = Math.min(Number(client.appConfig.timelineRestoration.mediaFetchTimeoutMs || 20_000), 8000);
    for (let index = 0; index < urls.length; index += 8) {
      const checks = await Promise.all(urls.slice(index, index + 8).map((url) => urlAccessible(url, timeoutMs)));
      report.inaccessibleMedia += checks.filter((accessible) => !accessible).length;
    }
  }
  report.limitations.push(
    'Timeline card text may have been truncated by the historical relay limit.',
    'Merged short cards can map several source IDs to one visible body.',
    'Expired source URLs and already-broken legacy media cannot always be recovered.',
    'Legacy reply context may be an excerpt rather than a native reference.',
    'The earliest or most prolific message author is not treated as thread-owner proof.'
  );
  client.logger.info(apply ? 'timeline restoration legacy index applied' : 'timeline restoration legacy index dry run completed', report);
  return report;
}

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 100;
}

function isLikelyVideoUrl(url) {
  return /\.(?:mp4|webm|mov)(?:[?#]|$)/iu.test(String(url || ''));
}

module.exports = {
  indexLegacyTimelineRestore
};
