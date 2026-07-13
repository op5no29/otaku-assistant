const { SlashCommandBuilder } = require('discord.js');
const { formatDuration } = require('../modules/voiceWorkTime');

const PAGE_SIZE = 10;

function secondsBetween(startIso, endMs) {
  if (!startIso) {
    return 0;
  }
  const startMs = new Date(startIso || 0).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 1000);
}

function buildRankingRows(client, guildId, now = new Date()) {
  const nowMs = now.getTime();
  return client.db.vcWorkTime.listRankingRows(guildId)
    .map((row) => ({
      userId: String(row.userId),
      totalSeconds: Number(row.totalSeconds || 0) + secondsBetween(row.openStartedAt, nowMs)
    }))
    .filter((row) => row.totalSeconds > 0)
    .sort((left, right) => {
      const totalDelta = right.totalSeconds - left.totalSeconds;
      if (totalDelta !== 0) {
        return totalDelta;
      }
      return left.userId.localeCompare(right.userId);
    });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work-ranking')
    .setDescription('作業通話の累計参加時間ランキングを表示します。')
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('ページ番号')
        .setMinValue(1)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const requestedPage = Math.max(1, interaction.options.getInteger('page') || 1);
    const rows = buildRankingRows(interaction.client, interaction.guildId, new Date());
    if (!rows.length) {
      await interaction.editReply({
        content: '作業時間ランキング\n\nまだ表示できる作業時間がありません。\n\n自分の順位: なし',
        allowedMentions: { parse: [], users: [], roles: [] }
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const startIndex = (page - 1) * PAGE_SIZE;
    const pageRows = rows.slice(startIndex, startIndex + PAGE_SIZE);
    const ownIndex = rows.findIndex((row) => row.userId === interaction.user.id);
    const ownLine = ownIndex >= 0
      ? `自分の順位: ${ownIndex + 1}位 / ${formatDuration(rows[ownIndex].totalSeconds, { largeCompact: true })}`
      : '自分の順位: なし';

    const lines = [
      `作業時間ランキング ${page}/${totalPages}`,
      '',
      ...pageRows.map((row, index) =>
        `${startIndex + index + 1}. <@${row.userId}> — ${formatDuration(row.totalSeconds, { largeCompact: true })}`
      ),
      '',
      ownLine
    ];
    await interaction.editReply({
      content: lines.join('\n'),
      allowedMentions: { parse: [], users: [], roles: [] }
    });
  },

  buildRankingRows
};
