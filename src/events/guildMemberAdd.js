const { upsertGuildMember } = require('../modules/guildMembers');
const { enqueueWelcomeJoinDm } = require('../modules/introDm');

module.exports = {
  async execute(member) {
    const client = member.client;
    try {
      upsertGuildMember(client, member);
      await enqueueWelcomeJoinDm(client, member);
    } catch (error) {
      client.logger.error('Failed to handle guildMemberAdd', {
        guildId: member.guild?.id || null,
        userId: member.id,
        error: error.message
      });
    }
  }
};
