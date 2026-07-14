const { AttachmentBuilder, ChannelType } = require('discord.js');
const { isAdministrator } = require('../../utils/permissions');
const {
  isConfiguredTweetThread,
  resolveThreadOwner,
  ensureTimelineUserThread,
  captureTimelineMessageSnapshot,
  recordTimelineRelayDelivery,
  preserveThreadHistory
} = require('./snapshots');
const {
  handleReturningMember,
  scheduleDepartedMemberPreservation,
  schedulePendingDepartedPreservationsOnReady,
  startReturnNoticeRetryWorker
} = require('./lifecycle');
const {
  ACTIVE_JOB_STATUSES,
  auditRestorationPermissions,
  applyRestorationThreadState,
  restoreOriginalThreadState,
  moveProgressCardToBottom,
  persistJobCounts,
  startTimelineRestorationWorker
} = require('./worker');
const { buildRestorationLog } = require('./ui');

function isRestorationAdmin(interaction) {
  return isAdministrator(interaction.member);
}

function isGuildOwner(interaction) {
  return Boolean(interaction?.guild?.ownerId)
    && String(interaction.guild.ownerId) === String(interaction.user?.id || '');
}

function normalizeUserIdOption(value) {
  const match = String(value || '').trim().match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/u);
  return match ? String(match[1] || match[2]) : null;
}

function isDiscordSnowflake(value) {
  return /^\d{17,20}$/u.test(String(value || ''));
}

async function resolveDiscordThreadCreatorId(thread) {
  if (isDiscordSnowflake(thread?.ownerId)) return String(thread.ownerId);
  const owner = await thread?.fetchOwner?.().catch(() => null);
  return isDiscordSnowflake(owner?.id) ? String(owner.id) : null;
}

function restorationRequestError(outcome) {
  if (String(outcome || '').startsWith('conflict_')) {
    return Object.assign(new Error(
      'この復元先スレッドは別の復元ジョブに関連付けられています。新しいテスト用スレッドを作成して再実行してください。'
    ), { code: outcome });
  }
  if (outcome === 'already_active') {
    return Object.assign(new Error('このスレッドでは、同じ復元ジョブがすでに進行中です。'), { code: 'job_active' });
  }
  if (outcome === 'already_completed') {
    return Object.assign(new Error(
      'このスレッドには完了済みの復元記録があります。別の復元先スレッドを使用してください。'
    ), { code: 'job_already_completed' });
  }
  return Object.assign(new Error(
    'このスレッドの既存復元ジョブは、この操作では再開できません。管理者が状態を確認してください。'
  ), { code: outcome || 'job_not_resumable' });
}

function activeJobForThread(client, guildId, threadId) {
  const job = client.db.timelineRestoration.jobs.getByThread(guildId, threadId);
  return job && ACTIVE_JOB_STATUSES.has(job.status) ? job : null;
}

async function handleRestorationMessageCreate(message) {
  if (!message?.inGuild?.() || !message.channel?.isThread?.()) return false;
  const client = message.client;
  if (!client.appConfig.timelineRestoration?.enabled) return false;

  const mapped = client.db.timelineRestoration.restoredMessages.get(message.guildId, message.id);
  if (mapped) return true;
  const activeJob = activeJobForThread(client, message.guildId, message.channelId);
  const managedWebhook = message.webhookId
    && client.managedTimelineRestorationWebhookIds.has(String(message.webhookId));
  if (managedWebhook) return true;
  if (!activeJob) return false;
  if (message.author?.id === client.user?.id || message.author?.bot) return true;
  if (!client.appConfig.timelineRestoration.blockHumanMessagesDuringRestore) return false;

  await message.delete().catch((error) => {
    client.logger.warn('restoration human message delete failed', {
      guildId: message.guildId,
      destinationThreadId: message.channelId,
      jobId: activeJob.jobId,
      userId: message.author?.id || null,
      errorCode: error.code || 'delete_failed'
    });
  });
  const noticeKey = `${message.guildId}:${message.author.id}`;
  const lastNotice = client.timelineRestorationNoticeCooldowns.get(noticeKey) || 0;
  if (Date.now() - lastNotice >= client.appConfig.timelineRestoration.restorationNoticeCooldownMs) {
    client.timelineRestorationNoticeCooldowns.set(noticeKey, Date.now());
    await message.author.send({
      content: '現在このスレッドでは過去ログを復元しています。復元完了後に投稿できます。',
      allowedMentions: { parse: [], users: [], roles: [] }
    }).catch(() => null);
  }
  client.logger.info('restoration human message blocked', {
    guildId: message.guildId,
    destinationThreadId: message.channelId,
    jobId: activeJob.jobId,
    userId: message.author.id,
    sourceMessageId: message.id
  });
  return true;
}

