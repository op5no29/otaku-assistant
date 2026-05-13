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

module.exports = {
  getRecentArchivedMessages,
  normalizeArchivedMessage
};
