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
  const setupMessage = await interaction.channel.send({
    content: `Welcome通知につけたいリアクションをこのメッセージに押してください。最大${maxCount}個まで保存されます。`
  });

  store.set(interaction.guildId, {
    channelId: interaction.channelId,
    messageId: setupMessage.id,
    createdByUserId: interaction.user.id,
    createdAt: Date.now()
  });

  client.logger.info('Welcome reaction setup message created', {
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

  const descriptor = createReactionDescriptor(reaction.emoji);
  const maxCount = Number(client.appConfig.welcomeReactionsMax || 5);
  const existing = client.db.welcomeReactions.get(guildId, descriptor.emojiKey);
  const currentCount = client.db.welcomeReactions.count(guildId);

  if (existing) {
    logger.info('Welcome reaction setup skipped', {
      guildId,
      reactionMessageId: message.id,
      userId: user.id,
      emojiKey: descriptor.emojiKey,
      reason: 'already_saved'
    });
    return;
  }

  if (currentCount >= maxCount) {
    logger.info('Welcome reaction setup skipped', {
      guildId,
      reactionMessageId: message.id,
      userId: user.id,
      emojiKey: descriptor.emojiKey,
      reason: 'max_reached',
      maxCount
    });
    return;
  }

  client.db.welcomeReactions.insert({
    guildId,
    ...descriptor,
    sortOrder: currentCount + 1
  });

  logger.info('Welcome reaction saved', {
    guildId,
    reactionMessageId: message.id,
    userId: user.id,
    emojiKey: descriptor.emojiKey,
    emojiName: descriptor.emojiName,
    emojiId: descriptor.emojiId,
    animated: descriptor.animated,
    sortOrder: currentCount + 1
  });
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

  for (const reaction of reactions) {
    const reactionTarget = reaction.emojiId || reaction.emojiName;

    try {
      await message.react(reactionTarget);
      logger.info('Welcome reaction applied', {
        sourceMessageId: message.id,
        channelId: message.channelId,
        emojiKey: reaction.emojiKey,
        emojiDisplay: formatSavedEmoji(reaction)
      });
    } catch (error) {
      logger.warn('Welcome reaction failed', {
        sourceMessageId: message.id,
        channelId: message.channelId,
        emojiKey: reaction.emojiKey,
        error: error.message
      });
    }
  }
}

module.exports = {
  createWelcomeReactionSetup,
  listWelcomeReactions,
  clearWelcomeReactions,
  handleWelcomeReactionSetup,
  applyWelcomeReactionsToMessage,
  formatSavedEmoji
};
