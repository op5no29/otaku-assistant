const { SlashCommandBuilder } = require('discord.js');
const { resolveThread } = require('../modules/questionResolver');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unresolve')
    .setDescription('この質問の解決済みを解除します。'),
  async execute(interaction) {
    await resolveThread({
      interaction,
      mode: 'unresolve'
    });
  }
};
