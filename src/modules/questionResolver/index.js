const { ChannelType } = require('discord.js');
const { setTimeout: sleep } = require('node:timers/promises');
const { updateResolvedState } = require('./resolveThread');
const { applyQuestionStatusTag, areQuestionStatusTagsAlreadyCorrect } = require('./threadTags');
const { canManageQuestionThread } = require('../../utils/permissions');
const { addPrefix, removePrefix } = require('../../utils/text');
const { updateQuestionTimelineCard } = require('../timelineRelay');
const THREAD_NAME_MAX_LENGTH = 100;

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
  const baseTitle = removePrefix(String(currentName || ''), prefix).trim();
  if (targetStatus !== 'resolved') {
    return baseTitle.slice(0, THREAD_NAME_MAX_LENGTH);
  }

  const prefixedTitle = addPrefix(baseTitle, prefix);
  if (prefixedTitle.length <= THREAD_NAME_MAX_LENGTH) {
    return prefixedTitle;
  }

  const availableBaseLength = Math.max(0, THREAD_NAME_MAX_LENGTH - String(prefix || '').length);
  const truncatedBase = baseTitle.slice(0, availableBaseLength).trimEnd();
  return addPrefix(truncatedBase, prefix).slice(0, THREAD_NAME_MAX_LENGTH);
}

function getCurrentTagNames(thread) {
  const availableTags = Array.isArray(thread?.parent?.availableTags)
    ? thread.parent.availableTags
    : Array.isArray(thread?.parent?.availableTags?.values?.())
      ? Array.from(thread.parent.availableTags.values())
      : [];
  const tagNameById = new Map(availableTags.map((tag) => [String(tag.id), String(tag.name || '')]));
  return (thread?.appliedTags || []).map((tagId) => tagNameById.get(String(tagId)) || String(tagId));
}

function getQuestionVisualState(thread, targetStatus, config) {
  const prefix = config.questions.resolvedPrefix;
  const desiredTitle = buildDesiredThreadTitle(thread?.name || '', targetStatus, prefix);
  const titleHasResolvedPrefix = String(thread?.name || '').startsWith(prefix);
  const currentTagNames = getCurrentTagNames(thread);
  const visualInSync = String(thread?.name || '') === desiredTitle
    && areQuestionStatusTagsAlreadyCorrect(thread, targetStatus, config);

  return {
    desiredTitle,
    titleHasResolvedPrefix,
    currentTagNames,
    visualInSync
  };
}

function getDbQuestionStatus(client, threadId) {
  const questionRecord = client.db.questions.getQuestionThread(threadId);
  return questionRecord?.resolvedAt ? 'resolved' : 'open';
}

async function performQuestionVisualSync({ client, threadId, targetStatus, logger, syncAttempt = 'initial' }) {
  logger.info('visual sync started', {
    threadId,
    targetStatus,
    syncAttempt
  });

  const dbStatus = getDbQuestionStatus(client, threadId);
  if (dbStatus !== targetStatus) {
    logger.info('visual sync skipped stale target', {
      threadId,
      targetStatus,
      dbStatus,
      syncAttempt,
      reason: 'stale_sync_target'
    });
    return { skipped: true, reason: 'stale_sync_target' };
  }

  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread?.isThread?.()) {
    throw new Error('thread_not_found');
  }

  const config = client.appConfig;
  const prefix = config.questions.resolvedPrefix;
  const desiredName = buildDesiredThreadTitle(thread.name || '', targetStatus, prefix);
  logger.info('question visual sync title computed', {
    threadId,
    targetStatus,
    syncAttempt,
    originalTitleLength: String(thread.name || '').length,
    finalTitleLength: String(desiredName || '').length,
    truncated: String(desiredName || '').length < String(thread.name || '').length && targetStatus === 'resolved'
  });

  if ((thread.name || '') === desiredName) {
    logger.info('title sync skipped/already correct', {
      threadId,
      targetStatus,
      syncAttempt,
      currentName: thread.name || ''
    });
  } else {
    await withTimeout(
      thread.setName(
        desiredName,
        `Question status sync ${syncAttempt} to ${targetStatus}`
      ),
      15_000,
      'thread_set_name'
    );
  }

  if (areQuestionStatusTagsAlreadyCorrect(thread, targetStatus, config)) {
    logger.info('tag sync skipped/already correct', {
      threadId,
      targetStatus,
      syncAttempt,
      appliedTags: thread.appliedTags || []
    });
  } else {
    await withTimeout(
      applyQuestionStatusTag(thread, targetStatus, {
        config,
        logger
      }),
      10_000,
      'apply_question_status_tag'
    );
  }

  logger.info('visual sync finished', {
    threadId,
    targetStatus,
    syncAttempt
  });
  return { skipped: false };
}

