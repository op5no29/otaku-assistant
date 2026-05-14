const { isAdministrator } = require('../../utils/permissions');

function ensureSetupStore(client) {
  if (!client.activeIntroReactionSetups) {
    client.activeIntroReactionSetups = new Map();
  }
  return client.activeIntroReactionSetups;
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

async function createIntroReactionSetup(interaction) {
  const { client } = interaction;
  const store = ensureSetupStore(client);
  const maxCount = Number(client.appConfig.introReactionsMax || 5);
  client.db.introReactions.clear(interaction.guildId);

  const setupMessage = await interaction.channel.send({
    content: `自己紹介投稿につけたいリアクションをこのメッセージに押してください。最大${maxCount}個まで保存されます。`
  });

  store.set(interaction.guildId, {
    channelId: interaction.channelId,
    messageId: setupMessage.id,
    createdByUserId: interaction.user.id,
    createdAt: Date.now()
  });

  client.logger.info('Intro reaction setup started', {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    setupMessageId: setupMessage.id
  });

  return setupMessage;
}

function listIntroReactions(client, guildId) {
  return client.db.introReactions.list(guildId);
}

function clearIntroReactions(client, guildId) {
  const count = client.db.introReactions.count(guildId);
  client.db.introReactions.clear(guildId);
  client.logger.info('Intro reactions cleared', {
    guildId,
    clearedCount: count
  });
  return count;
}

async function syncIntroReactionsFromSetupMessage(message, options = {}) {
  const client = message.client;
  const logger = client.logger;
  const guildId = message.guildId;
  const setup = ensureSetupStore(client).get(guildId);
  if (!setup || setup.messageId !== message.id) {
    return { savedCount: 0 };
  }

  const maxCount = Number(client.appConfig.introReactionsMax || 5);
  const fetchedMessage = message.partial ? await message.fetch().catch(() => null) : message;
  if (!fetchedMessage) {
    logger.warn('Intro setup message missing/deleted, keeping last saved settings', {
      guildId,
      reactionMessageId: message.id
    });
    return { savedCount: client.db.introReactions.count(guildId) };
  }

  const collected = [];
  const seen = new Set();
  for (const reaction of fetchedMessage.reactions.cache.values()) {
    const descriptor = createReactionDescriptor(reaction.emoji);
    if (!descriptor.emojiKey || seen.has(descriptor.emojiKey)) {
      continue;
    }
    seen.add(descriptor.emojiKey);
    collected.push(descriptor);
  }

  const selected = collected.slice(0, maxCount);
  client.db.introReactions.clear(guildId);
  selected.forEach((reaction, index) => {
    client.db.introReactions.insert({
      guildId,
      ...reaction,
      sortOrder: index + 1
    });
  });

  logger.info('Intro reaction setup sync finished', {
    guildId,
    reactionMessageId: fetchedMessage.id,
    savedReactionCount: selected.length,
    ignoredExtraReactionCount: Math.max(0, collected.length - selected.length),
    actorUserId: options.actorUserId || null,
    actorReason: options.actorReason || null
  });

  return { savedCount: selected.length };
}

async function handleIntroReactionSetup(reaction, user) {
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  const client = message.client;
  const setup = ensureSetupStore(client).get(message.guildId);
  if (!setup || setup.messageId !== message.id || user.bot) {
    return;
  }

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!isAdministrator(member)) {
    client.logger.info('Intro reaction setup ignored', {
      guildId: message.guildId,
      userId: user.id,
      reason: 'not_admin'
    });
    return;
  }

  if (reaction.partial) {
    await reaction.fetch().catch(() => null);
  }

  await syncIntroReactionsFromSetupMessage(message, {
    actorUserId: user.id,
    actorReason: 'reaction_add'
  });
}

async function handleIntroReactionSetupRemoval(reaction, user) {
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  const client = message.client;
  const setup = ensureSetupStore(client).get(message.guildId);
  if (!setup || setup.messageId !== message.id || user.bot) {
    return;
  }

  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!isAdministrator(member)) {
    client.logger.info('Intro reaction setup removal ignored', {
      guildId: message.guildId,
      userId: user.id,
      reason: 'not_admin'
    });
    return;
  }

  await syncIntroReactionsFromSetupMessage(message, {
    actorUserId: user.id,
    actorReason: 'reaction_remove'
  });
}

