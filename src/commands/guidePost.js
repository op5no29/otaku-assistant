const { ChannelType, SlashCommandBuilder } = require('discord.js');
const { isAdministrator } = require('../utils/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guide-post')
    .setDescription('案内用の任意テキストを投稿します。')
    .addStringOption((option) =>
      option
        .setName('text')
        .setDescription('投稿する本文')
        .setRequired(true)
        .setMaxLength(4000)
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('投稿先チャンネル。未指定時はコマンド実行チャンネルです。')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    ),
  async execute(interaction) {
    if (!isAdministrator(interaction.member)) {
      await interaction.reply({
        content: 'このコマンドは管理者のみ使用できます。',
        ephemeral: true
      });
      return;
    }

    const text = interaction.options.getString('text', true);
    const targetChannel =
      interaction.options.getChannel('channel') ||
      interaction.channel;

    if (!targetChannel?.isTextBased?.()) {
      await interaction.reply({
        content: '投稿先チャンネルを確認できませんでした。',
        ephemeral: true
      });
      return;
    }

    const sentMessage = await targetChannel.send({
      content: text,
      allowedMentions: {
        parse: ['users', 'roles'],
        repliedUser: false
      }
    });

    interaction.client.logger.info('Guide post sent', {
      interactionId: interaction.id,
      processPid: process.pid,
      handlerLabel: 'guide-post:send',
      destinationChannelId: targetChannel.id,
      hasContent: Boolean(text),
      returnedMessageId: sentMessage.id
    });

    await interaction.reply({
      content: `投稿しました。\n${sentMessage.url}`,
      ephemeral: true
    });
  }
};