async function handleTimelineThreadCreate(client, thread) {
  if (!client.appConfig.timelineRestoration?.enabled
    || thread.type !== ChannelType.PublicThread
    || !client.appConfig.watchedForums?.tweet?.includes(String(thread.parentId || ''))) {
    return null;
  }
  const ownerUserId = await resolveThreadOwner(client, thread, thread.ownerId || null);
  if (!ownerUserId) return null;
  const row = await ensureTimelineUserThread(client, thread, ownerUserId, null);
  client.logger.info('timeline personal thread binding retained', {
    guildId: thread.guildId,
    ownerUserId,
    threadId: thread.id,
    forumChannelId: thread.parentId,
    automaticRestorationStarted: false
  });
  return row;
}

async function handleTimelineThreadDelete(client, thread) {
  const existing = client.db.timelineRestoration.userThreads.get(thread.guildId, thread.id);
  const configured = client.appConfig.watchedForums?.tweet?.includes(String(thread.parentId || ''));
  if (!existing && !configured) return false;
  if (!existing) {
    const ownerUserId = String(thread.ownerId || '');
    if (!ownerUserId) return false;
    await ensureTimelineUserThread(client, thread, ownerUserId, null);
  }
  const reason = client.timelineKnownThreadDeletionReasons.get(thread.id) || 'unknown_external_delete';
  client.timelineKnownThreadDeletionReasons.delete(thread.id);
  client.db.timelineRestoration.userThreads.markDeleted(thread.guildId, thread.id, reason);
  client.logger.info('deleted thread reason recorded', {
    guildId: thread.guildId,
    threadId: thread.id,
    ownerUserId: existing?.ownerUserId || thread.ownerId || null,
    deletionReason: reason,
    restorationDataDeleted: false
  });
  return true;
}

function handleTimelineSourceMessageDeleted(client, messageOrId, guildId = null) {
  const messageId = typeof messageOrId === 'string' ? messageOrId : messageOrId?.id;
  const resolvedGuildId = guildId || messageOrId?.guildId;
  if (!messageId) return false;
  let changed = 0;
  if (resolvedGuildId) {
    changed = client.db.timelineRestoration.snapshots.markDeleted(resolvedGuildId, messageId);
  } else {
    const row = client.db.sqlite.prepare(`
      SELECT guild_id AS guildId FROM timeline_restore_snapshots WHERE source_message_id = ? LIMIT 1
    `).get(messageId);
    if (row) changed = client.db.timelineRestoration.snapshots.markDeleted(row.guildId, messageId);
  }
  if (changed) {
    client.logger.info('source deletion retained', {
      guildId: resolvedGuildId || null,
      sourceMessageId: messageId,
      restorationSnapshotRetained: true
    });
  }
  return Boolean(changed);
}

async function refreshTimelineSnapshotReactions(message) {
  const resolved = message?.partial ? await message.fetch().catch(() => null) : message;
  if (!resolved?.guildId || !resolved.channel?.isThread?.()) return false;
  const snapshot = resolved.client.db.timelineRestoration.snapshots.get(resolved.guildId, resolved.id);
  if (!snapshot) return false;
  const reactions = Array.from(resolved.reactions?.cache?.values?.() || []).map((reaction) => ({
    emoji: reaction.emoji?.toString?.() || reaction.emoji?.name || null,
    emojiId: reaction.emoji?.id || null,
    count: Number(reaction.count || 0),
    me: reaction.me === true
  }));
  resolved.client.db.sqlite.prepare(`
    UPDATE timeline_restore_snapshots
    SET reactions_json = ?, updated_at = ?
    WHERE guild_id = ? AND source_message_id = ?
  `).run(JSON.stringify(reactions), new Date().toISOString(), resolved.guildId, resolved.id);
  return true;
}

