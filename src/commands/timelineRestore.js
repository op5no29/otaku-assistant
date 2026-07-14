const { ChannelType, SlashCommandBuilder } = require('discord.js');
const { handleTimelineRestoreCommand } = require('../modules/timelineRestoration');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeline-restore')
    .setDescription('保存されている過去のつぶやき履歴を管理します。')
    .addSubcommand((subcommand) => subcommand
      .setName('start')
      .setDescription('自分の現在のスレッドへ過去ログを復元します。'))
    .addSubcommand((subcommand) => subcommand
      .setName('status')
      .setDescription('このスレッドの復元進捗を確認します。'))
    .addSubcommand((subcommand) => subcommand
      .setName('cancel')
      .setDescription('復元を停止し、通常投稿を再開します。'))
    .addSubcommand((subcommand) => subcommand
      .setName('log')
      .setDescription('復元項目ごとの詳細ログを取得します。'))
    .addSubcommand((subcommand) => subcommand
      .setName('force-start')
      .setDescription('サーバー所有者として安全なテスト復元を開始します。')
      .addStringOption((option) => option
        .setName('historical-user')
        .setDescription('復元元となる過去スレッドの歴史上の所有者IDまたはメンション')
        .setRequired(true))
      .addChannelOption((option) => option
        .setName('destination-thread')
        .setDescription('テスト復元先の一時スレッド')
        .addChannelTypes(ChannelType.PublicThread)
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName('retry')
      .setDescription('管理者として失敗項目を再試行します。'))
    .addSubcommand((subcommand) => subcommand
      .setName('unlock')
      .setDescription('管理者として復元先スレッドを緊急解除します。'))
    .addSubcommand((subcommand) => subcommand
      .setName('inspect')
      .setDescription('管理者として復元状態を調査します。')),

  async execute(interaction) {
    await handleTimelineRestoreCommand(interaction);
  }
};
