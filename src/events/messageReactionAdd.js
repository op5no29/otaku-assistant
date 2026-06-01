const { handleWelcomeReactionSetup } = require('../modules/welcomeReactions');
const { handleIntroReactionSetup } = require('../modules/introReactions');
const { handleAnimeReactionAdd } = require('../modules/anime');
const { handleDeletableMessageReaction } = require('../modules/deletableMessages');
const { handleRolePanelReactionAdd } = require('../modules/rolePanel');

module.exports = {
  async execute(reaction, user) {
    const client = reaction.message?.client;

    try {
      const handledDeletion = await handleDeletableMessageReaction(reaction, user);
      if (handledDeletion) {
        return;
      }
    } catch (error) {
      client?.logger?.error?.('Failed to handle deletable message reaction', {
        messageId: reaction.message?.id || null,
        channelId: reaction.message?.channelId || null,
        userId: user?.id || null,
        error: error.message
      });
    }

    try {
      const handledRolePanel = await handleRolePanelReactionAdd(reaction, user);
      if (handledRolePanel) {
        return;
      }
    } catch (error) {
      client?.logger?.error?.('Failed to handle role panel reaction add', {
        messageId: reaction.message?.id || null,
        channelId: reaction.message?.channelId || null,
        userId: user?.id || null,
        error: error.message
      });
    }

    try {
      await handleWelcomeReactionSetup(reaction, user);
    } catch (error) {
      client?.logger?.error?.('Failed to handle messageReactionAdd', {
        messageId: reaction.message?.id || null,
        channelId: reaction.message?.channelId || null,
        userId: user?.id || null,
        error: error.message
      });
    }

    try {
      await handleIntroReactionSetup(reaction, user);
    } catch (error) {
      client?.logger?.error?.('Failed to handle intro messageReactionAdd', {
        messageId: reaction.message?.id || null,
        channelId: reaction.message?.channelId || null,
        userId: user?.id || null,
        error: error.message
      });
    }

    try {
      await handleAnimeReactionAdd(reaction, user);
    } catch (error) {
      client?.logger?.error?.('Failed to handle anime messageReactionAdd', {
        messageId: reaction.message?.id || null,
        channelId: reaction.message?.channelId || null,
        userId: user?.id || null,
        error: error.message
      });
    }
  }
};
