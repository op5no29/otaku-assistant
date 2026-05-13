const { ChannelType } = require('discord.js');
const { setTimeout: sleep } = require('node:timers/promises');
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

async function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`${label}_timeout`);
    })
  ]);
}

async function resolveThread({ interaction, mode }) {
  const config = interaction.client.appConfig;
  const logger = interaction.client.logger;
  const lockKey = String(interaction.channelId || '');
  logger.info(`${mode} command received`, {
    interactionId: interaction.id,
    threadId: interaction.channelId,
    userId: interaction.user.id
  });
  await interaction.deferReply({ ephemeral: true });
  logger.info('interaction deferred', {
    interactionId: interaction.id,
    threadId: interaction.channelId,
    mode
  });

  if (interaction.client.questionResolveLocks.has(lockKey)) {
    await interaction.editReply('この質問のステータス更新は現在処理中です。少し待ってからもう一度試してください。');
    logger.warn('Question resolve lock already active', {
      interactionId: interaction.id,
      threadId: interaction.channelId,
      mode
    });
    return;
  }

  interaction.client.questionResolveLocks.add(lockKey);
  logger.info('question resolve lock acquired', {
    interactionId: interaction.id,
    threadId: interaction.channelId,
    mode
  });

  try {
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
  const currentStatus = currentName.startsWith(prefix) ? 'resolved' : 'open';
  logger.info('question state loaded', {
    interactionId: interaction.id,
    threadId: thread.id,
    currentStatus,
    targetStatus: mode === 'resolve' ? 'resolved' : 'open'
  });

  if (mode === 'resolve') {
    if (currentName.startsWith(prefix)) {
      await interaction.editReply('この質問はすでに解決済みです。');
      return;
    }

    const newName = addPrefix(currentName, prefix);
    logger.info('thread title update started', {
      threadId: thread.id,
      mode,
      from: currentName,
      to: newName
    });
    const renamedThread = await withTimeout(
      thread.setName(newName, 'Question resolved by slash command'),
      10_000,
      'thread_set_name'
    );
    logger.info('thread title update finished', {
      threadId: thread.id,
      mode,
      to: newName
    });
    const updatedThread = await withTimeout(applyQuestionStatusTag(renamedThread, 'resolved', {
      config,
      logger
    }), 10_000, 'apply_question_status_tag');
    logger.info('DB update started', {
      threadId: thread.id,
      mode
    });
    interaction.client.db.questions.markResolved(thread.id);
    logger.info('DB update finished', {
      threadId: thread.id,
      mode
    });

    let partialFailure = false;
    try {
      logger.info('timeline card update started', {
        threadId: thread.id,
        mode
      });
      await withTimeout(updateQuestionTimelineCard(updatedThread, {
        config,
        db: interaction.client.db,
        logger
      }), 10_000, 'question_timeline_update');
      logger.info('timeline card update finished', {
        threadId: thread.id,
        mode
      });
    } catch (error) {
      partialFailure = true;
      logger.warn('timeline card update failed', {
        threadId: thread.id,
        mode,
        error: error.message
      });
    }

    logger.info('Resolve success', {
      threadId: thread.id,
      userId: interaction.user.id
    });

    await interaction.editReply(
      partialFailure
        ? 'ステータスは更新しましたが、タイムラインカードの更新に失敗しました。'
        : 'この質問を解決済みにしました。'
    );
    logger.info('command reply sent', {
      interactionId: interaction.id,
      threadId: thread.id,
      mode,
      partialFailure
    });
    return;
  }

  if (!currentName.startsWith(prefix)) {
    await interaction.editReply('この質問はまだ解決済みになっていません。');
    return;
  }

  const newName = removePrefix(currentName, prefix);
  logger.info('thread title update started', {
    threadId: thread.id,
    mode,
    from: currentName,
    to: newName
  });
  const renamedThread = await withTimeout(
    thread.setName(newName, 'Question unresolved by slash command'),
    10_000,
    'thread_set_name'
  );
  logger.info('thread title update finished', {
    threadId: thread.id,
    mode,
    to: newName
  });
  const updatedThread = await withTimeout(applyQuestionStatusTag(renamedThread, 'open', {
    config,
    logger
  }), 10_000, 'apply_question_status_tag');
  logger.info('DB update started', {
    threadId: thread.id,
    mode
  });
  updateResolvedState(interaction.client.db, thread.id, null);
  logger.info('DB update finished', {
    threadId: thread.id,
    mode
  });

  let partialFailure = false;
  try {
    logger.info('timeline card update started', {
      threadId: thread.id,
      mode
    });
    await withTimeout(updateQuestionTimelineCard(updatedThread, {
      config,
      db: interaction.client.db,
      logger
    }), 10_000, 'question_timeline_update');
    logger.info('timeline card update finished', {
      threadId: thread.id,
      mode
    });
  } catch (error) {
    partialFailure = true;
    logger.warn('timeline card update failed', {
      threadId: thread.id,
      mode,
      error: error.message
    });
  }

  logger.info('Unresolve success', {
    threadId: thread.id,
    userId: interaction.user.id
  });

  await interaction.editReply(
    partialFailure
      ? 'ステータスは更新しましたが、タイムラインカードの更新に失敗しました。'
      : 'この質問を受付中に戻しました。'
  );
  logger.info('command reply sent', {
    interactionId: interaction.id,
    threadId: thread.id,
    mode,
    partialFailure
  });
  } catch (error) {
    logger.error('question resolve/unresolve failed', {
      interactionId: interaction.id,
      threadId: interaction.channelId,
      mode,
      error: error.message
    });
    throw error;
  } finally {
    interaction.client.questionResolveLocks.delete(lockKey);
    logger.info('question resolve lock released', {
      interactionId: interaction.id,
      threadId: interaction.channelId,
      mode
    });
  }
}

module.exports = {
  resolveThread
};
