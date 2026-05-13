module.exports = {
  async execute(message) {
    const client = message.client;
    const messageId = message?.id;
    if (!client || !messageId) {
      return;
    }

    try {
      client.db.archives.deleteMessage(messageId);
      client.db.introProfiles.deleteByMessageId(messageId);
      client.logger.info('Message archive deleted', {
        messageId,
        channelId: message.channelId || null
      });
    } catch (error) {
      client.logger.error('delete archive failed', {
        messageId,
        channelId: message.channelId || null,
        error: error.message
      });
    }

    try {
      client.db.llmResponses.deleteByMessageId(messageId);
      client.logger.info('LLM response reference deleted', {
        messageId
      });
    } catch (error) {
      client.logger.error('delete llm response reference failed', {
        messageId,
        error: error.message
      });
    }
  }
};
