const DELETE_EMOJI = '❌';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24;
const WRONG_USER_MESSAGE = 'このリアクションは、この操作をした本人だけが使えます。';
const POSTHOC_WRONG_USER_MESSAGE = 'このリアクションは、元の投稿者だけが使えます。';
const POSTHOC_PURPOSE = 'posthoc_route_relay';

function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isPosthocPurpose(purpose) {
  return String(purpose || '').startsWith('posthoc_');
}

async function registerDeletableMessage(message, ownerUserId, purpose, ttlMs = DEFAULT_TTL_MS, metadata = null) {
  const client = message.client;
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  client.db.deletableMessages.upsert({
    guildId: message.guildId || '',
    channelId: message.channelId,
    messageId: message.id,
    ownerUserId,
    purpose,
    metadataJson,
    expiresAt
  });
  await message.react(DELETE_EMOJI).catch(() => null);
}

async function registerPosthocDeletableCard(message, {
  ownerUserId,
  sourceMessageId,
  destinationChannelId,
  taggerUserId,
  relayKind,
  displayTags
}) {
  await registerDeletableMessage(message, ownerUserId, POSTHOC_PURPOSE, null, {
    sourceMessageId,
    destinationChannelId,
    taggerUserId,
    relayKind,
    displayTags: Array.isArray(displayTags) ? displayTags : []
  });
  message.client.logger.info('posthoc deletable card registered', {
    messageId: message.id,
    channelId: message.channelId,
    ownerUserId,
    sourceMessageId,
    destinationChannelId,
    taggerUserId,
    relayKind,
    displayTags: Array.isArray(displayTags) ? displayTags : []
  });
}

function cleanupPosthocRelayState(message, record) {
  const metadata = parseMetadataJson(record.metadataJson);
  const sourceMessageId = metadata?.sourceMessageId;
  const destinationChannelId = metadata?.destinationChannelId || record.channelId;

  if (!sourceMessageId || !destinationChannelId) {
    return;
  }

  message.client.db.relays.deleteMessageRelayTarget(sourceMessageId, destinationChannelId);
  message.client.db.timelineDestination?.deleteIfCurrent?.(
    record.guildId,
    destinationChannelId,
    record.messageId
  );
}

async function handleDeletableMessageReaction(reaction, user) {
  if (user?.bot) {
    return false;
  }

  const fullReaction = reaction.partial ? await reaction.fetch().catch(() => reaction) : reaction;
  const message = fullReaction.message?.partial
    ? await fullReaction.message.fetch().catch(() => fullReaction.message)
    : fullReaction.message;
  if (!message?.id) {
    return false;
  }
  if (String(fullReaction.emoji?.name || '') !== DELETE_EMOJI) {
    return false;
  }

  const record = message.client.db.deletableMessages.get(message.id);
  if (!record) {
    return false;
  }

  const guild = message.guild || null;
  const member = guild ? (guild.members.cache.get(user.id) || await guild.members.fetch(user.id).catch(() => null)) : null;
  const isAdminLike = Boolean(member?.permissions?.has?.('Administrator') || member?.permissions?.has?.('ManageMessages'));
  const ownerMatched = String(record.ownerUserId) === String(user.id);
  const posthocPurpose = isPosthocPurpose(record.purpose);
  const ownerOnlyPurpose = String(record.purpose || '').startsWith('anime_') || posthocPurpose;
  const allowedByAdmin = !ownerOnlyPurpose && isAdminLike;

  if (!ownerMatched && !allowedByAdmin) {
    const wrongUserLogName = posthocPurpose
      ? 'posthoc delete reaction rejected wrong user'
      : 'deletable reaction rejected wrong user';
    message.client.logger.info(wrongUserLogName, {
      messageId: message.id,
      channelId: message.channelId,
      ownerUserId: record.ownerUserId,
      reactingUserId: user.id,
      purpose: record.purpose || null,
      ownerOnlyPurpose
    });

    const notice = await message.channel?.send?.({
      content: `<@${user.id}> ${posthocPurpose ? POSTHOC_WRONG_USER_MESSAGE : WRONG_USER_MESSAGE}`,
      allowedMentions: { users: [user.id], parse: [] }
    }).catch(() => null);
    if (notice) {
      setTimeout(() => {
        notice.delete().catch(() => null);
      }, 8_000).unref();
    }

    try {
      await fullReaction.users.remove(user.id);
      message.client.logger.info(posthocPurpose
        ? 'posthoc delete reaction wrong user reaction removed'
        : 'deletable reaction wrong user reaction removed', {
        messageId: message.id,
        channelId: message.channelId,
        reactingUserId: user.id,
        purpose: record.purpose || null
      });
    } catch (error) {
      message.client.logger.warn(posthocPurpose
        ? 'posthoc delete reaction wrong user reaction remove failed'
        : 'deletable reaction wrong user reaction remove failed', {
        messageId: message.id,
        channelId: message.channelId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        error: error.message
      });
    }
    return true;
  }

  message.client.logger.info(posthocPurpose ? 'posthoc delete reaction owner accepted' : 'deletable reaction owner accepted', {
    messageId: message.id,
    channelId: message.channelId,
    ownerUserId: record.ownerUserId,
    reactingUserId: user.id,
    purpose: record.purpose || null,
    acceptedBy: ownerMatched ? 'owner' : 'admin'
  });

  if (posthocPurpose) {
    try {
      await message.delete();
    } catch (error) {
      message.client.logger.warn('posthoc delete reaction delete failed', {
        messageId: message.id,
        channelId: message.channelId,
        ownerUserId: record.ownerUserId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        error: error.message
      });
      return true;
    }

    try {
      cleanupPosthocRelayState(message, record);
    } catch (error) {
      message.client.logger.warn('posthoc delete reaction state cleanup failed', {
        messageId: message.id,
        channelId: message.channelId,
        ownerUserId: record.ownerUserId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        metadataJson: record.metadataJson || null,
        error: error.message
      });
    }

    message.client.db.deletableMessages.delete(message.id);
    return true;
  }

  try {
    await message.delete().catch(() => null);
  } finally {
    message.client.db.deletableMessages.delete(message.id);
  }
  return true;
}

module.exports = {
  DELETE_EMOJI,
  registerDeletableMessage,
  registerPosthocDeletableCard,
  handleDeletableMessageReaction
};
