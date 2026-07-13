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
      `<@${targetUser.id}> の作業通話累計`,
      `- 合計: ${formatDuration(info.totalSeconds, { largeCompact: true })}`,
      `- 履歴復元分: ${formatDuration(info.historicalBackfillSeconds)}`,
      `- 新規計測分: ${formatDuration(info.liveTrackedSeconds)}`,
      info.openInterval ? `- 現在参加中の見込みを含む: はい` : `- 現在参加中の見込みを含む: いいえ`
    ];
    if (info.nextMilestoneHours) {
      lines.push(`- 次のマイルストーン: ${getMilestoneLabel(info.nextMilestoneHours)}`);
      lines.push(`- 残り: ${formatDuration(info.remainingSeconds)}`);
    } else {
      lines.push('- 次のマイルストーン: 現在設定されている範囲ではありません');
    }
    await interaction.editReply({
      content: lines.join('\n'),
      allowedMentions: { parse: [], users: [], roles: [] }
    });
  }
};
