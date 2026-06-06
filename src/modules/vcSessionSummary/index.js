const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder
} = require('discord.js');
const { registerVcSummaryDeletableMessage } = require('../deletableMessages');

const DEFAULT_ACCENT_COLOR = 0x3b82f6;
const SESSION_STATUSES = {
  ACTIVE: 'active',
  SOLO_GRACE: 'solo_grace',
  CLOSED: 'closed',
  IGNORED: 'ignored'
};
const MAX_GRAPH_LINES = 7;
const MAX_HISTORY_SESSIONS = 5;
const MAX_SELECT_SESSION_OPTIONS = 25;
const VC_SUMMARY_SELECT_PREFIX = 'vc-summary:select:';
const VC_SUMMARY_SELECT_TTL_MS = 10 * 60 * 1000;

function getConfig(client) {
  return client.appConfig.voiceSessionSummary || {
    enabled: true,
    minHumansToStart: 2,
    soloGraceMinutes: 90,
    minSessionActiveMinutes: 5,
    summaryLookbackHours: 24,
    maxEventsToShow: 10,
    reconcileIntervalMinutes: 5
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function stringifyUnique(values) {
  return JSON.stringify([...new Set((values || []).map(String).filter(Boolean))]);
}

function secondsBetween(start, end) {
  const startMs = new Date(start || 0).getTime();
  const endMs = new Date(end || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 1000);
}

function addMinutes(iso, minutes) {
  const base = new Date(iso || 0).getTime();
  if (!Number.isFinite(base)) {
    return null;
  }
  return new Date(base + (Number(minutes || 0) * 60 * 1000)).toISOString();
}

function createSessionId(categoryId) {
  return `${categoryId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function getVoiceSessionQueueKey(guildId, categoryId, profileChannelId) {
  return `${String(guildId || '')}:${String(categoryId || '')}:${String(profileChannelId || '')}`;
}

function getVoiceSessionQueues(client) {
  if (!client.voiceSessionSummaryQueues) {
    client.voiceSessionSummaryQueues = new Map();
  }
  return client.voiceSessionSummaryQueues;
}

function getCategoryMapping(client, categoryId) {
  return client.voiceProfileCategoryMap?.get?.(String(categoryId || '')) || null;
}

async function getFreshVoiceChannel(guild, voiceChannelId) {
  if (!guild || !voiceChannelId) {
    return null;
  }

  const cached = guild.channels.cache.get(String(voiceChannelId));
  if (cached?.isVoiceBased?.()) {
    return cached;
  }

  const fetched = await guild.channels.fetch(String(voiceChannelId)).catch(() => null);
  return fetched?.isVoiceBased?.() ? fetched : null;
}

function getTrackedCategoryId(client, channel) {
  if (!channel?.parentId) {
    return null;
  }
  return client.voiceProfileCategoryMap?.has?.(channel.parentId) ? channel.parentId : null;
}

async function getVoiceChannelsForCategory(guild, categoryId) {
  let voiceChannels = [...(guild?.channels?.cache?.values?.() || [])]
    .filter((channel) => channel?.isVoiceBased?.() && String(channel.parentId) === String(categoryId));
  if (voiceChannels.length) {
    return voiceChannels;
  }

  const fetchedChannels = await guild.channels.fetch().catch(() => null);
  voiceChannels = [...(fetchedChannels?.values?.() || [])]
    .filter((channel) => channel?.isVoiceBased?.() && String(channel.parentId) === String(categoryId));
  return voiceChannels;
}

async function resolveVoiceStateMember(guild, voiceState) {
  const userId = String(voiceState?.id || voiceState?.member?.id || '').trim();
  if (!userId) {
    return null;
  }
  return voiceState.member ||
    guild.members.cache.get(userId) ||
    await guild.members.fetch(userId).catch(() => null);
}

function getStableDisplayName(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || String(member?.id || '');
}

function getMemberAvatarUrl(member) {
  try {
    return member?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
  } catch {
    return null;
  }
}

async function collectCategorySnapshot(client, guild, categoryId, mapping) {
  const voiceChannels = await getVoiceChannelsForCategory(guild, categoryId);
  const channelIds = new Set(voiceChannels.map((channel) => String(channel.id)));
  const channelById = new Map(voiceChannels.map((channel) => [String(channel.id), channel]));
  const membersById = new Map();
  const excludedBotIds = [];
  const excludedMissingMemberIds = [];

  const voiceStates = [...(guild.voiceStates?.cache?.values?.() || [])]
    .filter((voiceState) => channelIds.has(String(voiceState?.channelId || voiceState?.channel?.id || '')));

  for (const voiceState of voiceStates) {
    const voiceChannelId = String(voiceState?.channelId || voiceState?.channel?.id || '');
    const member = await resolveVoiceStateMember(guild, voiceState);
    const userId = String(voiceState?.id || member?.id || '').trim();
    if (!member) {
      excludedMissingMemberIds.push(userId || '(unknown)');
      continue;
    }
    if (member.user?.bot) {
      excludedBotIds.push(String(member.id));
      continue;
    }

    const profileSession = client.db.vcProfiles.getMemberSession({
      guildId: guild.id,
      userId: member.id,
      categoryId,
      profileChannelId: mapping.profileChannelId
    });
    membersById.set(String(member.id), {
      userId: String(member.id),
      member,
      displayName: getStableDisplayName(member),
      avatarUrl: getMemberAvatarUrl(member),
      voiceChannelId,
      voiceChannelName: channelById.get(voiceChannelId)?.name || voiceState.channel?.name || '',
      joinedAt: profileSession?.joinedAt || null
    });
  }

  const members = [...membersById.values()].sort((left, right) => {
    const leftTime = new Date(left.joinedAt || 0).getTime();
    const rightTime = new Date(right.joinedAt || 0).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    const nameCompare = String(left.displayName || '').localeCompare(String(right.displayName || ''), 'ja');
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return left.userId.localeCompare(right.userId);
  });

  const activeVoiceChannelIds = [...new Set(members.map((member) => String(member.voiceChannelId)).filter(Boolean))];
  const voiceChannelIds = [...new Set([
    ...voiceChannels.map((channel) => String(channel.id)),
    ...activeVoiceChannelIds
  ].filter(Boolean))];
  const channelCounts = new Map();
  for (const member of members) {
    channelCounts.set(member.voiceChannelId, (channelCounts.get(member.voiceChannelId) || 0) + 1);
  }
  const mainVoiceChannelId = [...channelCounts.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    [0]?.[0] || activeVoiceChannelIds[0] || null;

  client.logger.info('vc session category snapshot collected', {
    guildId: guild.id,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    humanCount: members.length,
    memberIds: members.map((member) => member.userId),
    activeVoiceChannelIds,
    excludedBotIds,
    excludedMissingMemberIds
  });

  return {
    members,
    memberIds: members.map((member) => member.userId),
    humanCount: members.length,
    activeVoiceChannelIds,
    voiceChannelIds,
    mainVoiceChannelId
  };
}

function normalizeSession(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    maxHumanCount: Number(row.maxHumanCount || 0),
    twoPlusTotalSeconds: Number(row.twoPlusTotalSeconds || 0),
    peakMemberIds: parseJsonArray(row.peakMemberIdsJson),
    allParticipantIds: parseJsonArray(row.allParticipantIdsJson),
    voiceChannelIds: parseJsonArray(row.voiceChannelIdsJson)
  };
}

function serializeSession(session) {
  return {
    ...session,
    peakMemberIdsJson: stringifyUnique(session.peakMemberIds),
    allParticipantIdsJson: stringifyUnique(session.allParticipantIds),
    voiceChannelIdsJson: stringifyUnique(session.voiceChannelIds)
  };
}

function insertSessionEvent(client, session, {
  eventType,
  userId = null,
  fromChannelId = null,
  toChannelId = null,
  occurredAt,
  snapshot,
  metadata = {}
}) {
  client.db.vcVoiceSessions.insertEvent({
    guildId: session.guildId,
    sessionId: session.sessionId,
    eventType,
    userId,
    fromChannelId,
    toChannelId,
    occurredAt,
    humanCountAfter: snapshot?.humanCount ?? null,
    memberIdsAfterJson: stringifyUnique(snapshot?.memberIds || []),
    metadataJson: JSON.stringify(metadata || {})
  });
}

function getExistingMembersById(client, session) {
  return new Map(
    client.db.vcVoiceSessions
      .listMembers(session.guildId, session.sessionId)
      .map((member) => [String(member.userId), member])
  );
}

function upsertCurrentMember(client, session, snapshotMember, {
  nowIso,
  existing = null,
  joinedWhileSessionActive = true
}) {
  client.db.vcVoiceSessions.upsertMember({
    guildId: session.guildId,
    sessionId: session.sessionId,
    userId: snapshotMember.userId,
    displayNameSnapshot: snapshotMember.displayName,
    avatarUrlSnapshot: snapshotMember.avatarUrl,
    firstJoinedAt: existing?.firstJoinedAt || snapshotMember.joinedAt || nowIso,
    lastLeftAt: null,
    totalPresentSeconds: Number(existing?.totalPresentSeconds || 0),
    wasPresentAtPeak: Number(existing?.wasPresentAtPeak || 0) === 1,
    joinedWhileSessionActive,
    presentSince: existing?.isPresent ? existing.presentSince || nowIso : nowIso,
    isPresent: true,
    currentVoiceChannelId: snapshotMember.voiceChannelId,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso
  });
}

function markMemberLeft(client, session, existing, {
  leftAt,
  lastVoiceChannelId = null
}) {
  const additionalSeconds = existing?.isPresent
    ? secondsBetween(existing.presentSince || existing.firstJoinedAt, leftAt)
    : 0;
  client.db.vcVoiceSessions.upsertMember({
    guildId: session.guildId,
    sessionId: session.sessionId,
    userId: existing.userId,
    displayNameSnapshot: existing.displayNameSnapshot,
    avatarUrlSnapshot: existing.avatarUrlSnapshot,
    firstJoinedAt: existing.firstJoinedAt,
    lastLeftAt: leftAt,
    totalPresentSeconds: Number(existing.totalPresentSeconds || 0) + additionalSeconds,
    wasPresentAtPeak: Number(existing.wasPresentAtPeak || 0) === 1,
    joinedWhileSessionActive: Number(existing.joinedWhileSessionActive || 0) === 1,
    presentSince: null,
    isPresent: false,
    currentVoiceChannelId: lastVoiceChannelId || existing.currentVoiceChannelId || null,
    createdAt: existing.createdAt,
    updatedAt: leftAt
  });
}

function syncSessionMembers(client, session, snapshot, {
  nowIso,
  forceLeaveAll = false
}) {
  const existingById = getExistingMembersById(client, session);
  const currentById = new Map(snapshot.members.map((member) => [member.userId, member]));
  let lastLeaveUserId = session.lastLeaveUserId || null;
  let lastLeaveAt = session.lastLeaveAt || null;

  for (const member of snapshot.members) {
    const existing = existingById.get(member.userId);
    if (!existing || Number(existing.isPresent || 0) !== 1) {
      insertSessionEvent(client, session, {
        eventType: 'join',
        userId: member.userId,
        toChannelId: member.voiceChannelId,
        occurredAt: nowIso,
        snapshot
      });
    } else if (String(existing.currentVoiceChannelId || '') !== String(member.voiceChannelId || '')) {
      insertSessionEvent(client, session, {
        eventType: 'move',
        userId: member.userId,
        fromChannelId: existing.currentVoiceChannelId || null,
        toChannelId: member.voiceChannelId,
        occurredAt: nowIso,
        snapshot
      });
    }

    upsertCurrentMember(client, session, member, {
      nowIso,
      existing,
      joinedWhileSessionActive: true
    });
  }

  for (const existing of existingById.values()) {
    const shouldLeave = forceLeaveAll || !currentById.has(String(existing.userId));
    if (!shouldLeave || Number(existing.isPresent || 0) !== 1) {
      continue;
    }
    markMemberLeft(client, session, existing, { leftAt: nowIso });
    lastLeaveUserId = existing.userId;
    lastLeaveAt = nowIso;
    insertSessionEvent(client, session, {
      eventType: 'leave',
      userId: existing.userId,
      fromChannelId: existing.currentVoiceChannelId || null,
      occurredAt: nowIso,
      snapshot
    });
  }

  return { lastLeaveUserId, lastLeaveAt };
}

function updatePeakMembers(client, session, peakMemberIds) {
  const peakIds = new Set(peakMemberIds.map(String));
  for (const member of client.db.vcVoiceSessions.listMembers(session.guildId, session.sessionId)) {
    client.db.vcVoiceSessions.upsertMember({
      ...member,
      wasPresentAtPeak: peakIds.has(String(member.userId)),
      joinedWhileSessionActive: Number(member.joinedWhileSessionActive || 0) === 1,
      isPresent: Number(member.isPresent || 0) === 1
    });
  }
}

function createSessionFromSnapshot(client, {
  guildId,
  categoryId,
  profileChannelId,
  snapshot,
  nowIso
}) {
  const firstMember = snapshot.members[0] || null;
  const session = {
    guildId,
    sessionId: createSessionId(categoryId),
    categoryId,
    profileChannelId,
    status: SESSION_STATUSES.ACTIVE,
    startedAt: nowIso,
    endedAt: null,
    firstTwoPlusAt: nowIso,
    lastTwoPlusAt: nowIso,
    soloSince: null,
    lastActiveAt: nowIso,
    maxHumanCount: snapshot.humanCount,
    peakStartedAt: nowIso,
    peakEndedAt: null,
    peakMemberIds: snapshot.memberIds,
    allParticipantIds: snapshot.memberIds,
    firstJoinUserId: firstMember?.userId || null,
    firstJoinAt: firstMember?.joinedAt || nowIso,
    lastLeaveUserId: null,
    lastLeaveAt: null,
    mainVoiceChannelId: snapshot.mainVoiceChannelId,
    voiceChannelIds: snapshot.voiceChannelIds,
    twoPlusTotalSeconds: 0,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  client.db.vcVoiceSessions.upsert(serializeSession(session));
  for (const member of snapshot.members) {
    upsertCurrentMember(client, session, member, {
      nowIso,
      existing: null,
      joinedWhileSessionActive: false
    });
  }
  updatePeakMembers(client, session, snapshot.memberIds);
  insertSessionEvent(client, session, {
    eventType: 'session_start',
    occurredAt: nowIso,
    snapshot,
    metadata: { reason: 'min_humans_reached' }
  });
  insertSessionEvent(client, session, {
    eventType: 'peak_update',
    occurredAt: nowIso,
    snapshot,
    metadata: { maxHumanCount: snapshot.humanCount }
  });
  client.logger.info('vc session started', {
    guildId,
    categoryId,
    profileChannelId,
    sessionId: session.sessionId,
    humanCount: snapshot.humanCount,
    startedAt: session.startedAt,
    maxHumanCount: session.maxHumanCount
  });
  return session;
}

function updateSessionPeakIfNeeded(client, session, snapshot, nowIso) {
  if (snapshot.humanCount > Number(session.maxHumanCount || 0)) {
    session.maxHumanCount = snapshot.humanCount;
    session.peakStartedAt = nowIso;
    session.peakEndedAt = null;
    session.peakMemberIds = snapshot.memberIds;
    updatePeakMembers(client, session, snapshot.memberIds);
    insertSessionEvent(client, session, {
      eventType: 'peak_update',
      occurredAt: nowIso,
      snapshot,
      metadata: { maxHumanCount: snapshot.humanCount }
    });
    client.logger.info('vc session peak updated', {
      guildId: session.guildId,
      categoryId: session.categoryId,
      sessionId: session.sessionId,
      humanCount: snapshot.humanCount,
      maxHumanCount: session.maxHumanCount
    });
  } else if (
    snapshot.humanCount < Number(session.maxHumanCount || 0) &&
    session.peakStartedAt &&
    !session.peakEndedAt
  ) {
    session.peakEndedAt = nowIso;
  }
}

function addActiveSeconds(session, untilIso) {
  if (session.status !== SESSION_STATUSES.ACTIVE || !session.lastActiveAt) {
    return;
  }
  session.twoPlusTotalSeconds = Number(session.twoPlusTotalSeconds || 0) +
    secondsBetween(session.lastActiveAt, untilIso);
}

function closeSession(client, session, snapshot, {
  closedAt,
  reason,
  config
}) {
  syncSessionMembers(client, session, snapshot, {
    nowIso: closedAt,
    forceLeaveAll: true
  });
  const refreshedMembers = client.db.vcVoiceSessions.listMembers(session.guildId, session.sessionId);
  const latestLeave = refreshedMembers
    .filter((member) => member.lastLeftAt)
    .sort((left, right) => new Date(right.lastLeftAt).getTime() - new Date(left.lastLeftAt).getTime())[0];
  const minSeconds = Number(config.minSessionActiveMinutes || 5) * 60;
  const finalStatus = Number(session.twoPlusTotalSeconds || 0) >= minSeconds
    ? SESSION_STATUSES.CLOSED
    : SESSION_STATUSES.IGNORED;

  session.status = finalStatus;
  session.endedAt = closedAt;
  session.soloSince = null;
  session.lastActiveAt = null;
  session.lastLeaveUserId = latestLeave?.userId || session.lastLeaveUserId || null;
  session.lastLeaveAt = latestLeave?.lastLeftAt || session.lastLeaveAt || closedAt;
  session.updatedAt = closedAt;
  client.db.vcVoiceSessions.upsert(serializeSession(session));
  insertSessionEvent(client, session, {
    eventType: finalStatus === SESSION_STATUSES.IGNORED ? 'session_ignore' : 'session_close',
    occurredAt: closedAt,
    snapshot,
    metadata: {
      reason,
      twoPlusTotalSeconds: session.twoPlusTotalSeconds,
      minSessionActiveMinutes: config.minSessionActiveMinutes
    }
  });

  const logName = finalStatus === SESSION_STATUSES.IGNORED
    ? 'vc session ignored too short'
    : reason === 'solo_grace_expired'
      ? 'vc session closed solo grace expired'
      : 'vc session closed empty';
  client.logger.info(logName, {
    guildId: session.guildId,
    categoryId: session.categoryId,
    profileChannelId: session.profileChannelId,
    sessionId: session.sessionId,
    humanCount: snapshot.humanCount,
    maxHumanCount: session.maxHumanCount,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    twoPlusTotalSeconds: session.twoPlusTotalSeconds,
    reason
  });

  return session;
}

function getSessionWithJson(sessionRow) {
  return normalizeSession(sessionRow);
}

async function processVoiceSessionCategoryLocked(client, guild, categoryId, mapping, {
  reason = 'voice_state_update',
  nowIso = new Date().toISOString()
} = {}) {
  const config = getConfig(client);
  if (!config.enabled) {
    return null;
  }

  const guildId = guild.id;
  const snapshot = await collectCategorySnapshot(client, guild, categoryId, mapping);
  const minHumansToStart = Math.max(2, Number(config.minHumansToStart || 2));
  const openSession = getSessionWithJson(client.db.vcVoiceSessions.getOpen({
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId
  }));

  if (!openSession) {
    if (snapshot.humanCount >= minHumansToStart) {
      return createSessionFromSnapshot(client, {
        guildId,
        categoryId,
        profileChannelId: mapping.profileChannelId,
        snapshot,
        nowIso
      });
    }
    return null;
  }

  const session = openSession;
  session.allParticipantIds = [...new Set([...session.allParticipantIds, ...snapshot.memberIds])];
  session.voiceChannelIds = [...new Set([...session.voiceChannelIds, ...snapshot.voiceChannelIds])];
  session.mainVoiceChannelId = snapshot.mainVoiceChannelId || session.mainVoiceChannelId || null;

  if (session.status === SESSION_STATUSES.SOLO_GRACE && snapshot.humanCount < minHumansToStart) {
    const expiresAt = addMinutes(session.soloSince, config.soloGraceMinutes);
    if (expiresAt && new Date(nowIso).getTime() >= new Date(expiresAt).getTime()) {
      return closeSession(client, session, snapshot, {
        closedAt: expiresAt,
        reason: 'solo_grace_expired',
        config
      });
    }
  }

  const syncResult = syncSessionMembers(client, session, snapshot, { nowIso });
  session.lastLeaveUserId = syncResult.lastLeaveUserId || session.lastLeaveUserId || null;
  session.lastLeaveAt = syncResult.lastLeaveAt || session.lastLeaveAt || null;

  if (snapshot.humanCount >= minHumansToStart) {
    if (session.status === SESSION_STATUSES.SOLO_GRACE) {
      session.status = SESSION_STATUSES.ACTIVE;
      session.soloSince = null;
      session.lastActiveAt = nowIso;
      insertSessionEvent(client, session, {
        eventType: 'session_resume',
        occurredAt: nowIso,
        snapshot,
        metadata: { reason }
      });
      client.logger.info('vc session resumed from solo grace', {
        guildId,
        categoryId,
        sessionId: session.sessionId,
        humanCount: snapshot.humanCount
      });
    } else {
      addActiveSeconds(session, nowIso);
      session.lastActiveAt = nowIso;
    }
    session.lastTwoPlusAt = nowIso;
    updateSessionPeakIfNeeded(client, session, snapshot, nowIso);
    session.updatedAt = nowIso;
    client.db.vcVoiceSessions.upsert(serializeSession(session));
    return session;
  }

  if (snapshot.humanCount === 0) {
    addActiveSeconds(session, nowIso);
    return closeSession(client, session, snapshot, {
      closedAt: nowIso,
      reason: 'empty',
      config
    });
  }

  if (session.status === SESSION_STATUSES.ACTIVE) {
    addActiveSeconds(session, nowIso);
    session.status = SESSION_STATUSES.SOLO_GRACE;
    session.soloSince = nowIso;
    session.lastActiveAt = null;
    session.updatedAt = nowIso;
    client.db.vcVoiceSessions.upsert(serializeSession(session));
    insertSessionEvent(client, session, {
      eventType: 'solo_grace_start',
      occurredAt: nowIso,
      snapshot,
      metadata: {
        soloGraceMinutes: config.soloGraceMinutes,
        reason
      }
    });
    client.logger.info('vc session entered solo grace', {
      guildId,
      categoryId,
      sessionId: session.sessionId,
      humanCount: snapshot.humanCount,
      soloSince: session.soloSince,
      maxHumanCount: session.maxHumanCount
    });
    return session;
  }

  session.updatedAt = nowIso;
  client.db.vcVoiceSessions.upsert(serializeSession(session));
  return session;
}

async function queueVoiceSessionCategoryUpdate(client, guild, categoryId, {
  reason = 'voice_state_update',
  nowIso = new Date().toISOString()
} = {}) {
  const config = getConfig(client);
  if (!config.enabled) {
    return null;
  }
  const mapping = getCategoryMapping(client, categoryId);
  if (!guild || !mapping) {
    return null;
  }

  const key = getVoiceSessionQueueKey(guild.id, categoryId, mapping.profileChannelId);
  const queues = getVoiceSessionQueues(client);
  let queue = queues.get(key);
  if (!queue) {
    queue = { pending: false, promise: null, latestNowIso: nowIso, latestReason: reason };
    queues.set(key, queue);
  }

  queue.pending = true;
  queue.latestNowIso = nowIso;
  queue.latestReason = reason;

  if (queue.promise) {
    return queue.promise;
  }

  queue.promise = (async () => {
    try {
      while (queue.pending) {
        queue.pending = false;
        await processVoiceSessionCategoryLocked(client, guild, categoryId, mapping, {
          reason: queue.latestReason,
          nowIso: queue.latestNowIso
        });
      }
    } finally {
      queue.promise = null;
      if (!queue.pending) {
        queues.delete(key);
      }
    }
  })();

  return queue.promise;
}

async function handleVoiceSessionStateUpdate(oldState, newState) {
  const client = newState.client;
  const config = getConfig(client);
  if (!config.enabled || !client.voiceProfileCategoryMap?.size) {
    return;
  }

  const guild = newState.guild || oldState.guild;
  if (!guild) {
    return;
  }

  const oldChannel = oldState.channelId
    ? (await getFreshVoiceChannel(guild, oldState.channelId)) || oldState.channel
    : null;
  const newChannel = newState.channelId
    ? (await getFreshVoiceChannel(guild, newState.channelId)) || newState.channel
    : null;
  const affectedCategoryIds = new Set([
    getTrackedCategoryId(client, oldChannel),
    getTrackedCategoryId(client, newChannel)
  ].filter(Boolean).map(String));

  for (const categoryId of affectedCategoryIds) {
    await queueVoiceSessionCategoryUpdate(client, guild, categoryId, {
      reason: 'voice_state_update'
    });
  }
}

async function reconcileVoiceSessions(client, {
  reason = 'reconcile',
  nowIso = new Date().toISOString()
} = {}) {
  const config = getConfig(client);
  if (!config.enabled || !client.voiceProfileCategoryMap?.size) {
    return { updatedCount: 0, skippedReason: config.enabled ? 'no_categories' : 'disabled' };
  }

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) {
    return { updatedCount: 0, skippedReason: 'guild_fetch_failed' };
  }
  await guild.channels.fetch?.().catch(() => null);

  let updatedCount = 0;
  for (const [categoryId] of client.voiceProfileCategoryMap) {
    await queueVoiceSessionCategoryUpdate(client, guild, categoryId, { reason, nowIso });
    updatedCount += 1;
  }
  return { updatedCount };
}

function startVoiceSessionReconciliation(client) {
  const config = getConfig(client);
  if (client.voiceSessionSummaryReconcileInterval) {
    clearInterval(client.voiceSessionSummaryReconcileInterval);
    client.voiceSessionSummaryReconcileInterval = null;
  }
  if (!config.enabled) {
    client.logger.info('vc session reconciliation disabled', {
      reason: 'feature_disabled'
    });
    return;
  }

  const intervalMinutes = Math.max(1, Number(config.reconcileIntervalMinutes || 5));
  const runTick = async () => {
    try {
      await reconcileVoiceSessions(client, { reason: 'periodic_reconcile' });
    } catch (error) {
      client.logger.error('vc session reconciliation failed', {
        error: error.message
      });
    }
  };
  client.voiceSessionSummaryReconcileInterval = setInterval(() => {
    void runTick();
  }, intervalMinutes * 60 * 1000);
  if (typeof client.voiceSessionSummaryReconcileInterval.unref === 'function') {
    client.voiceSessionSummaryReconcileInterval.unref();
  }
  client.logger.info('vc session reconciliation enabled', {
    intervalMinutes
  });
}

function formatTime(iso) {
  if (!iso) {
    return '不明';
  }
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

function formatClock(iso) {
  if (!iso) {
    return '不明';
  }
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

function formatDurationSeconds(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return `${hours}時間${minutes}分`;
  }
  return `${minutes}分`;
}

function getCloseReasonLabel(reason) {
  if (reason === 'empty') {
    return '全員退出';
  }
  if (reason === 'solo_grace_expired') {
    return '1人の状態が続いたため終了';
  }
  if (reason === 'too_short') {
    return '短時間のため集計対象外';
  }
  return reason || '記録なし';
}

function getSessionCloseReason(client, session) {
  const events = client.db.vcVoiceSessions.listEvents(session.guildId, session.sessionId, 20);
  const closeEvent = events.find((event) => event.eventType === 'session_close' || event.eventType === 'session_ignore');
  if (!closeEvent) {
    return null;
  }
  return parseEventMetadata(closeEvent).reason || null;
}

function getSessionDurationSeconds(session) {
  return secondsBetween(session.startedAt, session.endedAt || new Date().toISOString());
}

function formatMentionList(userIds, membersById, maxCount = 24) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const visible = ids.slice(0, maxCount).map((userId) => `<@${userId}>`);
  if (ids.length > maxCount) {
    visible.push(`ほか${ids.length - maxCount}人`);
  }
  if (!visible.length && membersById?.size) {
    return [...membersById.values()].slice(0, maxCount).map((member) => `<@${member.userId}>`).join(' / ');
  }
  return visible.join(' / ') || '記録なし';
}

function buildCountGraphLines(events, session) {
  const relevant = [...events]
    .reverse()
    .filter((event) => (
      event.humanCountAfter != null &&
      ['session_start', 'join', 'leave', 'move', 'peak_update', 'solo_grace_start', 'session_close'].includes(event.eventType)
    ));
  const deduped = [];
  let lastKey = null;

  for (const event of relevant) {
    const key = `${formatClock(event.occurredAt)}:${event.humanCountAfter}`;
    if (key === lastKey) {
      continue;
    }
    lastKey = key;
    deduped.push(event);
  }

  const peakEvent = relevant.find((event) => Number(event.humanCountAfter) === Number(session.maxHumanCount || 0));
  const selected = [];
  if (deduped[0]) {
    selected.push(deduped[0]);
  }
  if (peakEvent && !selected.some((event) => event.eventId === peakEvent.eventId)) {
    selected.push(peakEvent);
  }
  for (const event of deduped) {
    if (selected.length >= MAX_GRAPH_LINES) {
      break;
    }
    if (!selected.some((entry) => entry.eventId === event.eventId)) {
      selected.push(event);
    }
  }

  selected.sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime());
  return selected.map((event) => {
    const count = Math.max(0, Number(event.humanCountAfter || 0));
    const bar = '█'.repeat(Math.max(1, Math.min(count, 10)));
    return `${formatClock(event.occurredAt)}  ${bar} ${count}`;
  });
}

function resolveCategoryName(client, guild, categoryId, session = null) {
  const mapping = getCategoryMapping(client, categoryId);
  const category = guild?.channels?.cache?.get?.(String(categoryId));
  return mapping?.name || category?.name || session?.categoryId || '不明なカテゴリ';
}

function resolveVoiceChannelNames(guild, session) {
  const ids = parseJsonArray(session.voiceChannelIdsJson).filter(Boolean);
  const names = ids
    .map((channelId) => guild?.channels?.cache?.get?.(channelId)?.name || null)
    .filter(Boolean);
  if (names.length <= 3) {
    return names.join(' / ') || '記録なし';
  }
  return `${names.slice(0, 3).join(' / ')} ほか${names.length - 3}件`;
}

function resolvePrimaryVoiceChannelName(guild, session) {
  if (session.mainVoiceChannelId) {
    const name = guild?.channels?.cache?.get?.(String(session.mainVoiceChannelId))?.name;
    if (name) {
      return name;
    }
  }
  return resolveVoiceChannelNames(guild, session);
}

function parseEventMetadata(event) {
  try {
    return JSON.parse(event.metadataJson || '{}');
  } catch {
    return {};
  }
}

function formatEventLine(event) {
  const time = formatClock(event.occurredAt);
  const user = event.userId ? `<@${event.userId}>` : null;
  if (event.eventType === 'join') {
    return `${time} ${user} 参加`;
  }
  if (event.eventType === 'leave') {
    return `${time} ${user} 退出`;
  }
  if (event.eventType === 'move') {
    return `${time} ${user} 移動`;
  }
  if (event.eventType === 'peak_update') {
    return `${time} 最大 ${event.humanCountAfter || '?'}人`;
  }
  if (event.eventType === 'solo_grace_start') {
    return `${time} 1人になったため猶予中`;
  }
  if (event.eventType === 'session_close') {
    const metadata = parseEventMetadata(event);
    return `${time} 終了（${metadata.reason || 'closed'}）`;
  }
  return `${time} ${event.eventType}`;
}

async function buildVcSummaryPayload(client, guild, sessionRow, {
  includeEvents = false,
  commandUserId = null,
  mode = 'peak',
  lookbackHours = null
} = {}) {
  const session = normalizeSession(sessionRow);
  const members = client.db.vcVoiceSessions.listMembers(session.guildId, session.sessionId);
  const membersById = new Map(members.map((member) => [String(member.userId), member]));
  const events = client.db.vcVoiceSessions.listEvents(
    session.guildId,
    session.sessionId,
    Math.max(getConfig(client).maxEventsToShow, 20)
  );
  const categoryName = resolveCategoryName(client, guild, session.categoryId, session);
  const voiceChannelNames = resolveVoiceChannelNames(guild, session);
  const allParticipantIds = parseJsonArray(session.allParticipantIdsJson);
  const peakParticipantIds = parseJsonArray(session.peakMemberIdsJson);
  const durationSeconds = getSessionDurationSeconds(session);
  const activeSeconds = Number(session.twoPlusTotalSeconds || 0);
  const closeReason = getSessionCloseReason(client, session);
  const graphLines = buildCountGraphLines(events, session);
  const peakTime = session.peakStartedAt
    ? session.peakEndedAt
      ? `${formatTime(session.peakStartedAt)}〜${formatTime(session.peakEndedAt)}`
      : `${formatTime(session.peakStartedAt)}ごろ`
    : '記録なし';

  const container = new ContainerBuilder().setAccentColor(DEFAULT_ACCENT_COLOR);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 前回の通話まとめ'),
    new TextDisplayBuilder().setContent(`集計: ${categoryName} / mode: ${mode} / 直近${lookbackHours || getConfig(client).summaryLookbackHours}時間`),
    new TextDisplayBuilder().setContent(`**参加していた人**\n${formatMentionList(allParticipantIds, membersById)}`),
    new TextDisplayBuilder().setContent(`**ピーク時にいた人**\n${formatMentionList(peakParticipantIds, membersById)}`)
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      `**通話カテゴリ**\n${categoryName}`,
      `**主な通話チャンネル**\n${voiceChannelNames}`,
      `**通話時間**\n${formatTime(session.startedAt)}〜${formatTime(session.endedAt)}`,
      `**持続時間**\n${formatDurationSeconds(durationSeconds)}（2人以上: ${formatDurationSeconds(activeSeconds)}）`,
      `**最大人数**\n${Number(session.maxHumanCount || 0)}人`,
      `**ピーク時間**\n${peakTime}`
    ].join('\n\n'))
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      `**最初にいた人**\n${session.firstJoinUserId ? `<@${session.firstJoinUserId}>（${formatClock(session.firstJoinAt)}）` : '記録なし'}`,
      `**最後に抜けた人**\n${session.lastLeaveUserId ? `<@${session.lastLeaveUserId}>（${formatClock(session.lastLeaveAt)}）` : '記録なし'}`,
      `**会話開始**\n${formatClock(session.firstTwoPlusAt || session.startedAt)}`,
      `**終了理由**\n${getCloseReasonLabel(closeReason)}`
    ].join('\n\n'))
  );

  if (graphLines.length) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**人数の推移**\n${graphLines.join('\n')}`)
    );
  }

  if (includeEvents) {
    const visibleEvents = client.db.vcVoiceSessions
      .listEvents(session.guildId, session.sessionId, getConfig(client).maxEventsToShow)
      .reverse();
    if (visibleEvents.length) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**入退室ログ**\n${visibleEvents.map(formatEventLine).join('\n')}`)
      );
    }
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`集計対象: 直近${lookbackHours || getConfig(client).summaryLookbackHours}時間 / mode: ${mode}${commandUserId ? `\n実行者: <@${commandUserId}>` : ''}`)
  );

  client.logger.info('vc summary card built', {
    guildId: session.guildId,
    sessionId: session.sessionId,
    categoryId: session.categoryId,
    participantCount: allParticipantIds.length,
    peakParticipantCount: peakParticipantIds.length,
    graphLineCount: graphLines.length,
    includeEvents,
    mode,
    lookbackHours
  });

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: {
      parse: [],
      users: [],
      roles: []
    }
  };
}

function buildHistoryLine(client, guild, sessionRow) {
  const session = normalizeSession(sessionRow);
  const participantIds = parseJsonArray(session.allParticipantIdsJson);
  const visibleParticipants = participantIds.slice(0, 5).map((userId) => `<@${userId}>`).join(' / ');
  const extra = participantIds.length > 5 ? ` ほか${participantIds.length - 5}人` : '';
  return [
    `**${formatTime(session.startedAt)}〜${formatTime(session.endedAt)}**`,
    `${formatDurationSeconds(getSessionDurationSeconds(session))} / 最大${Number(session.maxHumanCount || 0)}人 / ${resolvePrimaryVoiceChannelName(guild, session)}`,
    visibleParticipants ? `${visibleParticipants}${extra}` : '参加者記録なし'
  ].join('\n');
}

async function buildVcHistoryPayload(client, guild, sessions, {
  mode,
  lookbackHours,
  categoryId = null,
  commandUserId = null
}) {
  const container = new ContainerBuilder().setAccentColor(DEFAULT_ACCENT_COLOR);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 最近の通話履歴'),
    new TextDisplayBuilder().setContent(`集計対象: 直近${lookbackHours}時間 / mode: ${mode}${categoryId ? ` / category: ${resolveCategoryName(client, guild, categoryId)}` : ''}${commandUserId ? `\n実行者: <@${commandUserId}>` : ''}`)
  );

  sessions.slice(0, MAX_HISTORY_SESSIONS).forEach((session, index) => {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${index + 1}.**\n${buildHistoryLine(client, guild, session)}`)
    );
  });

  client.logger.info('vc summary history built', {
    guildId: guild.id,
    sessionCount: sessions.length,
    renderedCount: Math.min(sessions.length, MAX_HISTORY_SESSIONS),
    lookbackHours,
    categoryId,
    commandUserId
  });

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: {
      parse: [],
      users: [],
      roles: []
    }
  };
}

