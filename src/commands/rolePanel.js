const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { postDevRolePanel, postTempRolePanel } = require('../modules/rolePanel');

function canManageRolePanel(member) {
  return Boolean(
    member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role-panel')
    .setDescription('一時的なロール付与パネルを管理します。')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('post-temp')
        .setDescription('告知チャンネルに一時ロール付与パネルを投稿または更新します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('post-dev')
        .setDescription('告知チャンネルに開発ロール付与パネルを投稿または更新します。')
    ),

  async execute(interaction) {
    if (!canManageRolePanel(interaction.member)) {
      await interaction.reply({
        content: 'このコマンドはサーバー管理権限を持つユーザーのみ使用できます。',
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (!['post-temp', 'post-dev'].includes(subcommand)) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      if (subcommand === 'post-dev') {
        const message = await postDevRolePanel(interaction.client, interaction.guildId);
        await interaction.editReply({
          content: [
            '開発ロールパネルを投稿しました。',
            `メッセージ: ${message.url}`
          ].join('\n'),
          allowedMentions: { parse: [] }
        });
        return;
      }

      const { mainMessage, overflowMessage } = await postTempRolePanel(interaction.client, interaction.guildId);
      await interaction.editReply({
        content: [
          'ロールパネルを投稿しました。',
          `メイン: ${mainMessage.url}`,
          `追加: ${overflowMessage.url}`
        ].join('\n'),
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      interaction.client.logger.error('role panel post command failed', {
        interactionId: interaction.id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error: error.message
      });
      await interaction.editReply({
        content: `ロール付与パネルの投稿に失敗しました。\n${error.message}`,
        allowedMentions: { parse: [] }
      });
    }
  }
};
