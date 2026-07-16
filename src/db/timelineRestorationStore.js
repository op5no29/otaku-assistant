const ACTIVE_RESTORATION_JOB_STATUSES = new Set(['active', 'retrying', 'completing']);
const RESUMABLE_RESTORATION_JOB_STATUSES = new Set(['cancelled', 'failed']);

function classifyRestorationJobRequest(existing, request) {
  if (!existing) return 'available';

  const requestedMode = String(request.mode || 'normal');
  const existingMode = String(existing.mode || 'normal');
  const requestedHistoricalOwnerId = String(request.historicalOwnerUserId || request.ownerUserId || '');
  const existingHistoricalOwnerId = String(existing.historicalOwnerUserId || existing.ownerUserId || '');

  if (existingHistoricalOwnerId !== requestedHistoricalOwnerId) {
    return 'conflict_different_historical_owner';
  }
  if (existingMode !== requestedMode) {
    return 'conflict_different_mode';
  }
  if (requestedMode === 'admin_test') {
    if (String(existing.initiatorUserId || '') !== String(request.initiatorUserId || '')) {
      return 'conflict_different_initiator';
    }
    if (String(existing.destinationTestThreadId || '') !== String(request.destinationThreadId || '')) {
      return 'conflict_different_test_destination';
    }
    if (String(existing.explicitSourceThreadId || '') !== String(request.explicitSourceThreadId || '')) {
      return 'conflict_different_source_thread';
    }
  } else if (String(existing.ownerUserId || '') !== String(request.ownerUserId || '')) {
    return 'conflict_different_real_owner';
  }

  if (ACTIVE_RESTORATION_JOB_STATUSES.has(existing.status)) return 'already_active';
  if (existing.status === 'completed') return 'already_completed';
  if (RESUMABLE_RESTORATION_JOB_STATUSES.has(existing.status)) return 'resumable_exact_match';
  return 'not_resumable';
}

