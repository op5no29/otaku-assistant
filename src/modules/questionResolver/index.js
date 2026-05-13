const { ChannelType } = require('discord.js');
const { updateResolvedState } = require('./resolveThread');
const { applyQuestionStatusTag } = require('./threadTags');
const { canManageQuestionThread } = require('../../utils/permissions');
const { addPrefix, removePrefix } = require('../../utils/text');
const { updateQuestionTimelineCard } = require('../timelineRelay');

function isWatchedQuestionThread(channel, config) {
  return (
    channel?.isThread?.() &&
    channel.type === ChannelType.PublicThread &&
    config.watchedForums.question.includes(channel.parentId)
  );
}

async function resolveThread({ interaction, mode }) {
  const config = interaction.client.appConfig;
  await interaction.deferReply({ ephemeral: true });
  const thread = await interaction.channel.fetch().catch(() => interaction.channel);

  if (!isWatchedQuestionThread(thread, config)) {
    await interaction.editReply('このコマンドは質問フォーラムの投稿内で使用してください。');
    return;
  }

  const allowed = canManageQuestionThread({
    member: interaction.member,
    thread,
    config
  });

  if (!allowed) {
    interaction.client.logger.warn('Resolve permission denied', {
      threadId: thread.id,
      userId: interaction.user.id,
      mode
    });

    await interaction.editReply('この操作は、質問の投稿者または管理者のみ実行できます。');
    return;
  }

  const prefix = config.questions.resolvedPrefix;
  const currentName = thread.name || '';
  interaction.client.db.questions.ensureQuestionThread(thread.id, thread.ownerId || null);

  if (mode === 'resolve') {
    if (currentName.startsWith(prefix)) {
      await interaction.editReply('この質問はすでに解決済みです。');
      return;
    }

    const newName = addPrefix(currentName, prefix);
    const renamedThread = await thread.setName(newName, 'Question resolved by slash command');
    const updatedThread = await applyQuestionStatusTag(renamedThread, 'resolved', {
      config,
      logger: interaction.client.logger
    });
    interaction.client.db.questions.markResolved(thread.id);
    await updateQuestionTimelineCard(updatedThread, {
      config,
      db: interaction.client.db,
      logger: interaction.client.logger
    });
    interaction.client.logger.info('Resolve success', {
      threadId: thread.id,
      userId: interaction.user.id
    });

    await interaction.editReply('この質問を解決済みにしました。');
    return;
  }

  if (!currentName.startsWith(prefix)) {
    await interaction.editReply('この質問はまだ解決済みになっていません。');
    return;
  }

  const newName = removePrefix(currentName, prefix);
  const renamedThread = await thread.setName(newName, 'Question unresolved by slash command');
  const updatedThread = await applyQuestionStatusTag(renamedThread, 'open', {
    config,
    logger: interaction.client.logger
  });
  updateResolvedState(interaction.client.db, thread.id, null);
  await updateQuestionTimelineCard(updatedThread, {
    config,
    db: interaction.client.db,
    logger: interaction.client.logger
  });
  interaction.client.logger.info('Unresolve success', {
    threadId: thread.id,
    userId: interaction.user.id
  });

  await interaction.editReply('この質問を受付中に戻しました。');
}

module.exports = {
  resolveThread
};