async function resolveMissingHistoricalThreads(client, guild, ownerUserId, destinationThreadId) {
  const rows = client.db.timelineRestoration.userThreads.listByOwner(guild.id, ownerUserId)
    .filter((row) => row.threadId !== destinationThreadId);
  const recoverable = [];
  for (const row of rows) {
    if (['deleted', 'legacy_missing'].includes(row.status)) {
      if (client.db.timelineRestoration.userThreads.countSnapshots(guild.id, row.threadId) > 0) recoverable.push(row);
      continue;
    }
    const channel = await guild.channels.fetch(row.threadId).catch(() => null);
    if (!channel) {
      client.db.timelineRestoration.userThreads.markDeleted(guild.id, row.threadId, 'legacy_missing', new Date().toISOString(), 'legacy_missing');
      if (client.db.timelineRestoration.userThreads.countSnapshots(guild.id, row.threadId) > 0) {
        recoverable.push({ ...row, status: 'legacy_missing', deletionReason: 'legacy_missing' });
      }
    }
  }
  return recoverable;
}

async function createOrResumeRestorationJob(interaction, {
  ownerUserId,
  force = false,
  destinationThread = null,
  mode = 'normal',
  initiatorUserId = null
} = {}) {
  const client = interaction.client;
  const thread = destinationThread || interaction.channel;
  const adminTest = mode === 'admin_test';
  if (force && !adminTest) {
    throw Object.assign(new Error('force-start はテスト復元専用です。'), { code: 'force_start_requires_admin_test' });
  }
  if (force && !isGuildOwner(interaction)) {
    throw Object.assign(new Error('このテスト復元を開始できるのはサーバー所有者だけです。'), { code: 'guild_owner_required' });
  }
  if (!interaction.inGuild() || !thread?.isThread?.()
    || !client.appConfig.watchedForums?.tweet?.includes(String(thread.parentId || ''))) {
    throw Object.assign(new Error('このコマンドは、つぶやきフォーラム内の自分のスレッドで実行してください。'), { code: 'invalid_destination' });
  }
  if (!client.timelineRestorationPermissionsReady) {
    throw Object.assign(new Error('復元に必要なDiscord権限が不足しています。管理者へ連絡してください。'), { code: 'permissions_missing' });
  }
  if (force) {
    const destinationCreatorId = await resolveDiscordThreadCreatorId(thread);
    const destinationBinding = client.db.timelineRestoration.userThreads.get(interaction.guildId, thread.id);
    if (destinationCreatorId !== String(interaction.user.id)) {
      throw Object.assign(new Error('テスト復元先には、サーバー所有者自身が作成したスレッドを指定してください。'), { code: 'destination_not_owned_by_guild_owner' });
    }
    if (destinationBinding && String(destinationBinding.ownerUserId || '') !== String(interaction.user.id)) {
      throw Object.assign(new Error('別のメンバーの個人スレッドはテスト復元先に使用できません。'), { code: 'destination_bound_to_another_member' });
    }
  }
  const resolvedOwner = await resolveThreadOwner(client, thread, thread.ownerId || interaction.user.id);
  const targetOwnerId = String(ownerUserId || resolvedOwner || '');
  if (!targetOwnerId || (!force && targetOwnerId !== interaction.user.id) || (!adminTest && String(resolvedOwner) !== targetOwnerId)) {
    throw Object.assign(new Error('復元先は、対象ユーザー本人が所有する新しいスレッドである必要があります。'), { code: 'owner_mismatch' });
  }
  const requestIdentity = {
    guildId: interaction.guildId,
    destinationThreadId: thread.id,
    mode: adminTest ? 'admin_test' : 'normal',
    historicalOwnerUserId: targetOwnerId,
    ownerUserId: targetOwnerId,
    initiatorUserId: adminTest ? String(initiatorUserId || interaction.user.id) : targetOwnerId
  };
  const resolution = client.db.timelineRestoration.jobs.resolveRequest(requestIdentity);
  if (resolution.outcome !== 'available') {
    if (resolution.outcome !== 'resumable_exact_match') throw restorationRequestError(resolution.outcome);
    const resumedResult = client.db.timelineRestoration.jobs.resumeExact(requestIdentity);
    if (resumedResult.outcome !== 'resumed_exact_match') throw restorationRequestError(resumedResult.outcome);
    const resumed = resumedResult.job;
    await applyRestorationThreadState(client, thread, resumed);
    await moveProgressCardToBottom(client, thread, resumed).catch((error) => {
      client.logger.warn('restoration progress card replacement failed', {
        guildId: interaction.guildId,
        jobId: resumed.jobId,
        destinationThreadId: thread.id,
        errorCode: error.code || 'progress_card_send_failed'
      });
    });
    client.logger.info('restoration job resumed', {
      guildId: interaction.guildId,
      jobId: resumed.jobId,
      mode: resumed.mode,
      historicalOwnerUserId: resumed.historicalOwnerUserId || resumed.ownerUserId,
      initiatorUserId: resumed.initiatorUserId,
      destinationThreadId: thread.id,
      resolution: 'resumed_exact_match'
    });
    return { outcome: 'resumed_exact_match', job: resumed };
  }
  if (!adminTest) {
    await ensureTimelineUserThread(client, thread, targetOwnerId, thread.id);
  }

  const historicalThreads = await resolveMissingHistoricalThreads(client, interaction.guild, targetOwnerId, thread.id);
  if (!historicalThreads.length) {
    throw Object.assign(new Error('復元対象となる、削除済みまたは欠落した過去スレッドの履歴がありません。'), { code: 'history_missing' });
  }
  const sourceThreadIds = historicalThreads.map((row) => row.threadId);
  const snapshots = client.db.timelineRestoration.snapshots.listByThreads(interaction.guildId, sourceThreadIds)
    .filter((snapshot) => !snapshot.authorIsBot || client.appConfig.timelineRestoration.restoreBotMessages);
  if (!snapshots.length) {
    throw Object.assign(new Error('復元可能なメッセージスナップショットがありません。'), { code: 'snapshot_missing' });
  }

  const now = new Date().toISOString();
  const job = client.db.timelineRestoration.jobs.create({
    guildId: interaction.guildId,
    ownerUserId: targetOwnerId,
    mode: adminTest ? 'admin_test' : 'normal',
    historicalOwnerUserId: targetOwnerId,
    initiatorUserId: String(initiatorUserId || interaction.user.id),
    destinationTestThreadId: adminTest ? thread.id : null,
    destinationForumId: String(thread.parentId || ''),
    destinationThreadId: thread.id,
    status: 'active',
    sourceThreadIdsJson: JSON.stringify(sourceThreadIds),
    totalItemCount: snapshots.length,
    startedAt: now,
    nextRunAt: now,
    previousThreadLocked: thread.locked ? 1 : 0,
    previousThreadArchived: thread.archived ? 1 : 0,
    previousSlowmodeSeconds: Number(thread.rateLimitPerUser || 0),
    previousAppliedTagsJson: JSON.stringify(thread.appliedTags || []),
    createdAt: now,
    updatedAt: now
  }, snapshots);
  if (!adminTest) {
    for (const sourceThreadId of sourceThreadIds) {
      client.db.timelineRestoration.userThreads.setRestoration(interaction.guildId, sourceThreadId, {
        replacementThreadId: thread.id, jobId: job.jobId
      });
    }
  }
  await applyRestorationThreadState(client, thread, job);
  await moveProgressCardToBottom(client, thread, job).catch((error) => {
    client.logger.warn('restoration progress card replacement failed', {
      guildId: interaction.guildId,
      jobId: job.jobId,
      destinationThreadId: thread.id,
      errorCode: error.code || 'progress_card_send_failed'
    });
  });
  client.logger.info('restoration job created', {
    guildId: interaction.guildId,
    jobId: job.jobId,
    mode: job.mode || 'normal',
    ownerUserId: targetOwnerId,
    initiatorUserId: job.initiatorUserId || interaction.user.id,
    destinationThreadId: thread.id,
    sourceThreadCount: sourceThreadIds.length,
    totalItemCount: snapshots.length
  });
  return { outcome: 'created', job };
}

