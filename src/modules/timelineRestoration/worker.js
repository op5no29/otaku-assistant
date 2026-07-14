const fs = require('node:fs/promises');
const {
  ChannelType,
  PermissionsBitField
} = require('discord.js');
const { resolvePermanentPath, stableUploadName, mirrorMediaCandidate } = require('./mediaMirror');
const { buildProgressPayload, buildCompletionPayload, buildRestorationLog, percent } = require('./ui');
const { notifyOpsChannel } = require('../ops/notify');

const ACTIVE_JOB_STATUSES = new Set(['active', 'retrying', 'completing']);

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function errorCode(error, fallback = 'restoration_failed') {
  return String(error?.code || fallback).slice(0, 120);
}

function sanitizeWebhookUsername(value) {
  const normalized = String(value || '復元されたユーザー')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/discord/giu, 'Dis cord')
    .replace(/clyde/giu, 'C lyde')
    .trim()
    .slice(0, 80);
  return normalized || '復元されたユーザー';
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function truncateReplyExcerpt(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '[返信先の本文を取得できませんでした]';
  return compact.length > 100 ? `${compact.slice(0, 99)}…` : compact;
}

function buildRestoredContent(snapshot) {
  const blocks = [];
  let replyStatus = 'not_a_reply';
  if (snapshot.referencedSourceMessageId) {
    const targetName = snapshot.referencedAuthorNameSnapshot || '不明なユーザー';
    blocks.push(`↪ ${targetName}「${truncateReplyExcerpt(snapshot.referencedContentSnapshot)}」への返信`);
    replyStatus = snapshot.referencedContentSnapshot ? 'visual_reply_context' : 'target_unavailable';
  }
  if (snapshot.content) blocks.push(String(snapshot.content));
  const stickers = safeJson(snapshot.stickersJson, []);
  if (stickers.length) {
    blocks.push(stickers.map((sticker) => `[復元したステッカー: ${sticker.name || sticker.id || '不明'}]`).join('\n'));
  }
  const fullContent = blocks.join('\n\n');
  const truncated = fullContent.length > 2000;
  return {
    content: truncated
      ? `${fullContent.slice(0, 1960).trimEnd()}\n\n[本文の一部を復元できませんでした]`
      : (fullContent || null),
    replyStatus,
    textStatus: truncated ? 'truncated' : (snapshot.content ? 'restored' : 'not_applicable')
  };
}

async function resolveHistoricalAvatar(client, snapshot) {
  if (/^https?:\/\//iu.test(String(snapshot.authorAvatarUrlSnapshot || ''))) {
    return { url: snapshot.authorAvatarUrlSnapshot, source: snapshot.authorAvatarSource || 'source_message_snapshot' };
  }
  if (/^https?:\/\//iu.test(String(snapshot.timelineCardAuthorAvatarUrl || ''))) {
    return { url: snapshot.timelineCardAuthorAvatarUrl, source: 'timeline_component_thumbnail' };
  }
  if (snapshot.authorUserId) {
    const historical = client.db.timelineRestoration.identities.nearest(
      snapshot.guildId,
      snapshot.authorUserId,
      snapshot.sourceCreatedAt
    );
    if (historical?.avatarUrl) return { url: historical.avatarUrl, source: 'membership_history' };
    const user = await client.users.fetch(snapshot.authorUserId).catch(() => null);
    if (user) {
      return {
        url: user.displayAvatarURL({ extension: 'png', size: 256 }),
        source: user.avatar ? 'current_discord_profile' : 'default_avatar'
      };
    }
  }
  return { url: null, source: 'generic_fallback' };
}

