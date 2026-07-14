const { extractTimelineComponentData, collectAttachmentUrls, toRawComponents } = require('./componentsParser');
const { mirrorMediaCandidate, mirrorSnapshotCandidates, stableUploadName } = require('./mediaMirror');

function json(value, fallback = []) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function serializeEmbed(embed) {
  if (typeof embed?.toJSON === 'function') return embed.toJSON();
  return embed?.data || embed || null;
}

function serializeSticker(sticker) {
  if (typeof sticker?.toJSON === 'function') return sticker.toJSON();
  return {
    id: sticker?.id || null,
    name: sticker?.name || null,
    format: sticker?.format || null,
    url: sticker?.url || null
  };
}

function serializeReactions(message) {
  return Array.from(message?.reactions?.cache?.values?.() || []).map((reaction) => ({
    emoji: reaction.emoji?.toString?.() || reaction.emoji?.name || null,
    emojiId: reaction.emoji?.id || null,
    count: Number(reaction.count || 0),
    me: reaction.me === true
  }));
}

function serializeAttachment(attachment) {
  return {
    id: String(attachment?.id || ''),
    name: attachment?.name || attachment?.filename || null,
    title: attachment?.title || null,
    description: attachment?.description || null,
    url: attachment?.url || null,
    proxyUrl: attachment?.proxyURL || attachment?.proxyUrl || null,
    contentType: attachment?.contentType || null,
    size: Number(attachment?.size || 0),
    width: attachment?.width || null,
    height: attachment?.height || null,
    durationSeconds: attachment?.duration || null,
    spoiler: Boolean(attachment?.spoiler || /^SPOILER_/u.test(String(attachment?.name || '')))
  };
}

function isConfiguredTweetThread(messageOrThread, config) {
  const channel = messageOrThread?.channel || messageOrThread;
  return Boolean(
    channel?.isThread?.()
    && config.watchedForums?.tweet?.includes(String(channel.parentId || ''))
  );
}

async function resolveThreadOwner(client, thread, fallbackAuthorId = null) {
  const existing = client.db.timelineRestoration.userThreads.get(thread.guildId, thread.id);
  if (existing?.ownerUserId) return existing.ownerUserId;
  if (thread.ownerId) return String(thread.ownerId);
  const relay = client.db.relays.getThreadRelay(thread.id);
  if (relay?.authorId) return String(relay.authorId);
  const owner = await thread.fetchOwner?.().catch(() => null);
  return String(owner?.id || fallbackAuthorId || '');
}

function identityFromMember(member, user) {
  return {
    username: user?.username || null,
    globalName: user?.globalName || null,
    displayName: member?.displayName || user?.globalName || user?.username || '不明なユーザー',
    nickname: member?.nickname || null,
    avatarUrl: member?.displayAvatarURL?.({ extension: 'png', size: 256 })
      || user?.displayAvatarURL?.({ extension: 'png', size: 256 })
      || null,
    avatarHash: user?.avatar || member?.avatar || null,
    avatarSource: member ? 'source_message_snapshot' : 'current_discord_profile'
  };
}

async function resolveReplySnapshot(message) {
  const referencedSourceMessageId = message.reference?.messageId || null;
  if (!referencedSourceMessageId) {
    return {
      referencedSourceMessageId: null,
      referencedAuthorUserId: null,
      referencedAuthorNameSnapshot: null,
      referencedContentSnapshot: null,
      replyKind: 'not_a_reply'
    };
  }
  const referenced = message.reference?.resolved
    || await message.fetchReference?.().catch(() => null);
  return {
    referencedSourceMessageId,
    referencedAuthorUserId: referenced?.author?.id || null,
    referencedAuthorNameSnapshot: referenced?.member?.displayName
      || referenced?.author?.globalName
      || referenced?.author?.username
      || null,
    referencedContentSnapshot: String(referenced?.content || '').slice(0, 300) || null,
    replyKind: referenced ? 'discord_reply' : 'unresolved_reply'
  };
}

