module.exports = {
  async execute(message) {
    const client = message.client;
    const messageId = message?.id;
    if (!client || !messageId) {
      return;
    }

    try {
      client.db.archives.deleteMessage(messageId);
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
      const { handleIntroProfileMessageDeleted } = require('../modules/introProfiles');
      await handleIntroProfileMessageDeleted(client, message);
    } catch (error) {
      client.logger.error('intro profile delete sync failed', {
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

    try {
      const { cleanupRelayedBotMessageState } = require('../modules/timelineRelay/relayDeletionCleanup');
      const reactionDeleteSet = client.posthocRelayReactionDeletes;
      const reason = reactionDeleteSet?.has?.(messageId) ? 'reaction_delete' : 'message_delete';
      await cleanupRelayedBotMessageState(client, {
        messageId,
        guildId: message.guildId || null,
        channelId: message.channelId || null,
        reason,
        logNoState: String(message.author?.id || '') === String(client.user?.id || '')
      });
    } catch (error) {
      client.logger.error('relayed bot message DB cleanup failed', {
        messageId,
        channelId: message.channelId || null,
        error: error.message
      });
    }

    try {
      client.db.deletableMessages.delete(messageId);
    } catch (error) {
      client.logger.error('delete deletable message reference failed', {
        messageId,
        error: error.message
      });
    }

    try {
      const { handleAnimeParentMessageDeleted } = require('../modules/anime');
      await handleAnimeParentMessageDeleted(client, message);
    } catch (error) {
      client.logger.error('anime parent delete cleanup failed', {
        messageId,
        channelId: message.channelId || null,
        error: error.message
      });
    }
  }
};
