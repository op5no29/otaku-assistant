const {
  initializeVoiceProfileMappings,
  rebuildVoiceProfileState,
  startVoiceProfileReconciliation
} = require('../modules/vcProfile');
const pkg = require('../../package.json');
const { getBotHealth } = require('../modules/ops/health');
const { notifyOpsChannel } = require('../modules/ops/notify');
const { startIntroDmQueueProcessor } = require('../modules/introDm');
const { runAnimeOrphanScan } = require('../modules/anime');
const { getAnnictAccessToken } = require('../modules/anime/annictClient');
const { startQuestionRolePromptTimeouts } = require('../modules/timelineRelay');
const { backfillIntroAddendums } = require('../modules/introProfiles');
const { reconcileVoiceSessions, startVoiceSessionReconciliation } = require('../modules/vcSessionSummary');

module.exports = {
  async execute(client) {
    client.db.deletableMessages.deleteExpired();
    await initializeVoiceProfileMappings(client);
    await backfillIntroAddendums(client, process.env.GUILD_ID).catch((error) => {
      client.logger.error('intro addendum backfill failed', {
        guildId: process.env.GUILD_ID,
        error: error.message
      });
    });
    await rebuildVoiceProfileState(client, { reason: 'ready_resync' });
    await reconcileVoiceSessions(client, { reason: 'ready_resync' }).catch((error) => {
      client.logger.error('vc session ready reconciliation failed', {
        error: error.message
      });
    });
    startVoiceProfileReconciliation(client);
    startVoiceSessionReconciliation(client);
    startQuestionRolePromptTimeouts(client);

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
          alsoTimeline: route.alsoTimeline === true,
          relayUserPostToDestination: route.relayUserPostToDestination !== false
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

    client.logger.info('anime config loaded', {
      enabled: client.appConfig.anime.enabled,
      provider: client.appConfig.anime.provider,
      channelId: client.appConfig.anime.channelId,
      autoPostOnCastLookup: client.appConfig.anime.autoPostOnCastLookup,
      interestEmoji: client.appConfig.anime.interestEmoji,
      watchedEmoji: client.appConfig.anime.watchedEmoji
    });

    if (client.appConfig.anime.provider === 'annict' && !getAnnictAccessToken(client)) {
      client.logger.warn('annict token missing', {
        provider: client.appConfig.anime.provider,
        accessTokenEnv: client.appConfig.annict.accessTokenEnv
      });
    }

    await runAnimeOrphanScan(client).catch((error) => {
      client.logger.error('anime orphan scan failed', {
        error: error.message
      });
    });

    startIntroDmQueueProcessor(client);

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
