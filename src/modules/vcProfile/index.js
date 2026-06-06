const crypto = require('node:crypto');
const { Routes } = require('discord-api-types/v10');
const { buildProfileMessage } = require('./buildProfileMessage');
const { findLatestIntroMessage } = require('./findLatestIntroMessage');
const { parseAccentColor } = require('../../utils/accentColors');
const { deleteActiveVoiceSessionEndCardsForCategory } = require('../vcSessionSummary');

const DISCORD_COMPONENT_LIMIT = 40;
const DEFAULT_MEMBERS_PER_PAGE = 6;
const SESSION_ACCENT_COLOR_PALETTE = [
  0x14b8a6,
  0x0ea5e9,
  0x8b5cf6,
  0xec4899,
  0xf43f5e,
  0xf59e0b,
  0x22c55e
];

async function initializeVoiceProfileMappings(client) {
  client.voiceProfileCategoryMap.clear();

  for (const entry of client.appConfig.voiceProfileChannels) {
    if (!entry.profileChannelId) {
      continue;
    }

    try {
      const profileChannel = await client.channels.fetch(entry.profileChannelId);

      if (!profileChannel) {
        client.logger.warn('VC profile channel not found', {
          profileChannelId: entry.profileChannelId,
          name: entry.name
        });
        continue;
      }

      if (!profileChannel.parentId) {
        client.logger.warn('VC profile channel has no parent category', {
          profileChannelId: entry.profileChannelId,
          name: entry.name
        });
        continue;
      }

      client.voiceProfileCategoryMap.set(profileChannel.parentId, {
        name: entry.name || profileChannel.parent?.name || profileChannel.name,
        categoryId: profileChannel.parentId,
        profileChannelId: profileChannel.id,
        accentColor: entry.accentColor ?? null,
        voiceStatusLabel: entry.voiceStatusLabel || null
      });
    } catch (error) {
      client.logger.error('Failed to initialize VC profile mapping', {
        profileChannelId: entry.profileChannelId,
        name: entry.name,
        error: error.message
      });
    }
  }
}

function getTrackedCategoryId(client, channel) {
  if (!channel?.parentId) {
    return null;
  }

  return client.voiceProfileCategoryMap.has(channel.parentId) ? channel.parentId : null;
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

function getStableMemberName(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || String(member?.id || '');
}

function selectRandomSessionAccentColor() {
  const index = crypto.randomInt(0, SESSION_ACCENT_COLOR_PALETTE.length);
  return SESSION_ACCENT_COLOR_PALETTE[index];
}

function getCategoryMapping(client, categoryId) {
  return client.voiceProfileCategoryMap?.get?.(String(categoryId || '')) || null;
}

function upsertVoiceMemberSession(client, {
  guildId,
  userId,
  categoryId,
  profileChannelId,
  voiceChannelId,
  joinedAt = null,
  reason = 'voice_profile_sync'
}) {
  const existing = client.db.vcProfiles.getMemberSession({
    guildId,
    userId,
    categoryId,
    profileChannelId
  });
  client.db.vcProfiles.upsertMemberSession({
    guildId,
    userId,
    categoryId,
    profileChannelId,
    voiceChannelId,
    joinedAt: existing?.joinedAt || joinedAt || new Date().toISOString()
  });
  client.logger.info(existing ? 'vc profile join session reused' : 'vc profile join session recorded', {
    guildId,
    userId,
    categoryId,
    profileChannelId,
    voiceChannelId,
    joinedAt: existing?.joinedAt || joinedAt || null,
    reason
  });
  return existing || client.db.vcProfiles.getMemberSession({
    guildId,
    userId,
    categoryId,
    profileChannelId
  });
}

function removeVoiceMemberSession(client, {
  guildId,
  userId,
  categoryId,
  profileChannelId,
  reason = 'voice_state_update'
}) {
  const deletedRows = client.db.vcProfiles.deleteMemberSession({
    guildId,
    userId,
    categoryId,
    profileChannelId
  });
  if (deletedRows > 0) {
    client.logger.info('vc profile join session removed', {
      guildId,
      userId,
      categoryId,
      profileChannelId,
      reason
    });
  }
  return deletedRows;
}

function normalizeStatusCandidate(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    return String(value.text || value.status || value.name || value.value || '').trim();
  }

  return '';
}

function pickStatusTextFromChannelLike(value) {
  const rawCandidates = [
    value?.status,
    value?.voiceStatus,
    value?.voiceStatus?.status,
    value?.voice_status,
    value?.voice_status?.status,
    value?.rtcStatus,
    value?.topic,
    value?.data?.status,
    value?.data?.voice_status,
    value?.raw?.status,
    value?.raw?.voice_status
  ];

  return rawCandidates
    .map(normalizeStatusCandidate)
    .find(Boolean) || null;
}

function safeObjectKeys(value) {
  return value && typeof value === 'object' ? Object.keys(value).slice(0, 80) : [];
}

async function fetchRawVoiceChannelData(client, voiceChannel) {
  if (!client?.rest || !voiceChannel?.id) {
    return null;
  }

  try {
    return await client.rest.get(Routes.channel(voiceChannel.id));
  } catch (error) {
    client.logger.warn('vc profile status raw inspection failed', {
      voiceChannelId: voiceChannel.id,
      error: error.message
    });
    return null;
  }
}

function logVoiceChannelStatusInspection(client, voiceChannel, rawChannelData) {
  const inspectionCache = client.voiceProfileStatusInspectionLogged || new Set();
  client.voiceProfileStatusInspectionLogged = inspectionCache;
  const cacheKey = String(voiceChannel?.id || '');
  if (inspectionCache.has(cacheKey)) {
    return;
  }
  inspectionCache.add(cacheKey);

  let json = null;
  try {
    json = typeof voiceChannel?.toJSON === 'function' ? voiceChannel.toJSON() : null;
  } catch {
    json = null;
  }

  client.logger.info('vc profile status raw inspection', {
    voiceChannelId: voiceChannel?.id || null,
    channelType: voiceChannel?.constructor?.name || null,
    ownPropertyNames: Object.getOwnPropertyNames(voiceChannel || {}).slice(0, 80),
    prototypePropertyNames: Object.getOwnPropertyNames(Object.getPrototypeOf(voiceChannel || {}) || {}).slice(0, 80),
    channelFields: {
      status: normalizeStatusCandidate(voiceChannel?.status) || null,
      voiceStatus: normalizeStatusCandidate(voiceChannel?.voiceStatus) || null,
      topic: normalizeStatusCandidate(voiceChannel?.topic) || null,
      rawPosition: voiceChannel?.rawPosition ?? null
    },
    toJSONKeys: safeObjectKeys(json),
    toJSONStatusFields: {
      status: normalizeStatusCandidate(json?.status) || null,
      voiceStatus: normalizeStatusCandidate(json?.voiceStatus || json?.voice_status) || null,
      topic: normalizeStatusCandidate(json?.topic) || null
    },
    rawRestKeys: safeObjectKeys(rawChannelData),
    rawRestStatusFields: {
      status: normalizeStatusCandidate(rawChannelData?.status) || null,
      voiceStatus: normalizeStatusCandidate(rawChannelData?.voiceStatus || rawChannelData?.voice_status) || null,
      topic: normalizeStatusCandidate(rawChannelData?.topic) || null
    }
  });
}

