module.exports = {
  async execute(messages) {
    const firstMessage = messages?.first?.() || null;
    const client = firstMessage?.client;
    if (!client || !messages?.size) {
      return;
    }

    const messageIds = Array.from(messages.keys());

    try {
      client.db.archives.deleteMessages(messageIds);
      for (const messageId of messageIds) {
        client.db.introProfiles.deleteByMessageId(messageId);
      }
      client.logger.info('Message archive bulk deleted', {
        count: messageIds.length
      });
    } catch (error) {
      client.logger.error('delete archive failed', {
        count: messageIds.length,
        error: error.message
      });
    }

    try {
      client.db.llmResponses.deleteByMessageIds(messageIds);
      client.logger.info('LLM response reference bulk deleted', {
        count: messageIds.length
      });
    } catch (error) {
      client.logger.error('delete llm response reference failed', {
        count: messageIds.length,
        error: error.message
      });
    }
  }
};