function createTimelineRestorationStore(sqlite) {
  const membership = {
    getOpen: sqlite.prepare(`
      SELECT guild_id AS guildId, user_id AS userId, episode_id AS episodeId,
        joined_at AS joinedAt, left_at AS leftAt, username_at_join AS usernameAtJoin,
        global_name_at_join AS globalNameAtJoin, display_name_at_join AS displayNameAtJoin,
        nickname_at_join AS nicknameAtJoin, avatar_url_at_join AS avatarUrlAtJoin,
        avatar_hash_at_join AS avatarHashAtJoin, created_at AS createdAt, updated_at AS updatedAt
      FROM guild_member_membership_episodes
      WHERE guild_id = ? AND user_id = ? AND left_at IS NULL
      LIMIT 1
    `),
    nextId: sqlite.prepare(`
      SELECT COALESCE(MAX(episode_id), 0) + 1 AS episodeId
      FROM guild_member_membership_episodes
      WHERE guild_id = ? AND user_id = ?
    `),
    insert: sqlite.prepare(`
      INSERT INTO guild_member_membership_episodes (
        guild_id, user_id, episode_id, joined_at, left_at,
        username_at_join, global_name_at_join, display_name_at_join,
        nickname_at_join, avatar_url_at_join, avatar_hash_at_join,
        created_at, updated_at
      ) VALUES (
        @guildId, @userId, @episodeId, @joinedAt, NULL,
        @username, @globalName, @displayName,
        @nickname, @avatarUrl, @avatarHash,
        @createdAt, @updatedAt
      )
    `),
    close: sqlite.prepare(`
      UPDATE guild_member_membership_episodes
      SET left_at = ?, updated_at = ?
      WHERE guild_id = ? AND user_id = ? AND left_at IS NULL
    `),
    list: sqlite.prepare(`
      SELECT guild_id AS guildId, user_id AS userId, episode_id AS episodeId,
        joined_at AS joinedAt, left_at AS leftAt,
        display_name_at_join AS displayNameAtJoin, avatar_url_at_join AS avatarUrlAtJoin
      FROM guild_member_membership_episodes
      WHERE guild_id = ? AND user_id = ?
      ORDER BY episode_id ASC
    `)
  };

  const identity = {
    insert: sqlite.prepare(`
      INSERT OR IGNORE INTO guild_member_identity_history (
        guild_id, user_id, observed_at, event_type, username, global_name,
        display_name, nickname, avatar_url, avatar_hash, identity_fingerprint, created_at
      ) VALUES (
        @guildId, @userId, @observedAt, @eventType, @username, @globalName,
        @displayName, @nickname, @avatarUrl, @avatarHash, @identityFingerprint, @createdAt
      )
    `),
    nearest: sqlite.prepare(`
      SELECT username, global_name AS globalName, display_name AS displayName,
        nickname, avatar_url AS avatarUrl, avatar_hash AS avatarHash,
        observed_at AS observedAt, event_type AS eventType
      FROM guild_member_identity_history
      WHERE guild_id = ? AND user_id = ?
      ORDER BY ABS(julianday(observed_at) - julianday(?)) ASC, identity_id DESC
      LIMIT 1
    `)
  };

  const threads = {
    upsert: sqlite.prepare(`
      INSERT INTO timeline_user_threads (
        guild_id, owner_user_id, forum_channel_id, thread_id, thread_name,
        starter_message_id, status, deletion_reason, created_at,
        archived_at, locked_at, created_by_current_member_episode_id, updated_at
      ) VALUES (
        @guildId, @ownerUserId, @forumChannelId, @threadId, @threadName,
        @starterMessageId, @status, @deletionReason, @createdAt,
        @archivedAt, @lockedAt, @membershipEpisodeId, @updatedAt
      )
      ON CONFLICT(guild_id, thread_id) DO UPDATE SET
        owner_user_id = COALESCE(excluded.owner_user_id, timeline_user_threads.owner_user_id),
        forum_channel_id = excluded.forum_channel_id,
        thread_name = COALESCE(excluded.thread_name, timeline_user_threads.thread_name),
        starter_message_id = COALESCE(excluded.starter_message_id, timeline_user_threads.starter_message_id),
        archived_at = excluded.archived_at,
        locked_at = excluded.locked_at,
        updated_at = excluded.updated_at
    `),
    get: sqlite.prepare(`
      SELECT guild_id AS guildId, owner_user_id AS ownerUserId,
        forum_channel_id AS forumChannelId, thread_id AS threadId, thread_name AS threadName,
        starter_message_id AS starterMessageId, status, deletion_reason AS deletionReason,
        created_at AS createdAt, archived_at AS archivedAt, locked_at AS lockedAt,
        owner_left_at AS ownerLeftAt, preservation_started_at AS preservationStartedAt,
        preservation_completed_at AS preservationCompletedAt,
        deletion_requested_at AS deletionRequestedAt, deleted_at AS deletedAt,
        replacement_thread_id AS replacementThreadId, restoration_job_id AS restorationJobId,
        snapshot_count AS snapshotCount, media_count AS mediaCount,
        preservation_coverage_json AS preservationCoverageJson,
        created_by_current_member_episode_id AS createdByCurrentMemberEpisodeId,
        updated_at AS updatedAt
      FROM timeline_user_threads
      WHERE guild_id = ? AND thread_id = ?
      LIMIT 1
    `),
    listByOwner: sqlite.prepare(`
      SELECT guild_id AS guildId, owner_user_id AS ownerUserId,
        forum_channel_id AS forumChannelId, thread_id AS threadId, thread_name AS threadName,
        starter_message_id AS starterMessageId, status, deletion_reason AS deletionReason,
        created_at AS createdAt, owner_left_at AS ownerLeftAt,
        preservation_completed_at AS preservationCompletedAt, deleted_at AS deletedAt,
        replacement_thread_id AS replacementThreadId, restoration_job_id AS restorationJobId,
        snapshot_count AS snapshotCount, media_count AS mediaCount,
        preservation_coverage_json AS preservationCoverageJson, updated_at AS updatedAt
      FROM timeline_user_threads
      WHERE guild_id = ? AND owner_user_id = ?
      ORDER BY datetime(created_at) ASC, thread_id ASC
    `),
    markOwnerLeft: sqlite.prepare(`
      UPDATE timeline_user_threads
      SET owner_left_at = ?, updated_at = ?
      WHERE guild_id = ? AND owner_user_id = ?
        AND status IN ('active', 'preserving', 'preserved', 'preservation_incomplete')
    `),
    beginPreservation: sqlite.prepare(`
      UPDATE timeline_user_threads
      SET status = 'preserving', preservation_started_at = COALESCE(preservation_started_at, ?),
        updated_at = ?
      WHERE guild_id = ? AND thread_id = ? AND status <> 'deleted'
    `),
    finishPreservation: sqlite.prepare(`
      UPDATE timeline_user_threads
      SET status = ?, preservation_completed_at = ?, snapshot_count = ?, media_count = ?,
        preservation_coverage_json = ?, updated_at = ?
      WHERE guild_id = ? AND thread_id = ?
    `),
    markDeleted: sqlite.prepare(`
      UPDATE timeline_user_threads
      SET status = ?, deletion_reason = ?, deleted_at = ?, updated_at = ?
      WHERE guild_id = ? AND thread_id = ?
    `),
    setRestoration: sqlite.prepare(`
      UPDATE timeline_user_threads
      SET status = COALESCE(?, status), replacement_thread_id = ?, restoration_job_id = ?, updated_at = ?
      WHERE guild_id = ? AND thread_id = ?
    `),
    countSnapshots: sqlite.prepare(`
      SELECT COUNT(*) AS count FROM timeline_restore_snapshots
      WHERE guild_id = ? AND source_thread_id = ? AND restore_eligible = 1
    `),
    countMedia: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM timeline_restore_media m
      JOIN timeline_restore_snapshots s ON s.snapshot_id = m.snapshot_id
      WHERE s.guild_id = ? AND s.source_thread_id = ? AND m.download_status = 'complete'
    `)
  };

  const snapshots = {
    upsert: sqlite.prepare(`
      INSERT INTO timeline_restore_snapshots (
        guild_id, source_forum_id, source_thread_id, source_message_id,
        thread_owner_user_id, author_user_id, author_username_snapshot,
        author_global_name_snapshot, author_display_name_snapshot, author_nickname_snapshot,
        author_avatar_url_snapshot, author_avatar_hash_snapshot, author_avatar_source,
        author_is_bot, content, clean_content, attachments_json, embeds_json,
        components_json, stickers_json, reactions_json, referenced_source_message_id,
        referenced_author_user_id, referenced_author_name_snapshot,
        referenced_content_snapshot, reply_kind, message_type, sequence_snowflake,
        source_created_at, source_edited_at, source_deleted_at, timeline_message_id,
        timeline_channel_id, timeline_card_payload_json, timeline_card_author_avatar_url,
        snapshot_source, restoration_fidelity, restore_eligible, quality_json,
        created_at, updated_at
      ) VALUES (
        @guildId, @sourceForumId, @sourceThreadId, @sourceMessageId,
        @threadOwnerUserId, @authorUserId, @authorUsernameSnapshot,
        @authorGlobalNameSnapshot, @authorDisplayNameSnapshot, @authorNicknameSnapshot,
        @authorAvatarUrlSnapshot, @authorAvatarHashSnapshot, @authorAvatarSource,
        @authorIsBot, @content, @cleanContent, @attachmentsJson, @embedsJson,
        @componentsJson, @stickersJson, @reactionsJson, @referencedSourceMessageId,
        @referencedAuthorUserId, @referencedAuthorNameSnapshot,
        @referencedContentSnapshot, @replyKind, @messageType, @sequenceSnowflake,
        @sourceCreatedAt, @sourceEditedAt, @sourceDeletedAt, @timelineMessageId,
        @timelineChannelId, @timelineCardPayloadJson, @timelineCardAuthorAvatarUrl,
        @snapshotSource, @restorationFidelity, @restoreEligible, @qualityJson,
        @createdAt, @updatedAt
      )
      ON CONFLICT(guild_id, source_message_id) DO UPDATE SET
        source_forum_id = excluded.source_forum_id,
        source_thread_id = excluded.source_thread_id,
        thread_owner_user_id = excluded.thread_owner_user_id,
        author_user_id = excluded.author_user_id,
        author_username_snapshot = excluded.author_username_snapshot,
        author_global_name_snapshot = excluded.author_global_name_snapshot,
        author_display_name_snapshot = excluded.author_display_name_snapshot,
        author_nickname_snapshot = excluded.author_nickname_snapshot,
        author_avatar_url_snapshot = COALESCE(excluded.author_avatar_url_snapshot, timeline_restore_snapshots.author_avatar_url_snapshot),
        author_avatar_hash_snapshot = COALESCE(excluded.author_avatar_hash_snapshot, timeline_restore_snapshots.author_avatar_hash_snapshot),
        author_avatar_source = excluded.author_avatar_source,
        author_is_bot = excluded.author_is_bot,
        content = excluded.content,
        clean_content = excluded.clean_content,
        attachments_json = excluded.attachments_json,
        embeds_json = excluded.embeds_json,
        components_json = excluded.components_json,
        stickers_json = excluded.stickers_json,
        reactions_json = excluded.reactions_json,
        referenced_source_message_id = excluded.referenced_source_message_id,
        referenced_author_user_id = excluded.referenced_author_user_id,
        referenced_author_name_snapshot = excluded.referenced_author_name_snapshot,
        referenced_content_snapshot = excluded.referenced_content_snapshot,
        reply_kind = excluded.reply_kind,
        message_type = excluded.message_type,
        source_created_at = excluded.source_created_at,
        source_edited_at = excluded.source_edited_at,
        source_deleted_at = COALESCE(excluded.source_deleted_at, timeline_restore_snapshots.source_deleted_at),
        snapshot_source = excluded.snapshot_source,
        restoration_fidelity = excluded.restoration_fidelity,
        restore_eligible = excluded.restore_eligible,
        quality_json = excluded.quality_json,
        updated_at = excluded.updated_at
    `),
    get: sqlite.prepare(`
      SELECT * FROM timeline_restore_snapshots
      WHERE guild_id = ? AND source_message_id = ? LIMIT 1
    `),
    getById: sqlite.prepare(`SELECT * FROM timeline_restore_snapshots WHERE snapshot_id = ? LIMIT 1`),
    listByThreads: null,
    listByOwner: sqlite.prepare(`
      SELECT * FROM timeline_restore_snapshots
      WHERE guild_id = ? AND thread_owner_user_id = ? AND restore_eligible = 1
      ORDER BY datetime(source_created_at) ASC, sequence_snowflake ASC, snapshot_id ASC
    `),
    markDeleted: sqlite.prepare(`
      UPDATE timeline_restore_snapshots
      SET source_deleted_at = COALESCE(source_deleted_at, ?), updated_at = ?
      WHERE guild_id = ? AND source_message_id = ?
    `),
    updateTimeline: sqlite.prepare(`
      UPDATE timeline_restore_snapshots
      SET timeline_message_id = ?, timeline_channel_id = ?, timeline_card_payload_json = ?,
        timeline_card_author_avatar_url = COALESCE(?, timeline_card_author_avatar_url),
        quality_json = COALESCE(?, quality_json), updated_at = ?
      WHERE guild_id = ? AND source_message_id = ?
    `),
    listAllRelayed: sqlite.prepare(`
      SELECT * FROM (
        SELECT r.source_message_id AS sourceMessageId, r.destination_channel_id AS destinationChannelId,
          r.thread_id AS threadId, r.parent_channel_id AS parentChannelId,
          r.relay_kind AS relayKind, r.relayed_message_id AS relayedMessageId,
          r.author_id AS authorId, r.created_at AS createdAt
        FROM relayed_message_targets r
        WHERE r.forum_type = 'tweet'
        UNION ALL
        SELECT m.message_id AS sourceMessageId, NULL AS destinationChannelId,
          m.thread_id AS threadId, m.parent_channel_id AS parentChannelId,
          'legacy_message' AS relayKind, m.timeline_message_id AS relayedMessageId,
          m.author_id AS authorId, m.relayed_at AS createdAt
        FROM relayed_messages m
        WHERE m.forum_type = 'tweet'
        UNION ALL
        SELECT t.starter_message_id AS sourceMessageId, NULL AS destinationChannelId,
          t.thread_id AS threadId, t.parent_channel_id AS parentChannelId,
          'legacy_thread' AS relayKind, t.timeline_message_id AS relayedMessageId,
          t.author_id AS authorId, t.relayed_at AS createdAt
        FROM relayed_threads t
      )
      WHERE sourceMessageId IS NOT NULL AND relayedMessageId IS NOT NULL
      ORDER BY datetime(createdAt) ASC, sourceMessageId ASC
    `)
  };

  const media = {
    upsert: sqlite.prepare(`
      INSERT INTO timeline_restore_media (
        guild_id, snapshot_id, source_message_id, source_url, proxy_url,
        timeline_message_id, timeline_attachment_id, timeline_attachment_url,
        component_media_url, original_filename, safe_filename, content_type,
        byte_size, sha256, local_path, media_kind, source_kind, spoiler,
        width, height, duration_seconds, download_status, last_error_code,
        first_downloaded_at, last_verified_at, created_at, updated_at
      ) VALUES (
        @guildId, @snapshotId, @sourceMessageId, @sourceUrl, @proxyUrl,
        @timelineMessageId, @timelineAttachmentId, @timelineAttachmentUrl,
        @componentMediaUrl, @originalFilename, @safeFilename, @contentType,
        @byteSize, @sha256, @localPath, @mediaKind, @sourceKind, @spoiler,
        @width, @height, @durationSeconds, @downloadStatus, @lastErrorCode,
        @firstDownloadedAt, @lastVerifiedAt, @createdAt, @updatedAt
      )
      ON CONFLICT(snapshot_id, source_kind, source_url) DO UPDATE SET
        proxy_url = COALESCE(excluded.proxy_url, timeline_restore_media.proxy_url),
        timeline_message_id = COALESCE(excluded.timeline_message_id, timeline_restore_media.timeline_message_id),
        timeline_attachment_id = COALESCE(excluded.timeline_attachment_id, timeline_restore_media.timeline_attachment_id),
        timeline_attachment_url = COALESCE(excluded.timeline_attachment_url, timeline_restore_media.timeline_attachment_url),
        component_media_url = COALESCE(excluded.component_media_url, timeline_restore_media.component_media_url),
        original_filename = COALESCE(excluded.original_filename, timeline_restore_media.original_filename),
        safe_filename = COALESCE(excluded.safe_filename, timeline_restore_media.safe_filename),
        content_type = COALESCE(excluded.content_type, timeline_restore_media.content_type),
        byte_size = CASE WHEN excluded.byte_size > 0 THEN excluded.byte_size ELSE timeline_restore_media.byte_size END,
        sha256 = COALESCE(excluded.sha256, timeline_restore_media.sha256),
        local_path = COALESCE(excluded.local_path, timeline_restore_media.local_path),
        media_kind = excluded.media_kind,
        spoiler = excluded.spoiler,
        width = COALESCE(excluded.width, timeline_restore_media.width),
        height = COALESCE(excluded.height, timeline_restore_media.height),
        duration_seconds = COALESCE(excluded.duration_seconds, timeline_restore_media.duration_seconds),
        download_status = excluded.download_status,
        last_error_code = excluded.last_error_code,
        first_downloaded_at = COALESCE(timeline_restore_media.first_downloaded_at, excluded.first_downloaded_at),
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `),
    listBySnapshot: sqlite.prepare(`
      SELECT * FROM timeline_restore_media
      WHERE snapshot_id = ?
      ORDER BY media_id ASC
    `),
    listByMessage: sqlite.prepare(`
      SELECT * FROM timeline_restore_media
      WHERE guild_id = ? AND source_message_id = ?
      ORDER BY media_id ASC
    `),
    findCompleteByUrl: sqlite.prepare(`
      SELECT * FROM timeline_restore_media
      WHERE guild_id = ? AND source_url = ? AND download_status = 'complete' AND local_path IS NOT NULL
      ORDER BY media_id ASC LIMIT 1
    `),
    getById: sqlite.prepare(`SELECT * FROM timeline_restore_media WHERE media_id = ? LIMIT 1`)
  };

  const notices = {
    get: sqlite.prepare(`
      SELECT guild_id AS guildId, user_id AS userId, membership_episode_id AS membershipEpisodeId,
        welcome_dm_status AS welcomeDmStatus, welcome_dm_sent_at AS welcomeDmSentAt,
        restoration_dm_status AS restorationDmStatus, restoration_dm_sent_at AS restorationDmSentAt,
        last_error_code AS lastErrorCode, last_attempt_at AS lastAttemptAt,
        created_at AS createdAt, updated_at AS updatedAt
      FROM guild_member_return_notices
      WHERE guild_id = ? AND user_id = ? AND membership_episode_id = ?
      LIMIT 1
    `),
    upsert: sqlite.prepare(`
      INSERT INTO guild_member_return_notices (
        guild_id, user_id, membership_episode_id, welcome_dm_status,
        welcome_dm_sent_at, restoration_dm_status, restoration_dm_sent_at,
        last_error_code, last_attempt_at, created_at, updated_at
      ) VALUES (
        @guildId, @userId, @membershipEpisodeId, @welcomeDmStatus,
        @welcomeDmSentAt, @restorationDmStatus, @restorationDmSentAt,
        @lastErrorCode, @lastAttemptAt, @createdAt, @updatedAt
      )
      ON CONFLICT(guild_id, user_id, membership_episode_id) DO UPDATE SET
        welcome_dm_status = excluded.welcome_dm_status,
        welcome_dm_sent_at = COALESCE(excluded.welcome_dm_sent_at, guild_member_return_notices.welcome_dm_sent_at),
        restoration_dm_status = excluded.restoration_dm_status,
        restoration_dm_sent_at = COALESCE(excluded.restoration_dm_sent_at, guild_member_return_notices.restoration_dm_sent_at),
        last_error_code = excluded.last_error_code,
        last_attempt_at = excluded.last_attempt_at,
        updated_at = excluded.updated_at
    `)
  };

  const jobs = {
    get: sqlite.prepare(`SELECT * FROM timeline_restoration_jobs WHERE job_id = ? LIMIT 1`),
    getByThread: sqlite.prepare(`
      SELECT * FROM timeline_restoration_jobs
      WHERE guild_id = ? AND destination_thread_id = ? LIMIT 1
    `),
    listDue: sqlite.prepare(`
      SELECT * FROM timeline_restoration_jobs
      WHERE status IN ('active', 'retrying', 'completing')
        AND (next_run_at IS NULL OR datetime(next_run_at) <= datetime(?))
      ORDER BY datetime(COALESCE(next_run_at, created_at)) ASC, job_id ASC
      LIMIT ?
    `),
    insert: sqlite.prepare(`
      INSERT INTO timeline_restoration_jobs (
        guild_id, owner_user_id, mode, historical_owner_user_id, initiator_user_id,
        destination_test_thread_id, explicit_source_thread_id, source_selection_reason,
        source_selection_evidence_json, destination_forum_id, destination_thread_id,
        status, source_thread_ids_json, total_item_count, started_at, next_run_at,
        previous_thread_locked, previous_thread_archived, previous_slowmode_seconds,
        previous_applied_tags_json, created_at, updated_at
      ) VALUES (
        @guildId, @ownerUserId, @mode, @historicalOwnerUserId, @initiatorUserId,
        @destinationTestThreadId, @explicitSourceThreadId, @sourceSelectionReason,
        @sourceSelectionEvidenceJson, @destinationForumId, @destinationThreadId,
        @status, @sourceThreadIdsJson, @totalItemCount, @startedAt, @nextRunAt,
        @previousThreadLocked, @previousThreadArchived, @previousSlowmodeSeconds,
        @previousAppliedTagsJson, @createdAt, @updatedAt
      )
    `),
    resume: sqlite.prepare(`
      UPDATE timeline_restoration_jobs
      SET status = 'active', cancelled_at = NULL, last_error_code = NULL,
        next_run_at = ?, updated_at = ?
      WHERE job_id = ? AND status IN ('cancelled', 'failed')
    `),
    replaceProgressMessage: sqlite.prepare(`
      UPDATE timeline_restoration_jobs
      SET progress_message_id = ?, updated_at = ?
      WHERE job_id = ? AND COALESCE(progress_message_id, '') = ?
    `),
    claimCompletion: sqlite.prepare(`
      UPDATE timeline_restoration_jobs
      SET status = 'completing', last_processed_at = ?, next_run_at = ?, updated_at = ?
      WHERE job_id = ? AND status IN ('active', 'retrying')
    `),
    insertItem: sqlite.prepare(`
      INSERT OR IGNORE INTO timeline_restoration_items (
        job_id, snapshot_id, source_thread_id, source_message_id,
        sequence_index, status, author_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `),
    listItems: sqlite.prepare(`
      SELECT * FROM timeline_restoration_items
      WHERE job_id = ? ORDER BY sequence_index ASC, snapshot_id ASC
    `),
    listPendingItems: sqlite.prepare(`
      SELECT * FROM timeline_restoration_items
      WHERE job_id = ? AND status IN ('pending', 'posting', 'failed_retryable')
      ORDER BY sequence_index ASC, snapshot_id ASC
      LIMIT ?
    `)
  };

  const restored = {
    get: sqlite.prepare(`
      SELECT * FROM timeline_restored_message_map
      WHERE guild_id = ? AND destination_message_id = ? LIMIT 1
    `),
    insert: sqlite.prepare(`
      INSERT OR IGNORE INTO timeline_restored_message_map (
        guild_id, destination_message_id, destination_thread_id,
        snapshot_id, restoration_job_id, webhook_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getBySnapshotJob: sqlite.prepare(`
      SELECT * FROM timeline_restored_message_map
      WHERE restoration_job_id = ? AND snapshot_id = ? LIMIT 1
    `)
  };

  const webhooks = {
    get: sqlite.prepare(`
      SELECT guild_id AS guildId, forum_channel_id AS forumChannelId,
        webhook_id AS webhookId, updated_at AS updatedAt
      FROM timeline_restoration_webhooks
      WHERE guild_id = ? AND forum_channel_id = ? LIMIT 1
    `),
    upsert: sqlite.prepare(`
      INSERT INTO timeline_restoration_webhooks (guild_id, forum_channel_id, webhook_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, forum_channel_id) DO UPDATE SET
        webhook_id = excluded.webhook_id, updated_at = excluded.updated_at
    `),
    remove: sqlite.prepare(`DELETE FROM timeline_restoration_webhooks WHERE guild_id = ? AND forum_channel_id = ?`)
  };

  function mapSnapshot(row) {
    if (!row) return null;
    const mapped = {};
    for (const [key, value] of Object.entries(row)) {
      mapped[key.replace(/_([a-z])/g, (_, character) => character.toUpperCase())] = value;
    }
    return mapped;
  }

  function updateById(table, idColumn, id, fields, allowed) {
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    const names = entries.map(([key]) => `${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} = @${key}`);
    sqlite.prepare(`UPDATE ${table} SET ${names.join(', ')} WHERE ${idColumn} = @id`).run({
      id,
      ...Object.fromEntries(entries)
    });
  }

  const jobFields = new Set([
    'mode', 'historicalOwnerUserId', 'initiatorUserId', 'destinationTestThreadId',
    'explicitSourceThreadId', 'sourceSelectionReason', 'sourceSelectionEvidenceJson',
    'status', 'totalItemCount', 'completedItemCount', 'failedItemCount', 'skippedItemCount',
    'textRestoredCount', 'imageRestoredCount', 'videoRestoredCount', 'fileRestoredCount',
    'replyRestoredCount', 'unavailableMediaCount', 'currentSequence', 'progressPercent',
    'startedAt', 'lastProcessedAt', 'nextRunAt', 'completedAt', 'cancelledAt',
    'lastErrorCode', 'progressMessageId', 'completionMessageId', 'qualityJson', 'updatedAt'
  ]);
  const itemFields = new Set([
    'destinationMessageId', 'destinationWebhookId', 'status', 'attempts', 'authorNameUsed',
    'avatarUrlUsed', 'identitySourceUsed', 'textStatus', 'mediaStatus', 'replyStatus', 'lastErrorCode',
    'processedAt', 'updatedAt'
  ]);

  return {
    membership: {
      getOpen(guildId, userId) { return membership.getOpen.get(guildId, userId) || null; },
      open(record) {
        return sqlite.transaction(() => {
          const existing = membership.getOpen.get(record.guildId, record.userId);
          if (existing) return existing;
          const now = record.joinedAt || new Date().toISOString();
          const episodeId = Number(membership.nextId.get(record.guildId, record.userId).episodeId);
          membership.insert.run({
            ...record,
            episodeId,
            joinedAt: now,
            createdAt: record.createdAt || now,
            updatedAt: now
          });
          return membership.getOpen.get(record.guildId, record.userId);
        })();
      },
      close(guildId, userId, leftAt = new Date().toISOString()) {
        return membership.close.run(leftAt, leftAt, guildId, userId).changes;
      },
      list(guildId, userId) { return membership.list.all(guildId, userId); }
    },
    identities: {
      record(record) { return identity.insert.run(record).changes; },
      nearest(guildId, userId, at) { return identity.nearest.get(guildId, userId, at) || null; }
    },
    userThreads: {
      upsert(record) { threads.upsert.run(record); return threads.get.get(record.guildId, record.threadId); },
      get(guildId, threadId) { return threads.get.get(guildId, threadId) || null; },
      listByOwner(guildId, userId) { return threads.listByOwner.all(guildId, userId); },
      markOwnerLeft(guildId, userId, leftAt) { return threads.markOwnerLeft.run(leftAt, leftAt, guildId, userId).changes; },
      beginPreservation(guildId, threadId, at) { return threads.beginPreservation.run(at, at, guildId, threadId).changes; },
      finishPreservation(guildId, threadId, { status, snapshotCount, mediaCount, coverageJson, at }) {
        return threads.finishPreservation.run(status, at, snapshotCount, mediaCount, coverageJson, at, guildId, threadId).changes;
      },
      markDeleted(guildId, threadId, reason, at = new Date().toISOString(), status = 'deleted') {
        return threads.markDeleted.run(status, reason, at, at, guildId, threadId).changes;
      },
      setRestoration(guildId, threadId, { status = null, replacementThreadId, jobId }) {
        return threads.setRestoration.run(status, replacementThreadId, jobId, new Date().toISOString(), guildId, threadId).changes;
      },
      countSnapshots(guildId, threadId) { return Number(threads.countSnapshots.get(guildId, threadId)?.count || 0); },
      countMedia(guildId, threadId) { return Number(threads.countMedia.get(guildId, threadId)?.count || 0); }
    },
    snapshots: {
      upsert(record) { snapshots.upsert.run(record); return mapSnapshot(snapshots.get.get(record.guildId, record.sourceMessageId)); },
      get(guildId, messageId) { return mapSnapshot(snapshots.get.get(guildId, messageId)); },
      getById(snapshotId) { return mapSnapshot(snapshots.getById.get(snapshotId)); },
      listByOwner(guildId, userId) { return snapshots.listByOwner.all(guildId, userId).map(mapSnapshot); },
      listByThreads(guildId, threadIds) {
        const ids = [...new Set((threadIds || []).map(String).filter(Boolean))];
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(', ');
        return sqlite.prepare(`
          SELECT * FROM timeline_restore_snapshots
          WHERE guild_id = ? AND source_thread_id IN (${placeholders}) AND restore_eligible = 1
          ORDER BY datetime(source_created_at) ASC, sequence_snowflake ASC, snapshot_id ASC
        `).all(guildId, ...ids).map(mapSnapshot);
      },
      markDeleted(guildId, messageId, at = new Date().toISOString()) {
        return snapshots.markDeleted.run(at, at, guildId, messageId).changes;
      },
      updateTimeline(guildId, messageId, record) {
        return snapshots.updateTimeline.run(
          record.timelineMessageId || null,
          record.timelineChannelId || null,
          record.timelineCardPayloadJson || null,
          record.timelineCardAuthorAvatarUrl || null,
          record.qualityJson || null,
          new Date().toISOString(),
          guildId,
          messageId
        ).changes;
      },
      listRelayMappings() { return snapshots.listAllRelayed.all(); }
    },
    media: {
      upsert(record) { media.upsert.run(record); },
      listBySnapshot(snapshotId) { return media.listBySnapshot.all(snapshotId).map(mapSnapshot); },
      listByMessage(guildId, messageId) { return media.listByMessage.all(guildId, messageId).map(mapSnapshot); },
      findCompleteByUrl(guildId, url) { return mapSnapshot(media.findCompleteByUrl.get(guildId, url)); },
      getById(mediaId) { return mapSnapshot(media.getById.get(mediaId)); }
    },
    returnNotices: {
      get(guildId, userId, episodeId) { return notices.get.get(guildId, userId, episodeId) || null; },
      upsert(record) { notices.upsert.run(record); return notices.get.get(record.guildId, record.userId, record.membershipEpisodeId); }
    },
    jobs: {
      get(jobId) { return mapSnapshot(jobs.get.get(jobId)); },
      getByThread(guildId, threadId) { return mapSnapshot(jobs.getByThread.get(guildId, threadId)); },
      resolveRequest(request) {
        const existing = mapSnapshot(jobs.getByThread.get(request.guildId, request.destinationThreadId));
        return {
          outcome: classifyRestorationJobRequest(existing, request),
          job: existing
        };
      },
      listDue(now, limit = 1) { return jobs.listDue.all(now, limit).map(mapSnapshot); },
      create(record, snapshotRows) {
        return sqlite.transaction(() => {
          jobs.insert.run({
            mode: 'normal',
            historicalOwnerUserId: record.ownerUserId,
            initiatorUserId: record.ownerUserId,
            destinationTestThreadId: null,
            explicitSourceThreadId: null,
            sourceSelectionReason: null,
            sourceSelectionEvidenceJson: null,
            ...record
          });
          const jobId = Number(sqlite.prepare('SELECT last_insert_rowid() AS id').get().id);
          snapshotRows.forEach((snapshot, index) => {
            jobs.insertItem.run(
              jobId, snapshot.snapshotId, snapshot.sourceThreadId, snapshot.sourceMessageId,
              index + 1, snapshot.authorUserId || null, record.createdAt, record.updatedAt
            );
          });
          return mapSnapshot(jobs.get.get(jobId));
        })();
      },
      resumeExact(request, at = new Date().toISOString()) {
        return sqlite.transaction(() => {
          const existing = mapSnapshot(jobs.getByThread.get(request.guildId, request.destinationThreadId));
          const outcome = classifyRestorationJobRequest(existing, request);
          if (outcome !== 'resumable_exact_match') return { outcome, job: existing };
          const resumed = jobs.resume.run(at, at, existing.jobId);
          if (!resumed.changes) {
            const current = mapSnapshot(jobs.get.get(existing.jobId));
            return { outcome: classifyRestorationJobRequest(current, request), job: current };
          }
          return { outcome: 'resumed_exact_match', job: mapSnapshot(jobs.get.get(existing.jobId)) };
        })();
      },
      replaceProgressMessage(jobId, expectedCurrentMessageId, replacementMessageId, at = new Date().toISOString()) {
        return sqlite.transaction(() => {
          const updated = jobs.replaceProgressMessage.run(
            replacementMessageId,
            at,
            jobId,
            String(expectedCurrentMessageId || '')
          );
          return {
            updated: updated.changes === 1,
            job: mapSnapshot(jobs.get.get(jobId))
          };
        })();
      },
      claimCompletion(jobId, at = new Date().toISOString()) {
        return jobs.claimCompletion.run(at, at, at, jobId).changes;
      },
      update(jobId, fields) { updateById('timeline_restoration_jobs', 'job_id', jobId, fields, jobFields); return mapSnapshot(jobs.get.get(jobId)); },
      listItems(jobId) { return jobs.listItems.all(jobId).map(mapSnapshot); },
      listPendingItems(jobId, limit) { return jobs.listPendingItems.all(jobId, limit).map(mapSnapshot); },
      updateItem(jobId, snapshotId, fields) {
        const entries = Object.entries(fields).filter(([key]) => itemFields.has(key));
        if (!entries.length) return;
        const names = entries.map(([key]) => `${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)} = @${key}`);
        sqlite.prepare(`
          UPDATE timeline_restoration_items SET ${names.join(', ')}
          WHERE job_id = @jobId AND snapshot_id = @snapshotId
        `).run({ jobId, snapshotId, ...Object.fromEntries(entries) });
      },
      getItem(jobId, snapshotId) {
        const row = sqlite.prepare(`
          SELECT * FROM timeline_restoration_items WHERE job_id = ? AND snapshot_id = ? LIMIT 1
        `).get(jobId, snapshotId);
        return mapSnapshot(row);
      }
    },
    restoredMessages: {
      get(guildId, messageId) { return mapSnapshot(restored.get.get(guildId, messageId)); },
      getBySnapshotJob(jobId, snapshotId) { return mapSnapshot(restored.getBySnapshotJob.get(jobId, snapshotId)); },
      insert(record) {
        return restored.insert.run(
          record.guildId, record.destinationMessageId, record.destinationThreadId,
          record.snapshotId, record.restorationJobId, record.webhookId || null,
          record.createdAt || new Date().toISOString()
        ).changes;
      }
    },
    webhooks: {
      get(guildId, forumId) { return webhooks.get.get(guildId, forumId) || null; },
      upsert(guildId, forumId, webhookId) { webhooks.upsert.run(guildId, forumId, webhookId, new Date().toISOString()); },
      remove(guildId, forumId) { webhooks.remove.run(guildId, forumId); }
    },
    audit: {
      record({ guildId, sourceMessageId = null, timelineMessageId, status, beforeJson = null, afterJson = null, errorCode = null }) {
        sqlite.prepare(`
          INSERT INTO timeline_media_audit_log (
            guild_id, source_message_id, timeline_message_id, status,
            before_json, after_json, error_code, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(guildId, sourceMessageId, timelineMessageId, status, beforeJson, afterJson, errorCode, new Date().toISOString());
      }
    }
  };
}

module.exports = {
  createTimelineRestorationStore
};
