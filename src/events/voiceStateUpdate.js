const { handleVoiceStateUpdate } = require('../modules/vcProfile');

module.exports = {
  async execute(oldState, newState) {
    try {
      await handleVoiceStateUpdate(oldState, newState);
    } catch (error) {
      newState.client.logger.error('Failed to handle voiceStateUpdate', {
        userId: newState.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        error: error.message
      });
    }
  }
};
