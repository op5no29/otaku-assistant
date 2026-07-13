const { SlashCommandBuilder } = require('discord.js');
const { exportKnowledgeThread } = require('../modules/knowledgeExport');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('knowledge-export')
    .setDescription('現在の「知りたいこと」スレッド全体をMarkdownまたはZIPで書き出します。')
    .addStringOption((option) =>
      option
        .setName('format')
        .setDescription('書き出し形式')
        .addChoices(
          { name: 'markdown', value: 'markdown' },
          { name: 'zip', value: 'zip' }
        )
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName('include-reactions')
        .setDescription('リアクション数も含めます。')
        .setRequired(false)
    ),

  async execute(interaction) {
    await exportKnowledgeThread(interaction);
  }
};
