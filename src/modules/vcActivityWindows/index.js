const crypto = require('node:crypto');
const { updateShortActivityCard } = require('../vcShortActivity');

function getConfig(client) {
  return client.appConfig?.voiceSessionSummary || {};
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueIds(values) {
  return [...new Set((values || []).filter(Boolean).map(String))].sort();
}

function getHumanMembers(channel) {
  return [...(channel?.members?.values?.() || [])]
    .filter((member) => !member?.user?.bot)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function getScope(client, channel) {
  if (!channel?.guild?.id || !channel.parentId || !client.voiceProfileCategoryMap?.has?.(channel.parentId)) {
    return null;
  }
  const config = getConfig(client).shortActivity || {};
  if (!config.includeAfk && String(channel.guild.afkChannelId || '') === String(channel.id)) {
    return null;
  }
  const mapping = client.voiceProfileCategoryMap.get(channel.parentId);
  if (!mapping?.profileChannelId) return null;
  return {
    guildId: channel.guild.id,
    categoryId: String(channel.parentId),
    profileChannelId: String(mapping.profileChannelId),
    voiceChannelId: String(channel.id)
  };
}

function normalizeWindow(row) {
  if (!row) return null;
  return {
    ...row,
    participantIds: uniqueIds(parseJson(row.participantIdsJson, [])),
    participantIntervals: parseJson(row.participantIntervalsJson, {})
  };
}

function ensureOpenInterval(intervals, userId, at) {
  const rows = Array.isArray(intervals[userId]) ? intervals[userId] : [];
  if (!rows.some((row) => !row.leftAt)) {
    rows.push({ joinedAt: at, leftAt: null });
  }
  intervals[userId] = rows;
}

function closeOpenInterval(intervals, userId, at) {
  const rows = Array.isArray(intervals[userId]) ? intervals[userId] : [];
  const open = [...rows].reverse().find((row) => !row.leftAt);
  if (open) open.leftAt = at;
  intervals[userId] = rows;
}

function synchronizeWindow(window, currentMembers, nowIso, { leavingUserId = null } = {}) {
  const currentIds = currentMembers.map((member) => String(member.id));
  const intervals = { ...window.participantIntervals };
  if (leavingUserId) closeOpenInterval(intervals, String(leavingUserId), nowIso);
  for (const userId of currentIds) ensureOpenInterval(intervals, userId, nowIso);
  return {
    ...window,
    participantIds: uniqueIds([...window.participantIds, ...currentIds, leavingUserId]),
    participantIntervals: intervals,
    peakHumanCount: Math.max(Number(window.peakHumanCount || 0), currentIds.length)
  };
}

function openWindow(client, scope, currentMembers, nowIso, { estimated = false } = {}) {
  const participantIds = currentMembers.map((member) => String(member.id));
  const participantIntervals = {};
  for (const userId of participantIds) ensureOpenInterval(participantIntervals, userId, nowIso);
  const windowId = `${scope.voiceChannelId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  client.db.vcActivityWindows.open({
    ...scope,
    windowId,
    startedAt: nowIso,
    participantIds,
    participantIntervals,
    peakHumanCount: participantIds.length,
    startEstimated: estimated
  });
  client.logger.info('vc activity window opened', {
    ...scope,
    windowId,
    humanCount: participantIds.length,
    startEstimated: estimated
  });
  return normalizeWindow(client.db.vcActivityWindows.getOpen(scope));
}

async function closeWindow(client, window, currentMembers, nowIso, {
  reason,
  leavingUserId = null,
  endEstimated = false
}) {
  let next = synchronizeWindow(window, currentMembers, nowIso, { leavingUserId });
  for (const userId of Object.keys(next.participantIntervals)) {
    closeOpenInterval(next.participantIntervals, userId, nowIso);
  }
  const minMeaningfulSeconds = Math.max(0, Number(getConfig(client).minSessionActiveMinutes || 5) * 60);
  const meaningfulSession = client.db.vcActivityWindows.findMeaningfulSession({
    ...next,
    endedAt: nowIso,
    minMeaningfulSeconds
  });
  const durationSeconds = Math.max(0, Math.floor((new Date(nowIso).getTime() - new Date(next.startedAt).getTime()) / 1000));
  const stableEpisodeKey = `activity-window:${next.guildId}:${next.windowId}`;
  const finalize = client.db.sqlite.transaction(() => {
    const closed = client.db.vcActivityWindows.close({
      ...next,
      endedAt: nowIso,
      meaningfulSessionId: meaningfulSession?.sessionId || null,
      qualifiedMeaningful: Boolean(meaningfulSession),
      closeReason: reason,
      endEstimated
    });
    let inserted = 0;
    if (!meaningfulSession) {
      inserted = client.db.vcShortActivity.insertEpisode({
        stableEpisodeKey,
        guildId: next.guildId,
        categoryId: next.categoryId,
        profileChannelId: next.profileChannelId,
        voiceChannelId: next.voiceChannelId,
        startedAt: next.startedAt,
        endedAt: nowIso,
        durationSeconds,
        participantIds: next.participantIds,
        peakHumanCount: next.peakHumanCount,
        closeReason: reason
      });
    }
    return { closed, inserted };
  });
  const result = finalize();
  if (meaningfulSession) {
    client.logger.info('vc activity window closed meaningful', {
      guildId: next.guildId,
      voiceChannelId: next.voiceChannelId,
      windowId: next.windowId,
      meaningfulSessionId: meaningfulSession.sessionId
    });
  } else {
    client.logger.info(result.inserted ? 'vc short activity episode recorded' : 'vc short activity duplicate prevented', {
      guildId: next.guildId,
      categoryId: next.categoryId,
      profileChannelId: next.profileChannelId,
      voiceChannelId: next.voiceChannelId,
      windowId: next.windowId,
      stableEpisodeKey,
      participantCount: next.participantIds.length,
      peakHumanCount: next.peakHumanCount,
      durationSeconds,
      reason
    });
  }
  await updateShortActivityCard(client, next).catch((error) => {
    client.logger.warn('vc short activity card update failed after window close', {
      guildId: next.guildId,
      profileChannelId: next.profileChannelId,
      error: error.message
    });
  });
  return result;
}

async function processChannel(client, channel, nowIso, options = {}) {
  const scope = getScope(client, channel);
  if (!scope) return null;
  const currentMembers = getHumanMembers(channel);
  let window = normalizeWindow(client.db.vcActivityWindows.getOpen(scope));
  if (!window && currentMembers.length > 0) {
    window = openWindow(client, scope, currentMembers, nowIso, { estimated: options.estimated === true });
  }
  if (!window) return null;
  if (currentMembers.length === 0) {
    return closeWindow(client, window, currentMembers, nowIso, options);
  }
  const next = synchronizeWindow(window, currentMembers, nowIso, options);
  client.db.vcActivityWindows.update(next);
  return next;
}

function queueChannel(client, channel, nowIso, options) {
  const scope = getScope(client, channel);
  if (!scope) return Promise.resolve(null);
  const key = `${scope.guildId}:${scope.voiceChannelId}`;
  const previous = client.vcActivityWindowQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => null).then(() => processChannel(client, channel, nowIso, options));
  client.vcActivityWindowQueues.set(key, next);
  return next.finally(() => {
    if (client.vcActivityWindowQueues.get(key) === next) client.vcActivityWindowQueues.delete(key);
  });
}

async function handleVoiceActivityWindowStateUpdate(oldState, newState) {
  const client = newState.client;
  const config = getConfig(client);
  if (!config.enabled || config.shortActivity?.enabled === false || config.shortActivity?.trackSoloVisits === false) return;
  const member = newState.member || oldState.member;
  if (member?.user?.bot || String(oldState.channelId || '') === String(newState.channelId || '')) return;
  const nowIso = new Date().toISOString();
  if (oldState.channel) {
    await queueChannel(client, oldState.channel, nowIso, {
      reason: newState.channelId ? 'channel_move' : 'voice_leave',
      leavingUserId: member?.id || oldState.id || null
    });
  }
  if (newState.channel) {
    await queueChannel(client, newState.channel, nowIso, {
      reason: oldState.channelId ? 'channel_move' : 'voice_join'
    });
  }
}

async function reconcileVoiceActivityWindows(client, { reason = 'ready_resync' } = {}) {
  const config = getConfig(client);
  if (!config.enabled || config.shortActivity?.enabled === false || config.shortActivity?.trackSoloVisits === false) {
    return { opened: 0, reconciled: 0 };
  }
  const guild = client.guilds.cache.get(process.env.GUILD_ID) || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) return { opened: 0, reconciled: 0 };
  await guild.channels.fetch().catch(() => null);
  const nowIso = new Date().toISOString();
  let opened = 0;
  let reconciled = 0;

  for (const row of client.db.vcActivityWindows.listOpen().filter((entry) => String(entry.guildId) === String(guild.id))) {
    const channel = guild.channels.cache.get(String(row.voiceChannelId));
    if (!channel || !getScope(client, channel)) {
      const synthetic = normalizeWindow(row);
      await closeWindow(client, synthetic, [], nowIso, {
        reason: 'restart_reconcile_missing_channel',
        endEstimated: true
      });
      reconciled += 1;
      continue;
    }
    await queueChannel(client, channel, nowIso, {
      reason: 'restart_reconcile',
      estimated: true,
      endEstimated: true
    });
    reconciled += 1;
  }

  for (const [categoryId, mapping] of client.voiceProfileCategoryMap) {
    const channels = [...guild.channels.cache.values()]
      .filter((channel) => channel?.isVoiceBased?.() && String(channel.parentId) === String(categoryId));
    for (const channel of channels) {
      if (!getScope(client, channel) || getHumanMembers(channel).length === 0) continue;
      const scope = getScope(client, channel);
      if (!client.db.vcActivityWindows.getOpen(scope)) {
        await queueChannel(client, channel, nowIso, { reason: 'restart_reconcile_open', estimated: true });
        opened += 1;
      }
    }
    await updateShortActivityCard(client, {
      guildId: guild.id,
      categoryId,
      profileChannelId: mapping.profileChannelId
    }).catch(() => null);
  }
  client.logger.info('vc activity window ready reconciliation completed', {
    guildId: guild.id,
    reason,
    openedCount: opened,
    reconciledCount: reconciled
  });
  return { opened, reconciled };
}

module.exports = {
  getHumanMembers,
  getScope,
  handleVoiceActivityWindowStateUpdate,
  reconcileVoiceActivityWindows,
  synchronizeWindow
};