function collectMessageMediaCandidates(message, identity) {
  const candidates = [];
  const attachments = Array.from(message.attachments?.values?.() || []);
  for (const [index, attachment] of attachments.entries()) {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const mediaKind = contentType.startsWith('image/')
      ? 'image'
      : contentType.startsWith('video/')
        ? 'video'
        : 'file';
    candidates.push({
      index,
      url: attachment.url,
      proxyUrl: attachment.proxyURL || null,
      originalFilename: attachment.name || `attachment-${index + 1}`,
      safeFilename: stableUploadName(message.id, index, attachment.name, attachment.spoiler),
      contentType: attachment.contentType || null,
      byteSize: Number(attachment.size || 0),
      mediaKind,
      sourceKind: 'source_attachment',
      spoiler: Boolean(attachment.spoiler || /^SPOILER_/u.test(String(attachment.name || ''))),
      width: attachment.width || null,
      height: attachment.height || null,
      durationSeconds: attachment.duration || null
    });
  }

  for (const [embedIndex, embed] of (message.embeds || []).entries()) {
    const raw = serializeEmbed(embed) || {};
    const entries = [
      ['image', raw.image?.url || raw.image?.proxy_url],
      ['thumbnail', raw.thumbnail?.url || raw.thumbnail?.proxy_url],
      ['video', raw.video?.url || raw.video?.proxy_url]
    ];
    for (const [kind, url] of entries) {
      if (!url) continue;
      candidates.push({
        index: attachments.length + candidates.length,
        url,
        originalFilename: `embed-${embedIndex + 1}-${kind}`,
        mediaKind: kind === 'video' ? 'video' : 'image',
        sourceKind: `source_embed_${kind}`,
        spoiler: false
      });
    }
  }

  if (identity.avatarUrl) {
    candidates.push({
      index: candidates.length,
      url: identity.avatarUrl,
      originalFilename: `avatar-${message.author?.id || 'unknown'}.png`,
      mediaKind: 'avatar',
      sourceKind: 'author_avatar',
      spoiler: false
    });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.sourceKind}:${candidate.url}`;
    if (!candidate.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function ensureTimelineUserThread(client, thread, ownerUserId, starterMessageId = null) {
  const now = new Date().toISOString();
  const membership = client.db.timelineRestoration.membership.getOpen(thread.guildId, ownerUserId);
  return client.db.timelineRestoration.userThreads.upsert({
    guildId: thread.guildId,
    ownerUserId,
    forumChannelId: String(thread.parentId || ''),
    threadId: thread.id,
    threadName: thread.name || null,
    starterMessageId: starterMessageId || (thread.id === starterMessageId ? starterMessageId : null),
    status: 'active',
    deletionReason: null,
    createdAt: thread.createdAt?.toISOString?.() || now,
    archivedAt: thread.archived ? (thread.archiveTimestamp?.toISOString?.() || now) : null,
    lockedAt: thread.locked ? now : null,
    membershipEpisodeId: membership?.episodeId || null,
    updatedAt: now
  });
}

async function captureTimelineMessageSnapshot(client, message, { snapshotSource = 'source_message_snapshot' } = {}) {
  if (!client.appConfig.timelineRestoration?.enabled || !message?.inGuild?.() || !isConfiguredTweetThread(message, client.appConfig)) {
    return null;
  }
  if (message.webhookId || message.system) return null;
  if (message.author?.bot && !client.appConfig.timelineRestoration.restoreBotMessages) return null;

  const canonical = message.partial ? await message.fetch().catch(() => null) : message;
  if (!canonical) return null;
  const thread = canonical.channel;
  const ownerUserId = await resolveThreadOwner(client, thread, canonical.author?.id || null);
  if (!ownerUserId) {
    client.logger.warn('timeline restoration snapshot skipped owner unresolved', {
      guildId: canonical.guildId,
      threadId: thread.id,
      sourceMessageId: canonical.id
    });
    return null;
  }
  await ensureTimelineUserThread(client, thread, ownerUserId, canonical.id === thread.id ? canonical.id : null);

  const member = canonical.member
    || await canonical.guild?.members?.fetch?.(canonical.author?.id).catch(() => null);
  const identity = identityFromMember(member, canonical.author);
  const reply = await resolveReplySnapshot(canonical);
  const now = new Date().toISOString();
  const attachments = Array.from(canonical.attachments?.values?.() || []).map(serializeAttachment);
  const embeds = (canonical.embeds || []).map(serializeEmbed).filter(Boolean);
  const components = toRawComponents(canonical);
  const stickers = Array.from(canonical.stickers?.values?.() || []).map(serializeSticker);
  const existing = client.db.timelineRestoration.snapshots.get(canonical.guildId, canonical.id);
  const record = {
    guildId: canonical.guildId,
    sourceForumId: String(thread.parentId || ''),
    sourceThreadId: thread.id,
    sourceMessageId: canonical.id,
    threadOwnerUserId: ownerUserId,
    authorUserId: canonical.author?.id || null,
    authorUsernameSnapshot: identity.username,
    authorGlobalNameSnapshot: identity.globalName,
    authorDisplayNameSnapshot: identity.displayName,
    authorNicknameSnapshot: identity.nickname,
    authorAvatarUrlSnapshot: identity.avatarUrl,
    authorAvatarHashSnapshot: identity.avatarHash,
    authorAvatarSource: identity.avatarSource,
    authorIsBot: canonical.author?.bot ? 1 : 0,
    content: String(canonical.content || ''),
    cleanContent: String(canonical.cleanContent || ''),
    attachmentsJson: json(attachments),
    embedsJson: json(embeds),
    componentsJson: json(components),
    stickersJson: json(stickers),
    reactionsJson: json(serializeReactions(canonical)),
    ...reply,
    messageType: Number(canonical.type || 0),
    sequenceSnowflake: canonical.id,
    sourceCreatedAt: canonical.createdAt?.toISOString?.() || now,
    sourceEditedAt: canonical.editedAt?.toISOString?.() || null,
    sourceDeletedAt: existing?.sourceDeletedAt || null,
    timelineMessageId: existing?.timelineMessageId || null,
    timelineChannelId: existing?.timelineChannelId || null,
    timelineCardPayloadJson: existing?.timelineCardPayloadJson || null,
    timelineCardAuthorAvatarUrl: existing?.timelineCardAuthorAvatarUrl || null,
    snapshotSource,
    restorationFidelity: 'exact_historical_snapshot',
    restoreEligible: canonical.author?.bot ? 0 : 1,
    qualityJson: json({ text: 'exact', identity: identity.avatarUrl ? 'exact' : 'partial', media: attachments.length ? 'pending' : 'not_applicable' }, {}),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const snapshot = client.db.timelineRestoration.snapshots.upsert(record);
  client.logger.info(existing ? 'snapshot updated after edit' : 'timeline restoration snapshot created', {
    guildId: canonical.guildId,
    sourceThreadId: thread.id,
    sourceMessageId: canonical.id,
    snapshotId: snapshot.snapshotId,
    authorUserId: canonical.author?.id || null,
    attachmentCount: attachments.length
  });

  const candidates = collectMessageMediaCandidates(canonical, identity);
  await mirrorSnapshotCandidates(client, snapshot, candidates);
  return snapshot;
}

function serializeTimelinePayload(payload) {
  return {
    flags: Number(payload?.flags || 0),
    components: toRawComponents(payload),
    attachmentNames: (payload?.files || []).map((file) => file?.name || null).filter(Boolean),
    allowedMentions: payload?.allowedMentions || { parse: [] }
  };
}

async function recordTimelineRelayDelivery(client, sourceMessage, sentMessage, payload) {
  const snapshot = client.db.timelineRestoration.snapshots.get(sourceMessage.guildId, sourceMessage.id);
  if (!snapshot) return { valid: true, skipped: true };
  const componentData = extractTimelineComponentData(payload);
  const sentAttachments = collectAttachmentUrls(sentMessage);
  const sentByName = new Map(sentAttachments.map((attachment) => [String(attachment.name || ''), attachment]));
  const missingReferences = componentData.attachmentReferences.filter((reference) => !sentByName.has(reference.filename));
  const zeroByteAttachments = sentAttachments.filter((attachment) => attachment.size <= 0);
  const valid = missingReferences.length === 0 && zeroByteAttachments.length === 0;

  client.db.timelineRestoration.snapshots.updateTimeline(sourceMessage.guildId, sourceMessage.id, {
    timelineMessageId: sentMessage.id,
    timelineChannelId: sentMessage.channelId,
    timelineCardPayloadJson: json(serializeTimelinePayload(payload), {}),
    timelineCardAuthorAvatarUrl: componentData.authorAvatarUrl,
    qualityJson: json({
      timelineMediaVerified: valid,
      expectedAttachmentReferences: componentData.attachmentReferences.length,
      actualAttachments: sentAttachments.length,
      missingReferenceCount: missingReferences.length,
      zeroByteCount: zeroByteAttachments.length
    }, {})
  });

  const mediaRows = client.db.timelineRestoration.media.listBySnapshot(snapshot.snapshotId);
  for (const attachment of sentAttachments) {
    const matched = mediaRows.find((row) => row.safeFilename === attachment.name || row.originalFilename === attachment.name);
    if (matched) {
      client.db.timelineRestoration.media.upsert({
        ...matched,
        timelineMessageId: sentMessage.id,
        timelineAttachmentId: attachment.id,
        timelineAttachmentUrl: attachment.url,
        componentMediaUrl: `attachment://${attachment.name}`,
        lastVerifiedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } else {
      await mirrorMediaCandidate(client, snapshot, {
        index: mediaRows.length,
        url: attachment.url,
        timelineMessageId: sentMessage.id,
        timelineAttachmentId: attachment.id,
        timelineAttachmentUrl: attachment.url,
        componentMediaUrl: `attachment://${attachment.name}`,
        originalFilename: attachment.name,
        safeFilename: attachment.name,
        contentType: attachment.contentType,
        byteSize: attachment.size,
        mediaKind: String(attachment.contentType || '').startsWith('image/')
          ? 'image'
          : String(attachment.contentType || '').startsWith('video/') ? 'video' : 'file',
        sourceKind: 'timeline_attachment',
        spoiler: attachment.spoiler,
        width: attachment.width,
        height: attachment.height
      });
    }
  }

  client.logger[valid ? 'info' : 'warn'](valid ? 'timeline media upload verified' : 'broken timeline media detected', {
    guildId: sourceMessage.guildId,
    sourceMessageId: sourceMessage.id,
    timelineMessageId: sentMessage.id,
    expectedAttachmentReferences: componentData.attachmentReferences.length,
    attachmentCount: sentAttachments.length,
    missingReferenceCount: missingReferences.length,
    zeroByteCount: zeroByteAttachments.length
  });
  return { valid, missingReferences, zeroByteAttachments };
}

