const { SlashCommandBuilder } = require('discord.js');
const { isAdministrator } = require('../utils/permissions');
const { initializeVoiceProfileMappings, rebuildVoiceProfileState } = require('../modules/vcProfile');
const { postEntranceGuide } = require('../modules/entranceGuide');
const { backfillQuestionTags } = require('../modules/questionResolver/backfillQuestionTags');
const { applyQuestionStatusTag } = require('../modules/questionResolver/threadTags');
const { getBotHealth } = require('../modules/ops/health');
const { notifyOpsChannel } = require('../modules/ops/notify');
const { sendIntroDm, getIntroDmStatus, PROMPT_TYPES } = require('../modules/introDm');
const {
  backfillIntroProfiles,
  getIntroProfileStatus,
  getMembersWithoutIntroOlderThan
} = require('../modules/introProfiles');
const {
  createWelcomeReactionSetup,
  listWelcomeReactions,
  clearWelcomeReactions,
  backfillWelcomeReactions,
  formatSavedEmoji
} = require('../modules/welcomeReactions');

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
        .setName('status')
        .setDescription('Bot の基本状態を表示します。')
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
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup-welcome-reactions')
        .setDescription('Welcome通知用リアクションの保存対象メッセージを作成します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear-welcome-reactions')
        .setDescription('保存済みのWelcome通知リアクションを全削除します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list-welcome-reactions')
        .setDescription('保存済みのWelcome通知リアクションを表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-welcome-reactions')
        .setDescription('既存のWelcome参加通知へ保存済みリアクションを付与します。')
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('確認する直近メッセージ数（1-500）')
            .setMinValue(1)
            .setMaxValue(500)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('llm-status')
        .setDescription('Ollama LLM の状態とアーカイブ件数を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('intro-dm-test')
        .setDescription('開発者限定の自己紹介DMテストを送信します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('intro-dm-status')
        .setDescription('intro DM テスト設定と保存状態を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('intro-dm-test-join48h')
        .setDescription('開発者限定の48時間経過自己紹介DMテストを送信します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-intro-profiles')
        .setDescription('自己紹介チャンネルを走査してプロフィールDBを補完します。')
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('確認する直近メッセージ数（1-1000）')
            .setMinValue(1)
            .setMaxValue(1000)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('intro-profile-status')
        .setDescription('自己紹介プロフィールDBの状態を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('intro-dm-scan-dry-run')
        .setDescription('自己紹介なしメンバー候補をDM送信せずに確認します。')
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

    if (subcommand === 'intro-dm-status') {
      const status = getIntroDmStatus(interaction.client);
      const promptCounts = interaction.client.db.introDm.countStatesByPromptType();
      await interaction.reply({
        content: [
          `introDmEnabled: ${status.enabled}`,
          `introDmDevTestMode: ${status.devTestMode}`,
          `introDmDevUserId: ${status.devUserId}`,
          `introDmStateCount: ${status.stateCount}`,
          `vc_no_intro count: ${promptCounts.find((entry) => entry.promptType === PROMPT_TYPES.VC_NO_INTRO)?.count || 0}`,
          `join_48h_no_intro count: ${promptCounts.find((entry) => entry.promptType === PROMPT_TYPES.JOIN_NO_INTRO)?.count || 0}`,
          `opt_out count: ${interaction.client.db.introDm.countOptOutStates()}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'intro-dm-test') {
      const targetUserId = interaction.client.appConfig.introDm.devUserId;
      const result = await sendIntroDm(interaction.client, {
        userId: targetUserId,
        promptType: PROMPT_TYPES.VC_NO_INTRO
      });

      await interaction.reply({
        content: result.ok
          ? `intro DM テストを送信しました。\n対象ユーザー: ${targetUserId}`
          : `intro DM テストを送信できませんでした。\n理由: ${result.skippedReason || result.error?.message || 'unknown'}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'intro-dm-test-join48h') {
      const targetUserId = interaction.client.appConfig.introDm.devUserId;
      const result = await sendIntroDm(interaction.client, {
        userId: targetUserId,
        promptType: PROMPT_TYPES.JOIN_NO_INTRO
      });

      await interaction.reply({
        content: result.ok
          ? `join48h intro DM テストを送信しました。\n対象ユーザー: ${targetUserId}`
          : `join48h intro DM テストを送信できませんでした。\n理由: ${result.skippedReason || result.error?.message || 'unknown'}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'intro-profile-status') {
      const status = getIntroProfileStatus(interaction.client, interaction.guildId);
      await interaction.reply({
        content: [
          `introChannelId: ${status.introChannelId || 'not set'}`,
          `savedProfileCount: ${status.savedProfileCount}`,
          `latestArchivedProfileDate: ${status.latestArchivedProfileDate || 'none'}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'intro-dm-scan-dry-run') {
      const members = await getMembersWithoutIntroOlderThan(interaction.guild, interaction.client.appConfig.introDm.joinReminderHours, interaction.client);
      await interaction.reply({
        content: [
          'intro DM scan dry-run を実行しました。',
          `候補数: ${members.length}`,
          ...members.slice(0, 20).map((member) => `- ${member.displayName || member.user?.username || member.id} (${member.id})`)
        ].join('\n'),
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

    if (subcommand === 'setup-welcome-reactions') {
      const setupMessage = await createWelcomeReactionSetup(interaction);
      await interaction.reply({
        content: `Welcomeリアクション設定メッセージを作成しました。\n${setupMessage.url}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'clear-welcome-reactions') {
      const clearedCount = clearWelcomeReactions(interaction.client, interaction.guildId);
      await interaction.reply({
        content: `Welcomeリアクションを削除しました。削除数: ${clearedCount}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'list-welcome-reactions') {
      const reactions = listWelcomeReactions(interaction.client, interaction.guildId);
      await interaction.reply({
        content: reactions.length
          ? [
              '保存済みWelcomeリアクション:',
              ...reactions.map((reaction, index) => `${index + 1}. ${formatSavedEmoji(reaction)}`)
            ].join('\n')
          : '保存済みWelcomeリアクションはありません。',
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'backfill-welcome-reactions') {
      await interaction.deferReply({ ephemeral: true });
      const limit = interaction.options.getInteger('limit') ?? 100;
      const summary = await backfillWelcomeReactions(interaction.client, interaction.guildId, limit);

      const lines = ['Welcomeリアクションの既存通知補完を実行しました。'];
      if (summary.skippedReason === 'no_configured_reactions') {
        lines.push('保存済みWelcomeリアクションがないため処理をスキップしました。');
      } else if (summary.skippedReason === 'welcome_channel_not_configured') {
        lines.push('welcomeChannelId が未設定のため処理をスキップしました。');
      } else if (summary.skippedReason === 'welcome_channel_unavailable') {
        lines.push('Welcomeチャンネルを取得できなかったため処理をスキップしました。');
      }

      lines.push(`走査メッセージ数: ${summary.scannedCount}`);
      lines.push(`参加通知メッセージ数: ${summary.matchedCount}`);
      lines.push(`リアクション適用メッセージ数: ${summary.reactedMessageCount}`);
      lines.push(`失敗リアクション数: ${summary.failedReactionCount}`);

      await interaction.editReply({
        content: lines.join('\n')
      });
      return;
    }

    if (subcommand === 'backfill-intro-profiles') {
      await interaction.deferReply({ ephemeral: true });
      const limit = interaction.options.getInteger('limit') ?? 500;
      const summary = await backfillIntroProfiles(interaction.client, interaction.guildId, limit);
      await interaction.editReply({
        content: [
          '自己紹介プロフィールの補完を実行しました。',
          `走査件数: ${summary.scannedCount}`,
          `保存件数: ${summary.savedCount}`,
          `Bot投稿スキップ数: ${summary.skippedBotCount}`,
          `失敗数: ${summary.failedCount}${summary.skippedReason ? `\nスキップ理由: ${summary.skippedReason}` : ''}`
        ].join('\n')
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