function scheduleQuestionVisualSyncRetry({ client, threadId, targetStatus, logger, reason, delayMs = 45_000 }) {
  logger.warn('sync retry scheduled', {
    threadId,
    targetStatus,
    reason,
    retryDelayMs: delayMs
  });

  setTimeout(async () => {
    try {
      await performQuestionVisualSync({
        client,
        threadId,
        targetStatus,
        logger,
        syncAttempt: 'retry'
      });
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
  }, delayMs);
}

function scheduleQuestionVisualSync({ client, threadId, targetStatus, logger }) {
  logger.info('visual sync scheduled', {
    threadId,
    targetStatus
  });

  setTimeout(async () => {
    try {
      await performQuestionVisualSync({
        client,
        threadId,
        targetStatus,
        logger,
        syncAttempt: 'initial'
      });
    } catch (error) {
      logger.warn('visual sync failed', {
        threadId,
        targetStatus,
        error: error.message
      });
      scheduleQuestionVisualSyncRetry({
        client,
        threadId,
        targetStatus,
        logger,
        reason: error.message
      });
    }
  }, 0);
}

async function repairQuestionVisualState({ client, thread, targetStatus, logger }) {
  logger.info('question visual repair started', {
    threadId: thread.id,
    targetStatus
  });
  try {
    await performQuestionVisualSync({
      client,
      threadId: thread.id,
      targetStatus,
      logger,
      syncAttempt: 'repair'
    });
    logger.info('question visual repair finished', {
      threadId: thread.id,
      targetStatus
    });
    return true;
  } catch (error) {
    logger.warn('question visual repair failed', {
      threadId: thread.id,
      targetStatus,
      error: error.message
    });
    return false;
  }
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
    const visualState = getQuestionVisualState(thread, targetStatus, config);
    logger.info('question visual state checked', {
      interactionId: interaction.id,
      threadId: thread.id,
      dbStatus: currentStatus,
      targetStatus,
      titleHasResolvedPrefix: visualState.titleHasResolvedPrefix,
      currentTagNames: visualState.currentTagNames,
      visualInSync: visualState.visualInSync
    });

    if (mode === 'resolve' && currentStatus === 'resolved') {
      if (visualState.visualInSync) {
        await interaction.editReply('この質問はすでに解決済みです。');
      } else {
        const repaired = await repairQuestionVisualState({
          client: interaction.client,
          thread,
          targetStatus,
          logger
        });
        await interaction.editReply(
          repaired
            ? 'この質問はすでに解決済みでしたが、表示を修正しました。'
            : 'ステータスは解決済みですが、表示同期に失敗しました。'
        );
      }
      return;
    }

    if (mode === 'unresolve' && currentStatus === 'open') {
      if (visualState.visualInSync) {
        await interaction.editReply('この質問はまだ解決済みになっていません。');
      } else {
        const repaired = await repairQuestionVisualState({
          client: interaction.client,
          thread,
          targetStatus,
          logger
        });
        await interaction.editReply(
          repaired
            ? 'この質問はすでに受付中でしたが、表示を修正しました。'
            : 'ステータスは受付中ですが、表示同期に失敗しました。'
        );
      }
      return;
    }

    const partialFailureReasons = [];
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
      await withTimeout(updateQuestionTimelineCard(thread, {
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

    const successMessage = mode === 'resolve'
      ? 'この質問を解決済みにしました。'
      : 'この質問を受付中に戻しました。';
    const partialMessageMap = {
      timeline_card: 'ステータスは更新しましたが、タイムラインカードの更新に失敗しました。',
      db: '内部状態の更新に失敗しました。時間をおいてもう一度お試しください。'
    };
    const primaryPartialFailure = partialFailureReasons[0];
    const replyMessage = partialFailureReasons.length
      ? partialMessageMap[primaryPartialFailure] || 'ステータスは更新しましたが、一部の更新に失敗しました。'
      : `${successMessage}\nスレッドタイトル/タグはバックグラウンドで同期します。`;

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
    logger.info('command critical update finished', {
      interactionId: interaction.id,
      threadId: thread.id,
      mode,
      targetStatus,
      partialFailureReasons
    });
    if (partialFailureReasons.length) {
      logger.info('command reply sent with partial failure', {
        interactionId: interaction.id,
        threadId: thread.id,
        mode,
        partialFailureReasons
      });
    } else {
      logger.info('command reply sent before visual sync', {
        interactionId: interaction.id,
        threadId: thread.id,
        mode
      });
    }

    scheduleQuestionVisualSync({
      client: interaction.client,
      threadId: thread.id,
      targetStatus,
      logger
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
    logger.info('lock released before visual sync', {
      interactionId: interaction.id,
      threadId: interaction.channelId,
      mode
    });
  }
}

module.exports = {
  resolveThread
};