async function preserveThreadHistory(client, thread) {
  const ownerUserId = await resolveThreadOwner(client, thread, null);
  if (!ownerUserId) throw Object.assign(new Error('Thread owner could not be resolved'), { code: 'owner_unresolved' });
  await ensureTimelineUserThread(client, thread, ownerUserId, null);
  const startedAt = new Date().toISOString();
  client.db.timelineRestoration.userThreads.beginPreservation(thread.guildId, thread.id, startedAt);
  client.logger.info('thread preservation started', { guildId: thread.guildId, threadId: thread.id, ownerUserId });

  const messages = new Map();
  let before;
  while (true) {
    const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of page.values()) messages.set(message.id, message);
    if (page.size < 100) break;
    before = page.last()?.id;
    if (!before) break;
  }
  const ordered = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id));
  let eligibleCount = 0;
  let failedCount = 0;
  for (const message of ordered) {
    if (message.author?.bot && !client.appConfig.timelineRestoration.restoreBotMessages) continue;
    eligibleCount += 1;
    await captureTimelineMessageSnapshot(client, message, { snapshotSource: 'leave_preservation_fetch' }).catch((error) => {
      failedCount += 1;
      client.logger.warn('timeline preservation message failed', {
        guildId: thread.guildId,
        threadId: thread.id,
        sourceMessageId: message.id,
        errorCode: error.code || 'snapshot_failed'
      });
    });
  }
  const snapshotCount = client.db.timelineRestoration.userThreads.countSnapshots(thread.guildId, thread.id);
  const snapshots = client.db.timelineRestoration.snapshots.listByThreads(thread.guildId, [thread.id]);
  const mediaRows = snapshots.flatMap((snapshot) => client.db.timelineRestoration.media.listBySnapshot(snapshot.snapshotId));
  const mediaCount = mediaRows.filter((row) => row.downloadStatus === 'complete').length;
  const failedMediaCount = mediaRows.filter((row) => row.downloadStatus !== 'complete').length;
  const complete = failedCount === 0 && snapshotCount >= eligibleCount && failedMediaCount === 0;
  const completedAt = new Date().toISOString();
  client.db.timelineRestoration.userThreads.finishPreservation(thread.guildId, thread.id, {
    status: complete ? 'preserved' : 'preservation_incomplete',
    snapshotCount,
    mediaCount,
    coverageJson: json({
      fetchedMessages: ordered.length,
      eligibleMessages: eligibleCount,
      snapshotCount,
      failedCount,
      mediaCount,
      failedMediaCount,
      threadDeletedByBot: false
    }, {}),
    at: completedAt
  });
  client.logger.info('snapshot count verified', {
    guildId: thread.guildId,
    threadId: thread.id,
    eligibleCount,
    snapshotCount,
    complete
  });
  client.logger.info('media preservation verified', {
    guildId: thread.guildId,
    threadId: thread.id,
    mediaCount,
    failedMediaCount,
    complete
  });
  return { complete, eligibleCount, snapshotCount, mediaCount, failedMediaCount, failedCount };
}

module.exports = {
  isConfiguredTweetThread,
  resolveThreadOwner,
  ensureTimelineUserThread,
  captureTimelineMessageSnapshot,
  recordTimelineRelayDelivery,
  preserveThreadHistory,
  collectMessageMediaCandidates,
  serializeAttachment,
  serializeEmbed
};
