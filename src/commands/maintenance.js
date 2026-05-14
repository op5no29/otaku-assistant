const { SlashCommandBuilder } = require('discord.js');
const { isAdministrator } = require('../utils/permissions');
const { initializeVoiceProfileMappings, rebuildVoiceProfileState } = require('../modules/vcProfile');
const { postEntranceGuide } = require('../modules/entranceGuide');
const { backfillQuestionTags } = require('../modules/questionResolver/backfillQuestionTags');
const { applyQuestionStatusTag } = require('../modules/questionResolver/threadTags');
const { getBotHealth } = require('../modules/ops/health');
const { notifyOpsChannel } = require('../modules/ops/notify');
const { getUserMemories, deleteAllUserMemories } = require('../modules/userMemory');

function buildStatusLines(interaction) {
  const { client } = interaction;
  const { appConfig } = client;
  const health = getBotHealth(client);
  const musicRouteEnabled = Object.values(appConfig.botHashtagRoutes || {}).some(
    (route) => route.channelId && route.aliases.includes('良い音楽')
  );

  return [
    `Bot: ${health.ready ? 'online' : 'offline'}`,
    `Uptime: ${health.uptime}`,
    `PID: ${health.pid}`,
    `Node.js: ${health.nodeVersion}`,
    `Platform: ${health.platform}`,
    `Memory: RSS ${health.memoryRss} / Heap ${health.memoryHeapUsed}`,
    `Guild ID: ${health.guildId || 'unknown'}${health.guildAvailable ? '' : ' (cache unavailable)'}`,
    `WS Ping: ${health.wsPing === null ? 'unknown' : `${health.wsPing} ms`}`,
    `VCプロフィールカテゴリ数: ${health.voiceProfileCategoryCount}`,
    '有効機能:',
    `- timeline relay: ${appConfig.timelineChannelId && appConfig.watchedForums.tweet.length > 0 ? 'enabled' : 'disabled'}`,
    `- question relay: ${appConfig.watchedForums.question.length > 0 ? 'enabled' : 'disabled'}`,
    `- VC profiles: ${appConfig.voiceProfileChannels.length > 0 ? 'enabled' : 'disabled'}`,
    `- media relay: ${appConfig.mediaRelay.maxReuploadBytes > 0 ? 'enabled' : 'disabled'}`,
    `- Odesli/music: ${musicRouteEnabled ? 'enabled' : 'disabled'}`,
    `- welcome auto-reactions: ${appConfig.welcomeChannelId ? 'enabled' : 'disabled'}`,
    `- local LLM: ${appConfig.llm.enabled ? 'enabled' : 'disabled'}`,
    '設定:',
    `- timeline channel: ${appConfig.timelineChannelId || 'not set'}`,
    `- tweet forum: ${appConfig.watchedForums.tweet[0] || 'not set'}`,
    `- question forums: ${appConfig.watchedForums.question.length}`,
    `- ops log channel: ${appConfig.ops.logChannelId || 'console only'}`,
    `- welcome channel: ${appConfig.welcomeChannelId || 'not set'}`
  ];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('maintenance')
    .setDescription('管理用の保守コマンドです。')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Bot の基本状態を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('llm-status')
        .setDescription('Ollama LLM の状態とアーカイブ件数を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('hashtag-route-status')
        .setDescription('グローバル ## ルート設定の読込状態を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('user-memory-status')
        .setDescription('ユーザーLLMメモリーの保存状況を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('user-memory-show')
        .setDescription('指定ユーザーのLLMメモリーを表示します。')
        .addStringOption((option) =>
          option
            .setName('user_id')
            .setDescription('対象ユーザーのID')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('user-memory-clear')
        .setDescription('指定ユーザーのLLMメモリーを全削除します。')
        .addStringOption((option) =>
          option
            .setName('user_id')
            .setDescription('対象ユーザーのID')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-question-tags')
        .setDescription('既存質問の受付中/解決済みタグを補完します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('resync-vc-profiles')
        .setDescription('現在のVCプロフィール表示を再構築します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('post-entrance-guide')
        .setDescription('案内チャンネルに公式ガイドを投稿または更新します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reload-config')
        .setDescription('設定再読み込み可否を確認します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('portal')
        .setDescription('Discord Developer Portal のリンクを表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('restart')
        .setDescription('Bot を終了し、プロセスマネージャに再起動させます。')
    ),

  async execute(interaction) {
    if (!isAdministrator(interaction.member)) {
      await interaction.reply({
        content: 'このコマンドは管理者のみ使用できます。',
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    const { appConfig, logger } = interaction.client;

    if (subcommand === 'status') {
      await interaction.reply({
        content: buildStatusLines(interaction).join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'llm-status') {
      const llmConfig = interaction.client.appConfig.llm;
      await interaction.reply({
        content: [
          `llmEnabled: ${llmConfig.enabled}`,
          `ollamaBaseUrl: ${llmConfig.baseUrl}`,
          `model: ${llmConfig.model}`,
          `activeRequestCount: ${interaction.client.activeLlmUsers.size}`,
          `globalBusy: ${interaction.client.llmGlobalRequestActive}`,
          `archivedMessageCount: ${interaction.client.db.archives.countMessages()}`,
          `llmResponseCount: ${interaction.client.db.llmResponses.count()}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'hashtag-route-status') {
      const routes = Object.entries(appConfig.globalHashtagRoutes || {});
      await interaction.reply({
        content: [
          `timelineChannelId: ${appConfig.timelineChannelId || 'not set'}`,
          `globalHashtagRoutes count: ${routes.length}`,
          ...(routes.length
            ? routes.map(
                ([routeKey, route]) =>
                  `- ${routeKey}: tags=[${(route.tags || []).join(', ')}], destination=${route.channelId || 'not set'}, displayMode=${route.displayMode || 'displayTag'}, alsoTimeline=${route.alsoTimeline === true}`
              )
            : ['- no global hashtag routes loaded'])
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'user-memory-status') {
      const total = interaction.client.db.userMemories.countAll(interaction.guildId);
      await interaction.reply({
        content: [
          'ユーザーLLMメモリーの状態:',
          `総メモリー件数（このサーバー）: ${total}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'user-memory-show') {
      const targetUserId = interaction.options.getString('user_id', true);
      const memories = getUserMemories(interaction.client, interaction.guildId, targetUserId);
      await interaction.reply({
        content: memories.length
          ? [
              `ユーザー ${targetUserId} のメモリー (${memories.length}件):`,
              ...memories.map((m) => `- [${m.memoryKey}] ${m.memoryText} (source: ${m.source})`)
            ].join('\n')
          : `ユーザー ${targetUserId} のメモリーはありません。`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'user-memory-clear') {
      const targetUserId = interaction.options.getString('user_id', true);
      const countBefore = interaction.client.db.userMemories.countByUser(interaction.guildId, targetUserId);
      deleteAllUserMemories(interaction.client, interaction.guildId, targetUserId);
      await interaction.reply({
        content: `ユーザー ${targetUserId} のメモリーを全削除しました。削除件数: ${countBefore}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'portal') {
      await interaction.reply({
        content: appConfig.ops.developerPortalUrl
          ? `Discord Developer Portal:\n${appConfig.ops.developerPortalUrl}`
          : 'Developer Portal URL が設定されていません。',
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'restart') {
      if (!appConfig.ops.allowRestartCommand) {
        await interaction.reply({
          content: '再起動コマンドは無効化されています。',
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        content: '再起動します。',
        ephemeral: true
      });

      await notifyOpsChannel(interaction.client, [
        '⚠️ Otaku Assistant restart requested',
        `- Requested by: ${interaction.user.tag} (${interaction.user.id})`,
        `- Guild: ${interaction.guildId || 'unknown'}`
      ].join('\n'));

      setTimeout(() => {
        process.exit(0);
      }, 1500).unref();
      return;
    }

    if (subcommand === 'reload-config') {
      await interaction.reply({
        content: '設定の再読み込みにはBotの再起動が必要です。',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (subcommand === 'backfill-question-tags') {
      const summary = await backfillQuestionTags({
        client: interaction.client,
        guildId: interaction.guildId,
        config: appConfig,
        logger,
        applyQuestionStatusTag
      });

      await interaction.editReply({
        content: [
          '質問タグの補完を実行しました。',
          `対象フォーラム数: ${summary.scannedForums}`,
          `対象スレッド数: ${summary.scannedThreads}`,
          `更新数: ${summary.updatedThreads}`,
          `失敗数: ${summary.failedThreads}`
        ].join('\n')
      });
      return;
    }

    if (subcommand === 'resync-vc-profiles') {
      await initializeVoiceProfileMappings(interaction.client);
      await rebuildVoiceProfileState(interaction.client);

      await interaction.editReply({
        content: 'VCプロフィール表示を再構築しました。'
      });
      return;
    }

    if (subcommand === 'post-entrance-guide') {
      let results;

      try {
        results = await postEntranceGuide({
          client: interaction.client,
          logger
        });
      } catch (error) {
        await interaction.editReply({
          content: `案内ガイドの投稿に失敗しました。\n${error.message}`
        });
        return;
      }

      await interaction.editReply({
        content: [
          '案内ガイドを投稿または更新しました。',
          ...results.map((entry) => `- ${entry.title}: ${entry.url}`)
        ].join('\n')
      });
    }
  }
};
