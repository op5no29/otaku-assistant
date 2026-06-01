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
        accentColor: entry.accentColor ?? null
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

function resolveVoiceChannelStatusText(client, voiceChannel) {
  const rawCandidates = [
    voiceChannel?.status,
    voiceChannel?.voiceStatus,
    voiceChannel?.voiceStatus?.status,
    voiceChannel?.rtcStatus,
    voiceChannel?.data?.status,
    voiceChannel?.raw?.status
  ];

  let statusText = rawCandidates
    .map((value) => {
      if (typeof value === 'string') {
        return value.trim();
      }
      if (value && typeof value === 'object') {
        return String(value.text || value.status || value.name || '').trim();
      }
      return '';
    })
    .find(Boolean) || null;

  if (!statusText && typeof voiceChannel?.toJSON === 'function') {
    try {
      const json = voiceChannel.toJSON();
      statusText = String(json?.status || json?.voiceStatus?.status || '').trim() || null;
    } catch {
      statusText = null;
    }
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

async function deleteRoomProfileCard(client, voiceChannelId) {
  const existing = client.db.vcProfiles.getRoomMessage(voiceChannelId);
  if (!existing) {
    return;
  }

  try {
    const profileChannel = await client.channels.fetch(existing.profileChannelId).catch(() => null);

    if (profileChannel?.isTextBased?.()) {
      const message = await profileChannel.messages.fetch(existing.messageId).catch(() => null);
      if (message) {
        await message.delete().catch(() => null);
      }
    }
  } finally {
    client.db.vcProfiles.deleteRoomMessage(voiceChannelId);
  }
}

async function buildVoiceChannelMembers(client, voiceChannel) {
  const introChannel = await client.channels.fetch(client.appConfig.introChannelId).catch(() => null);
  const humans = [...voiceChannel.members.values()].filter((member) => !member.user?.bot);

  client.logger.info('vc profile actual member scan', {
    guildId: voiceChannel.guild?.id || null,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    cachedMemberCount: voiceChannel.members.size,
    humanMemberCount: humans.length,
    ignoredBotCount: voiceChannel.members.size - humans.length
  });

  const members = await Promise.all(
    humans.map(async (member) => {
      const introMessage = introChannel
        ? await findLatestIntroMessage(introChannel, member.id)
        : null;

      return {
        id: member.id,
        displayName: member.displayName || member.user?.globalName || member.user?.username || '不明なメンバー',
        avatarUrl: member.displayAvatarURL?.({ extension: 'png', size: 128 }) || null,
        introSummary: introMessage?.content?.trim() || null
      };
    })
  );

  members.sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
  return members;
}

async function syncVoiceChannelProfile(client, voiceChannel) {
  const freshVoiceChannel = await getFreshVoiceChannel(voiceChannel.guild, voiceChannel.id) || voiceChannel;
  const categoryId = getTrackedCategoryId(client, freshVoiceChannel);
  if (!categoryId) {
    return;
  }

  const mapping = client.voiceProfileCategoryMap.get(categoryId);
  if (!mapping) {
    return;
  }

  const members = await buildVoiceChannelMembers(client, freshVoiceChannel);
  const profileChannel = await client.channels.fetch(mapping.profileChannelId).catch(() => null);

  if (!profileChannel?.isTextBased?.()) {
    client.logger.warn('VC profile destination is not text-based', {
      categoryId,
      profileChannelId: mapping.profileChannelId
    });
    return;
  }

  const existing = client.db.vcProfiles.getRoomMessage(freshVoiceChannel.id);

  if (members.length === 0) {
    if (existing) {
      client.logger.info('vc profile stale card detected', {
        categoryId,
        voiceChannelId: freshVoiceChannel.id,
        profileChannelId: profileChannel.id,
        messageId: existing.messageId,
        reason: 'empty_channel'
      });
      await deleteRoomProfileCard(client, freshVoiceChannel.id);
      client.logger.info('vc profile empty channel cleanup', {
        categoryId,
        voiceChannelId: freshVoiceChannel.id,
        profileChannelId: profileChannel.id
      });
    }

    return;
  }

  let accentColor = resolveVcProfileAccentColor({
    voiceChannelId: freshVoiceChannel.id,
    config: client.appConfig,
    logger: client.logger
  });
  if (mapping.accentColor != null) {
    accentColor = mapping.accentColor;
    client.logger.info('vc profile card color resolved', {
      voiceChannelId: freshVoiceChannel.id,
      configuredAccentColor: mapping.accentColor,
      accentColor,
      source: 'voiceProfileChannels'
    });
  }
  const statusText = resolveVoiceChannelStatusText(client, freshVoiceChannel);
  const payload = buildProfileMessage({
    contextName: mapping.name,
    voiceChannelName: freshVoiceChannel.name,
    statusText,
    members,
    accentColor
  });

  if (!existing) {
    const sentMessage = await profileChannel.send(payload);
    client.db.vcProfiles.upsertRoomMessage({
      categoryId,
      voiceChannelId: freshVoiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id
    });
    client.logger.info('VC room profile created', {
      categoryId,
      voiceChannelId: freshVoiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id
    });
    return;
  }

  const message = await profileChannel.messages.fetch(existing.messageId).catch(() => null);

  if (!message) {
    const sentMessage = await profileChannel.send(payload);
    client.db.vcProfiles.upsertRoomMessage({
      categoryId,
      voiceChannelId: freshVoiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id
    });
    client.logger.info('VC room profile created', {
      categoryId,
      voiceChannelId: freshVoiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id,
      recovered: true
    });
    return;
  }

  await message.edit(payload);
  client.db.vcProfiles.upsertRoomMessage({
    categoryId,
    voiceChannelId: freshVoiceChannel.id,
    profileChannelId: profileChannel.id,
    messageId: message.id
  });
  client.logger.info('VC room profile updated', {
    categoryId,
    voiceChannelId: freshVoiceChannel.id,
    profileChannelId: profileChannel.id,
    messageId: message.id
  });
}

async function syncVoiceChannelProfileById(client, guild, voiceChannelId) {
  const voiceChannel = await getFreshVoiceChannel(guild, voiceChannelId);
  if (!voiceChannel) {
    const existing = client.db.vcProfiles.getRoomMessage(String(voiceChannelId || ''));
    if (existing) {
      client.logger.info('vc profile stale card detected', {
        voiceChannelId: String(voiceChannelId || ''),
        profileChannelId: existing.profileChannelId,
        messageId: existing.messageId,
        reason: 'voice_channel_missing'
      });
      await deleteRoomProfileCard(client, String(voiceChannelId || ''));
    }
    return;
  }

  await syncVoiceChannelProfile(client, voiceChannel);
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
  const channels = await guild.channels.fetch();
  let scannedChannelCount = 0;
  let staleCardCount = 0;

  client.logger.info('vc profile reconciliation started', {
    reason,
    trackedCategoryCount: client.voiceProfileCategoryMap.size
  });

  for (const [categoryId] of client.voiceProfileCategoryMap) {
    await cleanupLegacyUserCards(client, categoryId);

    const storedRooms = client.db.vcProfiles.listRoomMessagesByCategory(categoryId);
    const trackedVoiceChannels = [...channels.values()].filter(
      (channel) => channel?.isVoiceBased?.() && channel.parentId === categoryId
    );
    const activeVoiceChannelIds = new Set();

    for (const voiceChannel of trackedVoiceChannels) {
      scannedChannelCount += 1;
      activeVoiceChannelIds.add(voiceChannel.id);
      await syncVoiceChannelProfile(client, voiceChannel);
    }

    for (const record of storedRooms) {
      if (!activeVoiceChannelIds.has(record.voiceChannelId)) {
        staleCardCount += 1;
        client.logger.info('vc profile stale card detected', {
          categoryId,
          voiceChannelId: record.voiceChannelId,
          profileChannelId: record.profileChannelId,
          messageId: record.messageId,
          reason: `${reason}_missing_voice_channel`
        });
        await deleteRoomProfileCard(client, record.voiceChannelId);
        client.logger.info('VC room profile deleted', {
          categoryId,
          voiceChannelId: record.voiceChannelId,
          profileChannelId: record.profileChannelId,
          reason: `${reason}_cleanup`
        });
      }
    }
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

  const affectedChannelIds = new Set();
  if (oldState.channelId && (oldCategoryId || client.db.vcProfiles.getRoomMessage(oldState.channelId))) {
    affectedChannelIds.add(String(oldState.channelId));
  }
  if (newState.channelId && newCategoryId) {
    affectedChannelIds.add(String(newState.channelId));
  }

  client.logger.info('Affected VC room profile channels', {
    userId,
    voiceChannelIds: [...affectedChannelIds]
  });

  for (const voiceChannelId of affectedChannelIds) {
    await syncVoiceChannelProfileById(client, guild, voiceChannelId);
  }
}

module.exports = {
  initializeVoiceProfileMappings,
  rebuildVoiceProfileState,
  startVoiceProfileReconciliation,
  handleVoiceStateUpdate
};