async function resolveVoiceChannelStatusText(client, voiceChannel, mapping = null) {
  const rawCandidates = [
    voiceChannel?.status,
    voiceChannel?.voiceStatus,
    voiceChannel?.voiceStatus?.status,
    voiceChannel?.rtcStatus,
    voiceChannel?.data?.status,
    voiceChannel?.raw?.status
  ];

  let statusText = rawCandidates
    .map(normalizeStatusCandidate)
    .find(Boolean) || null;

  if (!statusText && typeof voiceChannel?.toJSON === 'function') {
    try {
      const json = voiceChannel.toJSON();
      statusText = pickStatusTextFromChannelLike(json);
    } catch {
      statusText = null;
    }
  }

  let rawChannelData = null;
  if (!statusText) {
    rawChannelData = await fetchRawVoiceChannelData(client, voiceChannel);
    statusText = pickStatusTextFromChannelLike(rawChannelData);
  }

  logVoiceChannelStatusInspection(client, voiceChannel, rawChannelData);

  if (statusText) {
    client.logger.info('vc profile status text resolved from runtime', {
      voiceChannelId: voiceChannel?.id || null,
      statusText
    });
  }

  if (!statusText) {
    const configuredStatusText =
      client.appConfig.voiceProfile?.channelStatusLabels?.[String(voiceChannel?.id || '')] ||
      mapping?.voiceStatusLabel ||
      null;

    if (configuredStatusText) {
      statusText = String(configuredStatusText).trim();
      client.logger.info('vc profile status text resolved from config', {
        voiceChannelId: voiceChannel?.id || null,
        statusText,
        source: client.appConfig.voiceProfile?.channelStatusLabels?.[String(voiceChannel?.id || '')]
          ? 'voiceProfile.channelStatusLabels'
          : 'voiceProfileChannels.voiceStatusLabel'
      });
    }
  }

  if (!statusText) {
    client.logger.info('vc profile status unavailable in discord.js', {
      voiceChannelId: voiceChannel?.id || null,
      channelType: voiceChannel?.constructor?.name || null
    });
  }

  const inspectKeys = Object.keys(voiceChannel || {})
    .filter((key) => /status|voice/i.test(key))
    .slice(0, 20);

  client.logger.info('vc profile status text resolved', {
    voiceChannelId: voiceChannel?.id || null,
    statusText,
    inspectedKeys: inspectKeys,
    hasTypedStatus: Object.prototype.hasOwnProperty.call(voiceChannel || {}, 'status'),
    hasVoiceStatus: Object.prototype.hasOwnProperty.call(voiceChannel || {}, 'voiceStatus')
  });

  return statusText;
}

function getVoiceProfileUpdateQueues(client) {
  if (!client.voiceProfileUpdateQueues) {
    client.voiceProfileUpdateQueues = new Map();
  }
  return client.voiceProfileUpdateQueues;
}

function getVoiceProfileUpdateKey(guildId, categoryId, profileChannelId) {
  return `${String(guildId || '')}:${String(categoryId || '')}:${String(profileChannelId || '')}`;
}

async function queueVoiceProfileCategoryUpdate(client, guild, categoryId, { reason = 'voice_state_update' } = {}) {
  const mapping = client.voiceProfileCategoryMap.get(categoryId);
  if (!guild || !mapping) {
    return;
  }

  const key = getVoiceProfileUpdateKey(guild.id, categoryId, mapping.profileChannelId);
  const queues = getVoiceProfileUpdateQueues(client);
  let queue = queues.get(key);
  if (!queue) {
    queue = {
      pending: false,
      running: false,
      promise: null
    };
    queues.set(key, queue);
  }

  const wasRunning = Boolean(queue.promise);
  queue.pending = true;

  client.logger.info('vc profile update queued', {
    key,
    guildId: guild.id,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    reason,
    running: wasRunning
  });

  if (wasRunning) {
    client.logger.info('vc profile update coalesced', {
      key,
      guildId: guild.id,
      categoryId,
      profileChannelId: mapping.profileChannelId,
      reason
    });
    return queue.promise;
  }

  queue.promise = (async () => {
    try {
      while (queue.pending) {
        queue.pending = false;
        queue.running = true;
        client.logger.info('vc profile update lock acquired', {
          key,
          guildId: guild.id,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          reason
        });

        try {
          await syncVoiceProfileCategoryLocked(client, guild, categoryId, mapping, { reason });
        } finally {
          client.logger.info('vc profile update lock released', {
            key,
            guildId: guild.id,
            categoryId,
            profileChannelId: mapping.profileChannelId,
            reason
          });
        }
      }
    } finally {
      queue.running = false;
      queue.promise = null;
      if (!queue.pending) {
        queues.delete(key);
      }
    }
  })();

  return queue.promise;
}

async function buildVoiceMemberProfiles(client, humanEntries, { guildId, categoryId }) {
  const introChannelId = String(client.appConfig.introDm?.introChannelId || client.appConfig.introChannelId || '');
  const introChannel = await client.channels.fetch(introChannelId).catch(() => null);

  const enrichedMembers = await Promise.all(
    humanEntries.map(async (entry) => {
      const member = entry.member;
      let introMessage = null;
      let introSummary = null;
      const introProfile = client.db.introProfiles.getLatestByUser(
        guildId,
        member.id,
        introChannelId
      );
      if (introProfile?.introText?.trim()) {
        introSummary = introProfile.introText.trim();
      }
      if (introChannel) {
        try {
          introMessage = introSummary ? null : await findLatestIntroMessage(introChannel, member.id);
        } catch (error) {
          client.logger.warn('vc profile member missing intro fallback used', {
            guildId,
            categoryId,
            userId: member.id,
            reason: 'intro_lookup_failed',
            error: error.message
          });
        }
      }
      if (!introSummary) {
        introSummary = introMessage?.content?.trim() || null;
      }

      let avatarUrl = null;
      try {
        avatarUrl = member.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
      } catch (error) {
        client.logger.warn('vc profile member missing intro fallback used', {
          guildId,
          categoryId,
          userId: member.id,
          reason: 'avatar_lookup_failed',
          error: error.message
        });
      }

      if (!introSummary) {
        client.logger.info('vc profile member missing intro fallback used', {
          guildId,
          categoryId,
          userId: member.id
        });
      }

      return {
        id: member.id,
        displayName: member.displayName || member.user?.globalName || member.user?.username || '不明なメンバー',
        mention: `<@${member.id}>`,
        avatarUrl,
        introSummary,
        voiceChannelId: entry.channelId || null,
        joinedAt: entry.joinedAt || null
      };
    })
  );

  return enrichedMembers;
}

