const { SlashCommandBuilder } = require('discord.js');
const { isAdministrator } = require('../utils/permissions');
const {
  createWelcomeReactionSetup,
  listWelcomeReactions,
  clearWelcomeReactions,
  backfillWelcomeReactions,
  formatSavedEmoji
} = require('../modules/welcomeReactions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Welcome通知リアクションの管理コマンドです。')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup-reactions')
        .setDescription('Welcome通知用リアクションの保存対象メッセージを作成します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list-reactions')
        .setDescription('保存済みのWelcome通知リアクションを表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear-reactions')
        .setDescription('保存済みのWelcome通知リアクションを全削除します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('backfill-reactions')
        .setDescription('既存のWelcome参加通知へ保存済みリアクションを付与します。')
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('確認する直近メッセージ数（1-500）')
            .setMinValue(1)
            .setMaxValue(500)
        )
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

    if (subcommand === 'setup-reactions') {
      const setupMessage = await createWelcomeReactionSetup(interaction);
      await interaction.reply({
        content: `Welcomeリアクション設定メッセージを作成しました。\n${setupMessage.url}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'list-reactions') {
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

    if (subcommand === 'clear-reactions') {
      const clearedCount = clearWelcomeReactions(interaction.client, interaction.guildId);
      await interaction.reply({
        content: `Welcomeリアクションを削除しました。削除数: ${clearedCount}`,
        ephemeral: true
      });
      return;
    }

    if (subcommand === 'backfill-reactions') {
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
      lines.push(`削除した古いBotリアクション数: ${summary.removedOutdatedCount ?? 0}`);
      lines.push(`削除失敗リアクション数: ${summary.failedRemovalCount ?? 0}`);

      await interaction.editReply({
        content: lines.join('\n')
      });
    }
  }
};
