const { upsertGuildMember } = require('../modules/guildMembers');
const { enqueueWelcomeJoinDm } = require('../modules/introDm');
const { handleReturningMember } = require('../modules/timelineRestoration');

module.exports = {
  async execute(member) {
    const client = member.client;
    try {
      const previous = client.db.guildMembers.get(member.guild.id, member.id);
      const record = upsertGuildMember(client, member, { eventType: previous?.leftAt ? 'member_return' : 'member_join' });
      const result = await handleReturningMember(client, member, previous, {
        episodeId: record.membershipEpisodeId
      });
      if (!result.returning) {
        await enqueueWelcomeJoinDm(client, member);
      }
    } catch (error) {
      client.logger.error('Failed to handle guildMemberAdd', {
        guildId: member.guild?.id || null,
        userId: member.id,
        error: error.message
      });
    }
  }
};