async function prepareRestorationFiles(client, snapshot, { allowRecovery = true } = {}) {
  let rows = client.db.timelineRestoration.media.listBySnapshot(snapshot.snapshotId)
    .filter((row) => row.mediaKind !== 'avatar');
  for (const row of allowRecovery ? rows.filter((entry) => entry.downloadStatus !== 'complete') : []) {
    const fallbacks = [
      ['restore_timeline_attachment', row.timelineAttachmentUrl],
      ['restore_source_attachment', row.sourceUrl],
      ['restore_component_media', row.componentMediaUrl],
      ['restore_proxy_url', row.proxyUrl]
    ].filter(([, url], index, all) => url && all.findIndex((entry) => entry[1] === url) === index);
    for (const [sourceKind, url] of fallbacks) {
      const recovered = await mirrorMediaCandidate(client, snapshot, {
        index: row.mediaId,
        url,
        originalFilename: row.originalFilename,
        safeFilename: row.safeFilename,
        contentType: row.contentType,
        mediaKind: row.mediaKind,
        sourceKind,
        spoiler: Boolean(row.spoiler)
      });
      if (recovered?.downloadStatus === 'complete') break;
    }
  }
  rows = client.db.timelineRestoration.media.listBySnapshot(snapshot.snapshotId)
    .filter((row) => row.mediaKind !== 'avatar');
  const completeRows = rows.filter((row) => row.downloadStatus === 'complete');
  const seenHashes = new Set();
  rows = rows.filter((row) => {
    if (row.downloadStatus === 'complete') {
      if (row.sha256 && seenHashes.has(row.sha256)) return false;
      if (row.sha256) seenHashes.add(row.sha256);
      return true;
    }
    return !completeRows.some((complete) => (
      (row.safeFilename && complete.safeFilename === row.safeFilename)
      || (row.originalFilename && complete.originalFilename === row.originalFilename)
      || (row.sourceUrl && [complete.sourceUrl, complete.timelineAttachmentUrl, complete.componentMediaUrl].includes(row.sourceUrl))
    ));
  });
  const files = [];
  const unavailable = [];
  const counts = { image: 0, video: 0, file: 0 };
  const maxUpload = Number(client.appConfig.mediaRelay?.maxReuploadBytes || 25_000_000);
  const usedNames = new Set();
  const sourceAttachments = safeJson(snapshot.attachmentsJson, []);
  for (const [index, row] of rows.entries()) {
    if (files.length >= 10) {
      unavailable.push(row);
      continue;
    }
    const permanentPath = row.downloadStatus === 'complete' ? resolvePermanentPath(row.localPath) : null;
    const stat = permanentPath ? await fs.stat(permanentPath).catch(() => null) : null;
    if (!stat?.isFile() || stat.size <= 0 || stat.size > maxUpload) {
      unavailable.push(row);
      continue;
    }
    let name = row.safeFilename || stableUploadName(snapshot.sourceMessageId, index, row.originalFilename, row.spoiler);
    while (usedNames.has(name)) name = stableUploadName(snapshot.sourceMessageId, index + usedNames.size + 1, name, row.spoiler);
    usedNames.add(name);
    const sourceAttachment = sourceAttachments.find((attachment) => (
      attachment.name === row.originalFilename || attachment.url === row.sourceUrl
    ));
    files.push({
      attachment: permanentPath,
      name,
      description: sourceAttachment?.description || undefined
    });
    const kind = row.mediaKind === 'image' || row.mediaKind === 'video' ? row.mediaKind : 'file';
    counts[kind] += 1;
  }
  return { files, unavailable, counts };
}

function unavailablePlaceholders(rows) {
  return rows.map((row) => {
    if (row.mediaKind === 'image') return '[復元できなかった画像]';
    if (row.mediaKind === 'video') return '[元の動画は現在取得できません]';
    return `[復元できなかった添付ファイル: ${row.originalFilename || 'attachment'}]`;
  });
}

async function resolveManagedWebhook(client, guild, forum) {
  const store = client.db.timelineRestoration.webhooks;
  const tracked = store.get(guild.id, forum.id);
  const webhooks = await forum.fetchWebhooks();
  let webhook = tracked ? webhooks.get(tracked.webhookId) : null;
  if (webhook && String(webhook.channelId) !== String(forum.id)) webhook = null;
  if (!webhook) {
    webhook = webhooks.find((candidate) => (
      String(candidate.channelId) === String(forum.id)
      && candidate.name === client.appConfig.timelineRestoration.managedWebhookName
      && (!candidate.owner?.id || String(candidate.owner.id) === String(client.user.id))
    )) || null;
  }
  if (!webhook) {
    webhook = await forum.createWebhook({
      name: client.appConfig.timelineRestoration.managedWebhookName,
      reason: 'Timeline restoration replay'
    });
  }
  if (!webhook?.token) {
    webhook = await client.fetchWebhook(webhook.id).catch(() => webhook);
  }
  if (!webhook?.token) {
    throw Object.assign(new Error('Managed restoration webhook token unavailable'), { code: 'webhook_token_unavailable' });
  }
  store.upsert(guild.id, forum.id, webhook.id);
  client.managedTimelineRestorationWebhookIds.add(String(webhook.id));
  client.logger.info('restoration webhook resolved', {
    guildId: guild.id,
    forumChannelId: forum.id,
    webhookId: webhook.id,
    createdByBot: String(webhook.owner?.id || '') === String(client.user.id)
  });
  return webhook;
}

