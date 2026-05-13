const { initializeVoiceProfileMappings, rebuildVoiceProfileState } = require('../modules/vcProfile');
const pkg = require('../../package.json');
const { getBotHealth } = require('../modules/ops/health');
const { notifyOpsChannel } = require('../modules/ops/notify');

module.exports = {
  async execute(client) {
    await initializeVoiceProfileMappings(client);
    await rebuildVoiceProfileState(client);

    const health = getBotHealth(client);

    client.logger.info('Bot ready', {
      botTag: client.user?.tag,
      guildId: process.env.GUILD_ID,
      voiceProfileCategoryCount: client.voiceProfileCategoryMap.size
    });

    await notifyOpsChannel(client, [
      '✅ Otaku Assistant started / ready',
      `- Version: ${pkg.version}`,
      `- Node: ${health.nodeVersion}`,
      `- Uptime: ${health.uptime}`,
      `- Guild: ${health.guildId || 'unknown'}`,
      `- Timeline relay: ${client.appConfig.timelineChannelId ? 'enabled' : 'disabled'}`,
      `- Question relay: ${client.appConfig.watchedForums.question.length > 0 ? 'enabled' : 'disabled'}`,
      `- Media relay: ${client.appConfig.mediaRelay.maxReuploadBytes > 0 ? 'enabled' : 'disabled'}`,
      `- Odesli/music: ${Object.keys(client.appConfig.botHashtagRoutes || {}).length > 0 ? 'enabled' : 'disabled'}`,
      `- VC profile categories: ${health.voiceProfileCategoryCount}`
    ].join('\n'));
  }
};
