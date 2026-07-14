const { markGuildMemberLeft } = require('../modules/guildMembers');
const { scheduleDepartedMemberPreservation } = require('../modules/timelineRestoration');

module.exports = {
  async execute(member) {
    const client = member.client;
    try {
      markGuildMemberLeft(client, member);
      client.db.timelineRestoration.userThreads.markOwnerLeft(member.guild.id, member.id, new Date().toISOString());
      scheduleDepartedMemberPreservation(client, member.guild.id, member.id);
    } catch (error) {
      client.logger.error('Failed to handle guildMemberRemove', {
        guildId: member.guild?.id || null,
        userId: member.id,
        error: error.message
      });
    }
  }
};
