async function collectForumThreads(forumChannel, logger) {
  const threads = new Map();

  const active = await forumChannel.threads.fetchActive(false).catch((error) => {
    logger.warn('Failed to fetch active threads', {
      forumId: forumChannel.id,
      error: error.message
    });
    return null;
  });

  for (const thread of active?.threads?.values?.() || []) {
    threads.set(thread.id, thread);
  }

  let before;
  let hasMore = true;

  while (hasMore) {
    const archived = await forumChannel.threads.fetchArchived({
      limit: 100,
      before
    }, false).catch((error) => {
      logger.warn('Failed to fetch archived threads', {
        forumId: forumChannel.id,
        before: before || null,
        error: error.message
      });
      return null;
    });

    if (!archived) {
      break;
    }

    const archivedThreads = Array.from(archived.threads.values());
    for (const thread of archivedThreads) {
      threads.set(thread.id, thread);
    }

    hasMore = Boolean(archived.hasMore) && archivedThreads.length > 0;
    before = archivedThreads.at(-1)?.id;
  }

  return Array.from(threads.values());
}

async function backfillQuestionTags({ client, guildId, config, logger, applyQuestionStatusTag }) {
  const guild = await client.guilds.fetch(guildId);
  const summary = {
    scannedForums: 0,
    scannedThreads: 0,
    updatedThreads: 0,
    failedThreads: 0
  };

  for (const forumId of config.watchedForums.question) {
    const forumChannel = await guild.channels.fetch(forumId).catch(() => null);

    if (!forumChannel?.threads) {
      logger.warn('Question forum channel was not found or has no threads manager', {
        forumId
      });
      continue;
    }

    summary.scannedForums += 1;
    const threads = await collectForumThreads(forumChannel, logger);

    for (const thread of threads) {
      summary.scannedThreads += 1;
      const status = thread.name?.startsWith(config.questions.resolvedPrefix) ? 'resolved' : 'open';

      try {
        await applyQuestionStatusTag(thread, status, { config, logger });
        summary.updatedThreads += 1;
        logger.info('Backfilled question thread tag', {
          forumId,
          threadId: thread.id,
          threadName: thread.name,
          appliedStatus: status
        });
      } catch (error) {
        summary.failedThreads += 1;
        logger.warn('Backfill failed for thread', {
          forumId,
          threadId: thread.id,
          threadName: thread.name,
          appliedStatus: status,
          error: error.message
        });
      }
    }
  }

  return summary;
}

module.exports = {
  backfillQuestionTags
};
