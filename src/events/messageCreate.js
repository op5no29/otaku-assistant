const { relayTweetMessage } = require('../modules/timelineRelay');

module.exports = {
  async execute(message) {
    const client = message.client;

    if (!message.inGuild() || !message.channel?.isThread?.()) {
      return;
    }

    client.logger.info('messageCreate received in thread', {
      messageId: message.id,
      channelId: message.channelId,
      parentId: String(message.channel.parentId || ''),
      authorId: message.author?.id || null
    });

    try {
      await relayTweetMessage(message, {
        config: client.appConfig,
        db: client.db,
        logger: client.logger
      });
    } catch (error) {
      client.logger.error('Failed to handle messageCreate', {
        messageId: message.id,
        channelId: message.channelId,
        parentId: String(message.channel.parentId || ''),
        error: error.message
      });
    }
  }
};
