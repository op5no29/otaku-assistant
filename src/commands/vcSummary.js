const { SlashCommandBuilder } = require('discord.js');
const { buildLatestVcSummaryResponse } = require('../modules/vcSessionSummary');
const { registerVcSummaryDeletableMessage } = require('../modules/deletableMessages');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vc-summary')
    .setDescription('直近の通話セッションまとめを表示します。')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('表示するセッションの選び方')
        .addChoices(
          { name: '最大人数が多い通話', value: 'peak' },
          { name: '最新の通話', value: 'latest' },
          { name: '最近の通話履歴', value: 'history' }
        )
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName('hours')
        .setDescription('何時間前までを見るか')
        .setMinValue(1)
        .setMaxValue(168)
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('VCカテゴリ名またはIDで絞り込みます。')
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName('include-events')
        .setDescription('最近の参加/退出ログも表示します。')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false });

    const mode = interaction.options.getString('mode') || 'peak';
    const hours = interaction.options.getInteger('hours') || null;
    const category = interaction.options.getString('category') || null;
    const includeEvents = interaction.options.getBoolean('include-events') === true;
    const guild = interaction.guild || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null);

    if (!guild) {
      await interaction.editReply({
        content: 'サーバー情報を取得できませんでした。時間をおいてもう一度試してください。'
      });
      return;
    }

    await guild.channels.fetch().catch(() => null);

    const response = await buildLatestVcSummaryResponse(interaction.client, {
      guild,
      mode,
      hours,
      category,
      includeEvents,
      commandUserId: interaction.user.id
    });

    if (!response.found) {
      await interaction.editReply({
        content: response.content,
        allowedMentions: { parse: [] }
      });
      return;
    }

    const message = await interaction.editReply(response.payload);
    await registerVcSummaryDeletableMessage(message, {
      commandUserId: interaction.user.id,
      sessionId: response.session?.sessionId || null,
      mode: response.mode || mode,
      categoryId: response.categoryId || null,
      lookbackHours: response.lookbackHours || hours || null
    });
  }
};
