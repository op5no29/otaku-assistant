const { SlashCommandBuilder } = require('discord.js');
const { resolveThread } = require('../modules/questionResolver');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resolve')
    .setDescription('この質問を解決済みにします。'),
  async execute(interaction) {
    await resolveThread({
      interaction,
      mode: 'resolve'
    });
  }
};
