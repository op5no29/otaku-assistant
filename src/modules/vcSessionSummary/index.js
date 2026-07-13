const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder
} = require('discord.js');
const { registerVcSummaryDeletableMessage } = require('../deletableMessages');
const { appendOperationLog } = require('../logDashboard');
const {
  recordShortActivityForIgnoredSession,
  clearShortActivityForMeaningfulSession,
  updateShortActivityCard
} = require('../vcShortActivity');

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
const MAX_END_SUMMARY_RESTORE_CANDIDATES = 100;
const VC_SUMMARY_SELECT_PREFIX = 'vc-summary:select:';
const VC_SUMMARY_DETAIL_PREFIX = 'vc-summary:detail:';
const VC_SUMMARY_SELECT_TTL_MS = 10 * 60 * 1000;
const PERSISTENT_END_CARD_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

function getConfig(client) {
  return client.appConfig.voiceSessionSummary || {
    enabled: true,
    minHumansToStart: 2,
    soloGraceMinutes: 90,
    minSessionActiveMinutes: 5,
    summaryLookbackHours: 24,
    maxEventsToShow: 10,
    reconcileIntervalMinutes: 5,
    endCard: {
      enabled: true,
      deleteMode: 'on_next_session',
      ttlMinutes: null,
      restoreLatestOnReady: false,
      messages: {
        default: '通話チャンネルのご利用ありがとうございました。またお気軽にどうぞ。',
        work: '集中作業、お疲れ様でした。',
        workShort: '作業おつかれさまでした。',
        workMedium: '集中作業、お疲れ様でした。',
        workLong: '長時間の作業、お疲れ様でした。',
        workVeryLong: 'かなり長時間の作業、本当にお疲れ様でした。',
        workUltraLong: 'ものすごい長時間の作業、本当にお疲れ様でした。しっかり休んでください。',
        longWork: '長時間の作業、お疲れ様でした。',
        music: '音楽作業、お疲れ様でした。',
        longMusic: '長時間の音楽作業、本当にお疲れ様でした。',
        chat: '通話お疲れ様でした。また気軽に遊びに来てください。',
        longChat: '長時間の通話、お疲れ様でした。またゆっくり休んでください。'
      }
    }
  };
}

