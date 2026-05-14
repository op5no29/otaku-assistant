const { initializeVoiceProfileMappings, rebuildVoiceProfileState } = require('../modules/vcProfile');
const pkg = require('../../package.json');
const { getBotHealth } = require('../modules/ops/health');
const { notifyOpsChannel } = require('../modules/ops/notify');

module.exports = {
  async execute(client) {
    await initializeVoiceProfileMappings(client);
    await rebuildVoiceProfileState(client);

    const health = getBotHealth(client);
    const globalHashtagRoutes = Object.entries(client.appConfig.globalHashtagRoutes || {});

    client.logger.info('Bot ready', {
      botTag: client.user?.tag,
      guildId: process.env.GUILD_ID,
      voiceProfileCategoryCount: client.voiceProfileCategoryMap.size
    });

    if (globalHashtagRoutes.length > 0) {
      client.logger.info('globalHashtagRoutes loaded', {
        count: globalHashtagRoutes.length,
        routes: globalHashtagRoutes.map(([routeKey, route]) => ({
          routeKey,
          tags: route.tags || [],
          destinationChannelId: route.channelId || '',
          displayMode: route.displayMode || 'displayTag',
          alsoTimeline: route.alsoTimeline === true
        }))
      });
    } else {
      client.logger.warn('globalHashtagRoutes missing; ##技術 routing disabled', {
        count: 0
      });
    }

    client.logger.info('timeline short merge config loaded', {
      enabled: client.appConfig.timeline.shortMergeEnabled,
      maxChars: client.appConfig.timeline.shortMergeMaxChars,
      windowSeconds: client.appConfig.timeline.shortMergeWindowSeconds,
      maxParts: client.appConfig.timeline.shortMergeMaxParts
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
