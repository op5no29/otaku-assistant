const { updateTweetTimelineCard } = require('../modules/timelineRelay');
const { saveMessageToArchive } = require('../modules/messageArchive');
const { saveIntroProfileFromMessage } = require('../modules/introProfiles');

module.exports = {
  async execute(oldMessage, newMessage) {
    const client = newMessage.client;

    try {
      const resolvedMessage = newMessage.partial ? await newMessage.fetch() : newMessage;
      await saveMessageToArchive(client, resolvedMessage);
      await saveIntroProfileFromMessage(client, resolvedMessage);
    } catch (error) {
      client.logger.error('Archive update failed', {
        messageId: newMessage.id,
        channelId: newMessage.channelId,
        error: error.message
      });
    }

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
