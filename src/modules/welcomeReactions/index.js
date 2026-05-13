const { MessageType } = require('discord.js');
const { isAdministrator } = require('../../utils/permissions');

function ensureSetupStore(client) {
  if (!client.activeWelcomeReactionSetups) {
    client.activeWelcomeReactionSetups = new Map();
  }

  return client.activeWelcomeReactionSetups;
}

function getEmojiKey(emoji) {
  if (!emoji) {
    return '';
  }

  if (emoji.id) {
    return `${emoji.animated ? 'a' : 's'}:${emoji.name}:${emoji.id}`;
  }

  return String(emoji.name || '');
}

function formatSavedEmoji(reaction) {
  if (reaction.emojiId) {
    return `<${reaction.animated ? 'a' : ''}:${reaction.emojiName}:${reaction.emojiId}>`;
  }

  return reaction.emojiName || reaction.emojiKey;
}

function createReactionDescriptor(emoji) {
  return {
    emojiKey: getEmojiKey(emoji),
    emojiName: emoji.name || null,
    emojiId: emoji.id || null,
    animated: Boolean(emoji.animated)
  };
}

function hasWelcomeJoinMessageType(message) {
  return message.type === MessageType.UserJoin;
}

async function createWelcomeReactionSetup(interaction) {
  const { client } = interaction;
  const store = ensureSetupStore(client);
  const maxCount = Number(client.appConfig.welcomeReactionsMax || 5);
  const previousCount = client.db.welcomeReactions.count(interaction.guildId);
  client.db.welcomeReactions.clear(interaction.guildId);

  client.logger.info('Welcome reaction setup DB reset', {
    guildId: interaction.guildId,
    clearedCount: previousCount
  });

  const setupMessage = await interaction.channel.send({
    content: `Welcome通知につけたいリアクションをこのメッセージに押してください。最大${maxCount}個まで保存されます。`
  });

  store.set(interaction.guildId, {
    channelId: interaction.channelId,
    messageId: setupMessage.id,
    createdByUserId: interaction.user.id,
    createdAt: Date.now()
  });

  client.logger.info('Welcome reaction setup started', {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    setupMessageId: setupMessage.id,
    createdByUserId: interaction.user.id
  });

  return setupMessage;
}

function listWelcomeReactions(client, guildId) {
  return client.db.welcomeReactions.list(guildId);
}

function clearWelcomeReactions(client, guildId) {
  const count = client.db.welcomeReactions.count(guildId);
  client.db.welcomeReactions.clear(guildId);
  client.logger.info('Welcome reactions cleared', {
    guildId,
    clearedCount: count
  });
  return count;
}

async function handleWelcomeReactionSetup(reaction, user) {
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  const client = message.client;
  const logger = client.logger;
  const guildId = message.guildId;
  const setup = ensureSetupStore(client).get(guildId);

  if (!setup || setup.messageId !== message.id) {
    logger.info('Welcome reaction setup ignored', {
      guildId,
      reactionMessageId: message.id,
      reason: 'no_active_setup'
    });
    return;
  }

  if (user.bot) {
    logger.info('Welcome reaction setup ignored', {
      guildId,
      reactionMessageId: message.id,
      reason: 'bot_user'
    });
    return;
  }

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!isAdministrator(member)) {
    logger.info('Welcome reaction setup ignored', {
      guildId,
      reactionMessageId: message.id,
      userId: user.id,
      reason: 'not_admin'
    });
    return;
  }

  if (reaction.partial) {
    await reaction.fetch().catch(() => null);
  }

  await syncWelcomeReactionsFromSetupMessage(message, {
    actorUserId: user.id,
    actorReason: 'reaction_add'
  });
}

