const { buildProfileMessage } = require('./buildProfileMessage');
const { findLatestIntroMessage } = require('./findLatestIntroMessage');

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
        profileChannelId: profileChannel.id
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
  const categoryId = getTrackedCategoryId(client, voiceChannel);
  if (!categoryId) {
    return;
  }

  const mapping = client.voiceProfileCategoryMap.get(categoryId);
  if (!mapping) {
    return;
  }

  const members = await buildVoiceChannelMembers(client, voiceChannel);
  const profileChannel = await client.channels.fetch(mapping.profileChannelId).catch(() => null);

  if (!profileChannel?.isTextBased?.()) {
    client.logger.warn('VC profile destination is not text-based', {
      categoryId,
      profileChannelId: mapping.profileChannelId
    });
    return;
  }

  const existing = client.db.vcProfiles.getRoomMessage(voiceChannel.id);

  if (members.length === 0) {
    if (existing) {
      await deleteRoomProfileCard(client, voiceChannel.id);
      client.logger.info('VC room profile deleted', {
        categoryId,
        voiceChannelId: voiceChannel.id,
        profileChannelId: profileChannel.id
      });
    }

    return;
  }

  const payload = buildProfileMessage({
    contextName: mapping.name,
    voiceChannelName: voiceChannel.name,
    members
  });

  if (!existing) {
    const sentMessage = await profileChannel.send(payload);
    client.db.vcProfiles.upsertRoomMessage({
      categoryId,
      voiceChannelId: voiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id
    });
    client.logger.info('VC room profile created', {
      categoryId,
      voiceChannelId: voiceChannel.id,
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
      voiceChannelId: voiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id
    });
    client.logger.info('VC room profile created', {
      categoryId,
      voiceChannelId: voiceChannel.id,
      profileChannelId: profileChannel.id,
      messageId: sentMessage.id,
      recovered: true
    });
    return;
  }

  await message.edit(payload);
  client.db.vcProfiles.upsertRoomMessage({
    categoryId,
    voiceChannelId: voiceChannel.id,
    profileChannelId: profileChannel.id,
    messageId: message.id
  });
  client.logger.info('VC room profile updated', {
    categoryId,
    voiceChannelId: voiceChannel.id,
    profileChannelId: profileChannel.id,
    messageId: message.id
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

async function rebuildVoiceProfileState(client) {
  for (const [categoryId] of client.voiceProfileCategoryMap) {
    await cleanupLegacyUserCards(client, categoryId);

    const storedRooms = client.db.vcProfiles.listRoomMessagesByCategory(categoryId);
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const channels = await guild.channels.fetch();
    const trackedVoiceChannels = [...channels.values()].filter(
      (channel) => channel?.isVoiceBased?.() && channel.parentId === categoryId
    );
    const activeVoiceChannelIds = new Set();

    for (const voiceChannel of trackedVoiceChannels) {
      activeVoiceChannelIds.add(voiceChannel.id);
      await syncVoiceChannelProfile(client, voiceChannel);
    }

    for (const record of storedRooms) {
      if (!activeVoiceChannelIds.has(record.voiceChannelId)) {
        await deleteRoomProfileCard(client, record.voiceChannelId);
        client.logger.info('VC room profile deleted', {
          categoryId,
          voiceChannelId: record.voiceChannelId,
          profileChannelId: record.profileChannelId,
          reason: 'startup_cleanup'
        });
      }
    }
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  const client = newState.client;
  const userId = newState.id;
  const member =
    newState.member ||
    oldState.member ||
    (await newState.guild.members.fetch(userId).catch(() => null));

  const oldCategoryId = getTrackedCategoryId(client, oldState.channel);
  const newCategoryId = getTrackedCategoryId(client, newState.channel);
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

  if (oldState.channelId && oldState.channelId === newState.channelId) {
    return;
  }

  const affectedChannels = new Map();
  if (oldState.channel && oldCategoryId) {
    affectedChannels.set(oldState.channel.id, oldState.channel);
  }
  if (newState.channel && newCategoryId) {
    affectedChannels.set(newState.channel.id, newState.channel);
  }

  client.logger.info('Affected VC room profile channels', {
    userId,
    voiceChannelIds: [...affectedChannels.keys()]
  });

  for (const voiceChannel of affectedChannels.values()) {
    await syncVoiceChannelProfile(client, voiceChannel);
  }
}

module.exports = {
  initializeVoiceProfileMappings,
  rebuildVoiceProfileState,
  handleVoiceStateUpdate
};