async function auditRestorationPermissions(client) {
  const required = [
    ['ViewChannel', PermissionsBitField.Flags.ViewChannel],
    ['ReadMessageHistory', PermissionsBitField.Flags.ReadMessageHistory],
    ['SendMessages', PermissionsBitField.Flags.SendMessages],
    ['SendMessagesInThreads', PermissionsBitField.Flags.SendMessagesInThreads],
    ['CreatePublicThreads', PermissionsBitField.Flags.CreatePublicThreads],
    ['ManageThreads', PermissionsBitField.Flags.ManageThreads],
    ['ManageMessages', PermissionsBitField.Flags.ManageMessages],
    ['ManageWebhooks', PermissionsBitField.Flags.ManageWebhooks],
    ['AttachFiles', PermissionsBitField.Flags.AttachFiles],
    ['EmbedLinks', PermissionsBitField.Flags.EmbedLinks]
  ];
  const failures = [];
  const configuredGuildId = String(process.env.GUILD_ID || '');
  const configuredGuild = configuredGuildId ? client.guilds.cache.get(configuredGuildId) : null;
  if (configuredGuildId && !configuredGuild) {
    failures.push({ guildId: configuredGuildId, forumId: null, missing: ['Guild'] });
    client.timelineRestorationPermissionsReady = false;
    client.logger.error('timeline restoration permission validation failed', { failures });
    return { ok: false, failures };
  }
  const guilds = configuredGuildId
    ? [configuredGuild]
    : [...client.guilds.cache.values()];
  const forumIds = client.appConfig.watchedForums?.tweet || [];
  if (!forumIds.length) {
    failures.push({ guildId: configuredGuildId || null, forumId: null, missing: ['ConfiguredTweetForum'] });
  }
  for (const guild of guilds) {
    for (const forumId of forumIds) {
      const forum = await guild.channels.fetch(forumId).catch(() => null);
      if (!forum || forum.type !== ChannelType.GuildForum) {
        failures.push({ guildId: guild.id, forumId, missing: ['ForumChannel'] });
        continue;
      }
      const permissions = forum.permissionsFor(guild.members.me);
      const missing = required.filter(([, flag]) => !permissions?.has(flag)).map(([name]) => name);
      if (missing.length) failures.push({ guildId: guild.id, forumId, missing });
    }
  }
  client.timelineRestorationPermissionsReady = failures.length === 0;
  if (failures.length) {
    client.logger.error('timeline restoration permission validation failed', { failures });
  } else {
    client.logger.info('timeline restoration permission validation passed', {
      forumCount: (client.appConfig.watchedForums?.tweet || []).length
    });
  }
  return { ok: failures.length === 0, failures };
}

async function applyRestorationThreadState(client, thread, job) {
  const tagId = client.appConfig.timelineRestoration.restoringTagIds?.[String(thread.parentId || '')];
  const tags = [...new Set([...(thread.appliedTags || []), ...(tagId ? [tagId] : [])])].slice(0, 5);
  if (thread.archived) await thread.setArchived(false, 'Timeline restoration started');
  if (!thread.locked) await thread.setLocked(true, 'Timeline restoration in progress');
  if (Number(client.appConfig.timelineRestoration.temporarySlowmodeSeconds || 0) !== Number(thread.rateLimitPerUser || 0)) {
    await thread.setRateLimitPerUser(client.appConfig.timelineRestoration.temporarySlowmodeSeconds, 'Timeline restoration in progress');
  }
  if (tagId && JSON.stringify(tags) !== JSON.stringify(thread.appliedTags || [])) {
    await thread.setAppliedTags(tags, 'Timeline restoration in progress');
  }
  client.logger.info('restoration thread locked', {
    guildId: job.guildId,
    destinationThreadId: thread.id,
    jobId: job.jobId,
    restoringTagApplied: Boolean(tagId)
  });
}

async function restoreOriginalThreadState(client, thread, job, { restoreArchived = true } = {}) {
  const previousTags = safeJson(job.previousAppliedTagsJson, []);
  await thread.setLocked(Boolean(job.previousThreadLocked), 'Timeline restoration finished').catch(() => null);
  await thread.setRateLimitPerUser(Number(job.previousSlowmodeSeconds || 0), 'Timeline restoration finished').catch(() => null);
  await thread.setAppliedTags(previousTags, 'Timeline restoration finished').catch(() => null);
  if (restoreArchived && job.previousThreadArchived) {
    await thread.setArchived(true, 'Timeline restoration finished').catch(() => null);
  }
  client.logger.info('restoration thread unlocked', {
    guildId: job.guildId,
    destinationThreadId: thread.id,
    jobId: job.jobId,
    restoredLockedState: Boolean(job.previousThreadLocked)
  });
}

