function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeArchivedMessage(record) {
  return {
    ...record,
    authorIsBot: Boolean(record.authorIsBot),
    attachments: parseJsonArray(record.attachmentsJson),
    embeds: parseJsonArray(record.embedsJson)
  };
}

function getRecentArchivedMessages(client, { channelId, limit = 50 }) {
  const rows = client.db.archives.listRecentMessages(channelId, limit);
  return rows.map(normalizeArchivedMessage).reverse();
}

function getRecentArchivedMessagesByAuthor(client, { guildId, authorId, limit = 30 }) {
  const rows = client.db.archives.listRecentMessagesByAuthor(guildId, authorId, limit);
  return rows.map(normalizeArchivedMessage).reverse();
}

function getThreadStarterArchivedMessage(client, { channelId }) {
  const row = client.db.archives.getThreadStarterMessage(channelId);
  return row ? normalizeArchivedMessage(row) : null;
}

module.exports = {
  getRecentArchivedMessages,
  getRecentArchivedMessagesByAuthor,
  getThreadStarterArchivedMessage,
  normalizeArchivedMessage
};