function getCachedVoiceChannelsForCategory(guild, categoryId) {
  return [...(guild?.channels?.cache?.values?.() || [])]
    .filter((channel) => channel?.isVoiceBased?.() && channel.parentId === categoryId);
}

async function getVoiceChannelsForCategory(guild, categoryId) {
  let voiceChannels = getCachedVoiceChannelsForCategory(guild, categoryId);
  if (voiceChannels.length) {
    return voiceChannels;
  }

  const fetchedChannels = await guild.channels.fetch().catch(() => null);
  voiceChannels = [...(fetchedChannels?.values?.() || [])]
    .filter((channel) => channel?.isVoiceBased?.() && channel.parentId === categoryId);
  return voiceChannels;
}

function formatVoiceChannelName(activeChannels) {
  if (activeChannels.length === 1) {
    return activeChannels[0].name;
  }

  const names = activeChannels.map((entry) => entry.name).filter(Boolean);
  if (names.length <= 3) {
    return names.join(' / ');
  }

  return `${names.slice(0, 3).join(' / ')} ほか${names.length - 3}件`;
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

async function collectCategoryVoiceMembers(client, guild, categoryId, voiceChannels) {
  const channelIds = new Set(voiceChannels.map((channel) => String(channel.id)));
  const channelSourceHumans = new Map();
  const voiceStateSourceHumans = new Map();
  const voiceStateMemberEntries = new Map();
  const excludedBotIds = new Set();
  const excludedMissingMemberIds = new Set();

  client.logger.info('vc profile category member scan started', {
    guildId: guild.id,
    categoryId,
    voiceChannelIds: [...channelIds]
  });

  client.logger.info('vc profile category voice channels scanned', {
    guildId: guild.id,
    categoryId,
    channels: voiceChannels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      cachedMemberCount: channel.members?.size || 0
    }))
  });

  for (const voiceChannel of voiceChannels) {
    for (const member of voiceChannel.members?.values?.() || []) {
      if (!member) {
        continue;
      }

      if (member.user?.bot) {
        excludedBotIds.add(String(member.id));
        client.logger.info('vc profile member excluded bot', {
          guildId: guild.id,
          categoryId,
          voiceChannelId: voiceChannel.id,
          userId: member.id,
          source: 'channel.members'
        });
        continue;
      }

      if (!channelSourceHumans.has(member.id)) {
        channelSourceHumans.set(member.id, {
          member,
          channelId: voiceChannel.id
        });
      }
    }
  }

  const voiceStates = [...(guild.voiceStates?.cache?.values?.() || [])]
    .filter((voiceState) => channelIds.has(String(voiceState?.channelId || voiceState?.channel?.id || '')));

  for (const voiceState of voiceStates) {
    const userId = String(voiceState?.id || voiceState?.member?.id || '').trim();
    const voiceChannelId = String(voiceState?.channelId || voiceState?.channel?.id || '');
    const member = await resolveVoiceStateMember(guild, voiceState);
    if (!member) {
      excludedMissingMemberIds.add(userId || '(unknown)');
      client.logger.warn('vc profile member excluded missing member', {
        guildId: guild.id,
        categoryId,
        voiceChannelId,
        userId: userId || null,
        source: 'guild.voiceStates.cache'
      });
      continue;
    }

    if (member.user?.bot) {
      excludedBotIds.add(String(member.id));
      client.logger.info('vc profile member excluded bot', {
        guildId: guild.id,
        categoryId,
        voiceChannelId,
        userId: member.id,
        source: 'guild.voiceStates.cache'
      });
      continue;
    }

    voiceStateSourceHumans.set(member.id, member);
    if (!voiceStateMemberEntries.has(member.id)) {
      voiceStateMemberEntries.set(member.id, {
        member,
        channelId: voiceChannelId
      });
    }
    client.logger.info('vc profile human member included', {
      guildId: guild.id,
      categoryId,
      voiceChannelId,
      userId: member.id,
      displayName: member.displayName || member.user?.globalName || member.user?.username || null,
      source: 'guild.voiceStates.cache'
    });
  }

  const finalEntries = voiceStates.length > 0
    ? voiceStateMemberEntries
    : channelSourceHumans;
  const finalSource = voiceStates.length > 0
    ? 'guild.voiceStates.cache'
    : 'channel.members_fallback';

  if (finalSource === 'channel.members_fallback') {
    for (const entry of finalEntries.values()) {
      client.logger.info('vc profile human member included', {
        guildId: guild.id,
        categoryId,
        voiceChannelId: entry.channelId,
        userId: entry.member.id,
        displayName: entry.member.displayName || entry.member.user?.globalName || entry.member.user?.username || null,
        source: finalSource
      });
    }
  }

  client.logger.info('vc profile category member source counts', {
    guildId: guild.id,
    categoryId,
    channelMemberHumanCount: channelSourceHumans.size,
    voiceStateHumanCount: voiceStateSourceHumans.size,
    voiceStateRawCount: voiceStates.length,
    finalHumanCount: finalEntries.size,
    finalSource,
    excludedBotIds: [...excludedBotIds],
    excludedMissingMemberIds: [...excludedMissingMemberIds]
  });

  if (channelSourceHumans.size !== voiceStateSourceHumans.size && voiceStates.length > 0) {
    client.logger.warn('vc profile count mismatch detected', {
      guildId: guild.id,
      categoryId,
      channelMemberHumanCount: channelSourceHumans.size,
      voiceStateHumanCount: voiceStateSourceHumans.size,
      finalHumanCount: finalEntries.size,
      finalSource
    });
  }

  return {
    entries: [...finalEntries.values()],
    finalSource,
    channelSourceHumanCount: channelSourceHumans.size,
    voiceStateHumanCount: voiceStateSourceHumans.size
  };
}

function sortVoiceEntriesForSessionFallback(entries) {
  return [...entries].sort((left, right) => {
    const leftName = getStableMemberName(left.member);
    const rightName = getStableMemberName(right.member);
    const nameComparison = leftName.localeCompare(rightName, 'ja');
    if (nameComparison !== 0) {
      return nameComparison;
    }
    return String(left.member?.id || '').localeCompare(String(right.member?.id || ''));
  });
}