async function moveProgressCardToBottom(client, thread, job, options = {}) {
  const latest = client.db.timelineRestoration.jobs.get(job.jobId) || job;
  const priorMessageId = latest.progressMessageId || null;
  let sent;
  try {
    sent = await thread.send(buildProgressPayload(latest, options));
  } catch (error) {
    client.logger.warn('restoration progress card replacement send failed', {
      guildId: job.guildId,
      destinationThreadId: thread.id,
      jobId: job.jobId,
      retainedProgressMessageId: priorMessageId,
      errorCode: errorCode(error, 'progress_card_send_failed')
    });
    throw error;
  }
  try {
    const persisted = client.db.timelineRestoration.jobs.replaceProgressMessage(
      job.jobId,
      priorMessageId,
      sent.id
    );
    if (!persisted.updated || String(persisted.job?.progressMessageId || '') !== String(sent.id)) {
      throw Object.assign(new Error('Progress message ID was not persisted'), { code: 'progress_card_persist_failed' });
    }
  } catch (error) {
    const orphanDeleted = typeof sent.delete === 'function'
      ? await sent.delete().then(() => true).catch(() => false)
      : false;
    client.logger.error('restoration progress card persistence failed', {
      guildId: job.guildId,
      destinationThreadId: thread.id,
      jobId: job.jobId,
      retainedProgressMessageId: priorMessageId,
      orphanedProgressMessageId: sent.id,
      orphanDeleted,
      errorCode: errorCode(error, 'progress_card_persist_failed')
    });
    throw error;
  }
  if (priorMessageId && String(priorMessageId) !== String(sent.id)) {
    const prior = await thread.messages.fetch(priorMessageId).catch(() => null);
    await prior?.delete?.().catch((error) => {
      client.logger.warn('restoration previous progress card delete failed', {
        guildId: job.guildId,
        destinationThreadId: thread.id,
        jobId: job.jobId,
        priorProgressMessageId: priorMessageId,
        replacementProgressMessageId: sent.id,
        errorCode: errorCode(error, 'progress_card_delete_failed')
      });
    });
  }
  client.logger.info('progress card updated', {
    guildId: job.guildId,
    destinationThreadId: thread.id,
    jobId: job.jobId,
    progressMessageId: sent.id,
    keptAtBottom: true
  });
  return sent;
}

function calculateJobQuality(client, jobId) {
  const job = client.db.timelineRestoration.jobs.get(jobId);
  const items = client.db.timelineRestoration.jobs.listItems(jobId);
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let images = 0;
  let videos = 0;
  let files = 0;
  let unavailable = 0;
  let replies = 0;
  let replyExpected = 0;
  let identityExact = 0;
  let identityFallback = 0;
  const identitySourceCounts = {};
  let textExpected = 0;
  let textRestored = 0;
  for (const item of items) {
    if (item.status === 'posted') completed += 1;
    else if (item.status === 'skipped_duplicate') skipped += 1;
    else if (item.status === 'failed_permanent') failed += 1;
    const media = safeJson(item.mediaStatus, {});
    images += Number(media.image || 0);
    videos += Number(media.video || 0);
    files += Number(media.file || 0);
    unavailable += Number(media.unavailable || 0);
    if (item.replyStatus && item.replyStatus !== 'not_a_reply') replyExpected += 1;
    if (['native_reference', 'visual_reply_context'].includes(item.replyStatus)) replies += 1;
    const snapshot = client.db.timelineRestoration.snapshots.getById(item.snapshotId);
    if (snapshot?.content) {
      textExpected += 1;
      if (item.textStatus === 'restored') textRestored += 1;
    }
    const identitySource = item.identitySourceUsed || snapshot?.authorAvatarSource || 'generic_fallback';
    identitySourceCounts[identitySource] = Number(identitySourceCounts[identitySource] || 0) + 1;
    if (['source_message_snapshot', 'timeline_component_thumbnail', 'timeline_attachment'].includes(identitySource)) {
      identityExact += 1;
    } else {
      identityFallback += 1;
    }
  }
  const totalMedia = images + videos + files + unavailable;
  const messageNumerator = completed + skipped;
  const mediaNumerator = images + videos + files;
  const messageRate = percent(messageNumerator, items.length);
  const mediaRate = percent(mediaNumerator, totalMedia);
  const replyRate = percent(replies, replyExpected);
  const identityRate = percent(identityExact, items.length);
  const textRate = percent(textRestored, textExpected);
  const overallRate = Math.round((messageRate * 0.35 + textRate * 0.2 + mediaRate * 0.2 + replyRate * 0.1 + identityRate * 0.15) * 10) / 10;
  return {
    job,
    items,
    counts: { completed, failed, skipped, images, videos, files, unavailable, replies },
    quality: {
      messageRate,
      messageNumerator,
      messageDenominator: items.length,
      textRate,
      textNumerator: textRestored,
      textDenominator: textExpected,
      mediaRate,
      mediaNumerator,
      mediaDenominator: totalMedia,
      replyRate,
      replyNumerator: replies,
      replyDenominator: replyExpected,
      identityRate,
      identityNumerator: identityExact,
      identityDenominator: items.length,
      identityFallbackCount: identityFallback,
      identitySourceCounts,
      overallRate
    }
  };
}

