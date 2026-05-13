const { updateTweetTimelineCard } = require('../modules/timelineRelay');

module.exports = {
  async execute(oldMessage, newMessage) {
    const client = newMessage.client;

    try {
      await updateTweetTimelineCard(oldMessage, newMessage, {
        config: client.appConfig,
        db: client.db,
        logger: client.logger
      });
    } catch (error) {
      client.logger.error('Failed to handle messageUpdate', {
        messageId: newMessage.id,
        channelId: newMessage.channelId,
        parentId: String(newMessage.channel?.parentId || ''),
        error: error.message
      });
    }
  }
};
