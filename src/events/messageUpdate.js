const { updateTweetTimelineCard, handleRouteAddedOnMessageUpdate } = require('../modules/timelineRelay');
const { saveMessageToArchive } = require('../modules/messageArchive');
const { saveIntroProfileFromMessage } = require('../modules/introProfiles');
const { handleAnnictPreviewMessageUpdate } = require('../modules/annictUserIntegration');
const { captureTimelineMessageSnapshot, handleRestorationMessageCreate } = require('../modules/timelineRestoration');

module.exports = {
  async execute(oldMessage, newMessage) {
    const client = newMessage.client;

    const resolvedForGuard = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!resolvedForGuard) return;
    try {
      if (await handleRestorationMessageCreate(resolvedForGuard)) return;
    } catch (error) {
      client.logger.error('Restoration thread update guard failed', {
        messageId: newMessage.id,
        channelId: newMessage.channelId,
        errorCode: error.code || 'guard_failed'
      });
      return;
    }

    try {
      await captureTimelineMessageSnapshot(client, resolvedForGuard, { snapshotSource: 'source_message_edit' });
      await saveMessageToArchive(client, resolvedForGuard);
      await saveIntroProfileFromMessage(client, resolvedForGuard);
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

    try {
      await handleRouteAddedOnMessageUpdate(oldMessage, newMessage, {
        config: client.appConfig,
        db: client.db,
        logger: client.logger
      });
    } catch (error) {
      client.logger.error('Failed to handle messageUpdate route-added relay', {
        messageId: newMessage.id,
        channelId: newMessage.channelId,
        error: error.message
      });
    }

    try {
      await handleAnnictPreviewMessageUpdate(oldMessage, newMessage);
    } catch (error) {
      client.logger.error('Failed to handle Annict intro preview update', {
        messageId: newMessage.id,
        channelId: newMessage.channelId,
        error: error.message
      });
    }
  }
};
