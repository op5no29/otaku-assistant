const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder
} = require('discord.js');
const { preserveThreadHistory } = require('./snapshots');
const { notifyOpsChannel } = require('../ops/notify');

function sleepDelayMs(minutes) {
  return Math.max(0, Number(minutes || 0)) * 60 * 1000;
}

function hasRecoverableMissingHistory(client, guildId, userId) {
  return client.db.timelineRestoration.userThreads.listByOwner(guildId, userId)
    .filter((thread) => ['deleted', 'legacy_missing'].includes(thread.status))
    .filter((thread) => client.db.timelineRestoration.userThreads.countSnapshots(guildId, thread.threadId) > 0);
}

function buildRestorationInformationDm(client, member, historicalThreads) {
  const botDeleted = historicalThreads.some((thread) => thread.deletionReason === 'member_left_auto_cleanup');
  const deletionText = botDeleted
    ? 'そのスレッドは、サーバー退出時の整理処理によりBotが削除しましたが、復元に使用できる文章・画像・動画・投稿者・返信関係などの履歴は保存されています。'
    : '以前利用していたつぶやきスレッドは、現在サーバー上に残っていませんが、復元に使用できる履歴が保存されています。';
  const forumId = String(client.appConfig.watchedForums?.tweet?.[0] || '');
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        '## 以前のつぶやき履歴を復元できます',
        '',
        '以前参加していた際に、あなたが作成したつぶやきスレッドの履歴があります。',
        '',
        deletionText,
        '',
        '復元を希望する場合は、まず普段どおり、つぶやきフォーラムに自分の名前とアイコンで新しいスレッドを作成してください。',
        '',
        'その後、新しい自分のスレッド内で `/timeline-restore start` を実行してください。コマンドを実行するまで復元は開始されません。',
        '',
        '保存済みデータをもとに古い順で再構築するため、取得できなかった内容がある場合は復元ログに明記します。復元中はスレッドへの通常投稿を一時停止し、完了後に再開します。'
      ].join('\n'))
    );
  if (forumId) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('つぶやきフォーラムを開く')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${member.guild.id}/${forumId}`)
      )
    );
  }
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

async function sendReturnNoticesUnlocked(client, member, episodeId) {
  const existing = client.db.timelineRestoration.returnNotices.get(member.guild.id, member.id, episodeId);
  const now = new Date().toISOString();
  const historicalThreads = hasRecoverableMissingHistory(client, member.guild.id, member.id);
  const failureCooldownMs = Number(client.appConfig.timelineRestoration.returnDmFailureCooldownDays || 14) * 86400_000;
  if (existing?.lastAttemptAt
    && (['failed', 'sending'].includes(existing.welcomeDmStatus)
      || ['failed', 'sending'].includes(existing.restorationDmStatus))
    && Date.now() - new Date(existing.lastAttemptAt).getTime() < failureCooldownMs) {
    return existing;
  }

  let state = {
    guildId: member.guild.id,
    userId: member.id,
    membershipEpisodeId: episodeId,
    welcomeDmStatus: existing?.welcomeDmStatus || 'pending',
    welcomeDmSentAt: existing?.welcomeDmSentAt || null,
    restorationDmStatus: historicalThreads.length
      ? (existing?.restorationDmStatus === 'not_applicable' ? 'pending' : existing?.restorationDmStatus || 'pending')
      : 'not_applicable',
    restorationDmSentAt: existing?.restorationDmSentAt || null,
    lastErrorCode: null,
    lastAttemptAt: now,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  client.db.timelineRestoration.returnNotices.upsert(state);

  if (state.welcomeDmStatus !== 'sent') {
    try {
      state = { ...state, welcomeDmStatus: 'sending', lastAttemptAt: now, updatedAt: new Date().toISOString() };
      client.db.timelineRestoration.returnNotices.upsert(state);
      const sent = await member.send({
        content: [
          'おかえりなさい！',
          '',
          '以前このサーバーに参加していたことを確認しました。',
          'また参加していただけて嬉しいです。'
        ].join('\n'),
        allowedMentions: { parse: [], users: [], roles: [] }
      });
      state = { ...state, welcomeDmStatus: 'sent', welcomeDmSentAt: now, lastErrorCode: null, updatedAt: new Date().toISOString() };
      client.db.timelineRestoration.returnNotices.upsert(state);
      client.logger.info('welcome-back DM 1 sent', {
        guildId: member.guild.id,
        userId: member.id,
        membershipEpisodeId: episodeId,
        dmMessageId: sent.id
      });
    } catch (error) {
      state = { ...state, welcomeDmStatus: 'failed', lastErrorCode: error.code || 'dm_failed', updatedAt: new Date().toISOString() };
      client.db.timelineRestoration.returnNotices.upsert(state);
      client.logger.warn('welcome-back DM 1 failed', {
        guildId: member.guild.id,
        userId: member.id,
        membershipEpisodeId: episodeId,
        errorCode: state.lastErrorCode
      });
      await notifyOpsChannel(client, `Welcome-back DM failed\n- User: ${member.id}\n- Part: 1\n- Error: ${state.lastErrorCode}`, {
        severity: 'warn', eventType: 'timeline_return_dm_failed', immediateDashboard: true
      }).catch(() => null);
    }
  }

  if (historicalThreads.length && state.restorationDmStatus !== 'sent') {
    try {
      state = { ...state, restorationDmStatus: 'sending', lastAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      client.db.timelineRestoration.returnNotices.upsert(state);
      const sent = await member.send(buildRestorationInformationDm(client, member, historicalThreads));
      state = { ...state, restorationDmStatus: 'sent', restorationDmSentAt: new Date().toISOString(), lastErrorCode: null, updatedAt: new Date().toISOString() };
      client.db.timelineRestoration.returnNotices.upsert(state);
      client.logger.info('welcome-back DM 2 sent', {
        guildId: member.guild.id,
        userId: member.id,
        membershipEpisodeId: episodeId,
        dmMessageId: sent.id,
        historicalThreadCount: historicalThreads.length
      });
    } catch (error) {
      state = { ...state, restorationDmStatus: 'failed', lastErrorCode: error.code || 'dm_failed', updatedAt: new Date().toISOString() };
      client.db.timelineRestoration.returnNotices.upsert(state);
      client.logger.warn('welcome-back DM 2 failed', {
        guildId: member.guild.id,
        userId: member.id,
        membershipEpisodeId: episodeId,
        errorCode: state.lastErrorCode
      });
      await notifyOpsChannel(client, `Timeline restoration guidance DM failed\n- User: ${member.id}\n- Part: 2\n- Error: ${state.lastErrorCode}`, {
        severity: 'warn', eventType: 'timeline_return_dm_failed', immediateDashboard: true
      }).catch(() => null);
    }
  }
  return state;
}

async function sendReturnNotices(client, member, episodeId) {
  const key = `${member.guild.id}:${member.id}:${episodeId}`;
  if (client.timelineReturnNoticeLocks.has(key)) {
    return client.db.timelineRestoration.returnNotices.get(member.guild.id, member.id, episodeId);
  }
  client.timelineReturnNoticeLocks.add(key);
  try {
    return await sendReturnNoticesUnlocked(client, member, episodeId);
  } finally {
    client.timelineReturnNoticeLocks.delete(key);
  }
}

async function handleReturningMember(client, member, previousMemberRecord, episode) {
  const returning = Boolean(previousMemberRecord?.leftAt);
  if (!returning || member.user?.bot) return { returning: false };
  client.logger.info('returning member detected', {
    guildId: member.guild.id,
    userId: member.id,
    membershipEpisodeId: episode.episodeId,
    previousLeftAt: previousMemberRecord.leftAt
  });
  client.db.sqlite.prepare(`
    UPDATE intro_dm_queue
    SET status = 'skipped', updated_at = ?
    WHERE guild_id = ? AND user_id = ? AND prompt_type = 'welcome_join' AND status = 'pending'
  `).run(new Date().toISOString(), member.guild.id, member.id);
  const timerKey = `${member.guild.id}:${member.id}`;
  const timer = client.timelineLeavePreservationTimers?.get(timerKey);
  if (timer) {
    clearTimeout(timer);
    client.timelineLeavePreservationTimers.delete(timerKey);
    client.logger.info('personal thread preservation cancelled user returned', {
      guildId: member.guild.id,
      userId: member.id,
      preservationTimerCancelled: true
    });
  }
  await sendReturnNotices(client, member, episode.episodeId);
  return { returning: true };
}

async function preserveDepartedMemberThreads(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const rows = client.db.timelineRestoration.userThreads.listByOwner(guildId, userId)
    .filter((row) => !['deleted', 'legacy_missing', 'restored'].includes(row.status));
  let retryNeeded = false;
  for (const row of rows) {
    const thread = await guild.channels.fetch(row.threadId).catch(() => null);
    if (!thread?.isThread?.()) {
      client.db.timelineRestoration.userThreads.markDeleted(guildId, row.threadId, 'unknown_external_delete');
      client.logger.info('deleted thread reason recorded', {
        guildId,
        threadId: row.threadId,
        deletionReason: 'unknown_external_delete'
      });
      continue;
    }
    try {
      const result = await preserveThreadHistory(client, thread);
      if (!result.complete) {
        retryNeeded = true;
        client.logger.warn('thread preservation incomplete', {
          guildId,
          threadId: row.threadId,
          userId,
          failedMessageCount: result.failedCount,
          failedMediaCount: result.failedMediaCount
        });
        void notifyOpsChannel(client, `Timeline preservation incomplete\n- Thread: ${row.threadId}\n- Owner: ${userId}\n- Failed messages: ${result.failedCount}\n- Failed media: ${result.failedMediaCount}`, {
          severity: 'error', eventType: 'timeline_preservation_incomplete', immediateDashboard: true
        }).catch(() => null);
      }
    } catch (error) {
      retryNeeded = true;
      const snapshotCount = client.db.timelineRestoration.userThreads.countSnapshots(guildId, row.threadId);
      const mediaCount = client.db.timelineRestoration.userThreads.countMedia(guildId, row.threadId);
      client.db.timelineRestoration.userThreads.finishPreservation(guildId, row.threadId, {
        status: 'preservation_incomplete',
        snapshotCount,
        mediaCount,
        coverageJson: JSON.stringify({ errorCode: error.code || 'preservation_failed', threadDeletedByBot: false }),
        at: new Date().toISOString()
      });
      client.logger.warn('thread preservation incomplete', {
        guildId,
        threadId: row.threadId,
        userId,
        errorCode: error.code || 'preservation_failed',
        deletionCapabilityEnabled: false
      });
      void notifyOpsChannel(client, `Timeline preservation incomplete\n- Thread: ${row.threadId}\n- Owner: ${userId}\n- Error: ${error.code || 'preservation_failed'}`, {
        severity: 'error', eventType: 'timeline_preservation_incomplete', immediateDashboard: true
      }).catch(() => null);
    }
  }
  if (retryNeeded) {
    scheduleDepartedMemberPreservation(client, guildId, userId, {
      delayMs: Math.max(6 * 60 * 60 * 1000, sleepDelayMs(client.appConfig.timelineRestoration.leaveCleanupDelayMinutes))
    });
  }
}

function scheduleDepartedMemberPreservation(client, guildId, userId, { delayMs = null } = {}) {
  if (!client.appConfig.timelineRestoration?.enabled) return;
  const key = `${guildId}:${userId}`;
  const existing = client.timelineLeavePreservationTimers.get(key);
  if (existing) clearTimeout(existing);
  const delay = delayMs == null
    ? sleepDelayMs(client.appConfig.timelineRestoration.leaveCleanupDelayMinutes)
    : Math.max(0, Number(delayMs));
  const timer = setTimeout(() => {
    client.timelineLeavePreservationTimers.delete(key);
    void preserveDepartedMemberThreads(client, guildId, userId).catch((error) => {
      client.logger.error('departed member thread preservation failed', {
        guildId,
        userId,
        errorCode: error.code || 'preservation_failed'
      });
    });
  }, delay);
  timer.unref?.();
  client.timelineLeavePreservationTimers.set(key, timer);
  client.logger.info('leave preservation scheduled', {
    guildId,
    userId,
    delayMinutes: Math.round(delay / 60_000),
    preservationOnly: true,
    deletionCapabilityEnabled: false
  });
}

function schedulePendingDepartedPreservationsOnReady(client, guildId) {
  if (!client.appConfig.timelineRestoration?.enabled) return 0;
  const rows = client.db.sqlite.prepare(`
    SELECT DISTINCT t.owner_user_id AS userId, m.left_at AS leftAt
    FROM timeline_user_threads t
    JOIN guild_members m
      ON m.guild_id = t.guild_id AND m.user_id = t.owner_user_id
    WHERE t.guild_id = ?
      AND m.left_at IS NOT NULL
      AND t.status IN ('active', 'preserving', 'preservation_incomplete')
  `).all(guildId);
  for (const row of rows) {
    const key = `${guildId}:${row.userId}`;
    if (client.timelineLeavePreservationTimers.has(key)) continue;
    const configuredDelay = sleepDelayMs(client.appConfig.timelineRestoration.leaveCleanupDelayMinutes);
    const elapsed = Math.max(0, Date.now() - new Date(row.leftAt || 0).getTime());
    const remaining = Math.max(0, configuredDelay - elapsed);
    const timer = setTimeout(() => {
      client.timelineLeavePreservationTimers.delete(key);
      void preserveDepartedMemberThreads(client, guildId, row.userId).catch((error) => {
        client.logger.error('departed member thread preservation failed', {
          guildId,
          userId: row.userId,
          errorCode: error.code || 'preservation_failed'
        });
      });
    }, remaining);
    timer.unref?.();
    client.timelineLeavePreservationTimers.set(key, timer);
  }
  if (rows.length) {
    client.logger.info('pending leave preservation restored after restart', {
      guildId,
      ownerCount: rows.length,
      deletionCapabilityEnabled: false
    });
  }
  return rows.length;
}

async function retryDueReturnNotices(client) {
  const cutoff = new Date(Date.now() - Number(client.appConfig.timelineRestoration.returnDmFailureCooldownDays || 14) * 86400_000).toISOString();
  const rows = client.db.sqlite.prepare(`
    SELECT guild_id AS guildId, user_id AS userId, membership_episode_id AS membershipEpisodeId
    FROM guild_member_return_notices
    WHERE (welcome_dm_status IN ('failed', 'sending') OR restoration_dm_status IN ('failed', 'sending'))
      AND datetime(COALESCE(last_attempt_at, created_at)) <= datetime(?)
    ORDER BY datetime(COALESCE(last_attempt_at, created_at)) ASC
    LIMIT 10
  `).all(cutoff);
  for (const row of rows) {
    const guild = client.guilds.cache.get(row.guildId);
    const member = guild ? await guild.members.fetch(row.userId).catch(() => null) : null;
    if (!member || member.user?.bot) continue;
    await sendReturnNotices(client, member, row.membershipEpisodeId);
  }
  return rows.length;
}

function startReturnNoticeRetryWorker(client) {
  if (client.timelineReturnNoticeRetryInterval) clearInterval(client.timelineReturnNoticeRetryInterval);
  void retryDueReturnNotices(client).catch((error) => {
    client.logger.warn('welcome-back DM retry worker failed', { errorCode: error.code || 'retry_failed' });
  });
  client.timelineReturnNoticeRetryInterval = setInterval(() => {
    void retryDueReturnNotices(client).catch((error) => {
      client.logger.warn('welcome-back DM retry worker failed', { errorCode: error.code || 'retry_failed' });
    });
  }, 6 * 60 * 60 * 1000);
  client.timelineReturnNoticeRetryInterval.unref?.();
}

module.exports = {
  hasRecoverableMissingHistory,
  buildRestorationInformationDm,
  sendReturnNotices,
  handleReturningMember,
  preserveDepartedMemberThreads,
  scheduleDepartedMemberPreservation,
  schedulePendingDepartedPreservationsOnReady,
  retryDueReturnNotices,
  startReturnNoticeRetryWorker
};
