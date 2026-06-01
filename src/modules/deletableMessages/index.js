const DELETE_EMOJI = '❌';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24;
const WRONG_USER_MESSAGE = 'このリアクションは、この操作をした本人だけが使えます。';

async function registerDeletableMessage(message, ownerUserId, purpose, ttlMs = DEFAULT_TTL_MS) {
  const client = message.client;
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
  client.db.deletableMessages.upsert({
    guildId: message.guildId || '',
    channelId: message.channelId,
    messageId: message.id,
    ownerUserId,
    purpose,
    expiresAt
  });
  await message.react(DELETE_EMOJI).catch(() => null);
}

async function handleDeletableMessageReaction(reaction, user) {
  if (user?.bot) {
    return false;
  }

  const message = reaction.message.partial ? await reaction.message.fetch().catch(() => reaction.message) : reaction.message;
  if (!message?.id) {
    return false;
  }
  if (String(reaction.emoji?.name || '') !== DELETE_EMOJI) {
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
  const ownerOnlyPurpose = String(record.purpose || '').startsWith('anime_');
  const allowedByAdmin = !ownerOnlyPurpose && isAdminLike;

  if (!ownerMatched && !allowedByAdmin) {
    message.client.logger.info('deletable reaction rejected wrong user', {
      messageId: message.id,
      channelId: message.channelId,
      ownerUserId: record.ownerUserId,
      reactingUserId: user.id,
      purpose: record.purpose || null,
      ownerOnlyPurpose
    });

    const notice = await message.channel?.send?.({
      content: `<@${user.id}> ${WRONG_USER_MESSAGE}`,
      allowedMentions: { users: [user.id], parse: [] }
    }).catch(() => null);
    if (notice) {
      setTimeout(() => {
        notice.delete().catch(() => null);
      }, 8_000).unref();
    }

    try {
      await reaction.users.remove(user.id);
      message.client.logger.info('deletable reaction wrong user reaction removed', {
        messageId: message.id,
        channelId: message.channelId,
        reactingUserId: user.id,
        purpose: record.purpose || null
      });
    } catch (error) {
      message.client.logger.warn('deletable reaction wrong user reaction remove failed', {
        messageId: message.id,
        channelId: message.channelId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        error: error.message
      });
    }
    return true;
  }

  message.client.logger.info('deletable reaction owner accepted', {
    messageId: message.id,
    channelId: message.channelId,
    ownerUserId: record.ownerUserId,
    reactingUserId: user.id,
    purpose: record.purpose || null,
    acceptedBy: ownerMatched ? 'owner' : 'admin'
  });

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
  handleDeletableMessageReaction
};
