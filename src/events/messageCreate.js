const { relayTweetMessage, relayGlobalHashtagMessage } = require('../modules/timelineRelay');
const { applyWelcomeReactionsToMessage } = require('../modules/welcomeReactions');
const { saveMessageToArchive } = require('../modules/messageArchive');
const { handleLlmMessage } = require('../modules/llm');
const { handleIntroDmMessage } = require('../modules/introDm');
const { saveIntroProfileFromMessage } = require('../modules/introProfiles');

module.exports = {
  async execute(message) {
    const client = message.client;

    try {
      const handledIntroDm = await handleIntroDmMessage(message);
      if (handledIntroDm) {
        return;
      }
    } catch (error) {
      client.logger.error('Failed to handle intro DM message', {
        messageId: message.id,
        channelId: message.channelId,
        error: error.message
      });
    }

    try {
      await saveMessageToArchive(client, message);
    } catch (error) {
      client.logger.error('Archive save failed', {
        messageId: message.id,
        channelId: message.channelId,
        error: error.message
      });
    }

    try {
      await saveIntroProfileFromMessage(client, message);
    } catch (error) {
      client.logger.error('Intro profile save failed', {
        messageId: message.id,
        channelId: message.channelId,
        error: error.message
      });
    }

    try {
      await applyWelcomeReactionsToMessage(message);
    } catch (error) {
      client.logger.error('Failed to apply welcome reactions', {
        messageId: message.id,
        channelId: message.channelId,
        error: error.message
      });
    }

    try {
      await handleLlmMessage(message);
    } catch (error) {
      client.logger.error('Failed to handle LLM message trigger', {
        messageId: message.id,
        channelId: message.channelId,
        error: error.message
      });
    }

    if (message.inGuild() && message.channel?.isThread?.()) {
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
        client.logger.error('Failed to handle messageCreate tweet relay', {
          messageId: message.id,
          channelId: message.channelId,
          parentId: String(message.channel.parentId || ''),
          error: error.message
        });
      }
    }

    try {
      await relayGlobalHashtagMessage(message, {
        config: client.appConfig,
        db: client.db,
        logger: client.logger
      });
    } catch (error) {
      client.logger.error('Failed to handle global hashtag relay', {
        messageId: message.id,
        channelId: message.channelId,
        error: error.message
      });
    }
  }
};