function getEndCardConfig(client) {
  const config = getConfig(client);
  const endCard = config.endCard || {};
  return {
    enabled: endCard.enabled !== false,
    deleteMode: endCard.deleteMode === 'ttl' ? 'ttl' : 'on_next_session',
    ttlMinutes: endCard.deleteMode === 'ttl' ? Math.max(1, Number(endCard.ttlMinutes || 30)) : null,
    restoreLatestOnReady: endCard.restoreLatestOnReady !== false,
    messages: {
      default: '通話チャンネルのご利用ありがとうございました。またお気軽にどうぞ。',
      work: '集中作業、お疲れ様でした。',
      workShort: '作業おつかれさまでした。',
      workMedium: '集中作業、お疲れ様でした。',
      workLong: '長時間の作業、お疲れ様でした。',
      workVeryLong: 'かなり長時間の作業、本当にお疲れ様でした。',
      workUltraLong: 'ものすごい長時間の作業、本当にお疲れ様でした。しっかり休んでください。',
      longWork: '長時間の作業、お疲れ様でした。',
      music: '音楽作業、お疲れ様でした。',
      longMusic: '長時間の音楽作業、本当にお疲れ様でした。',
      chat: '通話お疲れ様でした。また気軽に遊びに来てください。',
      longChat: '長時間の通話、お疲れ様でした。またゆっくり休んでください。',
      ...(endCard.messages || {})
    }
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

function isReadyReconcileReason(reason) {
  return /ready|restart|startup/i.test(String(reason || ''));
}

function isOpenSessionUniqueConflict(error) {
  const message = String(error?.message || '');
  return (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT') &&
    /UNIQUE constraint failed: vc_voice_sessions\.guild_id, vc_voice_sessions\.category_id, vc_voice_sessions\.profile_channel_id(?:, vc_voice_sessions\.main_voice_channel_id)?/i.test(message);
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
  const channelOrder = new Map(voiceChannels.map((channel, index) => [String(channel.id), index]));
  const channelSnapshots = activeVoiceChannelIds
    .map((voiceChannelId) => {
      const channelMembers = members.filter((member) => String(member.voiceChannelId) === String(voiceChannelId));
      const voiceChannel = channelById.get(String(voiceChannelId));
      return {
        members: channelMembers,
        memberIds: channelMembers.map((member) => member.userId),
        humanCount: channelMembers.length,
        activeVoiceChannelIds: [String(voiceChannelId)],
        voiceChannelIds: [String(voiceChannelId)],
        mainVoiceChannelId: String(voiceChannelId),
        voiceChannelName: voiceChannel?.name || channelMembers[0]?.voiceChannelName || ''
      };
    })
    .sort((left, right) => {
      const leftOrder = channelOrder.has(left.mainVoiceChannelId) ? channelOrder.get(left.mainVoiceChannelId) : Number.MAX_SAFE_INTEGER;
      const rightOrder = channelOrder.has(right.mainVoiceChannelId) ? channelOrder.get(right.mainVoiceChannelId) : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return String(left.voiceChannelName || '').localeCompare(String(right.voiceChannelName || ''), 'ja') ||
        String(left.mainVoiceChannelId || '').localeCompare(String(right.mainVoiceChannelId || ''));
    });

  client.logger.info('vc session category snapshot collected', {
    guildId: guild.id,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    humanCount: members.length,
    memberIds: members.map((member) => member.userId),
    activeVoiceChannelIds,
    channelSnapshots: channelSnapshots.map((channelSnapshot) => ({
      voiceChannelId: channelSnapshot.mainVoiceChannelId,
      voiceChannelName: channelSnapshot.voiceChannelName,
      humanCount: channelSnapshot.humanCount,
      memberIds: channelSnapshot.memberIds
    })),
    excludedBotIds,
    excludedMissingMemberIds
  });

  return {
    members,
    memberIds: members.map((member) => member.userId),
    humanCount: members.length,
    activeVoiceChannelIds,
    voiceChannelIds,
    mainVoiceChannelId,
    channelSnapshots
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

function getEndCardTimerKey(record) {
  return `${String(record.guildId || '')}:${String(record.sessionId || '')}:${String(record.profileChannelId || '')}`;
}

function getEndCardTimers(client) {
  if (!client.vcSessionEndCardTimers) {
    client.vcSessionEndCardTimers = new Map();
  }
  return client.vcSessionEndCardTimers;
}

function clearEndCardTimer(client, record) {
  const timers = getEndCardTimers(client);
  const key = getEndCardTimerKey(record);
  const timer = timers.get(key);
  if (timer) {
    clearTimeout(timer);
    timers.delete(key);
  }
}

function formatCompactMentionList(userIds, maxCount = 15) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const visible = ids.slice(0, maxCount).map((userId) => `<@${userId}>`);
  if (ids.length > maxCount) {
    visible.push(`ほか${ids.length - maxCount}名`);
  }
  return visible.join(' / ') || '記録なし';
}

function selectEndCardMessage({ categoryName, mainVoiceChannelName, durationSeconds, messages }) {
  const categoryText = String(categoryName || '');
  const channelText = String(mainVoiceChannelName || '');
  const duration = Number(durationSeconds || 0);
  if (/音楽/.test(channelText)) {
    return duration >= 2 * 60 * 60
      ? messages.longMusic || messages.music
      : messages.music;
  }
  if (/通話2|作業/i.test(categoryText) || /作業/i.test(channelText)) {
    if (duration >= 10 * 60 * 60) {
      return messages.workUltraLong || messages.workVeryLong || messages.longWork || messages.work;
    }
    if (duration >= 5 * 60 * 60) {
      return messages.workVeryLong || messages.longWork || messages.work;
    }
    if (duration >= 2 * 60 * 60) {
      return messages.workLong || messages.longWork || messages.work;
    }
    if (duration >= 30 * 60) {
      return messages.workMedium || messages.work;
    }
    return messages.workShort || messages.work;
  }
  if (/通話1|雑談/i.test(categoryText) || /雑談/i.test(channelText)) {
    return duration >= 2 * 60 * 60
      ? messages.longChat || messages.chat
      : messages.chat;
  }
  return messages.default;
}

function buildVoiceSessionEndSummaryPayload(client, guild, sessionRow) {
  const session = normalizeSession(sessionRow);
  const endCardConfig = getEndCardConfig(client);
  const categoryName = resolveCategoryName(client, guild, session.categoryId, session);
  const mainVoiceChannelName = resolvePrimaryVoiceChannelName(guild, session);
  const participantIds = parseJsonArray(session.allParticipantIdsJson);
  const durationSeconds = getSessionDurationSeconds(session);
  const activeSeconds = Number(session.twoPlusTotalSeconds || 0);
  const isWork = /通話2|作業/i.test(categoryName) || /作業/i.test(mainVoiceChannelName);
  const title = isWork ? '## 作業通話おつかれさまでした' : '## 今回の通話まとめ';
  const closingMessage = selectEndCardMessage({
    categoryName,
    mainVoiceChannelName,
    durationSeconds,
    messages: endCardConfig.messages
  });

  const container = new ContainerBuilder().setAccentColor(DEFAULT_ACCENT_COLOR);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(title),
    new TextDisplayBuilder().setContent([
      `**日時:** ${formatSessionDateTimeRange(session.startedAt, session.endedAt)}`,
      `**通話時間:** ${formatDurationSeconds(durationSeconds)}`,
      `**累計参加人数:** ${participantIds.length}人`,
      `**最大同時接続人数:** ${Number(session.maxHumanCount || 0)}人`,
      `**主な通話チャンネル:** ${mainVoiceChannelName}`,
      activeSeconds > 0 ? `**2人以上で話していた時間:** ${formatDurationSeconds(activeSeconds)}` : null
    ].filter(Boolean).join('\n'))
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**参加していた人**\n${formatCompactMentionList(participantIds, 15)}`),
    new TextDisplayBuilder().setContent(`${closingMessage}\n詳しく見るには \`/vc-summary\``)
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('次の通話が始まるまで表示されます。')
  );

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

async function deleteVoiceSessionEndCardRecord(client, record, {
  status = 'expired',
  reason = 'ttl_expired'
} = {}) {
  if (!record?.messageId) {
    return false;
  }

  clearEndCardTimer(client, record);
  const channel = await client.channels.fetch(record.profileChannelId).catch(() => null);
  let deleted = false;
  if (channel?.isTextBased?.()) {
    const message = await channel.messages.fetch(record.messageId).catch(() => null);
    if (message) {
      try {
        await message.delete();
        deleted = true;
      } catch (error) {
        client.logger.warn('vc session end summary card delete failed', {
          guildId: record.guildId,
          sessionId: record.sessionId,
          categoryId: record.categoryId,
          profileChannelId: record.profileChannelId,
          messageId: record.messageId,
          reason,
          error: error.message
        });
        appendOperationLog(client, {
          severity: 'error',
          eventType: 'vc_end_summary_delete_failed',
          title: 'VC end summary card delete failed',
          body: [
            `session: \`${record.sessionId}\``,
            `category: \`${record.categoryId}\``,
            `message: \`${record.messageId}\``,
            `reason: ${reason}`,
            `error: ${error.message}`
          ].join('\n'),
          metadata: record
        });
        client.db.vcVoiceSessions.updateSummaryMessageStatus({
          guildId: record.guildId,
          sessionId: record.sessionId,
          profileChannelId: record.profileChannelId,
          status: 'failed'
        });
        return false;
      }
    }
  }

  client.db.vcVoiceSessions.updateSummaryMessageStatus({
    guildId: record.guildId,
    sessionId: record.sessionId,
    profileChannelId: record.profileChannelId,
    status
  });
  client.logger.info('vc session end summary card deleted', {
    guildId: record.guildId,
    sessionId: record.sessionId,
    categoryId: record.categoryId,
    profileChannelId: record.profileChannelId,
    messageId: record.messageId,
    status,
    reason,
    messageDeleted: deleted
  });
  appendOperationLog(client, {
    severity: 'info',
    eventType: 'vc_end_summary_deleted',
    title: 'VC end summary card deleted',
    body: [
      `session: \`${record.sessionId}\``,
      `category: \`${record.categoryId}\``,
      `status: ${status}`,
      `reason: ${reason}`
    ].join('\n'),
    metadata: {
      guildId: record.guildId,
      sessionId: record.sessionId,
      categoryId: record.categoryId,
      profileChannelId: record.profileChannelId,
      messageId: record.messageId,
      status,
      reason
    }
  });
  return true;
}

function scheduleVoiceSessionEndCardDelete(client, record) {
  if (!record?.expiresAt) {
    return;
  }
  clearEndCardTimer(client, record);
  const delayMs = Math.max(0, new Date(record.expiresAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    void deleteVoiceSessionEndCardRecord(client, record, {
      status: 'expired',
      reason: 'ttl_expired'
    });
  }, delayMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  getEndCardTimers(client).set(getEndCardTimerKey(record), timer);
  client.logger.info('vc session end summary card scheduled delete', {
    guildId: record.guildId,
    sessionId: record.sessionId,
    categoryId: record.categoryId,
    profileChannelId: record.profileChannelId,
    messageId: record.messageId,
    expiresAt: record.expiresAt,
    delayMs
  });
}

async function deleteActiveVoiceSessionEndCardsForCategory(client, {
  guildId,
  categoryId,
  profileChannelId,
  mainVoiceChannelId = null,
  reason = 'category_replaced'
}) {
  const records = client.db.vcVoiceSessions.listActiveSummaryMessagesForCategory({
    guildId,
    categoryId,
    profileChannelId
  });
  let deletedCount = 0;
  for (const record of records) {
    if (mainVoiceChannelId) {
      const recordSession = client.db.vcVoiceSessions.get({
        guildId: record.guildId,
        sessionId: record.sessionId
      });
      if (String(recordSession?.mainVoiceChannelId || '') !== String(mainVoiceChannelId)) {
        continue;
      }
    }
    const deleted = await deleteVoiceSessionEndCardRecord(client, record, {
      status: 'deleted',
      reason
    });
    if (deleted) {
      deletedCount += 1;
      if (reason === 'new_live_session') {
        client.logger.info('vc session end summary card replaced by new live session', {
          guildId,
          sessionId: record.sessionId,
          categoryId,
          profileChannelId,
          mainVoiceChannelId: mainVoiceChannelId || null,
          messageId: record.messageId
        });
        appendOperationLog(client, {
          severity: 'info',
          eventType: 'vc_end_summary_replaced_by_live',
          title: 'VC end summary replaced by live card',
          body: [
            `category: \`${categoryId}\``,
            mainVoiceChannelId ? `voiceChannel: \`${mainVoiceChannelId}\`` : null,
            `session: \`${record.sessionId}\``,
            `message: \`${record.messageId}\``
          ].filter(Boolean).join('\n'),
          metadata: {
            guildId,
            sessionId: record.sessionId,
            categoryId,
            profileChannelId,
            mainVoiceChannelId: mainVoiceChannelId || null,
            messageId: record.messageId
          }
        });
      }
    }
  }
  return deletedCount;
}

async function postVoiceSessionEndSummaryCard(client, sessionRow, { reason = 'session_closed' } = {}) {
  const endCardConfig = getEndCardConfig(client);
  const session = normalizeSession(sessionRow);
  if (!endCardConfig.enabled) {
    client.logger.info('vc session end summary card skipped disabled', {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId || null,
      reason
    });
    return null;
  }
  if (session.status !== SESSION_STATUSES.CLOSED) {
    client.logger.info('vc session end summary card skipped ignored session', {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId || null,
      status: session.status,
      reason
    });
    return null;
  }

  const mapping = getCategoryMapping(client, session.categoryId);
  const profileChannelId = session.profileChannelId || mapping?.profileChannelId || null;
  if (!profileChannelId) {
    client.logger.warn('vc session end summary card post failed', {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      reason: 'missing_profile_channel'
    });
    appendOperationLog(client, {
      severity: 'warn',
      eventType: 'vc_end_summary_post_failed',
      title: 'VC end summary card post failed',
      body: [
        `session: \`${session.sessionId}\``,
        `category: \`${session.categoryId}\``,
        'reason: missing_profile_channel'
      ].join('\n'),
      metadata: {
        guildId: session.guildId,
        sessionId: session.sessionId,
        categoryId: session.categoryId,
        reason: 'missing_profile_channel'
      }
    });
    return null;
  }

  const guild = await client.guilds.fetch(session.guildId).catch(() => null);
  if (guild) {
    if (typeof guild.channels?.fetch === 'function') {
      await guild.channels.fetch().catch(() => null);
    }
  }
  const profileChannel = await client.channels.fetch(profileChannelId).catch(() => null);
  if (!guild || !profileChannel?.isTextBased?.()) {
    client.logger.warn('vc session end summary card post failed', {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      profileChannelId,
      reason: 'profile_channel_unavailable'
    });
    appendOperationLog(client, {
      severity: 'warn',
      eventType: 'vc_end_summary_post_failed',
      title: 'VC end summary card post failed',
      body: [
        `session: \`${session.sessionId}\``,
        `category: \`${session.categoryId}\``,
        `profileChannel: \`${profileChannelId}\``,
        'reason: profile_channel_unavailable'
      ].join('\n'),
      metadata: {
        guildId: session.guildId,
        sessionId: session.sessionId,
        categoryId: session.categoryId,
        profileChannelId,
        reason: 'profile_channel_unavailable'
      }
    });
    return null;
  }

  await deleteActiveVoiceSessionEndCardsForCategory(client, {
    guildId: session.guildId,
    categoryId: session.categoryId,
    profileChannelId,
    mainVoiceChannelId: session.mainVoiceChannelId || null,
    reason: 'new_end_summary'
  });

  const payload = buildVoiceSessionEndSummaryPayload(client, guild, session);
  const message = await profileChannel.send(payload).catch((error) => {
    client.logger.warn('vc session end summary card post failed', {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      profileChannelId,
      reason: 'send_failed',
      error: error.message
    });
    appendOperationLog(client, {
      severity: 'error',
      eventType: 'vc_end_summary_post_failed',
      title: 'VC end summary card post failed',
      body: [
        `session: \`${session.sessionId}\``,
        `category: \`${session.categoryId}\``,
        `profileChannel: \`${profileChannelId}\``,
        `error: ${error.message}`
      ].join('\n'),
      metadata: {
        guildId: session.guildId,
        sessionId: session.sessionId,
        categoryId: session.categoryId,
        profileChannelId,
        reason: 'send_failed'
      }
    });
    return null;
  });
  if (!message) {
    return null;
  }

  const expiresAt = endCardConfig.deleteMode === 'ttl'
    ? new Date(Date.now() + endCardConfig.ttlMinutes * 60 * 1000).toISOString()
    : PERSISTENT_END_CARD_EXPIRES_AT;
  const record = {
    guildId: session.guildId,
    sessionId: session.sessionId,
    categoryId: session.categoryId,
    profileChannelId,
    messageId: message.id,
    expiresAt,
    status: 'active'
  };
  client.db.vcVoiceSessions.upsertSummaryMessage(record);
  if (endCardConfig.deleteMode === 'ttl') {
    scheduleVoiceSessionEndCardDelete(client, record);
  }
  client.logger.info('vc session end summary card posted', {
    guildId: session.guildId,
    sessionId: session.sessionId,
    categoryId: session.categoryId,
    profileChannelId,
    messageId: message.id,
    expiresAt,
    deleteMode: endCardConfig.deleteMode,
    participantCount: parseJsonArray(session.allParticipantIdsJson).length,
    maxHumanCount: Number(session.maxHumanCount || 0),
    durationSeconds: getSessionDurationSeconds(session)
  });
  appendOperationLog(client, {
    severity: 'info',
    eventType: 'vc_end_summary_posted',
    title: 'VC end summary card posted',
    body: [
      `${resolveCategoryName(client, guild, session.categoryId, session)} / ${resolvePrimaryVoiceChannelName(guild, session)}`,
      `累計参加人数: ${parseJsonArray(session.allParticipantIdsJson).length} / 最大同時接続人数: ${Number(session.maxHumanCount || 0)}`,
      `通話時間: ${formatDurationSeconds(getSessionDurationSeconds(session))}`
    ].join('\n'),
    metadata: {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      profileChannelId,
      messageId: message.id,
      expiresAt
    }
  });
  return message;
}

async function restoreLatestVoiceSessionEndSummaryCards(client, { reason = 'ready_cleanup' } = {}) {
  const forceRuntimeRestore = /short_activity|runtime_restore/i.test(String(reason || ''));
  const endCardConfig = getEndCardConfig(client);
  if (!endCardConfig.enabled || (!endCardConfig.restoreLatestOnReady && !forceRuntimeRestore)) {
    client.logger.info(
      !endCardConfig.restoreLatestOnReady && !forceRuntimeRestore
        ? 'vc end-summary startup recreation disabled'
        : 'vc end summary restore skipped disabled',
      {
      reason,
      enabled: endCardConfig.enabled,
      restoreLatestOnReady: endCardConfig.restoreLatestOnReady
      }
    );
    return { restoredCount: 0, skippedCount: 0, errorCount: 0 };
  }
  if (!client.voiceProfileCategoryMap?.size) {
    return { restoredCount: 0, skippedCount: 0, errorCount: 0 };
  }

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) {
    client.logger.warn('vc session end summary latest restore skipped guild missing', { reason });
    return { restoredCount: 0, skippedCount: 0, errorCount: 1 };
  }
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }

  const minHumansToStart = Math.max(2, Number(getConfig(client).minHumansToStart || 2));
  let restoredCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const [categoryId, mapping] of client.voiceProfileCategoryMap) {
    const profileChannelId = mapping.profileChannelId;
    const activeRecords = client.db.vcVoiceSessions.listActiveSummaryMessagesForCategory({
      guildId: guild.id,
      categoryId,
      profileChannelId
    });
    const activeSummaryVoiceChannelIds = new Set();
    for (const activeRecord of activeRecords) {
      const activeSession = client.db.vcVoiceSessions.get({
        guildId: activeRecord.guildId,
        sessionId: activeRecord.sessionId
      });
      const activeVoiceChannelId = getSessionScopeVoiceChannelId(activeSession || activeRecord);
      if (activeVoiceChannelId) {
        activeSummaryVoiceChannelIds.add(activeVoiceChannelId);
      }
    }

    const snapshot = await collectCategorySnapshot(client, guild, categoryId, mapping).catch((error) => {
      errorCount += 1;
      client.logger.warn('vc session end summary latest restore skipped snapshot failed', {
        guildId: guild.id,
        categoryId,
        profileChannelId,
        reason,
        error: error.message
      });
      return null;
    });
    if (!snapshot) {
      continue;
    }
    const activeLiveChannel = snapshot.channelSnapshots?.find((channelSnapshot) =>
      Number(channelSnapshot.humanCount || 0) > 0
    );
    if (activeLiveChannel) {
      skippedCount += 1;
      client.logger.info('vc end summary restore skipped active_live_session', {
        guildId: guild.id,
        categoryId,
        profileChannelId,
        voiceChannelId: activeLiveChannel.mainVoiceChannelId || null,
        voiceChannelName: activeLiveChannel.voiceChannelName || null,
        humanCount: activeLiveChannel.humanCount,
        minHumansToStart,
        reason
      });
      continue;
    }

    const closedSessions = client.db.vcVoiceSessions.listClosedForSummary({
      guildId: guild.id,
      sinceIso: '1970-01-01T00:00:00.000Z',
      categoryId,
      mode: 'latest',
      limit: MAX_END_SUMMARY_RESTORE_CANDIDATES
    });
    const latestSessions = selectLatestClosedSessionsByVoiceChannel(closedSessions);
    if (!latestSessions.length) {
      skippedCount += 1;
      client.logger.info('vc end summary restore skipped no_closed_session', {
        guildId: guild.id,
        categoryId,
        profileChannelId,
        reason
      });
      continue;
    }

    for (const latestSession of latestSessions) {
      const voiceChannelId = getSessionScopeVoiceChannelId(latestSession);
      if (voiceChannelId && activeSummaryVoiceChannelIds.has(voiceChannelId)) {
        skippedCount += 1;
        client.logger.info('vc end summary restore skipped active_summary_exists', {
          guildId: guild.id,
          categoryId,
          profileChannelId,
          sessionId: latestSession.sessionId,
          mainVoiceChannelId: voiceChannelId,
          activeCount: activeRecords.length,
          reason
        });
        continue;
      }

      const message = await postVoiceSessionEndSummaryCard(client, latestSession, {
        reason: `${reason}_restore_latest`
      }).catch((error) => {
        errorCount += 1;
        client.logger.warn('vc session end summary latest restore failed', {
          guildId: guild.id,
          categoryId,
          profileChannelId,
          sessionId: latestSession.sessionId,
          mainVoiceChannelId: voiceChannelId || null,
          reason,
          error: error.message
        });
        return null;
      });
      if (message) {
        restoredCount += 1;
        activeSummaryVoiceChannelIds.add(voiceChannelId);
        client.logger.info('vc end summary restored latest closed session', {
          guildId: guild.id,
          categoryId,
          profileChannelId,
          sessionId: latestSession.sessionId,
          mainVoiceChannelId: voiceChannelId || null,
          messageId: message.id,
          reason
        });
      }
    }
  }

  return { restoredCount, skippedCount, errorCount };
}

async function cleanupVoiceSessionEndSummaryCards(client, { reason = 'ready_cleanup' } = {}) {
  const endCardConfig = getEndCardConfig(client);
  const records = client.db.vcVoiceSessions.listActiveSummaryMessages();
  let deletedCount = 0;
  let missingCount = 0;
  let scheduledCount = 0;
  let keptCount = 0;
  let errorCount = 0;

  for (const record of records) {
    if (
      endCardConfig.deleteMode === 'ttl' &&
      record.expiresAt &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      const deleted = await deleteVoiceSessionEndCardRecord(client, record, {
        status: 'expired',
        reason
      });
      if (deleted) {
        deletedCount += 1;
      } else {
        errorCount += 1;
      }
      continue;
    }

    clearEndCardTimer(client, record);
    const channel = await client.channels.fetch(record.profileChannelId).catch(() => null);
    const message = channel?.isTextBased?.()
      ? await channel.messages.fetch(record.messageId).catch(() => null)
      : null;
    if (!message) {
      client.db.vcVoiceSessions.updateSummaryMessageStatus({
        guildId: record.guildId,
        sessionId: record.sessionId,
        profileChannelId: record.profileChannelId,
        status: 'failed'
      });
      missingCount += 1;
      client.logger.warn('vc session end summary card cleanup on ready missing message', {
        guildId: record.guildId,
        sessionId: record.sessionId,
        categoryId: record.categoryId,
        profileChannelId: record.profileChannelId,
        messageId: record.messageId,
        reason
      });
      continue;
    }

    if (endCardConfig.deleteMode === 'ttl') {
      scheduleVoiceSessionEndCardDelete(client, record);
      scheduledCount += 1;
    } else {
      keptCount += 1;
    }
  }

  const restored = await restoreLatestVoiceSessionEndSummaryCards(client, { reason }).catch((error) => {
    errorCount += 1;
    client.logger.warn('vc session end summary latest restore failed', {
      reason,
      error: error.message
    });
    return { restoredCount: 0, skippedCount: 0, errorCount: 1 };
  });

  client.logger.info('vc session end summary card cleanup on ready', {
    reason,
    activeCount: records.length,
    deletedCount,
    missingCount,
    scheduledCount,
    keptCount,
    restoredCount: restored?.restoredCount || 0,
    restoreSkippedCount: restored?.skippedCount || 0,
    errorCount
  });
  return {
    activeCount: records.length,
    deletedCount,
    missingCount,
    scheduledCount,
    keptCount,
    restoredCount: restored?.restoredCount || 0,
    restoreSkippedCount: restored?.skippedCount || 0,
    errorCount
  };
}

function updateExistingOpenSessionFromSnapshot(client, session, snapshot, {
  nowIso,
  reason,
  metadata = {}
}) {
  session.allParticipantIds = [...new Set([...session.allParticipantIds, ...snapshot.memberIds])];
  session.voiceChannelIds = [...new Set([...session.voiceChannelIds, ...snapshot.voiceChannelIds])];
  session.mainVoiceChannelId = snapshot.mainVoiceChannelId || session.mainVoiceChannelId || null;
  session.firstTwoPlusAt = session.firstTwoPlusAt || nowIso;
  session.lastTwoPlusAt = nowIso;

  const syncResult = syncSessionMembers(client, session, snapshot, { nowIso });
  session.lastLeaveUserId = syncResult.lastLeaveUserId || session.lastLeaveUserId || null;
  session.lastLeaveAt = syncResult.lastLeaveAt || session.lastLeaveAt || null;

  if (session.status === SESSION_STATUSES.SOLO_GRACE) {
    session.status = SESSION_STATUSES.ACTIVE;
    session.soloSince = null;
    insertSessionEvent(client, session, {
      eventType: 'session_resume',
      occurredAt: nowIso,
      snapshot,
      metadata: { reason, ...metadata }
    });
  } else {
    addActiveSeconds(session, nowIso);
  }

  session.lastActiveAt = nowIso;
  updateSessionPeakIfNeeded(client, session, snapshot, nowIso);
  session.updatedAt = nowIso;
  client.db.vcVoiceSessions.upsert(serializeSession(session));
  return session;
}

function createSessionFromSnapshot(client, {
  guildId,
  categoryId,
  profileChannelId,
  snapshot,
  nowIso,
  reason = 'voice_state_update'
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
  try {
    client.db.vcVoiceSessions.upsert(serializeSession(session));
  } catch (error) {
    if (!isOpenSessionUniqueConflict(error)) {
      throw error;
    }

    const existingSession = getSessionWithJson(client.db.vcVoiceSessions.getOpenForChannel({
      guildId,
      categoryId,
      profileChannelId,
      mainVoiceChannelId: snapshot.mainVoiceChannelId
    }));
    if (!existingSession) {
      throw error;
    }

    client.logger.info('vc session duplicate active prevented', {
      guildId,
      categoryId,
      profileChannelId,
      mainVoiceChannelId: snapshot.mainVoiceChannelId || null,
      attemptedSessionId: session.sessionId,
      existingSessionId: existingSession.sessionId,
      reason,
      humanCount: snapshot.humanCount
    });
    insertSessionEvent(client, existingSession, {
      eventType: 'restart_reconcile',
      occurredAt: nowIso,
      snapshot,
      metadata: {
        reason,
        duplicateActivePrevented: true,
        attemptedSessionId: session.sessionId
      }
    });
    return updateExistingOpenSessionFromSnapshot(client, existingSession, snapshot, {
      nowIso,
      reason,
      metadata: {
        duplicateActivePrevented: true,
        attemptedSessionId: session.sessionId
      }
    });
  }
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
    metadata: { reason: isReadyReconcileReason(reason) ? 'restart_reconcile' : 'min_humans_reached' }
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
    mainVoiceChannelId: snapshot.mainVoiceChannelId || null,
    sessionId: session.sessionId,
    humanCount: snapshot.humanCount,
    startedAt: session.startedAt,
    maxHumanCount: session.maxHumanCount
  });
  if (isReadyReconcileReason(reason)) {
    client.logger.info('vc session restart reconcile created new', {
      guildId,
      categoryId,
      profileChannelId,
      mainVoiceChannelId: snapshot.mainVoiceChannelId || null,
      sessionId: session.sessionId,
      humanCount: snapshot.humanCount,
      startedAt: session.startedAt,
      reason
    });
  }
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

async function closeSession(client, session, snapshot, {
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
  Object.assign(session, serializeSession(session));
  client.db.vcVoiceSessions.upsert(session);
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

  if (finalStatus === SESSION_STATUSES.CLOSED) {
    await clearShortActivityForMeaningfulSession(client, session).catch((error) => {
      client.logger.warn('vc short activity clear failed', {
        guildId: session.guildId,
        sessionId: session.sessionId,
        error: error.message
      });
    });
    await postVoiceSessionEndSummaryCard(client, session, { reason }).catch((error) => {
      client.logger.warn('vc session end summary card post failed', {
        guildId: session.guildId,
        sessionId: session.sessionId,
        categoryId: session.categoryId,
        profileChannelId: session.profileChannelId || null,
        reason: 'post_failed',
        error: error.message
      });
    });
  } else {
    await recordShortActivityForIgnoredSession(client, session, { reason }).catch((error) => {
      client.logger.warn('vc short activity record failed', {
        guildId: session.guildId,
        sessionId: session.sessionId,
        error: error.message
      });
    });
    await restoreLatestVoiceSessionEndSummaryCards(client, {
      reason: 'restored_previous_summary_after_short_activity'
    }).catch((error) => {
      client.logger.warn('restored previous summary after short activity failed', {
        guildId: session.guildId,
        sessionId: session.sessionId,
        error: error.message
      });
    });
    await updateShortActivityCard(client, {
      guildId: session.guildId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId
    }).catch(() => null);
    client.logger.info('restored previous summary after short activity', {
      guildId: session.guildId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId,
      sessionId: session.sessionId
    });
    client.logger.info('vc session end summary card skipped ignored session', {
      guildId: session.guildId,
      sessionId: session.sessionId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId || null,
      status: finalStatus,
      reason,
      twoPlusTotalSeconds: session.twoPlusTotalSeconds,
      minSessionActiveMinutes: config.minSessionActiveMinutes
    });
  }

  return session;
}

function getSessionWithJson(sessionRow) {
  return normalizeSession(sessionRow);
}

function getSessionScopeVoiceChannelId(sessionRow) {
  const session = normalizeSession(sessionRow);
  return String(session?.mainVoiceChannelId || session?.voiceChannelIds?.[0] || session?.sessionId || '').trim();
}

function selectLatestClosedSessionsByVoiceChannel(sessions) {
  const latestByChannelId = new Map();
  for (const session of sessions.map(normalizeSession).filter(Boolean)) {
    const voiceChannelId = getSessionScopeVoiceChannelId(session);
    if (!voiceChannelId || latestByChannelId.has(voiceChannelId)) {
      continue;
    }
    latestByChannelId.set(voiceChannelId, session);
  }
  return [...latestByChannelId.values()].sort((left, right) =>
    new Date(right.endedAt || 0).getTime() - new Date(left.endedAt || 0).getTime()
  );
}

function createEmptySnapshotForOpenSession(session) {
  const voiceChannelIds = parseJsonArray(session.voiceChannelIdsJson);
  const mainVoiceChannelId = session.mainVoiceChannelId || voiceChannelIds[0] || null;
  return {
    members: [],
    memberIds: [],
    humanCount: 0,
    activeVoiceChannelIds: [],
    voiceChannelIds: mainVoiceChannelId ? [String(mainVoiceChannelId)] : voiceChannelIds,
    mainVoiceChannelId,
    voiceChannelName: ''
  };
}

async function processVoiceSessionSnapshotLocked(client, guild, categoryId, mapping, {
  snapshot,
  openSession = null,
  reason = 'voice_state_update',
  nowIso = new Date().toISOString(),
  config = getConfig(client)
} = {}) {
  if (!config.enabled) {
    return null;
  }

  const guildId = guild.id;
  const minHumansToStart = Math.max(2, Number(config.minHumansToStart || 2));
  const readyReconcile = isReadyReconcileReason(reason);
  const resolvedOpenSession = openSession || (snapshot.mainVoiceChannelId
    ? getSessionWithJson(client.db.vcVoiceSessions.getOpenForChannel({
      guildId,
      categoryId,
      profileChannelId: mapping.profileChannelId,
      mainVoiceChannelId: snapshot.mainVoiceChannelId
    }))
    : null);

  if (!resolvedOpenSession) {
    if (snapshot.humanCount >= minHumansToStart) {
      return createSessionFromSnapshot(client, {
        guildId,
        categoryId,
        profileChannelId: mapping.profileChannelId,
        snapshot,
        nowIso,
        reason
      });
    }
    return null;
  }

  const session = resolvedOpenSession;
  session.allParticipantIds = [...new Set([...session.allParticipantIds, ...snapshot.memberIds])];
  session.voiceChannelIds = [...new Set([...session.voiceChannelIds, ...snapshot.voiceChannelIds])];
  session.mainVoiceChannelId = snapshot.mainVoiceChannelId || session.mainVoiceChannelId || null;

  if (readyReconcile) {
    client.logger.info('vc session restored on ready', {
      guildId,
      categoryId,
      profileChannelId: mapping.profileChannelId,
      mainVoiceChannelId: session.mainVoiceChannelId || null,
      sessionId: session.sessionId,
      status: session.status,
      humanCount: snapshot.humanCount,
      startedAt: session.startedAt,
      reason
    });
    insertSessionEvent(client, session, {
      eventType: 'restart_reconcile',
      occurredAt: nowIso,
      snapshot,
      metadata: {
        reason,
        restoredStatus: session.status
      }
    });
  }

  if (session.status === SESSION_STATUSES.SOLO_GRACE && snapshot.humanCount < minHumansToStart) {
    if (!session.soloSince) {
      session.soloSince = nowIso;
      session.updatedAt = nowIso;
      client.db.vcVoiceSessions.upsert(serializeSession(session));
      client.logger.info('vc session solo grace timestamp restored', {
        guildId,
        categoryId,
        profileChannelId: mapping.profileChannelId,
        mainVoiceChannelId: session.mainVoiceChannelId || null,
        sessionId: session.sessionId,
        soloSince: session.soloSince,
        reason
      });
    }
    const expiresAt = addMinutes(session.soloSince, config.soloGraceMinutes);
    if (expiresAt && new Date(nowIso).getTime() >= new Date(expiresAt).getTime()) {
      return await closeSession(client, session, snapshot, {
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
      if (readyReconcile) {
        client.logger.info('vc session resume existing active', {
          guildId,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          mainVoiceChannelId: session.mainVoiceChannelId || null,
          sessionId: session.sessionId,
          humanCount: snapshot.humanCount,
          startedAt: session.startedAt,
          maxHumanCount: session.maxHumanCount,
          reason
        });
      }
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
    if (readyReconcile) {
      client.logger.info('vc session restart reconcile closed empty', {
        guildId,
        categoryId,
        profileChannelId: mapping.profileChannelId,
        mainVoiceChannelId: session.mainVoiceChannelId || null,
        sessionId: session.sessionId,
        humanCount: snapshot.humanCount,
        startedAt: session.startedAt,
        maxHumanCount: session.maxHumanCount,
        reason
      });
    }
    return await closeSession(client, session, snapshot, {
      closedAt: nowIso,
      reason: readyReconcile ? 'restart_reconcile_empty' : 'empty',
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

async function processVoiceSessionCategoryLocked(client, guild, categoryId, mapping, {
  reason = 'voice_state_update',
  nowIso = new Date().toISOString()
} = {}) {
  const config = getConfig(client);
  if (!config.enabled) {
    return null;
  }

  const guildId = guild.id;
  const categorySnapshot = await collectCategorySnapshot(client, guild, categoryId, mapping);
  const channelSnapshots = categorySnapshot.channelSnapshots?.length
    ? categorySnapshot.channelSnapshots
    : [];
  const openSessions = client.db.vcVoiceSessions.listOpenForCategory({
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId
  }).map(getSessionWithJson).filter(Boolean);
  const openByMainChannelId = new Map();
  const legacyOpenSessions = [];
  for (const session of openSessions) {
    if (session.mainVoiceChannelId) {
      openByMainChannelId.set(String(session.mainVoiceChannelId), session);
    } else {
      legacyOpenSessions.push(session);
    }
  }

  const processedSessionIds = new Set();
  const results = [];

  for (const snapshot of channelSnapshots) {
    const channelId = String(snapshot.mainVoiceChannelId || '');
    let openSession = channelId ? openByMainChannelId.get(channelId) || null : null;
    if (!openSession && legacyOpenSessions.length === 1 && channelSnapshots.length === 1) {
      openSession = legacyOpenSessions[0];
      client.logger.info('vc session legacy open session adopted channel scope', {
        guildId,
        categoryId,
        profileChannelId: mapping.profileChannelId,
        sessionId: openSession.sessionId,
        mainVoiceChannelId: channelId || null,
        reason
      });
    }
    const result = await processVoiceSessionSnapshotLocked(client, guild, categoryId, mapping, {
      snapshot,
      openSession,
      reason,
      nowIso,
      config
    });
    if (openSession?.sessionId) {
      processedSessionIds.add(String(openSession.sessionId));
    }
    if (result?.sessionId) {
      processedSessionIds.add(String(result.sessionId));
      results.push(result);
    }
  }

  for (const session of openSessions) {
    if (processedSessionIds.has(String(session.sessionId))) {
      continue;
    }
    const emptySnapshot = createEmptySnapshotForOpenSession(session);
    const result = await processVoiceSessionSnapshotLocked(client, guild, categoryId, mapping, {
      snapshot: emptySnapshot,
      openSession: session,
      reason,
      nowIso,
      config
    });
    if (result?.sessionId) {
      results.push(result);
    }
  }

  client.logger.info('vc session category channel-scope processed', {
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    activeChannelCount: channelSnapshots.length,
    openSessionCount: openSessions.length,
    processedSessionCount: processedSessionIds.size,
    resultCount: results.length,
    reason,
    channels: channelSnapshots.map((snapshot) => ({
      mainVoiceChannelId: snapshot.mainVoiceChannelId,
      voiceChannelName: snapshot.voiceChannelName,
      humanCount: snapshot.humanCount,
      memberIds: snapshot.memberIds
    }))
  });

  return results;
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
    if (config.enabled && isReadyReconcileReason(reason)) {
      client.logger.info('vc session ready reconcile skipped no configured category', {
        reason,
        configuredCategoryCount: client.voiceProfileCategoryMap?.size || 0
      });
    }
    return { updatedCount: 0, skippedReason: config.enabled ? 'no_categories' : 'disabled' };
  }

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) {
    return { updatedCount: 0, skippedReason: 'guild_fetch_failed' };
  }
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }

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
  return formatDateTimeJa(iso);
}

function getJstDateTimeParts(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: valueByType.get('year'),
    month: valueByType.get('month'),
    day: valueByType.get('day'),
    hour: valueByType.get('hour'),
    minute: valueByType.get('minute')
  };
}

function formatDateTimeJa(iso) {
  try {
    const parts = getJstDateTimeParts(iso);
    if (!parts) {
      return String(iso);
    }
    return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
  } catch {
    return String(iso);
  }
}

function formatSessionDateTimeRange(startIso, endIso) {
  if (!startIso && !endIso) {
    return '不明';
  }
  if (!startIso || !endIso) {
    return formatDateTimeJa(startIso || endIso);
  }
  try {
    const start = getJstDateTimeParts(startIso);
    const end = getJstDateTimeParts(endIso);
    if (!start || !end) {
      return `${formatDateTimeJa(startIso)}〜${formatDateTimeJa(endIso)}`;
    }
    const startDate = `${start.year}-${start.month}-${start.day}`;
    const endDate = `${end.year}-${end.month}-${end.day}`;
    const startLabel = `${Number(start.month)}月${Number(start.day)}日 ${start.hour}:${start.minute}`;
    if (startDate === endDate) {
      return `${startLabel}〜${end.hour}:${end.minute}`;
    }
    return `${startLabel}〜${Number(end.month)}月${Number(end.day)}日 ${end.hour}:${end.minute}`;
  } catch {
    return `${formatDateTimeJa(startIso)}〜${formatDateTimeJa(endIso)}`;
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

function sortTimelineEvents(events) {
  return [...events].sort((left, right) => {
    const timeDelta = new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime();
    if (timeDelta !== 0) {
      return timeDelta;
    }
    const leftEventId = Number(left.eventId || 0);
    const rightEventId = Number(right.eventId || 0);
    const leftOrder = Number.isFinite(leftEventId) ? leftEventId : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(rightEventId) ? rightEventId : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

function buildTimelineEventCandidates(events, session) {
  const relevant = [...events]
    .filter((event) => (
      event.humanCountAfter != null &&
      ['session_start', 'join', 'leave', 'move', 'peak_update', 'solo_grace_start', 'session_close'].includes(event.eventType)
    ));
  const sorted = sortTimelineEvents(relevant);
  const firstCount = Number(sorted[0]?.humanCountAfter ?? Math.max(2, Math.min(Number(session.maxHumanCount || 2), 2)));
  const candidates = [
    {
      eventId: 'synthetic_start',
      eventType: 'session_start',
      occurredAt: session.startedAt,
      humanCountAfter: firstCount
    },
    ...sorted
  ];
  if (session.endedAt) {
    candidates.push({
      eventId: 'synthetic_end',
      eventType: 'session_close',
      occurredAt: session.endedAt,
      humanCountAfter: 0
    });
  }
  return sortTimelineEvents(candidates)
    .filter((event) => event.occurredAt && Number.isFinite(new Date(event.occurredAt).getTime()));
}

function selectTimelineEventsAcrossRange(events, session, maxLines) {
  const candidates = buildTimelineEventCandidates(events, session);
  if (candidates.length <= maxLines) {
    return candidates;
  }

  const startMs = new Date(session.startedAt || candidates[0].occurredAt).getTime();
  const endMs = new Date(session.endedAt || candidates[candidates.length - 1].occurredAt).getTime();
  const selected = new Map();
  const addEvent = (event) => {
    if (!event) {
      return;
    }
    const key = `${event.eventId || event.eventType}:${event.occurredAt}:${event.humanCountAfter}`;
    selected.set(key, event);
  };

  addEvent(candidates[0]);
  addEvent(candidates[candidates.length - 1]);
  addEvent(candidates.find((event) => Number(event.humanCountAfter || 0) === Number(session.maxHumanCount || 0)));

  const bucketCount = Math.max(2, maxLines - selected.size);
  for (let index = 0; index < bucketCount; index += 1) {
    const ratio = bucketCount === 1 ? 0 : index / (bucketCount - 1);
    const targetMs = startMs + ((endMs - startMs) * ratio);
    const nearest = candidates
      .filter((event) => ![...selected.values()].some((selectedEvent) => selectedEvent === event))
      .sort((left, right) =>
        Math.abs(new Date(left.occurredAt).getTime() - targetMs) -
        Math.abs(new Date(right.occurredAt).getTime() - targetMs)
      )[0];
    addEvent(nearest);
  }

  return sortTimelineEvents([...selected.values()])
    .slice(0, maxLines);
}

function formatTimelineTime(iso, session) {
  const start = getJstDateTimeParts(session.startedAt);
  const current = getJstDateTimeParts(iso);
  if (!current) {
    return formatClock(iso);
  }
  if (!start || start.year !== current.year || start.month !== current.month || start.day !== current.day) {
    return `${Number(current.month)}月${Number(current.day)}日 ${current.hour}:${current.minute}`;
  }
  return `${current.hour}:${current.minute}`;
}

function getTimelineEventLabel(event) {
  if (event.eventType === 'session_start') {
    return '開始';
  }
  if (event.eventType === 'session_close') {
    return '終了';
  }
  if (event.eventType === 'peak_update') {
    return 'ピーク';
  }
  if (event.eventType === 'solo_grace_start') {
    return '1人';
  }
  if (event.eventType === 'join') {
    return '参加';
  }
  if (event.eventType === 'leave') {
    return '退出';
  }
  if (event.eventType === 'move') {
    return '移動';
  }
  return '';
}

function getTimelineEventDisplayPriority(event) {
  if (event.eventType === 'session_close') {
    return 60;
  }
  if (event.eventType === 'peak_update') {
    return 50;
  }
  if (event.eventType === 'session_start') {
    return 45;
  }
  if (event.eventType === 'solo_grace_start') {
    return 40;
  }
  if (event.eventType === 'join') {
    return 30;
  }
  if (event.eventType === 'leave') {
    return 25;
  }
  if (event.eventType === 'move') {
    return 20;
  }
  return 0;
}

function dedupeTimelineDisplayEvents(events, session) {
  const deduped = [];
  for (const event of events) {
    const displayKey = `${formatTimelineTime(event.occurredAt, session)}:${Math.max(0, Number(event.humanCountAfter || 0))}`;
    const previous = deduped[deduped.length - 1];
    if (previous?.displayKey === displayKey) {
      const currentPriority = getTimelineEventDisplayPriority(event);
      const previousPriority = getTimelineEventDisplayPriority(previous.event);
      if (currentPriority >= previousPriority) {
        deduped[deduped.length - 1] = { displayKey, event };
      }
      continue;
    }
    deduped.push({ displayKey, event });
  }
  return deduped.map((entry) => entry.event);
}

function formatTimelineLines(events, session, { maxLines = MAX_GRAPH_LINES, detailed = false } = {}) {
  const selected = selectTimelineEventsAcrossRange(events, session, maxLines);
  const deduped = dedupeTimelineDisplayEvents(selected, session);

  return deduped.map((event) => {
    const count = Math.max(0, Number(event.humanCountAfter || 0));
    const bar = count > 0 ? '█'.repeat(Math.max(1, Math.min(count, 10))) : '・';
    const label = detailed ? ` ${getTimelineEventLabel(event)}` : '';
    return `${formatTimelineTime(event.occurredAt, session)}  ${bar} ${count}人${label}`.trim();
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
    return `${time} 終了`;
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
    Math.max(getConfig(client).maxEventsToShow, 200)
  );
  const categoryName = resolveCategoryName(client, guild, session.categoryId, session);
  const voiceChannelName = resolvePrimaryVoiceChannelName(guild, session);
  const allParticipantIds = parseJsonArray(session.allParticipantIdsJson);
  const peakParticipantIds = parseJsonArray(session.peakMemberIdsJson);
  const durationSeconds = getSessionDurationSeconds(session);
  const activeSeconds = Number(session.twoPlusTotalSeconds || 0);
  const graphLines = formatTimelineLines(events, session, { maxLines: MAX_GRAPH_LINES, detailed: false });
  const peakTime = session.peakStartedAt
    ? session.peakEndedAt
      ? formatSessionDateTimeRange(session.peakStartedAt, session.peakEndedAt)
      : `${formatDateTimeJa(session.peakStartedAt)}ごろ`
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
      `**日時:** ${formatSessionDateTimeRange(session.startedAt, session.endedAt)}`,
      `**通話時間:** ${formatDurationSeconds(durationSeconds)}`,
      `**累計参加人数:** ${allParticipantIds.length}人`,
      `**最大同時接続人数:** ${Number(session.maxHumanCount || 0)}人`,
      `**主な通話チャンネル:** ${voiceChannelName}`,
      activeSeconds > 0 ? `**2人以上で話していた時間:** ${formatDurationSeconds(activeSeconds)}` : null,
      `**ピーク時間:** ${peakTime}`
    ].filter(Boolean).join('\n'))
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      `**最初にいた人**\n${session.firstJoinUserId ? `<@${session.firstJoinUserId}>（${formatClock(session.firstJoinAt)}）` : '記録なし'}`,
      `**最後に抜けた人**\n${session.lastLeaveUserId ? `<@${session.lastLeaveUserId}>（${formatClock(session.lastLeaveAt)}）` : '記録なし'}`
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

  if (commandUserId) {
    const detailToken = createVcSummaryDetailState(client, {
      guildId: session.guildId,
      commandUserId,
      sessionId: session.sessionId,
      mode,
      lookbackHours
    });
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${VC_SUMMARY_DETAIL_PREFIX}${detailToken}`)
          .setLabel('人数推移を見る')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

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

async function buildVcSummaryDetailPayload(client, guild, sessionRow, {
  commandUserId = null,
  mode = 'peak',
  lookbackHours = null
} = {}) {
  const session = normalizeSession(sessionRow);
  const events = client.db.vcVoiceSessions.listEvents(session.guildId, session.sessionId, 500);
  const timelineLines = formatTimelineLines(events, session, { maxLines: 18, detailed: true });
  const durationSeconds = getSessionDurationSeconds(session);
  const categoryName = resolveCategoryName(client, guild, session.categoryId, session);
  const voiceChannelName = resolvePrimaryVoiceChannelName(guild, session);

  const container = new ContainerBuilder().setAccentColor(DEFAULT_ACCENT_COLOR);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 通話の人数推移'),
    new TextDisplayBuilder().setContent([
      `**日時:** ${formatSessionDateTimeRange(session.startedAt, session.endedAt)}`,
      `**通話時間:** ${formatDurationSeconds(durationSeconds)}`,
      `**カテゴリ:** ${categoryName}`,
      `**主な通話チャンネル:** ${voiceChannelName}`
    ].join('\n'))
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      '**人数の推移（詳細）**',
      timelineLines.length ? timelineLines.join('\n') : '記録なし'
    ].join('\n'))
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent([
      '長い通話でも開始・ピーク・中盤・終盤が見えるよう、全体の時間範囲から代表点を抽出しています。',
      `集計対象: 直近${lookbackHours || getConfig(client).summaryLookbackHours}時間 / mode: ${mode}${commandUserId ? `\n実行者: <@${commandUserId}>` : ''}`
    ].join('\n'))
  );

  client.logger.info('vc summary detail card built', {
    guildId: session.guildId,
    sessionId: session.sessionId,
    categoryId: session.categoryId,
    eventCount: events.length,
    timelineLineCount: timelineLines.length,
    mode,
    lookbackHours,
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

function buildHistoryLine(client, guild, sessionRow) {
  const session = normalizeSession(sessionRow);
  const participantIds = parseJsonArray(session.allParticipantIdsJson);
  const visibleParticipants = participantIds.slice(0, 5).map((userId) => `<@${userId}>`).join(' / ');
  const extra = participantIds.length > 5 ? ` ほか${participantIds.length - 5}人` : '';
  return [
    `**${formatSessionDateTimeRange(session.startedAt, session.endedAt)}**`,
    `${formatDurationSeconds(getSessionDurationSeconds(session))} / 最大同時接続${Number(session.maxHumanCount || 0)}人 / ${resolvePrimaryVoiceChannelName(guild, session)}`,
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

function createVcSummaryDetailState(client, state) {
  const token = createVcSummarySelectionState(client, {
    ...state,
    kind: 'detail',
    candidateSessionIds: [String(state.sessionId || '')].filter(Boolean)
  });
  client.logger.info('vc summary detail state created', {
    guildId: state.guildId,
    commandUserId: state.commandUserId,
    sessionId: state.sessionId,
    mode: state.mode,
    lookbackHours: state.lookbackHours,
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
    `${categoryName} / ${voiceChannelName} / 同時${Number(session.maxHumanCount || 0)}人 / ${timeRange}`,
    100
  );
}

function buildSessionSelectDescription(sessionRow) {
  const session = normalizeSession(sessionRow);
  const participantCount = parseJsonArray(session.allParticipantIdsJson).length;
  return truncateForDiscord(
    `${formatTime(session.startedAt)} / ${formatDurationSeconds(getSessionDurationSeconds(session))} / 累計参加${participantCount}人`,
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
  if (!interaction.isStringSelectMenu?.() && !interaction.isButton?.()) {
    return false;
  }
  const customId = String(interaction.customId || '');
  if (customId.startsWith(VC_SUMMARY_DETAIL_PREFIX)) {
    return await handleVcSummaryDetailInteraction(interaction);
  }
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
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }
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

async function handleVcSummaryDetailInteraction(interaction) {
  const client = interaction.client;
  const customId = String(interaction.customId || '');
  const token = customId.slice(VC_SUMMARY_DETAIL_PREFIX.length);
  const state = getVcSummarySelectionState(client, token);
  if (!state || state.kind !== 'detail') {
    client.logger.info('vc summary detail expired', {
      interactionId: interaction.id,
      customId,
      token,
      userId: interaction.user?.id || null
    });
    await interaction.reply({
      content: 'この詳細表示ボタンは期限切れです。もう一度 /vc-summary を実行してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  if (String(interaction.user.id) !== String(state.commandUserId)) {
    client.logger.info('vc summary detail rejected wrong user', {
      interactionId: interaction.id,
      token,
      commandUserId: state.commandUserId,
      interactingUserId: interaction.user.id,
      sessionId: state.sessionId || null
    });
    await interaction.reply({
      content: 'この詳細表示ボタンは、コマンドを実行した人だけが使えます。',
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
  if (typeof guild.channels?.fetch === 'function') {
    await guild.channels.fetch().catch(() => null);
  }
  const session = client.db.vcVoiceSessions.get({
    guildId: state.guildId,
    sessionId: state.sessionId
  });
  if (!session) {
    await interaction.reply({
      content: '通話セッションの記録が見つかりませんでした。もう一度 /vc-summary を実行してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  const payload = await buildVcSummaryDetailPayload(client, guild, session, {
    commandUserId: state.commandUserId,
    mode: state.mode,
    lookbackHours: state.lookbackHours
  });
  await interaction.reply({
    ...payload,
    flags: payload.flags | MessageFlags.Ephemeral
  }).catch((error) => {
    client.logger.warn('vc summary detail reply failed', {
      interactionId: interaction.id,
      token,
      sessionId: state.sessionId,
      error: error.message
    });
  });
  client.logger.info('vc summary detail shown', {
    interactionId: interaction.id,
    token,
    guildId: state.guildId,
    commandUserId: state.commandUserId,
    sessionId: state.sessionId,
    mode: state.mode,
    lookbackHours: state.lookbackHours
  });
  return true;
}

module.exports = {
  SESSION_STATUSES,
  buildLatestVcSummaryResponse,
  cleanupVoiceSessionEndSummaryCards,
  deleteActiveVoiceSessionEndCardsForCategory,
  handleVcSummaryInteraction,
  handleVoiceSessionStateUpdate,
  queueVoiceSessionCategoryUpdate,
  reconcileVoiceSessions,
  startVoiceSessionReconciliation
};
