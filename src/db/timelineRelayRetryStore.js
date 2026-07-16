function createTimelineRelayRetryStore(sqlite) {
  const get = sqlite.prepare(`
    SELECT
      guild_id AS guildId,
      source_message_id AS sourceMessageId,
      source_channel_id AS sourceChannelId,
      destination_channel_id AS destinationChannelId,
      relay_kind AS relayKind,
      fallback_message_id AS fallbackMessageId,
      status,
      attempts,
      max_attempts AS maxAttempts,
      next_attempt_at AS nextAttemptAt,
      last_error_code AS lastErrorCode,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM timeline_relay_retry_jobs
    WHERE source_message_id = ? AND destination_channel_id = ?
  `);
  const listDue = sqlite.prepare(`
    SELECT
      guild_id AS guildId,
      source_message_id AS sourceMessageId,
      source_channel_id AS sourceChannelId,
      destination_channel_id AS destinationChannelId,
      relay_kind AS relayKind,
      fallback_message_id AS fallbackMessageId,
      status,
      attempts,
      max_attempts AS maxAttempts,
      next_attempt_at AS nextAttemptAt,
      last_error_code AS lastErrorCode,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM timeline_relay_retry_jobs
    WHERE status = 'pending'
      AND attempts < max_attempts
      AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT ?
  `);
  const upsert = sqlite.prepare(`
    INSERT INTO timeline_relay_retry_jobs (
      guild_id, source_message_id, source_channel_id, destination_channel_id,
      relay_kind, fallback_message_id, status, attempts, max_attempts,
      next_attempt_at, last_error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
    ON CONFLICT(source_message_id, destination_channel_id) DO UPDATE SET
      guild_id = excluded.guild_id,
      source_channel_id = excluded.source_channel_id,
      relay_kind = excluded.relay_kind,
      fallback_message_id = COALESCE(excluded.fallback_message_id, timeline_relay_retry_jobs.fallback_message_id),
      status = 'pending',
      attempts = CASE
        WHEN timeline_relay_retry_jobs.status IN ('completed', 'failed') THEN 0
        ELSE timeline_relay_retry_jobs.attempts
      END,
      max_attempts = excluded.max_attempts,
      next_attempt_at = excluded.next_attempt_at,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at
  `);
  const markCompleted = sqlite.prepare(`
    UPDATE timeline_relay_retry_jobs
    SET status = 'completed', fallback_message_id = COALESCE(?, fallback_message_id),
        last_error_code = NULL, updated_at = ?
    WHERE source_message_id = ? AND destination_channel_id = ?
  `);
  const markRetry = sqlite.prepare(`
    UPDATE timeline_relay_retry_jobs
    SET attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
        next_attempt_at = ?, last_error_code = ?, updated_at = ?
    WHERE source_message_id = ? AND destination_channel_id = ?
  `);

  return {
    get(sourceMessageId, destinationChannelId) {
      return get.get(String(sourceMessageId), String(destinationChannelId)) || null;
    },
    listDue(nowIso = new Date().toISOString(), limit = 10) {
      return listDue.all(nowIso, Math.max(1, Math.min(Number(limit) || 10, 50)));
    },
    schedule({
      guildId,
      sourceMessageId,
      sourceChannelId,
      destinationChannelId,
      relayKind = 'timeline',
      fallbackMessageId = null,
      errorCode = 'attachment_copy_pending',
      maxAttempts = 5,
      nextAttemptAt = new Date(Date.now() + 60_000).toISOString()
    }) {
      const now = new Date().toISOString();
      upsert.run(
        String(guildId),
        String(sourceMessageId),
        String(sourceChannelId),
        String(destinationChannelId),
        String(relayKind),
        fallbackMessageId ? String(fallbackMessageId) : null,
        Math.max(1, Number(maxAttempts) || 5),
        nextAttemptAt,
        String(errorCode || 'attachment_copy_pending'),
        now,
        now
      );
      return this.get(sourceMessageId, destinationChannelId);
    },
    complete(sourceMessageId, destinationChannelId, fallbackMessageId = null) {
      markCompleted.run(
        fallbackMessageId ? String(fallbackMessageId) : null,
        new Date().toISOString(),
        String(sourceMessageId),
        String(destinationChannelId)
      );
      return this.get(sourceMessageId, destinationChannelId);
    },
    failAttempt(sourceMessageId, destinationChannelId, errorCode = 'retry_failed', delayMs = 60_000) {
      markRetry.run(
        new Date(Date.now() + Math.max(1_000, Number(delayMs) || 60_000)).toISOString(),
        String(errorCode || 'retry_failed'),
        new Date().toISOString(),
        String(sourceMessageId),
        String(destinationChannelId)
      );
      return this.get(sourceMessageId, destinationChannelId);
    }
  };
}

module.exports = { createTimelineRelayRetryStore };
