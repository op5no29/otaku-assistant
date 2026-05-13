const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  enabled: false,
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('プロフィール関連コマンドのプレースホルダーです。'),
  async execute(interaction) {
    await interaction.reply({
      content: 'プロフィール機能は準備中です。',
      ephemeral: true
    });
  }
};
