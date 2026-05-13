const { handleWelcomeReactionSetupRemoval } = require('../modules/welcomeReactions');

module.exports = {
  async execute(reaction, user) {
    const client = reaction.message?.client;

    try {
      await handleWelcomeReactionSetupRemoval(reaction, user);
    } catch (error) {
      client?.logger?.error?.('Failed to handle messageReactionRemove', {
        messageId: reaction.message?.id || null,
        channelId: reaction.message?.channelId || null,
        userId: user?.id || null,
        error: error.message
      });
    }
  }
};