function formatStatus(job) {
  const handled = Number(job.completedItemCount || 0) + Number(job.failedItemCount || 0) + Number(job.skippedItemCount || 0);
  const remaining = Math.max(0, Number(job.totalItemCount || 0) - handled);
  return [
    `状態: ${job.status}`,
    `モード: ${job.mode || 'normal'}`,
    `所有者: <@${job.ownerUserId}>`,
    job.mode === 'admin_test' ? `テスト開始者: <@${job.initiatorUserId}>` : null,
    `復元先: <#${job.destinationThreadId}>`,
    `元スレッド: ${safeArray(job.sourceThreadIdsJson).map((id) => `\`${id}\``).join(', ')}`,
    `進捗: ${handled} / ${job.totalItemCount}（${Number(job.progressPercent || 0).toFixed(1)}%）`,
    `成功: ${job.completedItemCount} / 失敗: ${job.failedItemCount} / 重複スキップ: ${job.skippedItemCount}`,
    `本文: ${job.textRestoredCount} / 画像: ${job.imageRestoredCount} / 動画: ${job.videoRestoredCount} / ファイル: ${job.fileRestoredCount}`,
    `返信関係: ${job.replyRestoredCount} / 取得不能メディア: ${job.unavailableMediaCount}`,
    `現在位置: ${job.currentSequence || handled}`,
    `最終処理: ${job.lastProcessedAt || '未処理'}`,
    `次回処理: ${job.nextRunAt || 'なし'}`,
    `残り: ${remaining}件`
  ].filter(Boolean).join('\n').slice(0, 1900);
}

function formatInspection(client, job) {
  const sourceThreadIds = safeArray(job.sourceThreadIdsJson);
  const sourceRows = sourceThreadIds.map((threadId) => (
    client.db.timelineRestoration.userThreads.get(job.guildId, threadId)
  ));
  const items = client.db.timelineRestoration.jobs.listItems(job.jobId);
  const snapshots = items.map((item) => client.db.timelineRestoration.snapshots.getById(item.snapshotId)).filter(Boolean);
  const statusCounts = items.reduce((counts, item) => {
    counts[item.status] = Number(counts[item.status] || 0) + 1;
    return counts;
  }, {});
  return [
    `ジョブ: ${job.jobId}`,
    `状態: ${job.status}`,
    `モード: ${job.mode || 'normal'}`,
    `履歴所有者: ${job.historicalOwnerUserId || job.ownerUserId}`,
    `開始者: ${job.initiatorUserId || 'none'}`,
    `復元先: ${job.destinationThreadId}`,
    `元スレッド: ${sourceThreadIds.length}件`,
    ...sourceRows.map((row, index) => (
      `- ${sourceThreadIds[index]}: ${row?.status || 'mapping_missing'} / snapshots ${client.db.timelineRestoration.userThreads.countSnapshots(job.guildId, sourceThreadIds[index])}`
    )),
    `項目状態: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(', ') || 'none'}`,
    `投稿者ID不明: ${snapshots.filter((snapshot) => !snapshot.authorUserId).length}`,
    `汎用アバター: ${snapshots.filter((snapshot) => snapshot.authorAvatarSource === 'generic_fallback').length}`,
    `未解決返信: ${snapshots.filter((snapshot) => snapshot.replyKind === 'unresolved_reply').length}`,
    `取得不能メディア: ${job.unavailableMediaCount || 0}`,
    `最終エラー: ${job.lastErrorCode || 'none'}`
  ].join('\n').slice(0, 1900);
}

function safeArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function cancelRestoration(client, job, thread) {
  const now = new Date().toISOString();
  let updated = client.db.timelineRestoration.jobs.update(job.jobId, {
    status: 'cancelled', cancelledAt: now, nextRunAt: null, lastProcessedAt: now, updatedAt: now
  });
  updated = persistJobCounts(client, job.jobId);
  await moveProgressCardToBottom(client, thread, updated, { stateLabel: '過去ログの復元をキャンセルしました' }).catch(() => null);
  await restoreOriginalThreadState(client, thread, updated);
  client.logger.info('restoration cancelled', {
    guildId: job.guildId,
    jobId: job.jobId,
    destinationThreadId: thread.id,
    ownerUserId: job.ownerUserId
  });
  return updated;
}

async function handleTimelineRestoreCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();
  const client = interaction.client;
  const thread = interaction.channel;
  const currentJob = interaction.inGuild() && thread?.isThread?.()
    ? client.db.timelineRestoration.jobs.getByThread(interaction.guildId, thread.id)
    : null;
  try {
    if (subcommand === 'start') {
      const result = await createOrResumeRestorationJob(interaction);
      const verb = result.outcome === 'resumed_exact_match' ? '再開' : '開始';
      await interaction.editReply(`過去ログの復元を${verb}しました。${result.job.totalItemCount}件を古い順に少しずつ復元します。進捗はスレッド最下部のカードで確認できます。`);
      client.logger.info('restoration command validated', {
        interactionId: interaction.id,
        jobId: result.job.jobId,
        action: 'start',
        resolution: result.outcome
      });
      return;
    }
    if (subcommand === 'force-start') {
      if (!isGuildOwner(interaction)) {
        throw Object.assign(new Error('このテスト復元を開始できるのはサーバー所有者だけです。'), { code: 'guild_owner_required' });
      }
      const historicalUserId = normalizeUserIdOption(interaction.options.getString('historical-user', true));
      const destinationThread = interaction.options.getChannel('destination-thread', true);
      if (!historicalUserId) {
        throw Object.assign(new Error('historical-user にはユーザーIDまたはメンションを指定してください。'), { code: 'invalid_historical_user' });
      }
      if (!destinationThread?.isThread?.()
        || !isDiscordSnowflake(destinationThread.id)
        || String(destinationThread.guildId || interaction.guildId) !== String(interaction.guildId)
        || !client.appConfig.watchedForums?.tweet?.includes(String(destinationThread.parentId || ''))) {
        throw Object.assign(new Error('復元先は、設定済みの個人つぶやきフォーラム内のスレッドを指定してください。'), { code: 'invalid_destination' });
      }
      const result = await createOrResumeRestorationJob(interaction, {
        ownerUserId: historicalUserId,
        force: true,
        destinationThread,
        mode: 'admin_test',
        initiatorUserId: interaction.user.id
      });
      await interaction.editReply({
        content: `テスト復元ジョブ ${result.job.jobId} を${result.outcome === 'resumed_exact_match' ? '再開' : '開始'}しました。履歴所有者ID: \`${historicalUserId}\` / 復元先: <#${destinationThread.id}>`,
        allowedMentions: { parse: [], users: [], roles: [] }
      });
      return;
    }
    if (!currentJob) throw Object.assign(new Error('このスレッドには復元ジョブがありません。'), { code: 'job_missing' });
    if (subcommand === 'status') {
      await interaction.editReply({ content: formatStatus(currentJob), allowedMentions: { parse: [], users: [], roles: [] } });
      return;
    }
    if (subcommand === 'log') {
      if (currentJob.ownerUserId !== interaction.user.id && !isRestorationAdmin(interaction)) {
        throw Object.assign(new Error('復元ログはスレッド所有者または管理者だけが確認できます。'), { code: 'owner_required' });
      }
      const items = client.db.timelineRestoration.jobs.listItems(currentJob.jobId);
      const snapshots = new Map(items.map((item) => [Number(item.snapshotId), client.db.timelineRestoration.snapshots.getById(item.snapshotId)]));
      const file = new AttachmentBuilder(buildRestorationLog(currentJob, items, snapshots), {
        name: `timeline-restoration-${currentJob.jobId}.md`
      });
      await interaction.editReply({ content: `復元ジョブ ${currentJob.jobId} の詳細ログです。`, files: [file] });
      return;
    }
    if (subcommand === 'cancel') {
      if (currentJob.ownerUserId !== interaction.user.id && !isRestorationAdmin(interaction)) {
        throw Object.assign(new Error('この復元をキャンセルできるのはスレッド所有者または管理者だけです。'), { code: 'owner_required' });
      }
      await cancelRestoration(client, currentJob, thread);
      await interaction.editReply('復元をキャンセルし、通常の投稿を再開しました。すでに復元済みの投稿は残ります。');
      return;
    }
    if (!isRestorationAdmin(interaction)) throw Object.assign(new Error('この操作は管理者専用です。'), { code: 'admin_required' });
    if (subcommand === 'retry') {
      const now = new Date().toISOString();
      client.db.sqlite.prepare(`
        UPDATE timeline_restoration_items
        SET status = 'failed_retryable', last_error_code = NULL, updated_at = ?
        WHERE job_id = ? AND status IN ('failed_permanent', 'failed_retryable')
      `).run(now, currentJob.jobId);
      const resumed = client.db.timelineRestoration.jobs.update(currentJob.jobId, {
        status: 'active', nextRunAt: now, completedAt: null, lastErrorCode: null, updatedAt: now
      });
      await applyRestorationThreadState(client, thread, resumed);
      await moveProgressCardToBottom(client, thread, resumed);
      await interaction.editReply(`失敗項目を再試行キューへ戻しました。ジョブ: ${currentJob.jobId}`);
      return;
    }
    if (subcommand === 'unlock') {
      const paused = client.db.timelineRestoration.jobs.update(currentJob.jobId, {
        status: 'paused',
        nextRunAt: null,
        lastProcessedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await restoreOriginalThreadState(client, thread, paused);
      await interaction.editReply('復元ジョブを一時停止し、保存されていたスレッド状態へ戻しました。再開には管理者の retry が必要です。');
      return;
    }
    if (subcommand === 'inspect') {
      await interaction.editReply({ content: formatInspection(client, currentJob), allowedMentions: { parse: [], users: [], roles: [] } });
    }
  } catch (error) {
    client.logger.warn('restoration command rejected', {
      interactionId: interaction.id,
      guildId: interaction.guildId || null,
      userId: interaction.user.id,
      destinationThreadId: thread?.id || null,
      action: subcommand,
      errorCode: error.code || 'command_failed'
    });
    await interaction.editReply(error.message || '復元コマンドを実行できませんでした。');
  }
}

