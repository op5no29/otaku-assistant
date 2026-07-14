const { handleVoiceStateUpdate } = require('../modules/vcProfile');
const { handleVoiceSessionStateUpdate } = require('../modules/vcSessionSummary');
const { handleVoiceWorkTimeStateUpdate } = require('../modules/voiceWorkTime');
const { updateGuildMemberVcJoined, upsertGuildMember } = require('../modules/guildMembers');
const { maybeSendVcNoIntroDm } = require('../modules/introDm');
const { handleVoiceActivityWindowStateUpdate } = require('../modules/vcActivityWindows');

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

    try {
      await handleVoiceActivityWindowStateUpdate(oldState, newState);
    } catch (error) {
      newState.client.logger.error('Failed to handle VC activity window state', {
        userId: newState.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        error: error.message
      });
    }

    try {
      await handleVoiceWorkTimeStateUpdate(oldState, newState);
    } catch (error) {
      newState.client.logger.error('Failed to handle work VC time state', {
        userId: newState.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        error: error.message
      });
    }

    const member = newState.member || oldState.member || null;
    if (member?.guild && oldState.channelId && !newState.channelId) {
      newState.client.db.introVcReminder?.recordDisconnect?.({
        guildId: member.guild.id,
        userId: member.id,
        leftAt: new Date().toISOString()
      });
    }
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