async function handleWelcomeReactionSetupRemoval(reaction, user) {
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  const client = message.client;
  const logger = client.logger;
  const guildId = message.guildId;
  const setup = ensureSetupStore(client).get(guildId);

  if (!setup || setup.messageId !== message.id) {
    logger.info('Welcome reaction setup removal ignored', {
      guildId,
      reactionMessageId: message.id,
      reason: 'no_active_setup'
    });
    return;
  }

  if (user.bot) {
    logger.info('Welcome reaction setup removal ignored', {
      guildId,
      reactionMessageId: message.id,
      reason: 'bot_user'
    });
    return;
  }

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!isAdministrator(member)) {
    logger.info('Welcome reaction setup removal ignored', {
      guildId,
      reactionMessageId: message.id,
      userId: user.id,
      reason: 'not_admin'
    });
    return;
  }

  logger.info('Welcome reaction remove detected', {
    guildId,
    reactionMessageId: message.id,
    userId: user.id
  });

  await syncWelcomeReactionsFromSetupMessage(message, {
    actorUserId: user.id,
    actorReason: 'reaction_remove'
  });
}

async function syncWelcomeReactionsFromSetupMessage(message, options = {}) {
  const client = message.client;
  const logger = client.logger;
  const guildId = message.guildId;
  const setup = ensureSetupStore(client).get(guildId);

  if (!setup || setup.messageId !== message.id) {
    logger.info('Welcome reaction sync skipped', {
      guildId,
      reactionMessageId: message.id,
      reason: 'no_active_setup'
    });
    return { savedCount: 0 };
  }

  const maxCount = Number(client.appConfig.welcomeReactionsMax || 5);
  const fetchedMessage = message.partial ? await message.fetch().catch(() => null) : message;

  if (!fetchedMessage) {
    logger.warn('Welcome setup message missing/deleted, keeping last saved settings', {
      guildId,
      reactionMessageId: message.id
    });
    return { savedCount: client.db.welcomeReactions.count(guildId) };
  }

  logger.info('Welcome reaction setup sync started', {
    guildId,
    channelId: fetchedMessage.channelId,
    reactionMessageId: fetchedMessage.id,
    actorUserId: options.actorUserId || null,
    actorReason: options.actorReason || 'unknown'
  });

  const collectedReactions = [];
  const seenEmojiKeys = new Set();

  for (const reaction of fetchedMessage.reactions.cache.values()) {
    const descriptor = createReactionDescriptor(reaction.emoji);
    if (!descriptor.emojiKey || seenEmojiKeys.has(descriptor.emojiKey)) {
      continue;
    }

    seenEmojiKeys.add(descriptor.emojiKey);
    collectedReactions.push(descriptor);
  }

  const selectedReactions = collectedReactions.slice(0, maxCount);
  client.db.welcomeReactions.clear(guildId);

  selectedReactions.forEach((reaction, index) => {
    client.db.welcomeReactions.insert({
      guildId,
      ...reaction,
      sortOrder: index + 1
    });
  });

  logger.info('Welcome reaction setup sync finished', {
    guildId,
    reactionMessageId: fetchedMessage.id,
    savedReactionCount: selectedReactions.length,
    ignoredExtraReactionCount: Math.max(0, collectedReactions.length - selectedReactions.length)
  });

  return {
    savedCount: selectedReactions.length
  };
}

async function applyWelcomeReactionsToMessage(message) {
  const client = message.client;
  const logger = client.logger;
  const configuredChannelId = String(client.appConfig.welcomeChannelId || '');

  if (!configuredChannelId || message.channelId !== configuredChannelId) {
    return;
  }

  if (!hasWelcomeJoinMessageType(message)) {
    logger.info('Welcome message reaction skipped', {
      sourceMessageId: message.id,
      channelId: message.channelId,
      reason: 'not_user_join_system_message',
      messageType: message.type,
      system: Boolean(message.system)
    });
    return;
  }

  const reactions = client.db.welcomeReactions.list(message.guildId);
  logger.info('Welcome message detected', {
    sourceMessageId: message.id,
    channelId: message.channelId,
    configuredReactionCount: reactions.length,
    messageType: message.type
  });

  return applyConfiguredWelcomeReactions(message, reactions, logger);
}

