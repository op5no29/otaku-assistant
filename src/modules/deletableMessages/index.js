const DELETE_EMOJI = '❌';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24;

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
  if (String(record.ownerUserId) !== String(user.id) && !isAdminLike) {
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
  handleDeletableMessageReaction
};
