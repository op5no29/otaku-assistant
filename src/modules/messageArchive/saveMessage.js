function serializeAttachment(attachment) {
  return {
    id: String(attachment?.id || ''),
    name: attachment?.name || null,
    filename: attachment?.filename || null,
    title: attachment?.title || null,
    description: attachment?.description || null,
    url: attachment?.url || null,
    proxyURL: attachment?.proxyURL || attachment?.proxyUrl || null,
    contentType: attachment?.contentType || null,
    size: Number(attachment?.size || 0)
  };
}

function serializeEmbed(embed) {
  if (typeof embed?.toJSON === 'function') {
    return embed.toJSON();
  }

  return embed?.data || null;
}

function buildArchiveRecord(message) {
  const channel = message.channel;
  const inThread = Boolean(channel?.isThread?.());
  const member = message.member;

  return {
    messageId: message.id,
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    parentId: inThread ? String(channel.parentId || '') : null,
    threadId: inThread ? message.channelId : null,
    authorId: message.author?.id || null,
    authorName:
      member?.displayName ||
      message.author?.globalName ||
      message.author?.username ||
      '不明なユーザー',
    authorIsBot: Boolean(message.author?.bot),
    content: String(message.content || ''),
    cleanContent: String(message.cleanContent || ''),
    attachmentsJson: JSON.stringify(Array.from(message.attachments.values()).map(serializeAttachment)),
    embedsJson: JSON.stringify(message.embeds.map(serializeEmbed).filter(Boolean)),
    referencedMessageId: message.reference?.messageId || null,
    messageType: Number(message.type || 0),
    createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null
  };
}

async function saveMessageToArchive(client, message) {
  if (!message?.inGuild?.() || !message.guildId) {
    return false;
  }

  const record = buildArchiveRecord(message);
  client.db.archives.upsertMessage(record);
  client.logger.info('Message archived', {
    messageId: record.messageId,
    guildId: record.guildId,
    channelId: record.channelId,
    authorId: record.authorId,
    authorIsBot: record.authorIsBot
  });
  return true;
}

module.exports = {
  saveMessageToArchive,
  buildArchiveRecord
};