async function applyConfiguredWelcomeReactions(message, reactions, logger = message.client?.logger) {
  let appliedCount = 0;
  let failedCount = 0;

  for (const reaction of reactions) {
    const reactionTarget = reaction.emojiId || reaction.emojiName;

    try {
      await message.react(reactionTarget);
      appliedCount += 1;
      logger.info('Welcome reaction applied', {
        sourceMessageId: message.id,
        channelId: message.channelId,
        emojiKey: reaction.emojiKey,
        emojiDisplay: formatSavedEmoji(reaction)
      });
    } catch (error) {
      failedCount += 1;
      logger.warn('Welcome reaction failed', {
        sourceMessageId: message.id,
        channelId: message.channelId,
        emojiKey: reaction.emojiKey,
        error: error.message
      });
    }
  }

  return {
    appliedCount,
    failedCount
  };
}

async function backfillWelcomeReactions(client, guildId, limit = 100) {
  const logger = client.logger;
  const configuredChannelId = String(client.appConfig.welcomeChannelId || '');
  const reactions = client.db.welcomeReactions.list(guildId);

  logger.info('Welcome reaction backfill started', {
    guildId,
    configuredChannelId,
    requestedLimit: limit,
    configuredReactionCount: reactions.length
  });

  if (!configuredChannelId) {
    return {
      scannedCount: 0,
      matchedCount: 0,
      reactedMessageCount: 0,
      failedReactionCount: 0,
      skippedReason: 'welcome_channel_not_configured'
    };
  }

  if (!reactions.length) {
    return {
      scannedCount: 0,
      matchedCount: 0,
      reactedMessageCount: 0,
      failedReactionCount: 0,
      skippedReason: 'no_configured_reactions'
    };
  }

  const channel = await client.channels.fetch(configuredChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return {
      scannedCount: 0,
      matchedCount: 0,
      reactedMessageCount: 0,
      failedReactionCount: 0,
      skippedReason: 'welcome_channel_unavailable'
    };
  }

  const targetLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const collectedMessages = [];
  let before;

  while (collectedMessages.length < targetLimit) {
    const batchSize = Math.min(100, targetLimit - collectedMessages.length);
    const batch = await channel.messages.fetch(before ? { limit: batchSize, before } : { limit: batchSize });
    if (!batch.size) {
      break;
    }

    const ordered = Array.from(batch.values());
    collectedMessages.push(...ordered);
    before = ordered[ordered.length - 1]?.id;

    if (batch.size < batchSize) {
      break;
    }
  }

  const scannedMessages = collectedMessages.slice(0, targetLimit);
  let matchedCount = 0;
  let reactedMessageCount = 0;
  let failedReactionCount = 0;

  logger.info('Welcome reaction backfill scanning finished', {
    guildId,
    configuredChannelId,
    scannedCount: scannedMessages.length
  });

  for (const message of scannedMessages) {
    if (!hasWelcomeJoinMessageType(message)) {
      continue;
    }

    matchedCount += 1;
    const result = await applyConfiguredWelcomeReactions(message, reactions, logger);
    if (result.appliedCount > 0) {
      reactedMessageCount += 1;
    }
    failedReactionCount += result.failedCount;
  }

  logger.info('Welcome reaction backfill finished', {
    guildId,
    configuredChannelId,
    scannedCount: scannedMessages.length,
    matchedCount,
    reactedMessageCount,
    failedReactionCount
  });

  return {
    scannedCount: scannedMessages.length,
    matchedCount,
    reactedMessageCount,
    failedReactionCount,
    skippedReason: null
  };
}

module.exports = {
  createWelcomeReactionSetup,
  listWelcomeReactions,
  clearWelcomeReactions,
  handleWelcomeReactionSetup,
  handleWelcomeReactionSetupRemoval,
  syncWelcomeReactionsFromSetupMessage,
  applyWelcomeReactionsToMessage,
  backfillWelcomeReactions,
  formatSavedEmoji
};
