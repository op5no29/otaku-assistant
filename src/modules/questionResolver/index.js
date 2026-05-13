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
    const targetStatus = mode === 'resolve' ? 'resolved' : 'open';
    logger.info('question state loaded', {
      interactionId: interaction.id,
      threadId: thread.id,
      currentStatus,
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

    const newName = mode === 'resolve'
      ? addPrefix(currentName, prefix)
      : removePrefix(currentName, prefix);

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
    }

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
      logger.warn('tag update partial failure', {
        threadId: thread.id,
        mode,
        error: error.message
      });
    }

    logger.info('DB update started', {
      threadId: thread.id,
      mode
    });
    try {
      if (mode === 'resolve') {
        interaction.client.db.questions.markResolved(thread.id);
      } else {
        updateResolvedState(interaction.client.db, thread.id, null);
      }
      logger.info('DB update finished', {
        threadId: thread.id,
        mode
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
      mode
    });
    try {
      await withTimeout(updateQuestionTimelineCard(workingThread, {
        config,
        db: interaction.client.db,
        logger
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

    const successMessage = mode === 'resolve'
      ? 'この質問を解決済みにしました。'
      : 'この質問を受付中に戻しました。';
    const partialMessageMap = {
      thread_title: 'ステータスは更新しましたが、スレッドタイトルの更新に失敗しました。少し後で再試行される可能性があります。',
      status_tag: 'ステータスは更新しましたが、フォーラムタグの更新に失敗しました。',
      timeline_card: 'ステータスは更新しましたが、タイムラインカードの更新に失敗しました。',
      db: 'ステータス更新処理の一部に失敗しました。'
    };
    const replyMessage = partialFailureReasons.length
      ? partialMessageMap[partialFailureReasons[0]] || 'ステータスは更新しましたが、一部の更新に失敗しました。'
      : successMessage;

    logger.info(mode === 'resolve' ? 'Resolve success' : 'Unresolve success', {
      threadId: thread.id,
      userId: interaction.user.id,
      partialFailureReasons
    });

    await interaction.editReply(replyMessage);
    logger.info('command reply sent with partial failure', {
      interactionId: interaction.id,
      threadId: thread.id,
      mode,
      partialFailureReasons
    });
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
