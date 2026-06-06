const { handleVoiceStateUpdate } = require('../modules/vcProfile');
const { handleVoiceSessionStateUpdate } = require('../modules/vcSessionSummary');
const { updateGuildMemberVcJoined, upsertGuildMember } = require('../modules/guildMembers');
const { maybeSendVcNoIntroDm } = require('../modules/introDm');

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

    try {
      await handleVoiceSessionStateUpdate(oldState, newState);
    } catch (error) {
      newState.client.logger.error('Failed to handle VC session summary state', {
        userId: newState.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        error: error.message
      });
    }

    const member = newState.member || oldState.member || null;
    if (!member?.guild || !newState.channelId || oldState.channelId) {
      return;
    }

    try {
      upsertGuildMember(newState.client, member);
      updateGuildMemberVcJoined(newState.client, member, new Date());
      await maybeSendVcNoIntroDm(newState.client, member, {
        channelId: newState.channelId,
        voiceChannel: newState.channel || null
      });
    } catch (error) {
      newState.client.logger.error('Failed to handle VC intro detection', {
        guildId: member.guild?.id || null,
        userId: member.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        error: error.message
      });
    }
  }
};
