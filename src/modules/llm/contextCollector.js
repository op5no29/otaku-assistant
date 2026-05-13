const { getRecentArchivedMessages } = require('../messageArchive');

function summarizeAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return '';
  }

  const items = attachments
    .slice(0, 4)
    .map((attachment) => {
      const fileName = attachment.title || attachment.filename || attachment.name || 'attachment';
      return attachment.url ? `${fileName} (${attachment.url})` : fileName;
    });

  return `添付: ${items.join(', ')}`;
}

function formatContextMessage(message) {
  const timestamp = message.createdAt ? new Date(message.createdAt).toLocaleString('ja-JP', { hour12: false }) : 'unknown';
  const author = message.authorName || message.authorId || '不明';
  const content = String(message.content || message.cleanContent || '').trim();
  const attachmentSummary = summarizeAttachments(message.attachments);
  const parts = [`[${timestamp}] ${author}:`];

  if (content) {
    parts.push(content);
  }

  if (attachmentSummary) {
    parts.push(attachmentSummary);
  }

  return parts.join(' ');
}

function collectContextForMessage(client, message) {
  const channelId = message.channelId;
  const limit = Number(client.appConfig.llm.contextMessageLimit || 50);
  const recentMessages = getRecentArchivedMessages(client, {
    channelId,
    limit
  });

  client.logger.info('LLM context collected', {
    sourceMessageId: message.id,
    channelId,
    contextCount: recentMessages.length
  });

  return {
    channelId,
    messages: recentMessages,
    formattedMessages: recentMessages.map(formatContextMessage)
  };
}

module.exports = {
  collectContextForMessage
};
