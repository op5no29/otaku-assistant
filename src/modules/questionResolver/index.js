const { ChannelType } = require('discord.js');
const { setTimeout: sleep } = require('node:timers/promises');
const { updateResolvedState } = require('./resolveThread');
const { applyQuestionStatusTag, areQuestionStatusTagsAlreadyCorrect } = require('./threadTags');
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

function buildDesiredThreadTitle(currentName, targetStatus, prefix) {
  return targetStatus === 'resolved'
    ? addPrefix(currentName, prefix)
    : removePrefix(currentName, prefix);
}

function scheduleQuestionVisualSyncRetry({ client, threadId, targetStatus, logger, reason }) {
  const retryDelayMs = 45_000;
  logger.warn('sync retry scheduled', {
    threadId,
    targetStatus,
    reason,
    retryDelayMs
  });

  setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread?.isThread?.()) {
        logger.warn('sync retry failed', {
          threadId,
          targetStatus,
          reason: 'thread_not_found'
        });
        return;
      }

      const config = client.appConfig;
      const prefix = config.questions.resolvedPrefix;
      const desiredName = buildDesiredThreadTitle(thread.name || '', targetStatus, prefix);

      if ((thread.name || '') !== desiredName) {
        await withTimeout(
          thread.setName(
            desiredName,
            `Question status sync retry to ${targetStatus}`
          ),
          15_000,
          'thread_set_name'
        );
      }

      if (!areQuestionStatusTagsAlreadyCorrect(thread, targetStatus, config)) {
        await withTimeout(
          applyQuestionStatusTag(thread, targetStatus, {
            config,
            logger
          }),
          10_000,
          'apply_question_status_tag'
        );
      }

      logger.info('sync retry finished', {
        threadId,
        targetStatus
      });
    } catch (error) {
      logger.warn('sync retry failed', {
        threadId,
        targetStatus,
        error: error.message
      });
    }
  }, retryDelayMs);
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
    const questionRecord = interaction.client.db.questions.getQuestionThread(thread.id);
    const currentStatus = questionRecord?.resolvedAt
      ? 'resolved'
      : currentName.startsWith(prefix) ? 'resolved' : 'open';
    const targetStatus = mode === 'resolve' ? 'resolved' : 'open';
    logger.info('question state loaded', {
      interactionId: interaction.id,
      threadId: thread.id,
      currentStatus,
      targetStatus,
      currentStatusSource: questionRecord?.resolvedAt ? 'db_status' : 'thread_title'
    });
    logger.info('command targetStatus computed', {
      interactionId: interaction.id,
      threadId: thread.id,
      targetStatus
    });

    if (mode === 'resolve' && currentStatus === 'resolved') {
      await interaction.editReply('この質問はすでに解決済みです。');
      return;
    }

    if (mode === 'unresolve' && currentStatus === 'open') {
      await interaction.editReply('この質問はまだ解決済みになっていません。');
      return;
    }

    const partialFailureReasons = [];
    let workingThread = thread;
    let dbStatusUpdated = false;

    logger.info('DB update started', {
      threadId: thread.id,
      mode,
      targetStatus
    });
    try {
      if (targetStatus === 'resolved') {
        interaction.client.db.questions.markResolved(thread.id);
      } else {
        updateResolvedState(interaction.client.db, thread.id, null);
      }
      dbStatusUpdated = true;
      logger.info('DB update finished', {
        threadId: thread.id,
        mode,
        targetStatus
      });
      logger.info('DB status set to targetStatus', {
        threadId: thread.id,
        targetStatus
      });
    } catch (error) {
      partialFailureReasons.push('db');
      logger.warn('DB update partial failure', {
        threadId: thread.id,
        mode,
        error: error.message
      });
    }

    logger.info('timeline card update started', {
      threadId: thread.id,
      mode,
      targetStatus
    });
    try {
      await withTimeout(updateQuestionTimelineCard(workingThread, {
        config,
        db: interaction.client.db,
        logger,
        questionStatusOverride: targetStatus,
        statusSource: dbStatusUpdated ? 'command_target_status' : 'db_status'
      }), 10_000, 'question_timeline_update');
      logger.info('timeline card update finished', {
        threadId: thread.id,
        mode
      });
    } catch (error) {
      partialFailureReasons.push('timeline_card');
      logger.warn('timeline card update partial failure', {
        threadId: thread.id,
        mode,
        error: error.message
      });
    }

    const newName = buildDesiredThreadTitle(currentName, targetStatus, prefix);
    if ((thread.name || '') === newName) {
      logger.info('title sync skipped/already correct', {
        threadId: thread.id,
        mode,
        targetStatus,
        currentName
      });
    } else {
      logger.info('thread title update started', {
        threadId: thread.id,
        mode,
        from: currentName,
        to: newName
      });
      try {
        workingThread = await withTimeout(
          thread.setName(
            newName,
            mode === 'resolve' ? 'Question resolved by slash command' : 'Question unresolved by slash command'
          ),
          15_000,
          'thread_set_name'
        );
        logger.info('thread title update finished', {
          threadId: thread.id,
          mode,
          to: newName
        });
      } catch (error) {
        partialFailureReasons.push('thread_title');
        logger.warn('thread title update partial failure', {
          threadId: thread.id,
          mode,
          error: error.message
        });
        logger.info('continuing after thread title failure', {
          threadId: thread.id,
          mode
        });
        logger.warn('stale thread tag ignored because command targetStatus is authoritative', {
          threadId: thread.id,
          mode,
          targetStatus
        });
      }
    }

    if (areQuestionStatusTagsAlreadyCorrect(workingThread, targetStatus, config)) {
      logger.info('tag sync skipped/already correct', {
        threadId: thread.id,
        mode,
        targetStatus,
        appliedTags: workingThread.appliedTags || []
      });
    } else {
      logger.info('tag update started', {
        threadId: thread.id,
        mode,
        targetStatus
      });
      try {
        workingThread = await withTimeout(
          applyQuestionStatusTag(workingThread, targetStatus, {
            config,
            logger
          }),
          10_000,
          'apply_question_status_tag'
        );
        logger.info('tag update finished', {
          threadId: thread.id,
          mode,
          targetStatus
        });
      } catch (error) {
        partialFailureReasons.push('status_tag');
        logger.warn('tag sync partial failure', {
          threadId: thread.id,
          mode,
          error: error.message
        });
        logger.warn('stale thread tag ignored because command targetStatus is authoritative', {
          threadId: thread.id,
          mode,
          targetStatus
        });
      }
    }

    if (!dbStatusUpdated) {
      await interaction.editReply('内部状態の更新に失敗しました。時間をおいてもう一度お試しください。');
      logger.warn('command reply sent with partial failure', {
        interactionId: interaction.id,
        threadId: thread.id,
        mode,
        partialFailureReasons
      });
      return;
    }

    if (partialFailureReasons.includes('thread_title') || partialFailureReasons.includes('status_tag')) {
      scheduleQuestionVisualSyncRetry({
        client: interaction.client,
        threadId: thread.id,
        targetStatus,
        logger,
        reason: partialFailureReasons.join(',')
      });
    }

    const successMessage = mode === 'resolve'
      ? 'この質問を解決済みにしました。'
      : 'この質問を受付中に戻しました。';
    const partialSyncMessage = mode === 'resolve'
      ? 'この質問を解決済みにしました。ただし、スレッドタイトル/タグの同期に失敗しました。後で再試行します。'
      : 'この質問を受付中に戻しました。ただし、スレッドタイトル/タグの同期に失敗しました。後で再試行します。';
    const partialMessageMap = {
      thread_title: partialSyncMessage,
      status_tag: partialSyncMessage,
      timeline_card: 'ステータスは更新しましたが、タイムラインカードの更新に失敗しました。',
      db: '内部状態の更新に失敗しました。時間をおいてもう一度お試しください。'
    };
    const primaryPartialFailure = partialFailureReasons.find((reason) => reason !== 'thread_title' && reason !== 'status_tag')
      || partialFailureReasons[0];
    const replyMessage = partialFailureReasons.length
      ? partialMessageMap[primaryPartialFailure] || 'ステータスは更新しましたが、一部の更新に失敗しました。'
      : successMessage;

    logger.info(
      partialFailureReasons.length
        ? mode === 'resolve' ? 'Resolve completed with partial failure' : 'Unresolve completed with partial failure'
        : mode === 'resolve' ? 'Resolve success' : 'Unresolve success',
      {
        threadId: thread.id,
        userId: interaction.user.id,
        partialFailureReasons
      }
    );

    await interaction.editReply(replyMessage);
    if (partialFailureReasons.length) {
      logger.info('command reply sent with partial failure', {
        interactionId: interaction.id,
        threadId: thread.id,
        mode,
        partialFailureReasons
      });
    } else {
      logger.info('command reply sent', {
        interactionId: interaction.id,
        threadId: thread.id,
        mode
      });
    }
  } catch (error) {
    logger.error('question resolve/unresolve failed', {
      interactionId: interaction.id,
      threadId: interaction.channelId,
      mode,
      error: error.message
    });
    await interaction.editReply('ステータス更新中にエラーが発生しました。時間をおいてもう一度お試しください。').catch(() => null);
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
