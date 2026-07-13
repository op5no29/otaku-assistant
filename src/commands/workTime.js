const { SlashCommandBuilder } = require('discord.js');
const { getNextMilestoneInfo, formatDuration, getMilestoneLabel } = require('../modules/voiceWorkTime');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work-time')
    .setDescription('作業通話の累計参加時間を確認します。')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('確認するユーザー（省略時は自分）')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const info = getNextMilestoneInfo(interaction.client, interaction.guildId, targetUser.id);
    const lines = [
      `合計: ${formatDuration(info.totalSeconds, { largeCompact: true })}`,
      `次のマイルストーン: ${info.nextMilestoneHours ? getMilestoneLabel(info.nextMilestoneHours) : 'なし'}`,
      `次まで残り: ${info.nextMilestoneHours ? formatDuration(info.remainingSeconds) : 'なし'}`
    ];
    await interaction.editReply({
      content: lines.join('\n'),
      allowedMentions: { parse: [], users: [], roles: [] }
    });
  }
};
