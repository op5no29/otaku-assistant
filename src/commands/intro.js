const { SlashCommandBuilder } = require('discord.js');
const { isAdministrator } = require('../utils/permissions');
const {
  sendIntroDm,
  getIntroDmStatus,
  PROMPT_TYPES,
  enqueueJoinIntroDmCandidates,
  processIntroDmQueue
} = require('../modules/introDm');
const {
  backfillIntroProfiles,
  getIntroProfileStatus,
  cleanupIntroProfiles,
  rebuildIntroProfiles
} = require('../modules/introProfiles');
const { backfillGuildMembers, getUsersWithoutIntroOlderThan } = require('../modules/guildMembers');
const {
  createIntroReactionSetup,
  listIntroReactions,
  clearIntroReactions,
  backfillIntroReactions,
  formatSavedEmoji: formatSavedIntroEmoji
} = require('../modules/introReactions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('intro')
    .setDescription('自己紹介プロフィール・DM・リアクション管理コマンドです。')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-status')
        .setDescription('intro DM 設定と保存状態を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-test')
        .setDescription('開発者限定の自己紹介DMテストを送信します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-test-join48h')
        .setDescription('開発者限定の48時間経過自己紹介DMテストを送信します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-scan-dry-run')
        .setDescription('自己紹介なしメンバー候補をDM送信せずに確認します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-enqueue-join48h')
        .setDescription('join48h自己紹介DM候補をキューに積みます。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-queue-status')
        .setDescription('intro DM キュー件数を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dm-process-queue')
        .setDescription('due の intro DM キューを手動処理します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-guild-members')
        .setDescription('ギルドメンバーDBをDiscordから補完します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-profiles')
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
        .setName('profile-status')
        .setDescription('自己紹介プロフィールDBの状態を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('rebuild-profiles')
        .setDescription('自己紹介プロフィールを first valid top-level ルールで再構築します。')
        .addBooleanOption((option) =>
          option
            .setName('dry_run')
            .setDescription('DBを書き換えずに結果だけ確認します')
        )
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('確認する直近メッセージ数（1-2000）')
            .setMinValue(1)
            .setMaxValue(2000)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cleanup-profiles')
        .setDescription('返信ベースの自己紹介プロフィールを整理します。')
        .addBooleanOption((option) =>
          option
            .setName('dry_run')
            .setDescription('削除せず件数だけ確認します')
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup-reactions')
        .setDescription('自己紹介投稿用リアクションの保存対象メッセージを作成します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list-reactions')
        .setDescription('保存済みの自己紹介投稿リアクションを表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear-reactions')
        .setDescription('保存済みの自己紹介投稿リアクションを全削除します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-reactions')
        .setDescription('既存の自己紹介投稿へ保存済みリアクションを付与します。')
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

    if (subcommand === 'dm-status') {
      const status = getIntroDmStatus(interaction.client);
      const promptCounts = interaction.client.db.introDm.countStatesByPromptType();
      const introProfileStatus = getIntroProfileStatus(interaction.client, interaction.guildId);
      const noIntroCount = interaction.client.db.guildMembers.countWithoutIntro(
        interaction.guildId,
        interaction.client.appConfig.introDm.introChannelId || interaction.client.appConfig.introChannelId
      );
      const queueCounts = interaction.client.db.introDmQueue.countByStatus();
      await interaction.reply({
        content: [
          `introDmEnabled: ${status.enabled}`,
          `introDmDevTestMode: ${status.devTestMode}`,
          `introDmDevUserId: ${status.devUserId}`,
          `introChannelId: ${status.introChannelId || 'not set'}`,
          `introDmLogChannelId: ${interaction.client.appConfig.introDm.logChannelId || 'not set'}`,
          `guildMemberCount: ${interaction.client.db.guildMembers.count(interaction.guildId)}`,
          `introProfileCount: ${introProfileStatus.savedProfileCount}`,
          `membersWithoutIntroCount: ${noIntroCount}`,
          `introDmStateCount: ${status.stateCount}`,
          `queue pending count: ${queueCounts.find((entry) => entry.status === 'pending')?.count || 0}`,
          `queue sent count: ${queueCounts.find((entry) => entry.status === 'sent')?.count || 0}`,
          `queue failed count: ${queueCounts.find((entry) => entry.status === 'failed')?.count || 0}`,
          `queue skipped count: ${queueCounts.find((entry) => entry.status === 'skipped')?.count || 0}`,
          `vc_no_intro count: ${promptCounts.find((entry) => entry.promptType === PROMPT_TYPES.VC_NO_INTRO)?.count || 0}`,
          `join_48h_no_intro count: ${promptCounts.find((entry) => entry.promptType === PROMPT_TYPES.JOIN_NO_INTRO)?.count || 0}`,
          `opt_out count: ${interaction.client.db.introDm.countOptOutStates()}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'dm-test') {
      const targetUserId = interaction.client.appConfig.introDm.devUserId;
      const result = await sendIntroDm(interaction.client, {
        guildId: interaction.guildId,
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

    if (subcommand === 'dm-test-join48h') {
      const targetUserId = interaction.client.appConfig.introDm.devUserId;
      const result = await sendIntroDm(interaction.client, {
        guildId: interaction.guildId,
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

    if (subcommand === 'dm-scan-dry-run') {
      const members = getUsersWithoutIntroOlderThan(
        interaction.client,
        interaction.guildId,
        interaction.client.appConfig.introDm.joinReminderHours,
        20
      );
      await interaction.reply({
        content: [
          'intro DM scan dry-run を実行しました。',
          `候補数: ${members.length}`,
          ...members.slice(0, 20).map((member) => `- ${member.displayName || member.username || member.userId} (${member.userId})`)
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'dm-enqueue-join48h') {
      const members = getUsersWithoutIntroOlderThan(
        interaction.client,
        interaction.guildId,
        interaction.client.appConfig.introDm.joinReminderHours,
        100
      );
      const result = enqueueJoinIntroDmCandidates(interaction.client, interaction.guildId, members);
      await interaction.reply({
        content: [
          'join48h intro DM enqueue を実行しました。',
          `candidateCount: ${members.length}`,
          `queuedCount: ${result.queuedCount}`,
          `skippedExistingCount: ${result.skippedExistingCount}${result.skippedReason ? `\nスキップ理由: ${result.skippedReason}` : ''}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'dm-queue-status') {
      const queueCounts = interaction.client.db.introDmQueue.countByStatus();
      await interaction.reply({
        content: [
          'intro DM queue status',
          `pending: ${queueCounts.find((entry) => entry.status === 'pending')?.count || 0}`,
          `sent: ${queueCounts.find((entry) => entry.status === 'sent')?.count || 0}`,
          `failed: ${queueCounts.find((entry) => entry.status === 'failed')?.count || 0}`,
          `skipped: ${queueCounts.find((entry) => entry.status === 'skipped')?.count || 0}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'dm-process-queue') {
      const result = await processIntroDmQueue(interaction.client, interaction.guildId);
      await interaction.reply({
        content: [
          'intro DM queue process を実行しました。',
          `dueCount: ${result.dueCount}`,
          `sentCount: ${result.sentCount}`,
          `failedCount: ${result.failedCount}`,
          `skippedCount: ${result.skippedCount}${result.skippedReason ? `\nスキップ理由: ${result.skippedReason}` : ''}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'backfill-guild-members') {
      const result = await backfillGuildMembers(interaction.client, interaction.guild);
      await interaction.reply({
        content: [
          'guild member backfill を実行しました。',
          `fetchedCount: ${result.fetchedCount}`,
          `savedCount: ${result.savedCount}`,
          `botCount: ${result.botCount}`,
          `failedCount: ${result.failedCount}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'profile-status') {
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

    if (subcommand === 'cleanup-profiles') {
      const dryRun = interaction.options.getBoolean('dry_run') !== false;
      const result = await cleanupIntroProfiles(interaction.client, interaction.guildId, {
        dryRun,
        limit: 1000
      });
      await interaction.reply({
        content: [
          `cleanup intro profiles (${dryRun ? 'dry-run' : 'apply'})`,
          `scannedCount: ${result.scannedCount}`,
          `removedCount: ${result.removedCount}`,
          `replyCount: ${result.replyCount}`,
          `greetingLikeCount: ${result.greetingLikeCount}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'rebuild-profiles') {
      const dryRun = interaction.options.getBoolean('dry_run') !== false;
      const limit = interaction.options.getInteger('limit') ?? 1000;
      const result = await rebuildIntroProfiles(interaction.client, interaction.guildId, {
        dryRun,
        limit
      });
      await interaction.reply({
        content: [
          `rebuild intro profiles (${dryRun ? 'dry-run' : 'apply'})`,
          `scannedCount: ${result.scannedCount}`,
          `selectedIntroCount: ${result.selectedIntroCount}`,
          `skippedReplyCount: ${result.skippedReplyCount}`,
          `skippedDuplicateUserCount: ${result.skippedDuplicateUserCount}`,
          `skippedBotCount: ${result.skippedBotCount}`,
          `skippedEmptyCount: ${result.skippedEmptyCount}`,
          `failedCount: ${result.failedCount}${result.skippedReason ? `\nスキップ理由: ${result.skippedReason}` : ''}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'setup-reactions') {
      const setupMessage = await createIntroReactionSetup(interaction);
      await interaction.reply({
        content: `自己紹介リアクション設定メッセージを作成しました。\n${setupMessage.url}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'list-reactions') {
      const reactions = listIntroReactions(interaction.client, interaction.guildId);
      await interaction.reply({
        content: reactions.length
          ? [
              '保存済みの自己紹介リアクション:',
              ...reactions.map((reaction, index) => `${index + 1}. ${formatSavedIntroEmoji(reaction)}`)
            ].join('\n')
          : '保存済みの自己紹介リアクションはありません。',
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'clear-reactions') {
      const clearedCount = clearIntroReactions(interaction.client, interaction.guildId);
      await interaction.reply({
        content: `保存済みの自己紹介リアクションを削除しました。削除数: ${clearedCount}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'backfill-reactions') {
      const summary = await backfillIntroReactions(interaction.client, interaction.guildId);
      await interaction.reply({
        content: [
          '自己紹介リアクションの補完を実行しました。',
          `走査自己紹介数: ${summary.scannedIntroCount}`,
          `リアクション付与メッセージ数: ${summary.reactedMessageCount}`,
          `付与数: ${summary.appliedCount}`,
          `削除した古いBotリアクション数: ${summary.removedOutdatedCount}`,
          `失敗数: ${summary.failedCount}${summary.skippedReason ? `\nスキップ理由: ${summary.skippedReason}` : ''}`
        ].join('\n'),
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'backfill-profiles') {
      await interaction.deferReply({ ephemeral: true });
      const limit = interaction.options.getInteger('limit') ?? 500;
      const summary = await backfillIntroProfiles(interaction.client, interaction.guildId, limit);
      await interaction.editReply({
        content: [
          '自己紹介プロフィールの補完を実行しました。',
          `走査件数: ${summary.scannedCount}`,
          `保存件数: ${summary.savedCount}`,
          `Bot投稿スキップ数: ${summary.skippedBotCount}`,
          `返信スキップ数: ${summary.skippedReplyCount}`,
          `短文あいさつスキップ数: ${summary.skippedGreetingLikeCount}`,
          `空メッセージスキップ数: ${summary.skippedEmptyCount ?? 0}`,
          `失敗数: ${summary.failedCount}${summary.skippedReason ? `\nスキップ理由: ${summary.skippedReason}` : ''}`
        ].join('\n')
      });
    }
  }
};