function ensureCategoryMemberSessions(client, {
  guildId,
  categoryId,
  mapping,
  entries,
  reason = 'voice_profile_sync'
}) {
  const profileChannelId = mapping.profileChannelId;
  const existingSessions = client.db.vcProfiles.listMemberSessions({
    guildId,
    categoryId,
    profileChannelId
  });
  const activeUserIds = new Set(entries.map((entry) => String(entry.member?.id || '')).filter(Boolean));
  const sessionByUserId = new Map(existingSessions.map((session) => [String(session.userId), session]));
  const fallbackOrder = sortVoiceEntriesForSessionFallback(entries);
  const fallbackJoinedAtByUserId = new Map();
  const fallbackBaseMs = Date.now();

  fallbackOrder.forEach((entry, index) => {
    fallbackJoinedAtByUserId.set(
      String(entry.member.id),
      new Date(fallbackBaseMs + index).toISOString()
    );
  });

  for (const session of existingSessions) {
    if (activeUserIds.has(String(session.userId))) {
      continue;
    }
    removeVoiceMemberSession(client, {
      guildId,
      userId: session.userId,
      categoryId,
      profileChannelId,
      reason: `${reason}_stale_session`
    });
  }

  const entriesWithSessions = entries.map((entry) => {
    const userId = String(entry.member.id);
    let session = sessionByUserId.get(userId);
    if (!session) {
      session = upsertVoiceMemberSession(client, {
        guildId,
        userId,
        categoryId,
        profileChannelId,
        voiceChannelId: entry.channelId,
        joinedAt: fallbackJoinedAtByUserId.get(userId),
        reason: `${reason}_reconcile_missing`
      });
    } else if (String(session.voiceChannelId || '') !== String(entry.channelId || '')) {
      session = upsertVoiceMemberSession(client, {
        guildId,
        userId,
        categoryId,
        profileChannelId,
        voiceChannelId: entry.channelId,
        joinedAt: session.joinedAt,
        reason: `${reason}_channel_update`
      });
    }

    return {
      ...entry,
      joinedAt: session?.joinedAt || fallbackJoinedAtByUserId.get(userId) || null
    };
  });

  entriesWithSessions.sort((left, right) => {
    const leftTime = new Date(left.joinedAt || 0).getTime();
    const rightTime = new Date(right.joinedAt || 0).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    const nameComparison = getStableMemberName(left.member).localeCompare(getStableMemberName(right.member), 'ja');
    if (nameComparison !== 0) {
      return nameComparison;
    }
    return String(left.member?.id || '').localeCompare(String(right.member?.id || ''));
  });

  client.logger.info('vc profile members sorted by join order', {
    guildId,
    categoryId,
    profileChannelId,
    memberOrder: entriesWithSessions.map((entry) => ({
      userId: entry.member.id,
      voiceChannelId: entry.channelId,
      joinedAt: entry.joinedAt
    }))
  });

  return entriesWithSessions;
}

async function buildCategoryVoiceProfileSnapshot(client, guild, categoryId, mapping) {
  const voiceChannels = await getVoiceChannelsForCategory(guild, categoryId);
  const channelById = new Map(voiceChannels.map((channel) => [String(channel.id), channel]));
  const memberScan = await collectCategoryVoiceMembers(client, guild, categoryId, voiceChannels);
  const activeChannelIds = new Set(memberScan.entries.map((entry) => String(entry.channelId)));
  const activeChannels = [...activeChannelIds]
    .map((channelId) => channelById.get(channelId))
    .filter(Boolean)
    .sort((left, right) => {
      const positionDelta = Number(left.rawPosition ?? left.position ?? 0) - Number(right.rawPosition ?? right.position ?? 0);
      if (positionDelta !== 0) {
        return positionDelta;
      }
      return String(left.name || '').localeCompare(String(right.name || ''), 'ja');
    });
  const statusByChannelId = new Map();

  for (const activeChannel of activeChannels) {
    const statusText = await resolveVoiceChannelStatusText(client, activeChannel, mapping);
    if (!statusText) {
      continue;
    }
    statusByChannelId.set(String(activeChannel.id), statusText);
  }

  const sortedMemberEntries = ensureCategoryMemberSessions(client, {
    guildId: guild.id,
    categoryId,
    mapping,
    entries: memberScan.entries,
    reason: 'category_snapshot'
  });
  const members = await buildVoiceMemberProfiles(client, sortedMemberEntries, { guildId: guild.id, categoryId });

  client.logger.info('vc profile final rendered member count', {
    guildId: guild.id,
    categoryId,
    finalSource: memberScan.finalSource,
    renderedMemberCount: members.length,
    scannedHumanCount: memberScan.entries.length,
    memberIds: members.map((member) => member.id)
  });

  if (members.length !== memberScan.entries.length) {
    client.logger.warn('vc profile count mismatch detected', {
      guildId: guild.id,
      categoryId,
      renderedMemberCount: members.length,
      scannedHumanCount: memberScan.entries.length,
      finalSource: memberScan.finalSource
    });
  }

  const channelSnapshots = activeChannels.map((activeChannel) => {
    const channelMembers = members.filter((member) => String(member.voiceChannelId || '') === String(activeChannel.id));
    return {
      voiceChannelId: String(activeChannel.id),
      voiceChannelName: activeChannel.name || String(activeChannel.id),
      activeChannels: [activeChannel],
      members: channelMembers,
      statusText: statusByChannelId.get(String(activeChannel.id)) || null
    };
  }).filter((channelSnapshot) => channelSnapshot.members.length > 0);

  client.logger.info('vc profile channel groups calculated', {
    guildId: guild.id,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    groupCount: channelSnapshots.length,
    groups: channelSnapshots.map((channelSnapshot) => ({
      voiceChannelId: channelSnapshot.voiceChannelId,
      voiceChannelName: channelSnapshot.voiceChannelName,
      memberCount: channelSnapshot.members.length,
      memberIds: channelSnapshot.members.map((member) => member.id)
    }))
  });

  return {
    activeChannels,
    members,
    channelSnapshots,
    statusText: [...new Set([...statusByChannelId.values()])].join('\n') || null,
    voiceChannelName: activeChannels.length ? formatVoiceChannelName(activeChannels) : ''
  };
}

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function getComponentJson(component) {
  try {
    return typeof component?.toJSON === 'function' ? component.toJSON() : component;
  } catch {
    return component;
  }
}

function countComponentTree(component) {
  const raw = getComponentJson(component);
  if (!raw || typeof raw !== 'object') {
    return 0;
  }

  let count = 1;
  for (const child of raw.components || []) {
    count += countComponentTree(child);
  }
  if (raw.accessory) {
    count += countComponentTree(raw.accessory);
  }
  return count;
}

function countPayloadComponents(payload) {
  return (payload.components || []).reduce((total, component) => total + countComponentTree(component), 0);
}

function buildProfilePagePayload({
  contextName,
  voiceChannelName,
  statusText,
  members,
  totalMemberCount,
  pageIndex,
  totalPages,
  accentColor,
  compact = false
}) {
  const payload = buildProfileMessage({
    contextName,
    voiceChannelName,
    statusText,
    members,
    totalMemberCount,
    pageIndex,
    totalPages,
    accentColor,
    compact
  });
  return {
    payload,
    componentCount: countPayloadComponents(payload)
  };
}