async function applyConfiguredIntroReactions(message, reactions, logger = message.client?.logger) {
  let appliedCount = 0;
  let failedCount = 0;
  for (const reaction of reactions) {
    const reactionTarget = reaction.emojiId || reaction.emojiName;
    try {
      await message.react(reactionTarget);
      appliedCount += 1;
      logger.info('intro reaction applied', {
        messageId: message.id,
        channelId: message.channelId,
        emojiKey: reaction.emojiKey
      });
    } catch (error) {
      failedCount += 1;
      logger.warn('intro reaction failed', {
        messageId: message.id,
        channelId: message.channelId,
        emojiKey: reaction.emojiKey,
        error: error.message
      });
    }
  }
  return { appliedCount, failedCount };
}

async function removeOutdatedBotReactions(message, savedEmojiKeySet, client, logger) {
  let removedCount = 0;
  let failedCount = 0;
  for (const reaction of message.reactions.cache.values()) {
    if (!reaction.me) {
      continue;
    }
    const emojiKey = getEmojiKey(reaction.emoji);
    if (savedEmojiKeySet.has(emojiKey)) {
      continue;
    }
    try {
      await reaction.users.remove(client.user.id);
      removedCount += 1;
    } catch (error) {
      failedCount += 1;
      logger.warn('intro outdated bot reaction removal failed', {
        messageId: message.id,
        emojiKey,
        error: error.message
      });
    }
  }
  return { removedCount, failedCount };
}

async function applyIntroReactionsToMessage(message) {
  const client = message.client;
  const logger = client.logger;
  const reactions = client.db.introReactions.list(message.guildId);
  if (!reactions.length) {
    logger.info('intro reaction skipped no configured reactions', {
      messageId: message.id,
      channelId: message.channelId
    });
    return { appliedCount: 0, failedCount: 0 };
  }
  return applyConfiguredIntroReactions(message, reactions, logger);
}

async function backfillIntroReactions(client, guildId) {
  const logger = client.logger;
  const introChannelId = String(client.appConfig.introDm?.introChannelId || client.appConfig.introChannelId || '');
  const rows = client.db.introProfiles.listByChannel(guildId, introChannelId, 2000);
  const reactions = client.db.introReactions.list(guildId);
  const savedEmojiKeySet = new Set(reactions.map((r) => r.emojiKey).filter(Boolean));
  let reactedMessageCount = 0;
  let appliedCount = 0;
  let removedOutdatedCount = 0;
  let failedCount = 0;

  const channel = await client.channels.fetch(introChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return {
      scannedIntroCount: 0,
      reactedMessageCount: 0,
      appliedCount: 0,
      removedOutdatedCount: 0,
      failedCount: 0,
      skippedReason: 'intro_channel_unavailable'
    };
  }

  for (const row of rows) {
    const message = await channel.messages.fetch(row.introMessageId).catch(() => null);
    if (!message) {
      failedCount += 1;
      continue;
    }

    const applyResult = await applyConfiguredIntroReactions(message, reactions, logger);
    if (applyResult.appliedCount > 0) {
      reactedMessageCount += 1;
    }
    appliedCount += applyResult.appliedCount;
    failedCount += applyResult.failedCount;

    const cleanupResult = await removeOutdatedBotReactions(message, savedEmojiKeySet, client, logger);
    removedOutdatedCount += cleanupResult.removedCount;
    failedCount += cleanupResult.failedCount;
  }

  return {
    scannedIntroCount: rows.length,
    reactedMessageCount,
    appliedCount,
    removedOutdatedCount,
    failedCount,
    skippedReason: null
  };
}

module.exports = {
  createIntroReactionSetup,
  listIntroReactions,
  clearIntroReactions,
  handleIntroReactionSetup,
  handleIntroReactionSetupRemoval,
  applyIntroReactionsToMessage,
  backfillIntroReactions,
  formatSavedEmoji
};
