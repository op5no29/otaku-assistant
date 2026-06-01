const { Routes } = require('discord-api-types/v10');
const { buildProfileMessage } = require('./buildProfileMessage');
const { findLatestIntroMessage } = require('./findLatestIntroMessage');
const { resolveVcProfileAccentColor } = require('../../utils/accentColors');

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

async function buildVoiceMemberProfiles(client, humanMembers, { guildId, categoryId }) {
  const introChannel = await client.channels.fetch(client.appConfig.introChannelId).catch(() => null);

  const enrichedMembers = await Promise.all(
    humanMembers.map(async (member) => {
      let introMessage = null;
      if (introChannel) {
        try {
          introMessage = await findLatestIntroMessage(introChannel, member.id);
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

      if (!introMessage?.content?.trim()) {
        client.logger.info('vc profile member missing intro fallback used', {
          guildId,
          categoryId,
          userId: member.id
        });
      }

      return {
        id: member.id,
        displayName: member.displayName || member.user?.globalName || member.user?.username || '不明なメンバー',
        avatarUrl,
        introSummary: introMessage?.content?.trim() || null
      };
    })
  );

  enrichedMembers.sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
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

async function buildCategoryVoiceProfileSnapshot(client, guild, categoryId, mapping) {
  const voiceChannels = await getVoiceChannelsForCategory(guild, categoryId);
  const channelById = new Map(voiceChannels.map((channel) => [String(channel.id), channel]));
  const memberScan = await collectCategoryVoiceMembers(client, guild, categoryId, voiceChannels);
  const activeChannelIds = new Set(memberScan.entries.map((entry) => String(entry.channelId)));
  const activeChannels = [...activeChannelIds]
    .map((channelId) => channelById.get(channelId))
    .filter(Boolean);
  const statusLines = [];

  for (const activeChannel of activeChannels) {
    const statusText = await resolveVoiceChannelStatusText(client, activeChannel, mapping);
    if (!statusText) {
      continue;
    }
    statusLines.push(activeChannels.length === 1 ? statusText : `${activeChannel.name}: ${statusText}`);
  }

  const members = await buildVoiceMemberProfiles(
    client,
    memberScan.entries.map((entry) => entry.member),
    { guildId: guild.id, categoryId }
  );

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

  return {
    activeChannels,
    members,
    statusText: [...new Set(statusLines)].join('\n') || null,
    voiceChannelName: activeChannels.length ? formatVoiceChannelName(activeChannels) : ''
  };
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
  return text.includes(`## ${mapping.name} /`);
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
  includeTracked = false,
  reason
}) {
  const duplicateIds = new Set();
  const tracked = client.db.vcProfiles.getCategoryMessage({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const roomRecords = client.db.vcProfiles
    .listRoomMessagesByCategory(categoryId)
    .filter((record) => String(record.profileChannelId) === String(profileChannel.id));

  for (const record of roomRecords) {
    if (!includeTracked && String(record.messageId) === String(keepMessageId || tracked?.messageId || '')) {
      continue;
    }
    duplicateIds.add(String(record.messageId));
  }

  const recentMessages = await profileChannel.messages.fetch({ limit: 50 }).catch(() => null);
  for (const message of recentMessages?.values?.() || []) {
    if (String(message.id) === String(keepMessageId || '')) {
      continue;
    }
    if (isVcProfileCardMessage(client, message, mapping)) {
      duplicateIds.add(String(message.id));
    }
  }

  if (tracked?.messageId && includeTracked) {
    duplicateIds.add(String(tracked.messageId));
  }

  for (const messageId of duplicateIds) {
    if (String(messageId) === String(keepMessageId || '')) {
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

  client.logger.info('vc profile empty category cleanup finished', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    deletedCategoryRows,
    reason
  });
}

async function fetchTrackedCategoryMessage(client, profileChannel, existing) {
  if (!existing?.messageId) {
    return null;
  }

  const message = await profileChannel.messages.fetch(existing.messageId).catch(() => null);
  if (message) {
    client.logger.info('vc profile existing card fetched', {
      categoryId: existing.categoryId,
      profileChannelId: profileChannel.id,
      messageId: existing.messageId
    });
  }
  return message;
}

function resolveCategoryAccentColor(client, mapping, activeChannels) {
  const colorSourceId = activeChannels[0]?.id || mapping.categoryId;
  let accentColor = resolveVcProfileAccentColor({
    voiceChannelId: colorSourceId,
    config: client.appConfig,
    logger: client.logger
  });
  if (mapping.accentColor != null) {
    accentColor = mapping.accentColor;
    client.logger.info('vc profile card color resolved', {
      voiceChannelId: colorSourceId,
      configuredAccentColor: mapping.accentColor,
      accentColor,
      source: 'voiceProfileChannels'
    });
  }
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

  const existing = client.db.vcProfiles.getCategoryMessage({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const existingMessage = await fetchTrackedCategoryMessage(client, profileChannel, existing);
  const accentColor = resolveCategoryAccentColor(client, mapping, snapshot.activeChannels);
  const payload = buildProfileMessage({
    contextName: mapping.name,
    voiceChannelName: snapshot.voiceChannelName,
    statusText: snapshot.statusText,
    members: snapshot.members,
    accentColor
  });

  if (existingMessage) {
    await existingMessage.edit(payload);
    client.db.vcProfiles.upsertCategoryMessage({
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      messageId: existingMessage.id
    });
    client.logger.info('vc profile existing card edited', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      messageId: existingMessage.id,
      activeVoiceChannelIds: snapshot.activeChannels.map((channel) => channel.id),
      memberCount: snapshot.members.length,
      reason
    });
    await cleanupDuplicateCategoryCards(client, {
      guildId,
      categoryId,
      profileChannel,
      mapping,
      keepMessageId: existingMessage.id,
      reason
    });
    return;
  }

  await cleanupDuplicateCategoryCards(client, {
    guildId,
    categoryId,
    profileChannel,
    mapping,
    keepMessageId: null,
    includeTracked: true,
    reason: `${reason}_before_create`
  });

  const latestAfterCleanup = client.db.vcProfiles.getCategoryMessage({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id
  });
  const recoveredMessage = await fetchTrackedCategoryMessage(client, profileChannel, latestAfterCleanup);
  if (recoveredMessage) {
    await recoveredMessage.edit(payload);
    client.db.vcProfiles.upsertCategoryMessage({
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      messageId: recoveredMessage.id
    });
    client.logger.info('vc profile existing card edited', {
      guildId,
      categoryId,
      profileChannelId: profileChannel.id,
      messageId: recoveredMessage.id,
      recovered: true,
      activeVoiceChannelIds: snapshot.activeChannels.map((channel) => channel.id),
      memberCount: snapshot.members.length,
      reason
    });
    return;
  }

  const sentMessage = await profileChannel.send(payload);
  client.db.vcProfiles.upsertCategoryMessage({
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    messageId: sentMessage.id
  });
  client.logger.info('vc profile new card created', {
    guildId,
    categoryId,
    profileChannelId: profileChannel.id,
    messageId: sentMessage.id,
    activeVoiceChannelIds: snapshot.activeChannels.map((channel) => channel.id),
    memberCount: snapshot.members.length,
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

module.exports = {
  initializeVoiceProfileMappings,
  rebuildVoiceProfileState,
  startVoiceProfileReconciliation,
  handleVoiceStateUpdate
};
