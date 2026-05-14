const { upsertGuildMember } = require('../modules/guildMembers');

module.exports = {
  async execute(member) {
    const client = member.client;
    try {
      upsertGuildMember(client, member);
    } catch (error) {
      client.logger.error('Failed to handle guildMemberAdd', {
        guildId: member.guild?.id || null,
        userId: member.id,
        error: error.message
      });
    }
  }
};