async function handleTimelineRestorationInteraction(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith('timeline_restore:dismiss:')) return false;
  const jobId = Number(String(interaction.customId).split(':').pop());
  const job = interaction.client.db.timelineRestoration.jobs.get(jobId);
  if (!job || String(job.completionMessageId || '') !== String(interaction.message?.id || '')) {
    await interaction.reply({ content: 'この完了レポートの記録を確認できませんでした。', ephemeral: true }).catch(() => null);
    return true;
  }
  const canDismiss = job.mode === 'admin_test'
    ? (String(job.initiatorUserId || '') === String(interaction.user.id) || isGuildOwner(interaction))
    : (String(job.ownerUserId) === String(interaction.user.id) || isRestorationAdmin(interaction));
  if (!canDismiss) {
    await interaction.reply({
      content: job.mode === 'admin_test'
        ? 'このテスト復元レポートを閉じられるのは開始したサーバー所有者だけです。'
        : 'このレポートを閉じられるのはスレッド所有者または管理者だけです。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }
  await interaction.deferUpdate().catch(() => null);
  const deleted = await interaction.message.delete().then(() => true).catch(() => false);
  if (!deleted) {
    await interaction.followUp({ content: '完了レポートを削除できませんでした。', ephemeral: true }).catch(() => null);
  }
  interaction.client.logger.info('completion report dismissed', {
    guildId: job.guildId,
    jobId,
    destinationThreadId: job.destinationThreadId,
    dismissedByUserId: interaction.user.id,
    deleted
  });
  return true;
}

module.exports = {
  isConfiguredTweetThread,
  captureTimelineMessageSnapshot,
  recordTimelineRelayDelivery,
  preserveThreadHistory,
  handleRestorationMessageCreate,
  handleTimelineThreadCreate,
  handleTimelineThreadDelete,
  handleTimelineSourceMessageDeleted,
  refreshTimelineSnapshotReactions,
  handleReturningMember,
  scheduleDepartedMemberPreservation,
  schedulePendingDepartedPreservationsOnReady,
  startReturnNoticeRetryWorker,
  auditRestorationPermissions,
  startTimelineRestorationWorker,
  handleTimelineRestoreCommand,
  handleTimelineRestorationInteraction,
  createOrResumeRestorationJob
};
