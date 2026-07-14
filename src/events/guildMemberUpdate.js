const { upsertGuildMember } = require('../modules/guildMembers');

module.exports = {
  async execute(oldMember, newMember) {
    try {
      upsertGuildMember(newMember.client, newMember, { eventType: 'member_identity_update' });
    } catch (error) {
      newMember.client.logger.error('Failed to retain guild member identity update', {
        guildId: newMember.guild?.id || null,
        userId: newMember.id,
        error: error.message
      });
    }
  }
};
