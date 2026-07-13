const { SlashCommandBuilder } = require('discord.js');
const { handleAnnictCommand } = require('../modules/annictUserIntegration');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('annict')
    .setDescription('Annictアカウント連携を管理します。')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('connect')
        .setDescription('Annictアカウントを連携します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('Annict連携状態を確認します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('disconnect')
        .setDescription('Annict連携を解除します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('sync')
        .setDescription('Annictから作品単位のステータスを同期します。')
        .addBooleanOption((option) =>
          option
            .setName('import-history')
            .setDescription('過去履歴も取り込みます（管理者が有効化している場合のみ）。')
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('import-watched')
        .setDescription('Annictの「見た」作品を少しずつアニメカードへ取り込みます。')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('操作')
            .setRequired(true)
            .addChoices(
              { name: 'start', value: 'start' },
              { name: 'status', value: 'status' },
              { name: 'cancel', value: 'cancel' }
            )
        )
    ),

  async execute(interaction) {
    await handleAnnictCommand(interaction);
  }
};