function buildPaginatedProfilePayloads({
  client,
  guildId,
  categoryId,
  mapping,
  snapshot,
  accentColor
}) {
  const maxInitialPageSize = Math.max(1, Math.min(DEFAULT_MEMBERS_PER_PAGE, snapshot.members.length));

  for (const compact of [false, true]) {
    for (let membersPerPage = maxInitialPageSize; membersPerPage >= 1; membersPerPage -= 1) {
      const memberPages = chunkArray(snapshot.members, membersPerPage);
      const totalPages = memberPages.length;
      const pages = memberPages.map((members, pageIndex) => {
        const normal = buildProfilePagePayload({
          contextName: mapping.name,
          voiceChannelName: snapshot.voiceChannelName,
          statusText: snapshot.statusText,
          members,
          totalMemberCount: snapshot.members.length,
          pageIndex,
          totalPages,
          accentColor,
          compact
        });
        const compactFallback = compact
          ? normal
          : buildProfilePagePayload({
            contextName: mapping.name,
            voiceChannelName: snapshot.voiceChannelName,
            statusText: snapshot.statusText,
            members,
            totalMemberCount: snapshot.members.length,
            pageIndex,
            totalPages,
            accentColor,
            compact: true
          });

        client.logger.info('vc profile page payload built', {
          guildId,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          voiceChannelId: snapshot.voiceChannelId || null,
          voiceChannelName: snapshot.voiceChannelName || null,
          pageIndex,
          totalPages,
          memberCount: members.length,
          totalMemberCount: snapshot.members.length,
          compact,
          componentCount: normal.componentCount,
          compactFallbackComponentCount: compactFallback.componentCount
        });
        client.logger.info('vc profile title rendered with voice channel name', {
          guildId,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          voiceChannelId: snapshot.voiceChannelId || null,
          pageIndex,
          totalPages,
          pageTitle: totalPages > 1
            ? `${snapshot.voiceChannelName} ${pageIndex + 1}/${totalPages}`
            : snapshot.voiceChannelName,
          pageNumberShown: totalPages > 1
        });
        client.logger.info('vc profile user mention rendering enabled', {
          guildId,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          pageIndex,
          userIds: members.map((member) => member.id)
        });
        if (members.some((member) => !member.mention)) {
          client.logger.info('vc profile user mention fallback plain text', {
            guildId,
            categoryId,
            profileChannelId: mapping.profileChannelId,
            pageIndex,
            userIds: members.filter((member) => !member.mention).map((member) => member.id || null)
          });
        }
        client.logger.info('vc profile user mention notification suppressed', {
          guildId,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          pageIndex,
          allowedMentions: normal.payload.allowedMentions
        });

        return {
          pageIndex,
          channelPageIndex: pageIndex,
          totalPages,
          voiceChannelId: snapshot.voiceChannelId || null,
          voiceChannelName: snapshot.voiceChannelName || null,
          members,
          payload: normal.payload,
          componentCount: normal.componentCount,
          retryPayload: compactFallback.payload,
          retryComponentCount: compactFallback.componentCount,
          compact
        };
      });

      const overLimit = pages.some((page) => page.componentCount > DISCORD_COMPONENT_LIMIT);
      if (!overLimit) {
        client.logger.info('vc profile pagination calculated', {
          guildId,
          categoryId,
          profileChannelId: mapping.profileChannelId,
          totalMemberCount: snapshot.members.length,
          totalPages,
          membersPerPage,
          compact
        });
        return pages;
      }

      client.logger.warn('vc profile page component overflow detected', {
        guildId,
        categoryId,
        profileChannelId: mapping.profileChannelId,
        totalMemberCount: snapshot.members.length,
        membersPerPage,
        compact,
        pageCounts: pages.map((page) => ({
          pageIndex: page.pageIndex,
          componentCount: page.componentCount
        }))
      });
    }
  }

  const membersPerPage = 1;
  const memberPages = chunkArray(snapshot.members, membersPerPage);
  const totalPages = memberPages.length;
  client.logger.warn('vc profile page compact fallback used', {
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    totalMemberCount: snapshot.members.length,
    reason: 'component_budget_exhausted'
  });
  return memberPages.map((members, pageIndex) => {
    const fallback = buildProfilePagePayload({
      contextName: mapping.name,
      voiceChannelName: snapshot.voiceChannelName,
      statusText: snapshot.statusText,
      members,
      totalMemberCount: snapshot.members.length,
      pageIndex,
      totalPages,
      accentColor,
      compact: true
    });
    return {
      pageIndex,
      channelPageIndex: pageIndex,
      totalPages,
      voiceChannelId: snapshot.voiceChannelId || null,
      voiceChannelName: snapshot.voiceChannelName || null,
      members,
      payload: fallback.payload,
      componentCount: fallback.componentCount,
      retryPayload: fallback.payload,
      retryComponentCount: fallback.componentCount,
      compact: true
    };
  });
}

function collectTextDisplayContent(component, collected = []) {
  if (!component) {
    return collected;
  }

  const raw = typeof component.toJSON === 'function' ? component.toJSON() : component;
  if (typeof raw?.content === 'string') {
    collected.push(raw.content);
  }

  for (const child of raw?.components || []) {
    collectTextDisplayContent(child, collected);
  }

  if (raw?.accessory) {
    collectTextDisplayContent(raw.accessory, collected);
  }

  return collected;
}

function isVcProfileCardMessage(client, message, mapping) {
  if (String(message?.author?.id || '') !== String(client.user?.id || '')) {
    return false;
  }

  const text = collectTextDisplayContent({ components: message.components || [] }).join('\n');
  return (
    text.includes(`## ${mapping.name} /`) ||
    (
      text.includes('**通話チャンネル**') &&
      text.includes('**現在の人数**')
    ) ||
    (
      text.includes('## VCにいる人のプロフィール') &&
      text.includes('**通話チャンネル**')
    )
  );
}

async function deleteMessageIfExists(message) {
  if (!message) {
    return false;
  }

  await message.delete();
  return true;
}