function truncateForDiscord(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function getVcSummarySelectionMaps(client) {
  if (!client.vcSummarySelectionState) {
    client.vcSummarySelectionState = new Map();
  }
  if (!client.vcSummarySelectionTimers) {
    client.vcSummarySelectionTimers = new Map();
  }
  return {
    states: client.vcSummarySelectionState,
    timers: client.vcSummarySelectionTimers
  };
}

function clearVcSummarySelectionState(client, token) {
  const { states, timers } = getVcSummarySelectionMaps(client);
  states.delete(token);
  const timer = timers.get(token);
  if (timer) {
    clearTimeout(timer);
    timers.delete(token);
  }
}

function createVcSummarySelectionState(client, state) {
  const token = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const expiresAt = now + VC_SUMMARY_SELECT_TTL_MS;
  const { states, timers } = getVcSummarySelectionMaps(client);
  states.set(token, {
    ...state,
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  });
  const timer = setTimeout(() => {
    clearVcSummarySelectionState(client, token);
  }, VC_SUMMARY_SELECT_TTL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  timers.set(token, timer);
  client.logger.info('vc summary selection state created', {
    guildId: state.guildId,
    commandUserId: state.commandUserId,
    candidateCount: state.candidateSessionIds?.length || 0,
    mode: state.mode,
    lookbackHours: state.lookbackHours,
    categoryId: state.categoryId || null,
    token
  });
  return token;
}

function getVcSummarySelectionState(client, token) {
  const { states } = getVcSummarySelectionMaps(client);
  const state = states.get(token);
  if (!state) {
    return null;
  }
  if (new Date(state.expiresAt).getTime() <= Date.now()) {
    clearVcSummarySelectionState(client, token);
    return null;
  }
  return state;
}

function buildSessionSelectLabel(client, guild, sessionRow) {
  const session = normalizeSession(sessionRow);
  const categoryName = resolveCategoryName(client, guild, session.categoryId, session);
  const voiceChannelName = resolvePrimaryVoiceChannelName(guild, session);
  const timeRange = `${formatClock(session.startedAt)}〜${formatClock(session.endedAt)}`;
  return truncateForDiscord(
    `${categoryName} / ${voiceChannelName} / 最大${Number(session.maxHumanCount || 0)}人 / ${timeRange}`,
    100
  );
}

function buildSessionSelectDescription(sessionRow) {
  const session = normalizeSession(sessionRow);
  const participantCount = parseJsonArray(session.allParticipantIdsJson).length;
  return truncateForDiscord(
    `${formatTime(session.startedAt)} / ${formatDurationSeconds(getSessionDurationSeconds(session))} / 参加${participantCount}人`,
    100
  );
}

async function buildVcSummarySelectionPayload(client, guild, sessions, {
  token,
  mode,
  lookbackHours,
  categoryId = null,
  commandUserId = null,
  truncated = false
}) {
  const visibleSessions = sessions.slice(0, MAX_SELECT_SESSION_OPTIONS);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${VC_SUMMARY_SELECT_PREFIX}${token}`)
    .setPlaceholder('通話セッションを選択')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      visibleSessions.map((session) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(buildSessionSelectLabel(client, guild, session))
          .setDescription(buildSessionSelectDescription(session))
          .setValue(String(session.sessionId))
      )
    );

  const container = new ContainerBuilder().setAccentColor(DEFAULT_ACCENT_COLOR);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 通話まとめを選択'),
    new TextDisplayBuilder().setContent([
      `直近${lookbackHours}時間に複数の通話セッションが見つかりました。`,
      `${commandUserId ? `<@${commandUserId}> ` : ''}表示したい通話を選んでください。`,
      `mode: ${mode}${categoryId ? ` / category: ${resolveCategoryName(client, guild, categoryId)}` : ''}`,
      'この選択メニューは10分で期限切れになります。',
      truncated ? `候補が${MAX_SELECT_SESSION_OPTIONS}件を超えたため、条件に合う上位${MAX_SELECT_SESSION_OPTIONS}件だけを表示しています。` : null
    ].filter(Boolean).join('\n'))
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(select)
  );

  client.logger.info('vc summary selection prompt built', {
    guildId: guild.id,
    candidateCount: sessions.length,
    renderedCount: visibleSessions.length,
    truncated,
    mode,
    lookbackHours,
    categoryId,
    commandUserId
  });

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: {
      parse: [],
      users: [],
      roles: []
    }
  };
}

function shouldShowSelectionForCandidates({ sessions, normalizedMode, categoryId }) {
  if (sessions.length <= 1) {
    return false;
  }
  if (!categoryId) {
    return true;
  }
  if (normalizedMode === 'latest') {
    return false;
  }
  const topCount = Number(sessions[0]?.maxHumanCount || 0);
  const secondCount = Number(sessions[1]?.maxHumanCount || 0);
  return topCount === secondCount;
}

function resolveSummaryCategory(client, categoryOption) {
  const value = String(categoryOption || '').trim();
  if (!value) {
    return null;
  }
  if (client.voiceProfileCategoryMap?.has?.(value)) {
    return value;
  }
  for (const [categoryId, mapping] of client.voiceProfileCategoryMap || []) {
    if (
      String(mapping.name || '').includes(value) ||
      String(mapping.categoryId || '') === value ||
      String(mapping.profileChannelId || '') === value
    ) {
      return categoryId;
    }
  }
  return value;
}

async function buildLatestVcSummaryResponse(client, {
  guild,
  mode = 'peak',
  hours = null,
  category = null,
  includeEvents = false,
  commandUserId = null
}) {
  const config = getConfig(client);
  const lookbackHours = Math.max(1, Number(hours || config.summaryLookbackHours || 24));
  const sinceIso = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000)).toISOString();
  const categoryId = resolveSummaryCategory(client, category);
  const normalizedMode = mode === 'history' ? 'history' : mode === 'latest' ? 'latest' : 'peak';
  const sessions = client.db.vcVoiceSessions.listClosedForSummary({
    guildId: guild.id,
    sinceIso,
    categoryId,
    mode: normalizedMode === 'latest' || normalizedMode === 'history' ? 'latest' : 'peak',
    limit: normalizedMode === 'history' ? MAX_HISTORY_SESSIONS : MAX_SELECT_SESSION_OPTIONS + 1
  });
  const truncated = sessions.length > MAX_SELECT_SESSION_OPTIONS;
  const candidateSessions = sessions.slice(0, MAX_SELECT_SESSION_OPTIONS);

  client.logger.info(sessions.length ? 'vc summary command used' : 'vc summary no session found', {
    guildId: guild.id,
    mode: normalizedMode,
    lookbackHours,
    categoryId,
    includeEvents,
    sessionId: sessions[0]?.sessionId || null,
    candidateCount: sessions.length,
    truncated
  });

  if (!sessions.length) {
    return {
      found: false,
      content: `直近${lookbackHours}時間に集計できる通話セッションはありませんでした。`
    };
  }

  if (normalizedMode === 'history') {
    return {
      found: true,
      kind: 'history',
      session: sessions[0],
      mode: normalizedMode,
      lookbackHours,
      categoryId,
      payload: await buildVcHistoryPayload(client, guild, sessions, {
        mode: normalizedMode,
        lookbackHours,
        categoryId,
        commandUserId
      })
    };
  }

  if (shouldShowSelectionForCandidates({ sessions: candidateSessions, normalizedMode, categoryId })) {
    const token = createVcSummarySelectionState(client, {
      guildId: guild.id,
      commandUserId,
      candidateSessionIds: candidateSessions.map((session) => String(session.sessionId)),
      mode: normalizedMode,
      lookbackHours,
      categoryId,
      includeEvents
    });
    return {
      found: true,
      kind: 'select',
      session: candidateSessions[0],
      mode: normalizedMode,
      lookbackHours,
      categoryId,
      token,
      payload: await buildVcSummarySelectionPayload(client, guild, candidateSessions, {
        token,
        mode: normalizedMode,
        lookbackHours,
        categoryId,
        commandUserId,
        truncated
      })
    };
  }

  return {
    found: true,
    kind: 'summary',
    session: sessions[0],
    mode: normalizedMode,
    lookbackHours,
    categoryId,
    payload: await buildVcSummaryPayload(client, guild, sessions[0], {
      includeEvents,
      commandUserId,
      mode: normalizedMode,
      lookbackHours
    })
  };
}

async function handleVcSummaryInteraction(interaction) {
  if (!interaction.isStringSelectMenu?.()) {
    return false;
  }
  const customId = String(interaction.customId || '');
  if (!customId.startsWith(VC_SUMMARY_SELECT_PREFIX)) {
    return false;
  }

  const client = interaction.client;
  const token = customId.slice(VC_SUMMARY_SELECT_PREFIX.length);
  const state = getVcSummarySelectionState(client, token);
  if (!state) {
    client.logger.info('vc summary selection expired', {
      interactionId: interaction.id,
      customId,
      token,
      userId: interaction.user?.id || null
    });
    await interaction.reply({
      content: 'この選択メニューは期限切れです。もう一度 /vc-summary を実行してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  if (String(interaction.user.id) !== String(state.commandUserId)) {
    client.logger.info('vc summary selection rejected wrong user', {
      interactionId: interaction.id,
      token,
      commandUserId: state.commandUserId,
      interactingUserId: interaction.user.id,
      candidateCount: state.candidateSessionIds?.length || 0
    });
    await interaction.reply({
      content: 'この選択メニューは、コマンドを実行した人だけが使えます。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  const sessionId = String(interaction.values?.[0] || '');
  if (!state.candidateSessionIds?.includes(sessionId)) {
    client.logger.warn('vc summary selection rejected unknown session', {
      interactionId: interaction.id,
      token,
      commandUserId: state.commandUserId,
      selectedSessionId: sessionId,
      candidateCount: state.candidateSessionIds?.length || 0
    });
    await interaction.reply({
      content: '選択された通話セッションを確認できませんでした。もう一度 /vc-summary を実行してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  const guild = interaction.guild || await client.guilds.fetch(state.guildId).catch(() => null);
  if (!guild) {
    await interaction.reply({
      content: 'サーバー情報を取得できませんでした。時間をおいてもう一度試してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }
  await guild.channels.fetch?.().catch(() => null);
  const session = client.db.vcVoiceSessions.get({ guildId: state.guildId, sessionId });
  if (!session) {
    client.logger.warn('vc summary selection session missing', {
      interactionId: interaction.id,
      token,
      guildId: state.guildId,
      sessionId
    });
    await interaction.reply({
      content: '選択された通話セッションの記録が見つかりませんでした。もう一度 /vc-summary を実行してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  const payload = await buildVcSummaryPayload(client, guild, session, {
    includeEvents: state.includeEvents,
    commandUserId: state.commandUserId,
    mode: state.mode,
    lookbackHours: state.lookbackHours
  });

  await interaction.update(payload);
  clearVcSummarySelectionState(client, token);

  const message = await interaction.message.fetch().catch(() => interaction.message);
  await registerVcSummaryDeletableMessage(message, {
    commandUserId: state.commandUserId,
    sessionId,
    mode: state.mode,
    categoryId: session.categoryId || state.categoryId || null,
    lookbackHours: state.lookbackHours
  }).catch((error) => {
    client.logger.warn('vc summary delete cleanup failed', {
      messageId: message?.id || null,
      channelId: message?.channelId || null,
      commandUserId: state.commandUserId,
      sessionId,
      error: error.message
    });
  });

  client.logger.info('vc summary selection accepted', {
    interactionId: interaction.id,
    token,
    guildId: state.guildId,
    commandUserId: state.commandUserId,
    sessionId,
    mode: state.mode,
    lookbackHours: state.lookbackHours,
    categoryId: session.categoryId || state.categoryId || null
  });
  return true;
}

module.exports = {
  SESSION_STATUSES,
  buildLatestVcSummaryResponse,
  handleVcSummaryInteraction,
  handleVoiceSessionStateUpdate,
  queueVoiceSessionCategoryUpdate,
  reconcileVoiceSessions,
  startVoiceSessionReconciliation
};