function persistJobCounts(client, jobId) {
  const calculated = calculateJobQuality(client, jobId);
  const handled = calculated.counts.completed + calculated.counts.failed + calculated.counts.skipped;
  const currentSequence = calculated.items
    .filter((item) => ['posted', 'failed_permanent', 'skipped_duplicate'].includes(item.status))
    .reduce((maximum, item) => Math.max(maximum, Number(item.sequenceIndex || 0)), 0);
  return client.db.timelineRestoration.jobs.update(jobId, {
    completedItemCount: calculated.counts.completed,
    failedItemCount: calculated.counts.failed,
    skippedItemCount: calculated.counts.skipped,
    textRestoredCount: calculated.items.filter((item) => item.textStatus === 'restored').length,
    imageRestoredCount: calculated.counts.images,
    videoRestoredCount: calculated.counts.videos,
    fileRestoredCount: calculated.counts.files,
    replyRestoredCount: calculated.counts.replies,
    unavailableMediaCount: calculated.counts.unavailable,
    currentSequence,
    progressPercent: percent(handled, calculated.items.length),
    qualityJson: JSON.stringify(calculated.quality),
    updatedAt: new Date().toISOString()
  });
}

async function postRestorationItem(client, job, item, webhook, thread) {
  const existingMap = client.db.timelineRestoration.restoredMessages.getBySnapshotJob(job.jobId, item.snapshotId);
  if (existingMap) {
    client.db.timelineRestoration.jobs.updateItem(job.jobId, item.snapshotId, {
      status: 'skipped_duplicate',
      destinationMessageId: existingMap.destinationMessageId,
      lastErrorCode: null,
      processedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    client.logger.info('restoration duplicate prevented', {
      guildId: job.guildId,
      jobId: job.jobId,
      snapshotId: item.snapshotId,
      destinationMessageId: existingMap.destinationMessageId
    });
    return;
  }
  const snapshot = client.db.timelineRestoration.snapshots.getById(item.snapshotId);
  if (!snapshot) throw Object.assign(new Error('Restoration snapshot missing'), { code: 'snapshot_missing' });
  const avatar = await resolveHistoricalAvatar(client, snapshot);
  const username = sanitizeWebhookUsername(snapshot.authorDisplayNameSnapshot || snapshot.authorUsernameSnapshot);
  const restored = buildRestoredContent(snapshot);
  const media = await prepareRestorationFiles(client, snapshot, {
    allowRecovery: job.mode !== 'admin_test'
  });
  const placeholders = unavailablePlaceholders(media.unavailable);
  const content = [restored.content, ...placeholders].filter(Boolean).join('\n\n').slice(0, 2000) || (media.files.length ? undefined : '（復元できる本文はありませんでした）');
  if (item.status === 'posting') {
    const threshold = Math.max(0, new Date(item.updatedAt || 0).getTime() - 1000);
    const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
    const expectedNames = [...media.files.map((file) => file.name)].sort();
    const recovered = recent?.find((candidate) => {
      if (String(candidate.webhookId || '') !== String(webhook.id)) return false;
      if (client.db.timelineRestoration.restoredMessages.get(job.guildId, candidate.id)) return false;
      if (candidate.createdTimestamp < threshold || String(candidate.content || '') !== String(content || '')) return false;
      const names = Array.from(candidate.attachments.values()).map((attachment) => attachment.name).sort();
      return JSON.stringify(names) === JSON.stringify(expectedNames);
    }) || null;
    if (recovered) {
      const inserted = client.db.timelineRestoration.restoredMessages.insert({
        guildId: job.guildId,
        destinationMessageId: recovered.id,
        destinationThreadId: thread.id,
        snapshotId: snapshot.snapshotId,
        restorationJobId: job.jobId,
        webhookId: webhook.id
      });
      const winner = inserted
        ? null
        : client.db.timelineRestoration.restoredMessages.getBySnapshotJob(job.jobId, snapshot.snapshotId);
      const recoveredDestinationMessageId = winner?.destinationMessageId || recovered.id;
      if (winner?.destinationMessageId && String(winner.destinationMessageId) !== String(recovered.id)) {
        await recovered.delete().catch(() => null);
      }
      client.db.timelineRestoration.jobs.updateItem(job.jobId, item.snapshotId, {
        status: 'posted',
        destinationMessageId: recoveredDestinationMessageId,
        destinationWebhookId: webhook.id,
        authorNameUsed: username,
        avatarUrlUsed: avatar.url,
        identitySourceUsed: avatar.source,
        textStatus: restored.textStatus,
        mediaStatus: JSON.stringify({ ...media.counts, unavailable: media.unavailable.length }),
        replyStatus: restored.replyStatus,
        lastErrorCode: null,
        processedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      client.logger.info('restoration duplicate prevented', {
        guildId: job.guildId,
        jobId: job.jobId,
        snapshotId: snapshot.snapshotId,
        destinationMessageId: recoveredDestinationMessageId,
        recoverySource: 'posting_state_webhook_scan'
      });
      return;
    }
  }
  const attemptAt = new Date().toISOString();
  client.db.timelineRestoration.jobs.updateItem(job.jobId, item.snapshotId, {
    status: 'posting',
    attempts: Number(item.attempts || 0) + 1,
    authorNameUsed: username,
    avatarUrlUsed: avatar.url,
    identitySourceUsed: avatar.source,
    updatedAt: attemptAt
  });
  client.logger.info('restoration identity source selected', {
    guildId: job.guildId,
    jobId: job.jobId,
    snapshotId: snapshot.snapshotId,
    authorUserId: snapshot.authorUserId,
    identitySource: avatar.source
  });
  client.logger.info('restoration reply source selected', {
    guildId: job.guildId,
    jobId: job.jobId,
    snapshotId: snapshot.snapshotId,
    replyStatus: restored.replyStatus
  });
  const sent = await webhook.send({
    threadId: thread.id,
    username,
    avatarURL: avatar.url || undefined,
    content,
    files: media.files,
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    wait: true
  });
  const inserted = client.db.timelineRestoration.restoredMessages.insert({
    guildId: job.guildId,
    destinationMessageId: sent.id,
    destinationThreadId: thread.id,
    snapshotId: snapshot.snapshotId,
    restorationJobId: job.jobId,
    webhookId: webhook.id
  });
  let destinationMessageId = sent.id;
  if (!inserted) {
    const winner = client.db.timelineRestoration.restoredMessages.getBySnapshotJob(job.jobId, snapshot.snapshotId);
    if (winner?.destinationMessageId && String(winner.destinationMessageId) !== String(sent.id)) {
      await sent.delete().catch(() => null);
      destinationMessageId = winner.destinationMessageId;
      client.logger.info('restoration duplicate prevented', {
        guildId: job.guildId,
        jobId: job.jobId,
        snapshotId: snapshot.snapshotId,
        discardedDestinationMessageId: sent.id,
        destinationMessageId
      });
    }
  }
  client.db.timelineRestoration.jobs.updateItem(job.jobId, item.snapshotId, {
    status: 'posted',
    destinationMessageId,
    destinationWebhookId: webhook.id,
    authorNameUsed: username,
    avatarUrlUsed: avatar.url,
    identitySourceUsed: avatar.source,
    textStatus: restored.textStatus,
    mediaStatus: JSON.stringify({ ...media.counts, unavailable: media.unavailable.length }),
    replyStatus: restored.replyStatus,
    lastErrorCode: null,
    processedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  client.logger.info('restoration item posted', {
    guildId: job.guildId,
    jobId: job.jobId,
    snapshotId: snapshot.snapshotId,
    sourceMessageId: snapshot.sourceMessageId,
    destinationMessageId,
    authorUserId: snapshot.authorUserId,
    mediaCount: media.files.length,
    unavailableMediaCount: media.unavailable.length
  });
}

async function finalizeRestoration(client, job, thread) {
  const now = new Date().toISOString();
  let latest = persistJobCounts(client, job.jobId);
  if (job.status !== 'completing') {
    const claimed = client.db.timelineRestoration.jobs.claimCompletion(job.jobId, now);
    if (!claimed) return client.db.timelineRestoration.jobs.get(job.jobId);
  }
  latest = client.db.timelineRestoration.jobs.get(job.jobId);
  const progress = latest.progressMessageId ? await thread.messages.fetch(latest.progressMessageId).catch(() => null) : null;
  await progress?.delete?.().catch(() => null);
  await restoreOriginalThreadState(client, thread, latest, { restoreArchived: false });
  const items = client.db.timelineRestoration.jobs.listItems(job.jobId);
  const snapshotsById = new Map(items.map((item) => [Number(item.snapshotId), client.db.timelineRestoration.snapshots.getById(item.snapshotId)]));
  const completingJob = { ...latest, status: 'completed', completedAt: now };
  const logBuffer = buildRestorationLog(completingJob, items, snapshotsById);
  let completion = latest.completionMessageId
    ? await thread.messages.fetch(latest.completionMessageId).catch(() => null)
    : null;
  if (!completion) {
    const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
    const customId = `timeline_restore:dismiss:${job.jobId}`;
    completion = recent?.find((candidate) => (
      String(candidate.author?.id || '') === String(client.user?.id || '')
      && JSON.stringify(candidate.components?.map((component) => component.toJSON?.() || component) || []).includes(customId)
    )) || null;
  }
  if (!completion) completion = await thread.send(buildCompletionPayload(completingJob, logBuffer));
  latest = client.db.timelineRestoration.jobs.update(job.jobId, {
    status: 'completed',
    completedAt: now,
    nextRunAt: null,
    completionMessageId: completion.id,
    progressMessageId: null,
    updatedAt: new Date().toISOString()
  });
  if (latest.previousThreadArchived) {
    await thread.setArchived(true, 'Timeline restoration finished').catch(() => null);
  }
  if (latest.mode !== 'admin_test') {
    for (const sourceThreadId of safeJson(latest.sourceThreadIdsJson, [])) {
      client.db.timelineRestoration.userThreads.setRestoration(job.guildId, sourceThreadId, {
        replacementThreadId: thread.id,
        jobId: job.jobId
      });
    }
  }
  client.logger.info('restoration completed', {
    guildId: job.guildId,
    jobId: job.jobId,
    mode: latest.mode || 'normal',
    destinationThreadId: thread.id,
    completedItemCount: latest.completedItemCount,
    failedItemCount: latest.failedItemCount,
    quality: safeJson(latest.qualityJson, {})
  });
  client.logger.info('completion owner notified', {
    guildId: job.guildId,
    jobId: job.jobId,
    ownerUserId: job.ownerUserId,
    notifiedUserId: latest.mode === 'admin_test' ? latest.initiatorUserId : job.ownerUserId,
    completionMessageId: completion.id
  });
  await notifyOpsChannel(client, `Timeline restoration completed\n- Job: ${job.jobId}\n- Thread: ${thread.id}\n- Success: ${latest.completedItemCount}\n- Failed: ${latest.failedItemCount}`, {
    severity: latest.failedItemCount ? 'warn' : 'info',
    eventType: 'timeline_restoration_completed',
    immediateDashboard: true
  });
  return latest;
}

async function processRestorationJob(client, rawJob) {
  const lockKey = String(rawJob.jobId);
  if (client.timelineRestorationJobLocks.has(lockKey)) return;
  client.timelineRestorationJobLocks.add(lockKey);
  try {
    let job = client.db.timelineRestoration.jobs.get(rawJob.jobId);
    if (!ACTIVE_JOB_STATUSES.has(job?.status)) return;
    const guild = client.guilds.cache.get(job.guildId) || await client.guilds.fetch(job.guildId).catch(() => null);
    const thread = guild ? await guild.channels.fetch(job.destinationThreadId).catch(() => null) : null;
    if (!thread?.isThread?.()) {
      client.db.timelineRestoration.jobs.update(job.jobId, {
        status: 'failed', lastErrorCode: 'destination_thread_missing', nextRunAt: null, updatedAt: new Date().toISOString()
      });
      return;
    }
    await applyRestorationThreadState(client, thread, job);
    const forum = thread.parent;
    const webhook = await resolveManagedWebhook(client, guild, forum);
    const pending = client.db.timelineRestoration.jobs.listPendingItems(job.jobId, client.appConfig.timelineRestoration.messagesPerBatch);
    if (!pending.length) {
      await finalizeRestoration(client, job, thread);
      return;
    }
    client.logger.info('restoration job resumed', {
      guildId: job.guildId,
      jobId: job.jobId,
      pendingInBatch: pending.length
    });
    for (const item of pending) {
      job = client.db.timelineRestoration.jobs.get(job.jobId);
      if (!ACTIVE_JOB_STATUSES.has(job.status)) break;
      try {
        await postRestorationItem(client, job, item, webhook, thread);
      } catch (error) {
        const attempts = Number(item.attempts || 0) + 1;
        const permanent = attempts >= Number(client.appConfig.timelineRestoration.maxAttemptsPerItem || 5);
        client.db.timelineRestoration.jobs.updateItem(job.jobId, item.snapshotId, {
          status: permanent ? 'failed_permanent' : 'failed_retryable',
          attempts,
          lastErrorCode: errorCode(error),
          processedAt: permanent ? new Date().toISOString() : null,
          updatedAt: new Date().toISOString()
        });
        client.logger[permanent ? 'error' : 'warn'](permanent ? 'restoration item permanently failed' : 'restoration retry scheduled', {
          guildId: job.guildId,
          jobId: job.jobId,
          snapshotId: item.snapshotId,
          attempts,
          errorCode: errorCode(error)
        });
      }
      job = persistJobCounts(client, job.jobId);
      if (!ACTIVE_JOB_STATUSES.has(job.status)) break;
      await moveProgressCardToBottom(client, thread, job);
      await delay(client.appConfig.timelineRestoration.delayBetweenMessagesMs);
    }
    job = persistJobCounts(client, job.jobId);
    if (!ACTIVE_JOB_STATUSES.has(job.status)) return;
    const remaining = client.db.timelineRestoration.jobs.listPendingItems(job.jobId, 1);
    if (!remaining.length) {
      await finalizeRestoration(client, job, thread);
      return;
    }
    client.db.timelineRestoration.jobs.update(job.jobId, {
      status: 'active',
      lastProcessedAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + client.appConfig.timelineRestoration.delayBetweenBatchesMs).toISOString(),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    const job = client.db.timelineRestoration.jobs.get(rawJob.jobId);
    if (job && ACTIVE_JOB_STATUSES.has(job.status)) {
      const retryDelayMs = Math.min(
        15 * 60_000,
        Math.max(client.appConfig.timelineRestoration.delayBetweenBatchesMs, 30_000)
      );
      client.db.timelineRestoration.jobs.update(job.jobId, {
        status: 'retrying',
        lastErrorCode: errorCode(error),
        lastProcessedAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + retryDelayMs).toISOString(),
        updatedAt: new Date().toISOString()
      });
      client.logger.warn('restoration retry scheduled', {
        guildId: job.guildId,
        jobId: job.jobId,
        errorCode: errorCode(error),
        retryDelayMs
      });
    }
  } finally {
    client.timelineRestorationJobLocks.delete(lockKey);
  }
}

async function runTimelineRestorationWorker(client) {
  if (!client.appConfig.timelineRestoration?.enabled || !client.timelineRestorationPermissionsReady) return;
  if (client.timelineRestorationWorkerRunning) return;
  client.timelineRestorationWorkerRunning = true;
  try {
    const capacity = Math.max(0, client.appConfig.timelineRestoration.maxConcurrentJobs - client.timelineRestorationJobLocks.size);
    if (!capacity) return;
    const due = client.db.timelineRestoration.jobs.listDue(new Date().toISOString(), capacity);
    await Promise.all(due.map((job) => processRestorationJob(client, job)));
  } finally {
    client.timelineRestorationWorkerRunning = false;
  }
}

function startTimelineRestorationWorker(client) {
  if (client.timelineRestorationWorkerInterval) clearInterval(client.timelineRestorationWorkerInterval);
  void runTimelineRestorationWorker(client).catch((error) => {
    client.logger.error('timeline restoration worker failed', { errorCode: errorCode(error) });
  });
  client.timelineRestorationWorkerInterval = setInterval(() => {
    void runTimelineRestorationWorker(client).catch((error) => {
      client.logger.error('timeline restoration worker failed', { errorCode: errorCode(error) });
    });
  }, 5000);
  client.timelineRestorationWorkerInterval.unref?.();
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  sanitizeWebhookUsername,
  auditRestorationPermissions,
  applyRestorationThreadState,
  restoreOriginalThreadState,
  moveProgressCardToBottom,
  calculateJobQuality,
  persistJobCounts,
  resolveManagedWebhook,
  postRestorationItem,
  finalizeRestoration,
  processRestorationJob,
  runTimelineRestorationWorker,
  startTimelineRestorationWorker
};