async function cleanupDuplicateCategoryCards(client, {
  guildId,
  categoryId,
  profileChannel,
  mapping,
  keepMessageId = null,
  keepMessageIds = [],
  includeTracked = false,
  reason
}) {
  const duplicateIds = new Set();
  const keepIds = new Set(
    [keepMessageId, ...keepMessageIds]
      .map((messageId) => String(messageId || ''))
      .filter(Boolean)
  );
  const trackedSingle = client.db.vcProfiles.getCategoryMessage({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const trackedPages = client.db.vcProfiles.listCategoryPages({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const roomRecords = client.db.vcProfiles
    .listRoomMessagesByCategory(categoryId)
    .filter((record) => String(record.profileChannelId) === String(profileChannel.id));

  for (const record of roomRecords) {
    if (!includeTracked && (keepIds.has(String(record.messageId)) || String(record.messageId) === String(trackedSingle?.messageId || ''))) {
      continue;
    }
    duplicateIds.add(String(record.messageId));
  }

  const recentMessages = await profileChannel.messages.fetch({ limit: 50 }).catch(() => null);
  for (const message of recentMessages?.values?.() || []) {
    if (keepIds.has(String(message.id))) {
      continue;
    }
    if (isVcProfileCardMessage(client, message, mapping)) {
      duplicateIds.add(String(message.id));
    }
  }

  if (includeTracked && trackedSingle?.messageId) {
    duplicateIds.add(String(trackedSingle.messageId));
  }
  if (includeTracked) {
    for (const page of trackedPages) {
      duplicateIds.add(String(page.messageId));
    }
  }

  for (const messageId of duplicateIds) {
    if (keepIds.has(String(messageId))) {
      continue;
    }

    client.logger.info('vc profile duplicate card detected', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      messageId,
      keepMessageId,
      reason
    });

    const message = await profileChannel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      client.logger.info('vc profile duplicate cleanup skipped', {
        guildId,
        categoryId,
        profileChannelId: profileChannel.id,
        messageId,
        reason: 'message_missing'
      });
      continue;
    }

    try {
      await deleteMessageIfExists(message);
      client.logger.info('vc profile duplicate card deleted', {
        guildId,
        categoryId,
        profileChannelId: profileChannel.id,
        messageId,
        reason
      });
    } catch (error) {
      client.logger.warn('vc profile duplicate cleanup skipped', {
        guildId,
        categoryId,
        profileChannelId: profileChannel.id,
        messageId,
        reason: 'delete_failed',
        error: error.message
      });
    }
  }

  const deletedRows = client.db.vcProfiles.deleteRoomMessagesByCategoryProfile(categoryId, profileChannel.id);
  if (deletedRows > 0) {
    client.logger.info('vc profile duplicate card deleted', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      deletedLegacyRows: deletedRows,
      reason: `${reason}_legacy_db_rows`
    });
  }
}

async function cleanupEmptyCategoryProfile(client, {
  guildId,
  categoryId,
  profileChannel,
  mapping,
  reason
}) {
  client.logger.info('vc profile all pages cleanup started', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    reason
  });
  client.logger.info('vc profile empty category cleanup started', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    reason
  });

  await cleanupDuplicateCategoryCards(client, {
    guildId,
    categoryId,
    profileChannel,
    mapping,
    keepMessageId: null,
    includeTracked: true,
    reason: `${reason}_empty_category`
  });

  const deletedCategoryRows = client.db.vcProfiles.deleteCategoryMessage({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const deletedPageRows = client.db.vcProfiles.deleteCategoryPages({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const deletedSessionRows = client.db.vcProfiles.deleteMemberSessionsForCategory({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const deletedColorRows = client.db.vcProfiles.deleteColorSession({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  if (deletedColorRows > 0) {
    client.logger.info('vc profile color session cleared', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      reason
    });
  }

  client.logger.info('vc profile empty category cleanup finished', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    deletedCategoryRows,
    deletedPageRows,
    deletedSessionRows,
    deletedColorRows,
    reason
  });
  client.logger.info('vc profile all pages cleanup finished', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    deletedCategoryRows,
    deletedPageRows,
    deletedSessionRows,
    deletedColorRows,
    reason
  });
}

async function fetchTrackedCategoryPageMessage(client, profileChannel, pageRecord) {
  if (!pageRecord?.messageId) {
    return null;
  }

  const message = await profileChannel.messages.fetch(pageRecord.messageId).catch(() => null);
  if (message) {
    client.logger.info('vc profile page existing message fetched', {
      categoryId: pageRecord.categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: pageRecord.pageIndex,
      messageId: pageRecord.messageId
    });
  }
  return message;
}

function listTrackedCategoryPagesWithLegacy(client, {
  guildId,
  categoryId,
  profileChannelId
}) {
  const pages = client.db.vcProfiles.listCategoryPages({
    guildId,
    categoryId,
    profileChannelId
  });
  if (pages.length > 0) {
    return pages;
  }

  const legacy = client.db.vcProfiles.getCategoryMessage({
    guildId,
    categoryId,
    profileChannelId
  });
  if (!legacy?.messageId) {
    return [];
  }

  client.db.vcProfiles.upsertCategoryPage({
    guildId,
    categoryId,
    profileChannelId,
    pageIndex: 0,
    messageId: legacy.messageId
  });

  return [{
    guildId,
    categoryId,
    profileChannelId,
    pageIndex: 0,
    messageId: legacy.messageId,
    updatedAt: legacy.updatedAt
  }];
}

function isComponentOverflowError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.rawError?.message,
    JSON.stringify(error?.rawError || {})
  ].filter(Boolean).join(' ');
  return /COMPONENT_MAX_TOTAL_COMPONENTS_EXCEEDED|Total number of components cannot exceed 40/i.test(text);
}

async function sendOrEditProfilePage(client, {
  profileChannel,
  existingMessage,
  page,
  guildId,
  categoryId,
  reason
}) {
  client.logger.info('vc profile page component count final', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    pageIndex: page.pageIndex,
    totalPages: page.totalPages,
    componentCount: page.componentCount,
    compact: page.compact,
    reason
  });

  const action = existingMessage ? 'edit' : 'send';
  try {
    const message = existingMessage
      ? await existingMessage.edit(page.payload)
      : await profileChannel.send(page.payload);
    client.logger.info(existingMessage ? 'vc profile page edited' : 'vc profile page created', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: page.pageIndex,
      totalPages: page.totalPages,
      messageId: message.id,
      componentCount: page.componentCount,
      reason
    });
    return message;
  } catch (error) {
    if (!isComponentOverflowError(error)) {
      client.logger.error('vc profile page send/edit failed', {
        guildId,
        categoryId,
        profileChannelId: profileChannel.id,
        pageIndex: page.pageIndex,
        action,
        error: error.message
      });
      throw error;
    }

    client.logger.warn('vc profile page component overflow detected', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: page.pageIndex,
      action,
      componentCount: page.componentCount,
      retryComponentCount: page.retryComponentCount,
      error: error.message
    });
    client.logger.warn('vc profile page compact fallback used', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: page.pageIndex,
      action
    });

    const message = existingMessage
      ? await existingMessage.edit(page.retryPayload)
      : await profileChannel.send(page.retryPayload);
    client.logger.info('vc profile page send/edit retry succeeded', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: page.pageIndex,
      action,
      messageId: message.id,
      componentCount: page.retryComponentCount
    });
    return message;
  }
}

function resolveCategoryAccentColor(client, {
  guildId,
  categoryId,
  mapping,
  activeChannels
}) {
  const colorSourceId = activeChannels[0]?.id || mapping.categoryId;
  if (mapping.accentColor != null) {
    client.logger.info('vc profile card color resolved', {
      voiceChannelId: colorSourceId,
      configuredAccentColor: mapping.accentColor,
      accentColor: mapping.accentColor,
      source: 'voiceProfileChannels'
    });
    client.logger.info('vc profile configured accent color override used', {
      guildId,
      categoryId,
      profileChannelId: mapping.profileChannelId,
      accentColor: mapping.accentColor
    });
    return mapping.accentColor;
  }

  const configuredChannelColor = parseAccentColor(
    client.appConfig.voiceProfile?.channelAccentColors?.[String(colorSourceId || '')],
    null
  );
  if (configuredChannelColor != null) {
    client.logger.info('vc profile configured accent color override used', {
      guildId,
      categoryId,
      profileChannelId: mapping.profileChannelId,
      voiceChannelId: colorSourceId,
      accentColor: configuredChannelColor,
      source: 'voiceProfile.channelAccentColors'
    });
    client.logger.info('vc profile card color resolved', {
      voiceChannelId: colorSourceId,
      configuredAccentColor: configuredChannelColor,
      accentColor: configuredChannelColor,
      source: 'voiceProfile.channelAccentColors'
    });
    return configuredChannelColor;
  }

  const existing = client.db.vcProfiles.getColorSession({
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId
  });
  if (existing?.color != null) {
    client.logger.info('vc profile color session reused', {
      guildId,
      categoryId,
      profileChannelId: mapping.profileChannelId,
      accentColor: Number(existing.color),
      activeSince: existing.activeSince || null
    });
    client.logger.info('vc profile card color resolved', {
      voiceChannelId: colorSourceId,
      accentColor: Number(existing.color),
      source: 'color_session'
    });
    return Number(existing.color);
  }

  const accentColor = selectRandomSessionAccentColor();
  const activeSince = new Date().toISOString();
  client.db.vcProfiles.upsertColorSession({
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    color: accentColor,
    activeSince
  });
  client.logger.info('vc profile random accent color selected', {
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    accentColor
  });
  client.logger.info('vc profile color session created', {
    guildId,
    categoryId,
    profileChannelId: mapping.profileChannelId,
    accentColor,
    activeSince
  });
  client.logger.info('vc profile card color resolved', {
    voiceChannelId: colorSourceId,
    accentColor,
    source: 'new_color_session'
  });
  return accentColor;
}

async function syncVoiceProfileCategoryLocked(client, guild, categoryId, mapping, { reason = 'voice_profile_sync' } = {}) {
  const guildId = guild.id;
  const profileChannel = await client.channels.fetch(mapping.profileChannelId).catch(() => null);

  if (!profileChannel?.isTextBased?.()) {
    client.logger.warn('VC profile destination is not text-based', {
      categoryId,
      profileChannelId: mapping.profileChannelId
    });
    return;
  }

  const snapshot = await buildCategoryVoiceProfileSnapshot(client, guild, categoryId, mapping);

  if (snapshot.members.length === 0) {
    await cleanupEmptyCategoryProfile(client, {
      guildId,
      categoryId,
      profileChannel,
      mapping,
      reason
    });
    return;
  }

  await deleteActiveVoiceSessionEndCardsForCategory(client, {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    reason: 'new_live_session'
  });

  const accentColor = resolveCategoryAccentColor(client, {
    guildId,
    categoryId,
    mapping,
    activeChannels: snapshot.activeChannels
  });
  client.logger.info('vc profile page color applied', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    accentColor,
    pageCountPreview: snapshot.members.length
  });
  const channelSnapshots = snapshot.channelSnapshots?.length
    ? snapshot.channelSnapshots
    : [snapshot];
  const pages = channelSnapshots.flatMap((channelSnapshot) => buildPaginatedProfilePayloads({
    client,
    guildId,
    categoryId,
    mapping,
    snapshot: channelSnapshot,
    accentColor
  }));
  pages.forEach((page, globalPageIndex) => {
    page.globalPageIndex = globalPageIndex;
    page.pageIndex = globalPageIndex;
  });
  client.logger.info('vc profile channel pagination calculated', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    channelCount: channelSnapshots.length,
    totalPageCount: pages.length,
    channels: channelSnapshots.map((channelSnapshot) => ({
      voiceChannelId: channelSnapshot.voiceChannelId || null,
      voiceChannelName: channelSnapshot.voiceChannelName || null,
      memberCount: channelSnapshot.members.length,
      pageCount: pages.filter((page) => String(page.voiceChannelId || '') === String(channelSnapshot.voiceChannelId || '')).length
    }))
  });
  const existingPages = listTrackedCategoryPagesWithLegacy(client, {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const existingPagesByIndex = new Map(existingPages.map((page) => [Number(page.pageIndex), page]));
  const keptMessageIds = [];

  for (const page of pages) {
    const existingPage = existingPagesByIndex.get(page.pageIndex);
    const existingMessage = await fetchTrackedCategoryPageMessage(client, profileChannel, existingPage);
    const message = await sendOrEditProfilePage(client, {
      profileChannel,
      existingMessage,
      page,
      guildId,
      categoryId,
      reason
    });

    keptMessageIds.push(message.id);
    client.db.vcProfiles.upsertCategoryPage({
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: page.pageIndex,
      messageId: message.id
    });
    client.logger.info('vc profile page db upserted', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: page.pageIndex,
      messageId: message.id,
      reason
    });
  }

  if (keptMessageIds[0]) {
    client.db.vcProfiles.upsertCategoryMessage({
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      messageId: keptMessageIds[0]
    });
  }

  for (const pageRecord of existingPages) {
    if (Number(pageRecord.pageIndex) < pages.length) {
      continue;
    }
    const message = await profileChannel.messages.fetch(pageRecord.messageId).catch(() => null);
    if (message) {
      try {
        await deleteMessageIfExists(message);
        client.logger.info('vc profile surplus page deleted', {
          guildId,
          categoryId,
          profileChannelId: profileChannel.id,
          pageIndex: pageRecord.pageIndex,
          messageId: pageRecord.messageId,
          reason
        });
      } catch (error) {
        client.logger.warn('vc profile duplicate cleanup skipped', {
          guildId,
          categoryId,
          profileChannelId: profileChannel.id,
          pageIndex: pageRecord.pageIndex,
          messageId: pageRecord.messageId,
          reason: 'surplus_page_delete_failed',
          error: error.message
        });
      }
    }
    const deletedRows = client.db.vcProfiles.deleteCategoryPage({
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: pageRecord.pageIndex
    });
    client.logger.info('vc profile page db deleted', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      pageIndex: pageRecord.pageIndex,
      deletedRows,
      reason: `${reason}_surplus_page`
    });
  }

  client.db.vcProfiles.deleteCategoryPagesFromIndex({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    pageIndex: pages.length
  });

  await cleanupDuplicateCategoryCards(client, {
    guildId,
    categoryId,
    profileChannel,
    mapping,
    keepMessageIds: keptMessageIds,
    reason
  });
}

async function cleanupLegacyUserCards(client, categoryId) {
  const legacyEntries = client.db.vcProfiles.listLegacyProfileMessagesByCategory(categoryId);

  for (const entry of legacyEntries) {
    const profileChannel = await client.channels.fetch(entry.profileChannelId).catch(() => null);
    if (!profileChannel?.isTextBased?.()) {
      continue;
    }

    const message = await profileChannel.messages.fetch(entry.messageId).catch(() => null);
    if (message) {
      await message.delete().catch(() => null);
    }
  }

  if (legacyEntries.length > 0) {
    client.db.vcProfiles.deleteLegacyProfileMessagesByCategory(categoryId);
  }
}

async function rebuildVoiceProfileState(client, { reason = 'startup' } = {}) {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  let scannedChannelCount = 0;
  let staleCardCount = 0;
  await guild.channels.fetch();

  client.logger.info('vc profile reconciliation started', {
    reason,
    trackedCategoryCount: client.voiceProfileCategoryMap.size
  });

  for (const [categoryId] of client.voiceProfileCategoryMap) {
    await cleanupLegacyUserCards(client, categoryId);

    const staleRecords = client.db.vcProfiles.listRoomMessagesByCategory(categoryId);
    staleCardCount += staleRecords.length;
    const trackedVoiceChannels = await getVoiceChannelsForCategory(guild, categoryId);
    scannedChannelCount += trackedVoiceChannels.length;
    await queueVoiceProfileCategoryUpdate(client, guild, categoryId, { reason });
  }

  client.logger.info('vc profile reconciliation finished', {
    reason,
    trackedCategoryCount: client.voiceProfileCategoryMap.size,
    scannedChannelCount,
    staleCardCount
  });
}

function updateVoiceProfileMemberSessionsForStateChange(client, {
  guild,
  member,
  oldCategoryId,
  newCategoryId,
  newChannelId,
  reason = 'voice_state_update'
}) {
  if (!guild?.id || !member?.id) {
    return;
  }

  if (oldCategoryId && oldCategoryId !== newCategoryId) {
    const oldMapping = getCategoryMapping(client, oldCategoryId);
    if (oldMapping) {
      removeVoiceMemberSession(client, {
        guildId: guild.id,
        userId: member.id,
        categoryId: oldCategoryId,
        profileChannelId: oldMapping.profileChannelId,
        reason
      });
    }
  }

  if (!newCategoryId || !newChannelId) {
    return;
  }

  const newMapping = getCategoryMapping(client, newCategoryId);
  if (!newMapping) {
    return;
  }

  const existing = client.db.vcProfiles.getMemberSession({
    guildId: guild.id,
    userId: member.id,
    categoryId: newCategoryId,
    profileChannelId: newMapping.profileChannelId
  });

  upsertVoiceMemberSession(client, {
    guildId: guild.id,
    userId: member.id,
    categoryId: newCategoryId,
    profileChannelId: newMapping.profileChannelId,
    voiceChannelId: newChannelId,
    joinedAt: existing?.joinedAt || new Date().toISOString(),
    reason: existing ? `${reason}_existing_category` : `${reason}_entered_category`
  });
}

function startVoiceProfileReconciliation(client) {
  const intervalMinutes = Number(client.appConfig.voiceProfile?.reconcileIntervalMinutes ?? 3);

  if (client.voiceProfileReconcileInterval) {
    clearInterval(client.voiceProfileReconcileInterval);
    client.voiceProfileReconcileInterval = null;
  }

  if (!client.voiceProfileCategoryMap?.size || intervalMinutes <= 0) {
    client.logger.info('vc profile reconciliation disabled', {
      intervalMinutes,
      trackedCategoryCount: client.voiceProfileCategoryMap?.size || 0
    });
    return;
  }

  const runTick = async () => {
    try {
      await rebuildVoiceProfileState(client, { reason: 'periodic_reconcile' });
    } catch (error) {
      client.logger.error('vc profile reconciliation failed', {
        error: error.message
      });
    }
  };

  client.voiceProfileReconcileInterval = setInterval(() => {
    void runTick();
  }, Math.max(1, intervalMinutes) * 60 * 1000);

  if (typeof client.voiceProfileReconcileInterval.unref === 'function') {
    client.voiceProfileReconcileInterval.unref();
  }

  client.logger.info('vc profile reconciliation enabled', {
    intervalMinutes,
    trackedCategoryCount: client.voiceProfileCategoryMap.size
  });
}

async function handleVoiceStateUpdate(oldState, newState) {
  const client = newState.client;
  const userId = newState.id;
  const guild = newState.guild || oldState.guild;
  const member =
    newState.member ||
    oldState.member ||
    (await newState.guild.members.fetch(userId).catch(() => null));

  const oldChannel = oldState.channelId
    ? (await getFreshVoiceChannel(guild, oldState.channelId)) || oldState.channel
    : null;
  const newChannel = newState.channelId
    ? (await getFreshVoiceChannel(guild, newState.channelId)) || newState.channel
    : null;
  const oldCategoryId = getTrackedCategoryId(client, oldChannel);
  const newCategoryId = getTrackedCategoryId(client, newChannel);
  const ignoreBots = client.appConfig.voiceProfile?.ignoreBots !== false;

  client.logger.info('Processing VC state change', {
    userId,
    oldChannelId: oldState.channelId,
    newChannelId: newState.channelId,
    oldCategoryId,
    newCategoryId
  });

  if (ignoreBots && member?.user?.bot) {
    client.logger.info('Skipped VC profile card for bot user', {
      userId,
      oldCategoryId,
      newCategoryId
    });
    return;
  }

  updateVoiceProfileMemberSessionsForStateChange(client, {
    guild,
    member,
    oldCategoryId,
    newCategoryId,
    newChannelId: newState.channelId,
    reason: 'voice_state_update'
  });

  const affectedCategoryIds = new Set();
  if (oldState.channelId && (oldCategoryId || client.db.vcProfiles.getRoomMessage(oldState.channelId))) {
    const oldRoomMessage = client.db.vcProfiles.getRoomMessage(oldState.channelId);
    affectedCategoryIds.add(String(oldCategoryId || oldRoomMessage?.categoryId || ''));
  }
  if (newState.channelId && newCategoryId) {
    affectedCategoryIds.add(String(newCategoryId));
  }

  client.logger.info('Affected VC room profile channels', {
    userId,
    categoryIds: [...affectedCategoryIds].filter(Boolean)
  });

  for (const categoryId of [...affectedCategoryIds].filter(Boolean)) {
    await queueVoiceProfileCategoryUpdate(client, guild, categoryId, { reason: 'voice_state_update' });
  }
}

async function queueVoiceProfileRefreshForUser(client, guild, userId, { reason = 'intro_profile_change' } = {}) {
  if (!client?.voiceProfileCategoryMap?.size || !guild?.voiceStates?.cache || !userId) {
    return 0;
  }

  const voiceState = guild.voiceStates.cache.get(String(userId));
  if (!voiceState?.channelId) {
    return 0;
  }

  const voiceChannel = await getFreshVoiceChannel(guild, voiceState.channelId) || voiceState.channel;
  const categoryId = getTrackedCategoryId(client, voiceChannel);
  if (!categoryId) {
    return 0;
  }

  await queueVoiceProfileCategoryUpdate(client, guild, categoryId, { reason });
  return 1;
}

module.exports = {
  initializeVoiceProfileMappings,
  rebuildVoiceProfileState,
  startVoiceProfileReconciliation,
  handleVoiceStateUpdate,
  queueVoiceProfileRefreshForUser
};
