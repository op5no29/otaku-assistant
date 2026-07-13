const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

function createDatabase(databasePath) {
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  runMigrations(sqlite);

  const statements = {
    hasThreadRelay: sqlite.prepare('SELECT 1 FROM relayed_threads WHERE thread_id = ? LIMIT 1'),
    getThreadRelay: sqlite.prepare(`
      SELECT
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        starter_message_id AS starterMessageId,
        timeline_message_id AS timelineMessageId,
        author_id AS authorId,
        relayed_at AS relayedAt
      FROM relayed_threads
      WHERE thread_id = ?
      LIMIT 1
    `),
    insertThreadRelay: sqlite.prepare(`
      INSERT INTO relayed_threads (
        thread_id,
        parent_channel_id,
        starter_message_id,
        timeline_message_id,
        author_id,
        relayed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    hasMessageRelay: sqlite.prepare('SELECT 1 FROM relayed_messages WHERE message_id = ? LIMIT 1'),
    getMessageRelay: sqlite.prepare(`
      SELECT
        message_id AS messageId,
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        forum_type AS forumType,
        timeline_message_id AS timelineMessageId,
        author_id AS authorId,
        relayed_at AS relayedAt
      FROM relayed_messages
      WHERE message_id = ?
      LIMIT 1
    `),
    listMessageRelaysByTimelineMessageId: sqlite.prepare(`
      SELECT
        message_id AS messageId,
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        forum_type AS forumType,
        timeline_message_id AS timelineMessageId,
        author_id AS authorId,
        relayed_at AS relayedAt
      FROM relayed_messages
      WHERE timeline_message_id = ?
      ORDER BY relayed_at ASC
    `),
    deleteMessageRelaysByTimelineMessageId: sqlite.prepare(`
      DELETE FROM relayed_messages
      WHERE timeline_message_id = ?
    `),
    getLogDashboardMessage: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        channel_id AS channelId,
        dashboard_kind AS dashboardKind,
        message_id AS messageId,
        last_payload_json AS lastPayloadJson,
        recent_events_json AS recentEventsJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM bot_log_dashboard_messages
      WHERE guild_id = ? AND dashboard_kind = ?
      LIMIT 1
    `),
    listLogDashboardMessages: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        channel_id AS channelId,
        dashboard_kind AS dashboardKind,
        message_id AS messageId,
        last_payload_json AS lastPayloadJson,
        recent_events_json AS recentEventsJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM bot_log_dashboard_messages
      WHERE guild_id = ?
      ORDER BY dashboard_kind ASC
    `),
    upsertLogDashboardMessage: sqlite.prepare(`
      INSERT INTO bot_log_dashboard_messages (
        guild_id,
        channel_id,
        dashboard_kind,
        message_id,
        last_payload_json,
        recent_events_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, dashboard_kind) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        last_payload_json = excluded.last_payload_json,
        recent_events_json = excluded.recent_events_json,
        updated_at = excluded.updated_at
    `),
    listMessageRelayTargets: sqlite.prepare(`
      SELECT
        source_message_id AS sourceMessageId,
        destination_channel_id AS destinationChannelId,
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        forum_type AS forumType,
        relay_kind AS relayKind,
        relayed_message_id AS relayedMessageId,
        author_id AS authorId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM relayed_message_targets
      WHERE source_message_id = ?
      ORDER BY created_at ASC
    `),
    getMessageRelayTarget: sqlite.prepare(`
      SELECT
        source_message_id AS sourceMessageId,
        destination_channel_id AS destinationChannelId,
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        forum_type AS forumType,
        relay_kind AS relayKind,
        relayed_message_id AS relayedMessageId,
        author_id AS authorId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM relayed_message_targets
      WHERE source_message_id = ? AND destination_channel_id = ?
      LIMIT 1
    `),
    listMessageRelayTargetsByRelayedMessageId: sqlite.prepare(`
      SELECT
        source_message_id AS sourceMessageId,
        destination_channel_id AS destinationChannelId,
        thread_id AS threadId,
        parent_channel_id AS parentChannelId,
        forum_type AS forumType,
        relay_kind AS relayKind,
        relayed_message_id AS relayedMessageId,
        author_id AS authorId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM relayed_message_targets
      WHERE relayed_message_id = ?
      ORDER BY created_at ASC
    `),
    upsertMessageRelayTarget: sqlite.prepare(`
      INSERT INTO relayed_message_targets (
        source_message_id,
        destination_channel_id,
        thread_id,
        parent_channel_id,
        forum_type,
        relay_kind,
        relayed_message_id,
        author_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_message_id, destination_channel_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        parent_channel_id = excluded.parent_channel_id,
        forum_type = excluded.forum_type,
        relay_kind = excluded.relay_kind,
        relayed_message_id = excluded.relayed_message_id,
        author_id = excluded.author_id,
        updated_at = excluded.updated_at
    `),
    deleteMessageRelayTarget: sqlite.prepare(`
      DELETE FROM relayed_message_targets
      WHERE source_message_id = ? AND destination_channel_id = ?
    `),
    deleteMessageRelayTargetsByRelayedMessageId: sqlite.prepare(`
      DELETE FROM relayed_message_targets
      WHERE relayed_message_id = ?
    `),
    insertMessageRelay: sqlite.prepare(`
      INSERT INTO relayed_messages (
        message_id,
        thread_id,
        parent_channel_id,
        forum_type,
        timeline_message_id,
        author_id,
        relayed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    upsertQuestionThread: sqlite.prepare(`
      INSERT INTO question_threads (
        thread_id,
        author_id,
        created_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        author_id = excluded.author_id
    `),
    markResolved: sqlite.prepare(`
      UPDATE question_threads
      SET resolved_at = ?
      WHERE thread_id = ?
    `),
    ensureQuestionThread: sqlite.prepare(`
      INSERT OR IGNORE INTO question_threads (
        thread_id,
        author_id,
        created_at
      ) VALUES (?, ?, ?)
    `),
    getQuestionThread: sqlite.prepare(`
      SELECT
        thread_id AS threadId,
        author_id AS authorId,
        created_at AS createdAt,
        resolved_at AS resolvedAt,
        guide_message_id AS guideMessageId,
        guide_sent_at AS guideSentAt
      FROM question_threads
      WHERE thread_id = ?
      LIMIT 1
    `),
    clearResolved: sqlite.prepare(`
      UPDATE question_threads
      SET resolved_at = NULL
      WHERE thread_id = ?
    `),
    setQuestionGuideMessage: sqlite.prepare(`
      UPDATE question_threads
      SET guide_message_id = ?,
          guide_sent_at = ?
      WHERE thread_id = ?
    `),
    upsertQuestionRolePrompt: sqlite.prepare(`
      INSERT INTO question_role_prompts (
        thread_id,
        guild_id,
        author_user_id,
        prompt_message_id,
        selected_role_ids_json,
        status,
        relayed_message_id,
        expires_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        author_user_id = excluded.author_user_id,
        prompt_message_id = excluded.prompt_message_id,
        selected_role_ids_json = excluded.selected_role_ids_json,
        status = excluded.status,
        relayed_message_id = excluded.relayed_message_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
    getQuestionRolePrompt: sqlite.prepare(`
      SELECT
        thread_id AS threadId,
        guild_id AS guildId,
        author_user_id AS authorUserId,
        prompt_message_id AS promptMessageId,
        selected_role_ids_json AS selectedRoleIdsJson,
        status,
        relayed_message_id AS relayedMessageId,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM question_role_prompts
      WHERE thread_id = ?
      LIMIT 1
    `),
    listPendingQuestionRolePrompts: sqlite.prepare(`
      SELECT
        thread_id AS threadId,
        guild_id AS guildId,
        author_user_id AS authorUserId,
        prompt_message_id AS promptMessageId,
        selected_role_ids_json AS selectedRoleIdsJson,
        status,
        relayed_message_id AS relayedMessageId,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM question_role_prompts
      WHERE status = 'pending'
      ORDER BY expires_at ASC
    `),
    markQuestionRolePromptStatus: sqlite.prepare(`
      UPDATE question_role_prompts
      SET selected_role_ids_json = ?,
          status = ?,
          relayed_message_id = ?,
          updated_at = ?
      WHERE thread_id = ?
    `),
    upsertRolePanelMessage: sqlite.prepare(`
      INSERT INTO role_panel_messages (
        guild_id,
        panel_kind,
        channel_id,
        message_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, panel_kind) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `),
    getRolePanelMessage: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        panel_kind AS panelKind,
        channel_id AS channelId,
        message_id AS messageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM role_panel_messages
      WHERE guild_id = ? AND panel_kind = ?
      LIMIT 1
    `),
    getRolePanelMessageByMessageId: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        panel_kind AS panelKind,
        channel_id AS channelId,
        message_id AS messageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM role_panel_messages
      WHERE message_id = ?
      LIMIT 1
    `),
    getVcProfileMessage: sqlite.prepare(`
      SELECT
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        user_id AS userId,
        message_id AS messageId,
        voice_channel_id AS voiceChannelId,
        voice_channel_name AS voiceChannelName,
        created_at AS createdAt
      FROM vc_profile_messages
      WHERE category_id = ? AND user_id = ?
      LIMIT 1
    `),
    upsertVcProfileMessage: sqlite.prepare(`
      INSERT INTO vc_profile_messages (
        category_id,
        profile_channel_id,
        user_id,
        message_id,
        voice_channel_id,
        voice_channel_name,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(category_id, user_id) DO UPDATE SET
        profile_channel_id = excluded.profile_channel_id,
        message_id = excluded.message_id,
        voice_channel_id = excluded.voice_channel_id,
        voice_channel_name = excluded.voice_channel_name,
        created_at = excluded.created_at
    `),
    deleteVcProfileMessage: sqlite.prepare(`
      DELETE FROM vc_profile_messages
      WHERE category_id = ? AND user_id = ?
    `),
    getVcChannelProfileMessage: sqlite.prepare(`
      SELECT
        category_id AS categoryId,
        voice_channel_id AS voiceChannelId,
        profile_channel_id AS profileChannelId,
        message_id AS messageId,
        updated_at AS updatedAt
      FROM vc_channel_profile_messages
      WHERE voice_channel_id = ?
      LIMIT 1
    `),
    listVcChannelProfileMessagesByCategory: sqlite.prepare(`
      SELECT
        category_id AS categoryId,
        voice_channel_id AS voiceChannelId,
        profile_channel_id AS profileChannelId,
        message_id AS messageId,
        updated_at AS updatedAt
      FROM vc_channel_profile_messages
      WHERE category_id = ?
    `),
    getVcCategoryProfileMessage: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        message_id AS messageId,
        updated_at AS updatedAt
      FROM vc_category_profile_messages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
      LIMIT 1
    `),
    upsertVcCategoryProfileMessage: sqlite.prepare(`
      INSERT INTO vc_category_profile_messages (
        guild_id,
        category_id,
        profile_channel_id,
        message_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, category_id, profile_channel_id) DO UPDATE SET
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `),
    deleteVcCategoryProfileMessage: sqlite.prepare(`
      DELETE FROM vc_category_profile_messages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
    `),
    listVcCategoryProfilePages: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        page_index AS pageIndex,
        message_id AS messageId,
        updated_at AS updatedAt
      FROM vc_category_profile_message_pages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
      ORDER BY page_index ASC
    `),
    upsertVcCategoryProfilePage: sqlite.prepare(`
      INSERT INTO vc_category_profile_message_pages (
        guild_id,
        category_id,
        profile_channel_id,
        page_index,
        message_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, category_id, profile_channel_id, page_index) DO UPDATE SET
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `),
    deleteVcCategoryProfilePage: sqlite.prepare(`
      DELETE FROM vc_category_profile_message_pages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ? AND page_index = ?
    `),
    deleteVcCategoryProfilePages: sqlite.prepare(`
      DELETE FROM vc_category_profile_message_pages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
    `),
    deleteVcCategoryProfilePagesFromIndex: sqlite.prepare(`
      DELETE FROM vc_category_profile_message_pages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ? AND page_index >= ?
    `),
    getVcProfileMemberSession: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        voice_channel_id AS voiceChannelId,
        joined_at AS joinedAt,
        joined_at_estimated AS joinedAtEstimated,
        updated_at AS updatedAt
      FROM vc_profile_member_sessions
      WHERE guild_id = ? AND user_id = ? AND category_id = ? AND profile_channel_id = ?
      LIMIT 1
    `),
    listVcProfileMemberSessions: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        voice_channel_id AS voiceChannelId,
        joined_at AS joinedAt,
        joined_at_estimated AS joinedAtEstimated,
        updated_at AS updatedAt
      FROM vc_profile_member_sessions
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
      ORDER BY joined_at ASC, user_id ASC
    `),
    upsertVcProfileMemberSession: sqlite.prepare(`
      INSERT INTO vc_profile_member_sessions (
        guild_id,
        user_id,
        category_id,
        profile_channel_id,
        voice_channel_id,
        joined_at,
        joined_at_estimated,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, category_id, profile_channel_id) DO UPDATE SET
        joined_at = CASE
          WHEN vc_profile_member_sessions.voice_channel_id = excluded.voice_channel_id
          THEN vc_profile_member_sessions.joined_at
          ELSE excluded.joined_at
        END,
        joined_at_estimated = CASE
          WHEN vc_profile_member_sessions.voice_channel_id = excluded.voice_channel_id
          THEN vc_profile_member_sessions.joined_at_estimated
          ELSE excluded.joined_at_estimated
        END,
        voice_channel_id = excluded.voice_channel_id,
        updated_at = excluded.updated_at
    `),
    deleteVcProfileMemberSession: sqlite.prepare(`
      DELETE FROM vc_profile_member_sessions
      WHERE guild_id = ? AND user_id = ? AND category_id = ? AND profile_channel_id = ?
    `),
    deleteVcProfileMemberSessionsForCategory: sqlite.prepare(`
      DELETE FROM vc_profile_member_sessions
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
    `),
    upsertVcProfileRecentLeave: sqlite.prepare(`
      INSERT INTO vc_profile_recent_leaves (
        guild_id,
        category_id,
        profile_channel_id,
        voice_channel_id,
        user_id,
        left_at,
        display_name_snapshot,
        avatar_url_snapshot,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, category_id, profile_channel_id, voice_channel_id, user_id) DO UPDATE SET
        left_at = excluded.left_at,
        display_name_snapshot = excluded.display_name_snapshot,
        avatar_url_snapshot = excluded.avatar_url_snapshot,
        updated_at = excluded.updated_at
    `),
    deleteVcProfileRecentLeave: sqlite.prepare(`
      DELETE FROM vc_profile_recent_leaves
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND voice_channel_id = ?
        AND user_id = ?
    `),
    listVcProfileRecentLeavesForChannel: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        voice_channel_id AS voiceChannelId,
        user_id AS userId,
        left_at AS leftAt,
        display_name_snapshot AS displayNameSnapshot,
        avatar_url_snapshot AS avatarUrlSnapshot,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_profile_recent_leaves
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND voice_channel_id = ?
        AND datetime(left_at) >= datetime(?)
      ORDER BY datetime(left_at) DESC, user_id ASC
    `),
    deleteExpiredVcProfileRecentLeaves: sqlite.prepare(`
      DELETE FROM vc_profile_recent_leaves
      WHERE datetime(left_at) < datetime(?)
    `),
    getVcProfileColorSession: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        color,
        active_since AS activeSince,
        updated_at AS updatedAt
      FROM vc_profile_color_sessions
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
      LIMIT 1
    `),
    upsertVcProfileColorSession: sqlite.prepare(`
      INSERT INTO vc_profile_color_sessions (
        guild_id,
        category_id,
        profile_channel_id,
        color,
        active_since,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, category_id, profile_channel_id) DO UPDATE SET
        color = excluded.color,
        updated_at = excluded.updated_at
    `),
    deleteVcProfileColorSession: sqlite.prepare(`
      DELETE FROM vc_profile_color_sessions
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
    `),
    getOpenVcVoiceSession: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND status IN ('active', 'solo_grace')
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `),
    getOpenVcVoiceSessionForChannel: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND main_voice_channel_id = ?
        AND status IN ('active', 'solo_grace')
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `),
    getVcVoiceSession: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ? AND session_id = ?
      LIMIT 1
    `),
    upsertVcVoiceSession: sqlite.prepare(`
      INSERT INTO vc_voice_sessions (
        guild_id,
        session_id,
        category_id,
        profile_channel_id,
        status,
        started_at,
        ended_at,
        first_two_plus_at,
        last_two_plus_at,
        solo_since,
        last_active_at,
        max_human_count,
        peak_started_at,
        peak_ended_at,
        peak_member_ids_json,
        all_participant_ids_json,
        first_join_user_id,
        first_join_at,
        last_leave_user_id,
        last_leave_at,
        main_voice_channel_id,
        voice_channel_ids_json,
        two_plus_total_seconds,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, session_id) DO UPDATE SET
        category_id = excluded.category_id,
        profile_channel_id = excluded.profile_channel_id,
        status = excluded.status,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        first_two_plus_at = excluded.first_two_plus_at,
        last_two_plus_at = excluded.last_two_plus_at,
        solo_since = excluded.solo_since,
        last_active_at = excluded.last_active_at,
        max_human_count = excluded.max_human_count,
        peak_started_at = excluded.peak_started_at,
        peak_ended_at = excluded.peak_ended_at,
        peak_member_ids_json = excluded.peak_member_ids_json,
        all_participant_ids_json = excluded.all_participant_ids_json,
        first_join_user_id = excluded.first_join_user_id,
        first_join_at = excluded.first_join_at,
        last_leave_user_id = excluded.last_leave_user_id,
        last_leave_at = excluded.last_leave_at,
        main_voice_channel_id = excluded.main_voice_channel_id,
        voice_channel_ids_json = excluded.voice_channel_ids_json,
        two_plus_total_seconds = excluded.two_plus_total_seconds,
        updated_at = excluded.updated_at
    `),
    listClosedVcVoiceSessionsPeak: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ?
        AND status = 'closed'
        AND datetime(ended_at) >= datetime(?)
        AND (? IS NULL OR category_id = ?)
      ORDER BY max_human_count DESC, datetime(ended_at) DESC
      LIMIT ?
    `),
    listClosedVcVoiceSessionsLatest: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ?
        AND status = 'closed'
        AND datetime(ended_at) >= datetime(?)
        AND (? IS NULL OR category_id = ?)
      ORDER BY datetime(ended_at) DESC, max_human_count DESC
      LIMIT ?
    `),
    listOpenVcVoiceSessions: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ?
        AND status IN ('active', 'solo_grace')
      ORDER BY datetime(created_at) ASC
    `),
    listOpenVcVoiceSessionsForCategory: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        first_two_plus_at AS firstTwoPlusAt,
        last_two_plus_at AS lastTwoPlusAt,
        solo_since AS soloSince,
        last_active_at AS lastActiveAt,
        max_human_count AS maxHumanCount,
        peak_started_at AS peakStartedAt,
        peak_ended_at AS peakEndedAt,
        peak_member_ids_json AS peakMemberIdsJson,
        all_participant_ids_json AS allParticipantIdsJson,
        first_join_user_id AS firstJoinUserId,
        first_join_at AS firstJoinAt,
        last_leave_user_id AS lastLeaveUserId,
        last_leave_at AS lastLeaveAt,
        main_voice_channel_id AS mainVoiceChannelId,
        voice_channel_ids_json AS voiceChannelIdsJson,
        two_plus_total_seconds AS twoPlusTotalSeconds,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_sessions
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND status IN ('active', 'solo_grace')
      ORDER BY datetime(created_at) ASC
    `),
    listVcVoiceSessionMembers: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        user_id AS userId,
        display_name_snapshot AS displayNameSnapshot,
        avatar_url_snapshot AS avatarUrlSnapshot,
        first_joined_at AS firstJoinedAt,
        last_left_at AS lastLeftAt,
        total_present_seconds AS totalPresentSeconds,
        was_present_at_peak AS wasPresentAtPeak,
        joined_while_session_active AS joinedWhileSessionActive,
        present_since AS presentSince,
        is_present AS isPresent,
        current_voice_channel_id AS currentVoiceChannelId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_session_members
      WHERE guild_id = ? AND session_id = ?
      ORDER BY datetime(COALESCE(first_joined_at, created_at)) ASC, user_id ASC
    `),
    upsertVcVoiceSessionMember: sqlite.prepare(`
      INSERT INTO vc_voice_session_members (
        guild_id,
        session_id,
        user_id,
        display_name_snapshot,
        avatar_url_snapshot,
        first_joined_at,
        last_left_at,
        total_present_seconds,
        was_present_at_peak,
        joined_while_session_active,
        present_since,
        is_present,
        current_voice_channel_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, session_id, user_id) DO UPDATE SET
        display_name_snapshot = excluded.display_name_snapshot,
        avatar_url_snapshot = excluded.avatar_url_snapshot,
        first_joined_at = COALESCE(vc_voice_session_members.first_joined_at, excluded.first_joined_at),
        last_left_at = excluded.last_left_at,
        total_present_seconds = excluded.total_present_seconds,
        was_present_at_peak = excluded.was_present_at_peak,
        joined_while_session_active = MAX(vc_voice_session_members.joined_while_session_active, excluded.joined_while_session_active),
        present_since = excluded.present_since,
        is_present = excluded.is_present,
        current_voice_channel_id = excluded.current_voice_channel_id,
        updated_at = excluded.updated_at
    `),
    insertVcVoiceSessionEvent: sqlite.prepare(`
      INSERT INTO vc_voice_session_events (
        guild_id,
        session_id,
        event_type,
        user_id,
        from_channel_id,
        to_channel_id,
        occurred_at,
        human_count_after,
        member_ids_after_json,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listVcVoiceSessionEvents: sqlite.prepare(`
      SELECT
        event_id AS eventId,
        guild_id AS guildId,
        session_id AS sessionId,
        event_type AS eventType,
        user_id AS userId,
        from_channel_id AS fromChannelId,
        to_channel_id AS toChannelId,
        occurred_at AS occurredAt,
        human_count_after AS humanCountAfter,
        member_ids_after_json AS memberIdsAfterJson,
        metadata_json AS metadataJson
      FROM vc_voice_session_events
      WHERE guild_id = ? AND session_id = ?
      ORDER BY datetime(occurred_at) DESC, event_id DESC
      LIMIT ?
    `),
    upsertVcVoiceSessionSummaryMessage: sqlite.prepare(`
      INSERT INTO vc_voice_session_summary_messages (
        guild_id,
        session_id,
        category_id,
        profile_channel_id,
        message_id,
        expires_at,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, session_id, profile_channel_id) DO UPDATE SET
        category_id = excluded.category_id,
        message_id = excluded.message_id,
        expires_at = excluded.expires_at,
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
    listActiveVcVoiceSessionSummaryMessages: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        message_id AS messageId,
        expires_at AS expiresAt,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_session_summary_messages
      WHERE status = 'active'
      ORDER BY datetime(expires_at) ASC
    `),
    listActiveVcVoiceSessionSummaryMessagesForCategory: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        session_id AS sessionId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        message_id AS messageId,
        expires_at AS expiresAt,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_voice_session_summary_messages
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND status = 'active'
      ORDER BY datetime(created_at) DESC
    `),
    updateVcVoiceSessionSummaryMessageStatus: sqlite.prepare(`
      UPDATE vc_voice_session_summary_messages
      SET status = ?, updated_at = ?
      WHERE guild_id = ? AND session_id = ? AND profile_channel_id = ?
    `),
    insertVcShortActivityEpisode: sqlite.prepare(`
      INSERT OR IGNORE INTO vc_short_activity_episodes (
        stable_episode_key,
        guild_id,
        category_id,
        profile_channel_id,
        voice_channel_id,
        started_at,
        ended_at,
        duration_seconds,
        participant_ids_json,
        peak_human_count,
        close_reason,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listVcShortActivityEpisodes: sqlite.prepare(`
      SELECT
        id,
        stable_episode_key AS stableEpisodeKey,
        guild_id AS guildId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        voice_channel_id AS voiceChannelId,
        started_at AS startedAt,
        ended_at AS endedAt,
        duration_seconds AS durationSeconds,
        participant_ids_json AS participantIdsJson,
        peak_human_count AS peakHumanCount,
        close_reason AS closeReason,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM vc_short_activity_episodes
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND status = 'active'
      ORDER BY datetime(ended_at) DESC, id DESC
      LIMIT ?
    `),
    clearVcShortActivityForChannel: sqlite.prepare(`
      UPDATE vc_short_activity_episodes
      SET status = 'cleared',
          updated_at = ?
      WHERE guild_id = ?
        AND category_id = ?
        AND profile_channel_id = ?
        AND voice_channel_id = ?
        AND status = 'active'
    `),
    expireVcShortActivityBefore: sqlite.prepare(`
      UPDATE vc_short_activity_episodes
      SET status = 'expired',
          updated_at = ?
      WHERE status = 'active'
        AND datetime(ended_at) < datetime(?)
    `),
    getVcShortActivityMessage: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        message_id AS messageId,
        status,
        updated_at AS updatedAt
      FROM vc_short_activity_messages
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
      LIMIT 1
    `),
    upsertVcShortActivityMessage: sqlite.prepare(`
      INSERT INTO vc_short_activity_messages (
        guild_id,
        category_id,
        profile_channel_id,
        message_id,
        status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, category_id, profile_channel_id) DO UPDATE SET
        message_id = excluded.message_id,
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
    updateVcShortActivityMessageStatus: sqlite.prepare(`
      UPDATE vc_short_activity_messages
      SET status = ?, updated_at = ?
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
    `),
    getOpenVcWorkInterval: sqlite.prepare(`
      SELECT *
      FROM vc_work_presence_intervals
      WHERE guild_id = ? AND user_id = ? AND status = 'open'
      LIMIT 1
    `),
    listOpenVcWorkIntervals: sqlite.prepare(`
      SELECT *
      FROM vc_work_presence_intervals
      WHERE status = 'open'
      ORDER BY datetime(started_at) ASC
    `),
    insertVcWorkInterval: sqlite.prepare(`
      INSERT OR IGNORE INTO vc_work_presence_intervals (
        stable_interval_key,
        guild_id,
        user_id,
        category_id,
        voice_channel_id,
        listen_chat_channel_id,
        started_at,
        ended_at,
        duration_seconds,
        source,
        source_session_id,
        source_member_key,
        start_estimated,
        end_estimated,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, 0, 'open', ?, ?)
    `),
    closeVcWorkInterval: sqlite.prepare(`
      UPDATE vc_work_presence_intervals
      SET ended_at = ?,
          duration_seconds = ?,
          end_estimated = ?,
          status = 'closed',
          updated_at = ?
      WHERE id = ? AND status = 'open'
    `),
    getVcWorkTotal: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        total_seconds AS totalSeconds,
        historical_backfill_seconds AS historicalBackfillSeconds,
        live_tracked_seconds AS liveTrackedSeconds,
        last_counted_at AS lastCountedAt,
        updated_at AS updatedAt
      FROM vc_work_user_totals
      WHERE guild_id = ? AND user_id = ?
      LIMIT 1
    `),
    upsertVcWorkTotalDelta: sqlite.prepare(`
      INSERT INTO vc_work_user_totals (
        guild_id,
        user_id,
        total_seconds,
        historical_backfill_seconds,
        live_tracked_seconds,
        last_counted_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        total_seconds = vc_work_user_totals.total_seconds + excluded.total_seconds,
        historical_backfill_seconds = vc_work_user_totals.historical_backfill_seconds + excluded.historical_backfill_seconds,
        live_tracked_seconds = vc_work_user_totals.live_tracked_seconds + excluded.live_tracked_seconds,
        last_counted_at = excluded.last_counted_at,
        updated_at = excluded.updated_at
    `),
    listVcWorkTotals: sqlite.prepare(`
      SELECT guild_id AS guildId, user_id AS userId, total_seconds AS totalSeconds
      FROM vc_work_user_totals
      WHERE guild_id = ?
    `),
    listVcWorkRankingRows: sqlite.prepare(`
      WITH users AS (
        SELECT guild_id, user_id
        FROM vc_work_user_totals
        WHERE guild_id = ?
        UNION
        SELECT guild_id, user_id
        FROM vc_work_presence_intervals
        WHERE guild_id = ? AND status = 'open'
      )
      SELECT
        users.guild_id AS guildId,
        users.user_id AS userId,
        COALESCE(t.total_seconds, 0) AS totalSeconds,
        open_interval.started_at AS openStartedAt
      FROM users
      LEFT JOIN vc_work_user_totals t
        ON t.guild_id = users.guild_id AND t.user_id = users.user_id
      LEFT JOIN vc_work_presence_intervals open_interval
        ON open_interval.guild_id = users.guild_id
       AND open_interval.user_id = users.user_id
       AND open_interval.status = 'open'
      LEFT JOIN guild_members gm
        ON gm.guild_id = users.guild_id AND gm.user_id = users.user_id
      WHERE COALESCE(gm.is_bot, 0) = 0
        AND gm.left_at IS NULL
      ORDER BY users.user_id ASC
    `),
    insertVcWorkMilestoneAward: sqlite.prepare(`
      INSERT OR IGNORE INTO vc_work_milestone_awards (
        guild_id,
        user_id,
        milestone_hours,
        reached_at,
        reached_in_voice_channel_id,
        reached_in_category_id,
        dm_status,
        public_status,
        card_status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', 'pending', ?, ?)
    `),
    updateVcWorkMilestoneDelivery: sqlite.prepare(`
      UPDATE vc_work_milestone_awards
      SET dm_status = COALESCE(?, dm_status),
          dm_message_id = COALESCE(?, dm_message_id),
          dm_sent_at = COALESCE(?, dm_sent_at),
          public_status = COALESCE(?, public_status),
          public_message_channel_id = COALESCE(?, public_message_channel_id),
          public_message_id = COALESCE(?, public_message_id),
          public_sent_at = COALESCE(?, public_sent_at),
          card_status = COALESCE(?, card_status),
          card_error = COALESCE(?, card_error),
          updated_at = ?
      WHERE guild_id = ? AND user_id = ? AND milestone_hours = ?
    `),
    listVcWorkMilestoneAwardsForUser: sqlite.prepare(`
      SELECT *
      FROM vc_work_milestone_awards
      WHERE guild_id = ? AND user_id = ?
      ORDER BY milestone_hours ASC
    `),
    listLegacyVcProfileMessagesByCategory: sqlite.prepare(`
      SELECT
        category_id AS categoryId,
        profile_channel_id AS profileChannelId,
        user_id AS userId,
        message_id AS messageId,
        created_at AS createdAt
      FROM vc_profile_messages
      WHERE category_id = ?
    `),
    upsertVcChannelProfileMessage: sqlite.prepare(`
      INSERT INTO vc_channel_profile_messages (
        category_id,
        voice_channel_id,
        profile_channel_id,
        message_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(voice_channel_id) DO UPDATE SET
        category_id = excluded.category_id,
        profile_channel_id = excluded.profile_channel_id,
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `),
    deleteVcChannelProfileMessage: sqlite.prepare(`
      DELETE FROM vc_channel_profile_messages
      WHERE voice_channel_id = ?
    `),
    deleteVcChannelProfileMessagesByCategoryProfile: sqlite.prepare(`
      DELETE FROM vc_channel_profile_messages
      WHERE category_id = ? AND profile_channel_id = ?
    `),
    deleteLegacyVcProfileMessagesByCategory: sqlite.prepare(`
      DELETE FROM vc_profile_messages
      WHERE category_id = ?
    `),
    getGuidePost: sqlite.prepare(`
      SELECT
        channel_id AS channelId,
        guide_key AS guideKey,
        message_id AS messageId,
        updated_at AS updatedAt
      FROM guide_posts
      WHERE channel_id = ? AND guide_key = ?
      LIMIT 1
    `),
    listGuidePostsByChannel: sqlite.prepare(`
      SELECT
        channel_id AS channelId,
        guide_key AS guideKey,
        message_id AS messageId,
        updated_at AS updatedAt
      FROM guide_posts
      WHERE channel_id = ?
      ORDER BY guide_key ASC
    `),
    upsertGuidePost: sqlite.prepare(`
      INSERT INTO guide_posts (
        channel_id,
        guide_key,
        message_id,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id, guide_key) DO UPDATE SET
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `),
    deleteGuidePost: sqlite.prepare(`
      DELETE FROM guide_posts
      WHERE channel_id = ? AND guide_key = ?
    `),
    getMusicLinkCache: sqlite.prepare(`
      SELECT
        source_url AS sourceUrl,
        universal_url AS universalUrl,
        title,
        artist,
        artwork_url AS artworkUrl,
        platform_names AS platformNames,
        platform_links_json AS platformLinksJson,
        raw_json AS rawJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM music_link_cache
      WHERE source_url = ?
      LIMIT 1
    `),
    upsertMusicLinkCache: sqlite.prepare(`
      INSERT INTO music_link_cache (
        source_url,
        universal_url,
        title,
        artist,
        artwork_url,
        platform_names,
        platform_links_json,
        raw_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        universal_url = excluded.universal_url,
        title = excluded.title,
        artist = excluded.artist,
        artwork_url = excluded.artwork_url,
        platform_names = excluded.platform_names,
        platform_links_json = excluded.platform_links_json,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `),
    listWelcomeReactions: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        emoji_key AS emojiKey,
        emoji_name AS emojiName,
        emoji_id AS emojiId,
        animated,
        sort_order AS sortOrder,
        created_at AS createdAt
      FROM welcome_reactions
      WHERE guild_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `),
    getWelcomeReaction: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        emoji_key AS emojiKey,
        emoji_name AS emojiName,
        emoji_id AS emojiId,
        animated,
        sort_order AS sortOrder,
        created_at AS createdAt
      FROM welcome_reactions
      WHERE guild_id = ? AND emoji_key = ?
      LIMIT 1
    `),
    insertWelcomeReaction: sqlite.prepare(`
      INSERT INTO welcome_reactions (
        guild_id,
        emoji_key,
        emoji_name,
        emoji_id,
        animated,
        sort_order,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    clearWelcomeReactions: sqlite.prepare(`
      DELETE FROM welcome_reactions
      WHERE guild_id = ?
    `),
    getWelcomeReactionCount: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM welcome_reactions
      WHERE guild_id = ?
    `),
    upsertArchivedMessage: sqlite.prepare(`
      INSERT INTO archived_messages (
        message_id,
        guild_id,
        channel_id,
        parent_id,
        thread_id,
        author_id,
        author_name,
        author_is_bot,
        content,
        clean_content,
        attachments_json,
        embeds_json,
        referenced_message_id,
        message_type,
        created_at,
        edited_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        channel_id = excluded.channel_id,
        parent_id = excluded.parent_id,
        thread_id = excluded.thread_id,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        author_is_bot = excluded.author_is_bot,
        content = excluded.content,
        clean_content = excluded.clean_content,
        attachments_json = excluded.attachments_json,
        embeds_json = excluded.embeds_json,
        referenced_message_id = excluded.referenced_message_id,
        message_type = excluded.message_type,
        created_at = excluded.created_at,
        edited_at = excluded.edited_at,
        archived_at = excluded.archived_at
    `),
    getArchivedMessage: sqlite.prepare(`
      SELECT
        message_id AS messageId,
        guild_id AS guildId,
        channel_id AS channelId,
        parent_id AS parentId,
        thread_id AS threadId,
        author_id AS authorId,
        author_name AS authorName,
        author_is_bot AS authorIsBot,
        content,
        clean_content AS cleanContent,
        attachments_json AS attachmentsJson,
        embeds_json AS embedsJson,
        referenced_message_id AS referencedMessageId,
        message_type AS messageType,
        created_at AS createdAt,
        edited_at AS editedAt,
        archived_at AS archivedAt
      FROM archived_messages
      WHERE message_id = ?
      LIMIT 1
    `),
    listRecentArchivedMessagesByChannel: sqlite.prepare(`
      SELECT
        message_id AS messageId,
        guild_id AS guildId,
        channel_id AS channelId,
        parent_id AS parentId,
        thread_id AS threadId,
        author_id AS authorId,
        author_name AS authorName,
        author_is_bot AS authorIsBot,
        content,
        clean_content AS cleanContent,
        attachments_json AS attachmentsJson,
        embeds_json AS embedsJson,
        referenced_message_id AS referencedMessageId,
        message_type AS messageType,
        created_at AS createdAt,
        edited_at AS editedAt,
        archived_at AS archivedAt
      FROM archived_messages
      WHERE channel_id = ?
      ORDER BY datetime(created_at) DESC, message_id DESC
      LIMIT ?
    `),
    listRecentArchivedMessagesByAuthorInGuild: sqlite.prepare(`
      SELECT
        message_id AS messageId,
        guild_id AS guildId,
        channel_id AS channelId,
        parent_id AS parentId,
        thread_id AS threadId,
        author_id AS authorId,
        author_name AS authorName,
        author_is_bot AS authorIsBot,
        content,
        clean_content AS cleanContent,
        attachments_json AS attachmentsJson,
        embeds_json AS embedsJson,
        referenced_message_id AS referencedMessageId,
        message_type AS messageType,
        created_at AS createdAt,
        edited_at AS editedAt,
        archived_at AS archivedAt
      FROM archived_messages
      WHERE guild_id = ? AND author_id = ?
      ORDER BY datetime(created_at) DESC, message_id DESC
      LIMIT ?
    `),
    getThreadStarterArchivedMessage: sqlite.prepare(`
      SELECT
        message_id AS messageId,
        guild_id AS guildId,
        channel_id AS channelId,
        parent_id AS parentId,
        thread_id AS threadId,
        author_id AS authorId,
        author_name AS authorName,
        author_is_bot AS authorIsBot,
        content,
        clean_content AS cleanContent,
        attachments_json AS attachmentsJson,
        embeds_json AS embedsJson,
        referenced_message_id AS referencedMessageId,
        message_type AS messageType,
        created_at AS createdAt,
        edited_at AS editedAt,
        archived_at AS archivedAt
      FROM archived_messages
      WHERE channel_id = ? OR thread_id = ?
      ORDER BY datetime(created_at) ASC, message_id ASC
      LIMIT 1
    `),
    countArchivedMessages: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM archived_messages
    `),
    deleteArchivedMessage: sqlite.prepare(`
      DELETE FROM archived_messages
      WHERE message_id = ?
    `),
    deleteArchivedMessages: sqlite.prepare(`
      DELETE FROM archived_messages
      WHERE message_id = ?
    `),
    insertLlmResponse: sqlite.prepare(`
      INSERT OR REPLACE INTO llm_responses (
        response_message_id,
        request_message_id,
        channel_id,
        author_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `),
    getLlmResponseByMessageId: sqlite.prepare(`
      SELECT
        response_message_id AS responseMessageId,
        request_message_id AS requestMessageId,
        channel_id AS channelId,
        author_id AS authorId,
        created_at AS createdAt
      FROM llm_responses
      WHERE response_message_id = ?
      LIMIT 1
    `),
    countLlmResponses: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM llm_responses
    `),
    deleteLlmResponseByMessageId: sqlite.prepare(`
      DELETE FROM llm_responses
      WHERE response_message_id = ? OR request_message_id = ?
    `),
    deleteLlmResponsesByMessageId: sqlite.prepare(`
      DELETE FROM llm_responses
      WHERE response_message_id = ? OR request_message_id = ?
    `),
    upsertIntroDmState: sqlite.prepare(`
      INSERT INTO intro_dm_state (
        guild_id,
        user_id,
        prompt_type,
        status,
        sent_at,
        replied_count,
        opt_out,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, prompt_type) DO UPDATE SET
        status = excluded.status,
        sent_at = excluded.sent_at,
        replied_count = excluded.replied_count,
        opt_out = excluded.opt_out,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `),
    getIntroDmState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        prompt_type AS promptType,
        status,
        sent_at AS sentAt,
        replied_count AS repliedCount,
        opt_out AS optOut,
        last_error AS lastError,
        updated_at AS updatedAt
      FROM intro_dm_state
      WHERE guild_id = ? AND user_id = ? AND prompt_type = ?
      LIMIT 1
    `),
    listIntroDmStatesByUser: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        prompt_type AS promptType,
        status,
        sent_at AS sentAt,
        replied_count AS repliedCount,
        opt_out AS optOut,
        last_error AS lastError,
        updated_at AS updatedAt
      FROM intro_dm_state
      WHERE guild_id = ? AND user_id = ?
      ORDER BY updated_at DESC
    `),
    markIntroDmOptOutByUser: sqlite.prepare(`
      UPDATE intro_dm_state
      SET opt_out = 1,
          updated_at = ?,
          last_error = NULL
      WHERE guild_id = ? AND user_id = ?
    `),
    incrementIntroDmReplyCountByUser: sqlite.prepare(`
      UPDATE intro_dm_state
      SET replied_count = replied_count + 1,
          updated_at = ?
      WHERE guild_id = ? AND user_id = ?
    `),
    countIntroDmStates: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM intro_dm_state
    `),
    countIntroDmStatesByPromptType: sqlite.prepare(`
      SELECT
        prompt_type AS promptType,
        COUNT(*) AS count
      FROM intro_dm_state
      GROUP BY prompt_type
    `),
    countIntroDmOptOutStates: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM intro_dm_state
      WHERE opt_out = 1
    `),
    insertIntroDmQueue: sqlite.prepare(`
      INSERT INTO intro_dm_queue (
        guild_id,
        user_id,
        prompt_type,
        reason,
        scheduled_at,
        status,
        attempts,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listIntroDmQueueDue: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        user_id AS userId,
        prompt_type AS promptType,
        reason,
        scheduled_at AS scheduledAt,
        status,
        attempts,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM intro_dm_queue
      WHERE guild_id = ?
        AND status = 'pending'
        AND datetime(scheduled_at) <= datetime(?)
      ORDER BY datetime(scheduled_at) ASC, id ASC
      LIMIT ?
    `),
    listIntroDmQueueDueAllGuilds: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        user_id AS userId,
        prompt_type AS promptType,
        reason,
        scheduled_at AS scheduledAt,
        status,
        attempts,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM intro_dm_queue
      WHERE status = 'pending'
        AND datetime(scheduled_at) <= datetime(?)
      ORDER BY datetime(scheduled_at) ASC, id ASC
      LIMIT ?
    `),
    updateIntroDmQueueStatus: sqlite.prepare(`
      UPDATE intro_dm_queue
      SET status = ?,
          attempts = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `),
    countIntroDmQueueByStatus: sqlite.prepare(`
      SELECT
        status,
        COUNT(*) AS count
      FROM intro_dm_queue
      GROUP BY status
    `),
    getIntroDmQueueNextScheduledAt: sqlite.prepare(`
      SELECT MIN(datetime(scheduled_at)) AS nextScheduledAt
      FROM intro_dm_queue
      WHERE status = 'pending'
    `),
    countIntroDmQueueDueAllGuilds: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM intro_dm_queue
      WHERE status = 'pending'
        AND datetime(scheduled_at) <= datetime(?)
    `),
    getPendingIntroDmQueueForUserPrompt: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        user_id AS userId,
        prompt_type AS promptType,
        reason,
        scheduled_at AS scheduledAt,
        status,
        attempts,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM intro_dm_queue
      WHERE guild_id = ? AND user_id = ? AND prompt_type = ? AND status = 'pending'
      ORDER BY datetime(scheduled_at) ASC, id ASC
      LIMIT 1
    `),
    markIntroDmQueueStatusById: sqlite.prepare(`
      UPDATE intro_dm_queue
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `),
    resetStaleIntroDmQueueProcessing: sqlite.prepare(`
      UPDATE intro_dm_queue
      SET status = 'pending',
          updated_at = ?
      WHERE status = 'processing'
        AND datetime(updated_at) <= datetime(?)
    `),
    getIntroVcReminderState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        reminder_count AS reminderCount,
        first_sent_at AS firstSentAt,
        last_sent_at AS lastSentAt,
        last_voice_join_at AS lastVoiceJoinAt,
        qualifying_join_count AS qualifyingJoinCount,
        last_qualifying_join_at AS lastQualifyingJoinAt,
        last_disconnected_at AS lastDisconnectedAt,
        last_failure_at AS lastFailureAt,
        last_channel_id AS lastChannelId,
        last_dm_message_id AS lastDmMessageId,
        last_error AS lastError,
        completed_at AS completedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM intro_vc_reminder_state
      WHERE guild_id = ? AND user_id = ?
      LIMIT 1
    `),
    upsertIntroVcReminderJoin: sqlite.prepare(`
      INSERT INTO intro_vc_reminder_state (
        guild_id,
        user_id,
        reminder_count,
        qualifying_join_count,
        first_sent_at,
        last_sent_at,
        last_voice_join_at,
        last_qualifying_join_at,
        last_disconnected_at,
        last_failure_at,
        last_channel_id,
        last_dm_message_id,
        last_error,
        completed_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 0, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        last_voice_join_at = excluded.last_voice_join_at,
        qualifying_join_count = excluded.qualifying_join_count,
        last_qualifying_join_at = excluded.last_qualifying_join_at,
        last_channel_id = excluded.last_channel_id,
        updated_at = excluded.updated_at
    `),
    markIntroVcReminderDisconnected: sqlite.prepare(`
      INSERT INTO intro_vc_reminder_state (
        guild_id,
        user_id,
        reminder_count,
        qualifying_join_count,
        first_sent_at,
        last_sent_at,
        last_voice_join_at,
        last_qualifying_join_at,
        last_disconnected_at,
        last_failure_at,
        last_channel_id,
        last_dm_message_id,
        last_error,
        completed_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 0, 0, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        last_disconnected_at = excluded.last_disconnected_at,
        updated_at = excluded.updated_at
    `),
    markIntroVcReminderSent: sqlite.prepare(`
      INSERT INTO intro_vc_reminder_state (
        guild_id,
        user_id,
        reminder_count,
        qualifying_join_count,
        first_sent_at,
        last_sent_at,
        last_voice_join_at,
        last_qualifying_join_at,
        last_disconnected_at,
        last_failure_at,
        last_channel_id,
        last_dm_message_id,
        last_error,
        completed_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 1, 0, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        reminder_count = intro_vc_reminder_state.reminder_count + 1,
        first_sent_at = COALESCE(intro_vc_reminder_state.first_sent_at, excluded.first_sent_at),
        last_sent_at = excluded.last_sent_at,
        last_voice_join_at = excluded.last_voice_join_at,
        last_channel_id = excluded.last_channel_id,
        last_dm_message_id = excluded.last_dm_message_id,
        last_error = NULL,
        last_failure_at = NULL,
        completed_at = NULL,
        updated_at = excluded.updated_at
    `),
    markIntroVcReminderError: sqlite.prepare(`
      INSERT INTO intro_vc_reminder_state (
        guild_id,
        user_id,
        reminder_count,
        qualifying_join_count,
        first_sent_at,
        last_sent_at,
        last_voice_join_at,
        last_qualifying_join_at,
        last_disconnected_at,
        last_failure_at,
        last_channel_id,
        last_dm_message_id,
        last_error,
        completed_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 0, 0, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        last_voice_join_at = excluded.last_voice_join_at,
        last_channel_id = excluded.last_channel_id,
        last_error = excluded.last_error,
        last_failure_at = excluded.last_failure_at,
        updated_at = excluded.updated_at
    `),
    markIntroVcReminderCompleted: sqlite.prepare(`
      UPDATE intro_vc_reminder_state
      SET completed_at = ?,
          updated_at = ?,
          last_error = NULL
      WHERE guild_id = ? AND user_id = ?
    `),
    insertIntroReaction: sqlite.prepare(`
      INSERT INTO intro_reactions (
        guild_id,
        emoji_key,
        emoji_name,
        emoji_id,
        animated,
        sort_order,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listIntroReactions: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        emoji_key AS emojiKey,
        emoji_name AS emojiName,
        emoji_id AS emojiId,
        animated,
        sort_order AS sortOrder,
        created_at AS createdAt
      FROM intro_reactions
      WHERE guild_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `),
    clearIntroReactions: sqlite.prepare(`
      DELETE FROM intro_reactions
      WHERE guild_id = ?
    `),
    countIntroReactions: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM intro_reactions
      WHERE guild_id = ?
    `),
    upsertIntroProfile: sqlite.prepare(`
      INSERT INTO intro_profiles (
        guild_id,
        user_id,
        intro_channel_id,
        intro_message_id,
        display_name,
        username,
        global_name,
        nickname,
        intro_text,
        links_json,
        embeds_json,
        attachments_json,
        search_aliases_json,
        posted_at,
        updated_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intro_message_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        user_id = excluded.user_id,
        intro_channel_id = excluded.intro_channel_id,
        display_name = excluded.display_name,
        username = excluded.username,
        global_name = excluded.global_name,
        nickname = excluded.nickname,
        intro_text = excluded.intro_text,
        links_json = excluded.links_json,
        embeds_json = excluded.embeds_json,
        attachments_json = excluded.attachments_json,
        search_aliases_json = excluded.search_aliases_json,
        posted_at = excluded.posted_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `),
    deleteIntroProfileByMessageId: sqlite.prepare(`
      DELETE FROM intro_profiles
      WHERE intro_message_id = ?
    `),
    deleteIntroProfileByUserInChannel: sqlite.prepare(`
      DELETE FROM intro_profiles
      WHERE guild_id = ? AND user_id = ? AND intro_channel_id = ?
    `),
    deleteIntroProfilesByChannel: sqlite.prepare(`
      DELETE FROM intro_profiles
      WHERE guild_id = ? AND intro_channel_id = ?
    `),
    getLatestIntroProfileByUser: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        intro_channel_id AS introChannelId,
        intro_message_id AS introMessageId,
        display_name AS displayName,
        username,
        global_name AS globalName,
        nickname,
        intro_text AS introText,
        links_json AS linksJson,
        embeds_json AS embedsJson,
        attachments_json AS attachmentsJson,
        search_aliases_json AS searchAliasesJson,
        posted_at AS postedAt,
        updated_at AS updatedAt,
        archived_at AS archivedAt
      FROM intro_profiles
      WHERE guild_id = ? AND user_id = ? AND intro_channel_id = ?
      ORDER BY datetime(COALESCE(posted_at, updated_at)) ASC, intro_message_id ASC
      LIMIT 1
    `),
    listIntroProfilesByUser: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        intro_channel_id AS introChannelId,
        intro_message_id AS introMessageId,
        display_name AS displayName,
        username,
        global_name AS globalName,
        nickname,
        intro_text AS introText,
        links_json AS linksJson,
        embeds_json AS embedsJson,
        attachments_json AS attachmentsJson,
        search_aliases_json AS searchAliasesJson,
        posted_at AS postedAt,
        updated_at AS updatedAt,
        archived_at AS archivedAt
      FROM intro_profiles
      WHERE guild_id = ? AND user_id = ? AND intro_channel_id = ?
      ORDER BY datetime(COALESCE(updated_at, posted_at)) DESC, intro_message_id DESC
    `),
    searchIntroProfiles: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        intro_channel_id AS introChannelId,
        intro_message_id AS introMessageId,
        display_name AS displayName,
        username,
        global_name AS globalName,
        nickname,
        intro_text AS introText,
        links_json AS linksJson,
        embeds_json AS embedsJson,
        attachments_json AS attachmentsJson,
        search_aliases_json AS searchAliasesJson,
        posted_at AS postedAt,
        updated_at AS updatedAt,
        archived_at AS archivedAt
      FROM intro_profiles
      WHERE guild_id = ? AND intro_channel_id = ?
        AND (
          LOWER(COALESCE(display_name, '')) LIKE ?
          OR LOWER(COALESCE(username, '')) LIKE ?
          OR LOWER(COALESCE(global_name, '')) LIKE ?
          OR LOWER(COALESCE(nickname, '')) LIKE ?
          OR LOWER(COALESCE(search_aliases_json, '')) LIKE ?
        )
      ORDER BY datetime(COALESCE(updated_at, posted_at)) DESC, intro_message_id DESC
      LIMIT ?
    `),
    countIntroProfiles: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM intro_profiles
      WHERE guild_id = ? AND intro_channel_id = ?
    `),
    getLatestIntroProfileDate: sqlite.prepare(`
      SELECT MAX(COALESCE(updated_at, posted_at)) AS latestDate
      FROM intro_profiles
      WHERE guild_id = ? AND intro_channel_id = ?
    `),
    listIntroProfilesByChannel: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        intro_channel_id AS introChannelId,
        intro_message_id AS introMessageId,
        display_name AS displayName,
        username,
        global_name AS globalName,
        nickname,
        intro_text AS introText,
        links_json AS linksJson,
        embeds_json AS embedsJson,
        attachments_json AS attachmentsJson,
        search_aliases_json AS searchAliasesJson,
        posted_at AS postedAt,
        updated_at AS updatedAt,
        archived_at AS archivedAt
      FROM intro_profiles
      WHERE guild_id = ? AND intro_channel_id = ?
      ORDER BY datetime(COALESCE(updated_at, posted_at)) DESC, intro_message_id DESC
      LIMIT ?
    `),
    getIntroProfileByMessageId: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        intro_channel_id AS introChannelId,
        intro_message_id AS introMessageId,
        display_name AS displayName,
        username,
        global_name AS globalName,
        nickname,
        intro_text AS introText,
        links_json AS linksJson,
        embeds_json AS embedsJson,
        attachments_json AS attachmentsJson,
        search_aliases_json AS searchAliasesJson,
        posted_at AS postedAt,
        updated_at AS updatedAt,
        archived_at AS archivedAt
      FROM intro_profiles
      WHERE intro_message_id = ?
      LIMIT 1
    `),
    upsertIntroProfileAddendum: sqlite.prepare(`
      INSERT INTO intro_profile_addendums (
        guild_id,
        user_id,
        addendum_message_id,
        channel_id,
        target_intro_message_id,
        absorbed_text,
        absorbed_urls_json,
        status,
        created_at,
        updated_at,
        removed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, addendum_message_id) DO UPDATE SET
        user_id = excluded.user_id,
        channel_id = excluded.channel_id,
        target_intro_message_id = excluded.target_intro_message_id,
        absorbed_text = excluded.absorbed_text,
        absorbed_urls_json = excluded.absorbed_urls_json,
        status = excluded.status,
        updated_at = excluded.updated_at,
        removed_at = excluded.removed_at
    `),
    getIntroProfileAddendum: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        addendum_message_id AS addendumMessageId,
        channel_id AS channelId,
        target_intro_message_id AS targetIntroMessageId,
        absorbed_text AS absorbedText,
        absorbed_urls_json AS absorbedUrlsJson,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt,
        removed_at AS removedAt
      FROM intro_profile_addendums
      WHERE guild_id = ? AND addendum_message_id = ?
      LIMIT 1
    `),
    listActiveIntroProfileAddendumsForProfile: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        addendum_message_id AS addendumMessageId,
        channel_id AS channelId,
        target_intro_message_id AS targetIntroMessageId,
        absorbed_text AS absorbedText,
        absorbed_urls_json AS absorbedUrlsJson,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt,
        removed_at AS removedAt
      FROM intro_profile_addendums
      WHERE guild_id = ?
        AND user_id = ?
        AND target_intro_message_id = ?
        AND status = 'active'
      ORDER BY datetime(created_at) ASC, addendum_message_id ASC
    `),
    listActiveIntroProfileAddendumsByChannel: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        addendum_message_id AS addendumMessageId,
        channel_id AS channelId,
        target_intro_message_id AS targetIntroMessageId,
        absorbed_text AS absorbedText,
        absorbed_urls_json AS absorbedUrlsJson,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt,
        removed_at AS removedAt
      FROM intro_profile_addendums
      WHERE guild_id = ?
        AND channel_id = ?
        AND status = 'active'
      ORDER BY datetime(created_at) ASC, addendum_message_id ASC
      LIMIT ?
    `),
    markIntroProfileAddendumStatus: sqlite.prepare(`
      UPDATE intro_profile_addendums
      SET status = ?,
          updated_at = ?,
          removed_at = ?
      WHERE guild_id = ? AND addendum_message_id = ?
    `),
    upsertGuildMember: sqlite.prepare(`
      INSERT INTO guild_members (
        guild_id,
        user_id,
        username,
        global_name,
        display_name,
        nickname,
        joined_at,
        is_bot,
        left_at,
        last_seen_at,
        last_vc_joined_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        username = excluded.username,
        global_name = excluded.global_name,
        display_name = excluded.display_name,
        nickname = excluded.nickname,
        joined_at = COALESCE(excluded.joined_at, guild_members.joined_at),
        is_bot = excluded.is_bot,
        left_at = excluded.left_at,
        last_seen_at = excluded.last_seen_at,
        last_vc_joined_at = COALESCE(excluded.last_vc_joined_at, guild_members.last_vc_joined_at),
        updated_at = excluded.updated_at
    `),
    markGuildMemberLeft: sqlite.prepare(`
      UPDATE guild_members
      SET left_at = ?,
          updated_at = ?
      WHERE guild_id = ? AND user_id = ?
    `),
    updateGuildMemberVcJoined: sqlite.prepare(`
      UPDATE guild_members
      SET last_vc_joined_at = ?,
          last_seen_at = ?,
          updated_at = ?
      WHERE guild_id = ? AND user_id = ?
    `),
    getGuildMember: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        username,
        global_name AS globalName,
        display_name AS displayName,
        nickname,
        joined_at AS joinedAt,
        is_bot AS isBot,
        left_at AS leftAt,
        last_seen_at AS lastSeenAt,
        last_vc_joined_at AS lastVcJoinedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM guild_members
      WHERE guild_id = ? AND user_id = ?
      LIMIT 1
    `),
    listGuildMembersWithoutIntroOlderThan: sqlite.prepare(`
      SELECT
        gm.guild_id AS guildId,
        gm.user_id AS userId,
        gm.username,
        gm.global_name AS globalName,
        gm.display_name AS displayName,
        gm.nickname,
        gm.joined_at AS joinedAt,
        gm.is_bot AS isBot,
        gm.left_at AS leftAt,
        gm.last_seen_at AS lastSeenAt,
        gm.last_vc_joined_at AS lastVcJoinedAt,
        gm.created_at AS createdAt,
        gm.updated_at AS updatedAt
      FROM guild_members gm
      WHERE gm.guild_id = ?
        AND gm.is_bot = 0
        AND gm.left_at IS NULL
        AND gm.joined_at IS NOT NULL
        AND datetime(gm.joined_at) <= datetime(?)
        AND NOT EXISTS (
          SELECT 1
          FROM intro_profiles ip
          WHERE ip.guild_id = gm.guild_id
            AND ip.user_id = gm.user_id
            AND ip.intro_channel_id = ?
        )
      ORDER BY datetime(gm.joined_at) ASC, gm.user_id ASC
      LIMIT ?
    `),
    countGuildMembers: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM guild_members
      WHERE guild_id = ?
    `),
    countGuildMembersWithoutIntro: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM guild_members gm
      WHERE gm.guild_id = ?
        AND gm.is_bot = 0
        AND gm.left_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM intro_profiles ip
          WHERE ip.guild_id = gm.guild_id
            AND ip.user_id = gm.user_id
            AND ip.intro_channel_id = ?
        )
    `),
    upsertAnimeEntry: sqlite.prepare(`
      INSERT INTO anime_entries (
        guild_id,
        provider,
        provider_media_id,
        title_native,
        title_kana,
        title_romaji,
        title_english,
        title_user_preferred,
        aliases_json,
        description,
        site_url,
        official_site_url,
        mal_anime_id,
        cover_image_url,
        banner_image_url,
        season,
        season_year,
        status,
        episodes,
        duration,
        next_airing_at,
        anime_channel_id,
        anime_channel_message_id,
        thread_id,
        thread_card_message_id,
        review_card_message_id,
        has_spoiler_reviews,
        created_by_user_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, provider, provider_media_id) DO UPDATE SET
        title_native = excluded.title_native,
        title_kana = excluded.title_kana,
        title_romaji = excluded.title_romaji,
        title_english = excluded.title_english,
        title_user_preferred = excluded.title_user_preferred,
        aliases_json = excluded.aliases_json,
        description = excluded.description,
        site_url = excluded.site_url,
        official_site_url = excluded.official_site_url,
        mal_anime_id = excluded.mal_anime_id,
        cover_image_url = excluded.cover_image_url,
        banner_image_url = excluded.banner_image_url,
        season = excluded.season,
        season_year = excluded.season_year,
        status = excluded.status,
        episodes = excluded.episodes,
        duration = excluded.duration,
        next_airing_at = excluded.next_airing_at,
        anime_channel_id = COALESCE(excluded.anime_channel_id, anime_entries.anime_channel_id),
        anime_channel_message_id = COALESCE(excluded.anime_channel_message_id, anime_entries.anime_channel_message_id),
        thread_id = COALESCE(excluded.thread_id, anime_entries.thread_id),
        thread_card_message_id = COALESCE(excluded.thread_card_message_id, anime_entries.thread_card_message_id),
        review_card_message_id = COALESCE(excluded.review_card_message_id, anime_entries.review_card_message_id),
        has_spoiler_reviews = excluded.has_spoiler_reviews,
        created_by_user_id = COALESCE(excluded.created_by_user_id, anime_entries.created_by_user_id),
        updated_at = excluded.updated_at
    `),
    getAnimeEntryByProviderMediaId: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        provider,
        provider_media_id AS providerMediaId,
        title_native AS titleNative,
        title_kana AS titleKana,
        title_romaji AS titleRomaji,
        title_english AS titleEnglish,
        title_user_preferred AS titleUserPreferred,
        aliases_json AS aliasesJson,
        description,
        site_url AS siteUrl,
        official_site_url AS officialSiteUrl,
        mal_anime_id AS malAnimeId,
        cover_image_url AS coverImageUrl,
        banner_image_url AS bannerImageUrl,
        season,
        season_year AS seasonYear,
        status,
        episodes,
        duration,
        next_airing_at AS nextAiringAt,
        anime_channel_id AS animeChannelId,
        anime_channel_message_id AS animeChannelMessageId,
        thread_id AS threadId,
        thread_card_message_id AS threadCardMessageId,
        review_card_message_id AS reviewCardMessageId,
        has_spoiler_reviews AS hasSpoilerReviews,
        created_by_user_id AS createdByUserId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_entries
      WHERE guild_id = ? AND provider = ? AND provider_media_id = ?
      LIMIT 1
    `),
    getAnimeEntryById: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        provider,
        provider_media_id AS providerMediaId,
        title_native AS titleNative,
        title_kana AS titleKana,
        title_romaji AS titleRomaji,
        title_english AS titleEnglish,
        title_user_preferred AS titleUserPreferred,
        aliases_json AS aliasesJson,
        description,
        site_url AS siteUrl,
        official_site_url AS officialSiteUrl,
        mal_anime_id AS malAnimeId,
        cover_image_url AS coverImageUrl,
        banner_image_url AS bannerImageUrl,
        season,
        season_year AS seasonYear,
        status,
        episodes,
        duration,
        next_airing_at AS nextAiringAt,
        anime_channel_id AS animeChannelId,
        anime_channel_message_id AS animeChannelMessageId,
        thread_id AS threadId,
        thread_card_message_id AS threadCardMessageId,
        review_card_message_id AS reviewCardMessageId,
        has_spoiler_reviews AS hasSpoilerReviews,
        created_by_user_id AS createdByUserId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_entries
      WHERE id = ?
      LIMIT 1
    `),
    getAnimeEntryByThreadId: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        provider,
        provider_media_id AS providerMediaId,
        title_native AS titleNative,
        title_kana AS titleKana,
        title_romaji AS titleRomaji,
        title_english AS titleEnglish,
        title_user_preferred AS titleUserPreferred,
        aliases_json AS aliasesJson,
        description,
        site_url AS siteUrl,
        official_site_url AS officialSiteUrl,
        mal_anime_id AS malAnimeId,
        cover_image_url AS coverImageUrl,
        banner_image_url AS bannerImageUrl,
        season,
        season_year AS seasonYear,
        status,
        episodes,
        duration,
        next_airing_at AS nextAiringAt,
        anime_channel_id AS animeChannelId,
        anime_channel_message_id AS animeChannelMessageId,
        thread_id AS threadId,
        thread_card_message_id AS threadCardMessageId,
        review_card_message_id AS reviewCardMessageId,
        has_spoiler_reviews AS hasSpoilerReviews,
        created_by_user_id AS createdByUserId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_entries
      WHERE guild_id = ? AND thread_id = ?
      LIMIT 1
    `),
    getAnimeEntryByChannelMessageId: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        provider,
        provider_media_id AS providerMediaId,
        title_native AS titleNative,
        title_kana AS titleKana,
        title_romaji AS titleRomaji,
        title_english AS titleEnglish,
        title_user_preferred AS titleUserPreferred,
        aliases_json AS aliasesJson,
        description,
        site_url AS siteUrl,
        official_site_url AS officialSiteUrl,
        mal_anime_id AS malAnimeId,
        cover_image_url AS coverImageUrl,
        banner_image_url AS bannerImageUrl,
        season,
        season_year AS seasonYear,
        status,
        episodes,
        duration,
        next_airing_at AS nextAiringAt,
        anime_channel_id AS animeChannelId,
        anime_channel_message_id AS animeChannelMessageId,
        thread_id AS threadId,
        thread_card_message_id AS threadCardMessageId,
        review_card_message_id AS reviewCardMessageId,
        has_spoiler_reviews AS hasSpoilerReviews,
        created_by_user_id AS createdByUserId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_entries
      WHERE guild_id = ? AND anime_channel_message_id = ?
      LIMIT 1
    `),
    listAnimeEntriesPage: sqlite.prepare(`
      SELECT
        e.id,
        e.guild_id AS guildId,
        e.provider,
        e.provider_media_id AS providerMediaId,
        e.title_native AS titleNative,
        e.title_kana AS titleKana,
        e.title_romaji AS titleRomaji,
        e.title_english AS titleEnglish,
        e.title_user_preferred AS titleUserPreferred,
        e.aliases_json AS aliasesJson,
        e.description,
        e.site_url AS siteUrl,
        e.official_site_url AS officialSiteUrl,
        e.mal_anime_id AS malAnimeId,
        e.cover_image_url AS coverImageUrl,
        e.banner_image_url AS bannerImageUrl,
        e.season,
        e.season_year AS seasonYear,
        e.status,
        e.episodes,
        e.duration,
        e.next_airing_at AS nextAiringAt,
        e.anime_channel_id AS animeChannelId,
        e.anime_channel_message_id AS animeChannelMessageId,
        e.thread_id AS threadId,
        e.thread_card_message_id AS threadCardMessageId,
        e.review_card_message_id AS reviewCardMessageId,
        e.has_spoiler_reviews AS hasSpoilerReviews,
        e.created_by_user_id AS createdByUserId,
        e.created_at AS createdAt,
        e.updated_at AS updatedAt
      FROM anime_entries e
      WHERE e.guild_id = ?
      ORDER BY COALESCE(e.season_year, 0) DESC, COALESCE(e.title_user_preferred, e.title_romaji, e.title_native, e.title_english) ASC
      LIMIT ? OFFSET ?
    `),
    countAnimeEntries: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_entries
      WHERE guild_id = ?
    `),
    searchAnimeEntriesLocal: sqlite.prepare(`
      SELECT
        e.id,
        e.guild_id AS guildId,
        e.provider,
        e.provider_media_id AS providerMediaId,
        e.title_native AS titleNative,
        e.title_kana AS titleKana,
        e.title_romaji AS titleRomaji,
        e.title_english AS titleEnglish,
        e.title_user_preferred AS titleUserPreferred,
        e.aliases_json AS aliasesJson,
        e.description,
        e.site_url AS siteUrl,
        e.official_site_url AS officialSiteUrl,
        e.mal_anime_id AS malAnimeId,
        e.cover_image_url AS coverImageUrl,
        e.banner_image_url AS bannerImageUrl,
        e.season,
        e.season_year AS seasonYear,
        e.status,
        e.episodes,
        e.duration,
        e.next_airing_at AS nextAiringAt,
        e.anime_channel_id AS animeChannelId,
        e.anime_channel_message_id AS animeChannelMessageId,
        e.thread_id AS threadId,
        e.thread_card_message_id AS threadCardMessageId,
        e.has_spoiler_reviews AS hasSpoilerReviews,
        e.created_by_user_id AS createdByUserId,
        e.created_at AS createdAt,
        e.updated_at AS updatedAt
      FROM anime_entries e
      WHERE e.guild_id = ?
        AND (
          LOWER(COALESCE(e.title_user_preferred, '')) LIKE ?
          OR LOWER(COALESCE(e.title_kana, '')) LIKE ?
          OR LOWER(COALESCE(e.title_romaji, '')) LIKE ?
          OR LOWER(COALESCE(e.title_native, '')) LIKE ?
          OR LOWER(COALESCE(e.title_english, '')) LIKE ?
          OR LOWER(COALESCE(e.aliases_json, '')) LIKE ?
        )
      ORDER BY COALESCE(e.updated_at, e.created_at) DESC
      LIMIT ?
    `),
    replaceAnimeEntrySpoilerFlag: sqlite.prepare(`
      UPDATE anime_entries
      SET has_spoiler_reviews = ?,
          updated_at = ?
      WHERE id = ?
    `),
    updateAnimeEntryMessageBindings: sqlite.prepare(`
      UPDATE anime_entries
      SET anime_channel_id = COALESCE(?, anime_channel_id),
          anime_channel_message_id = COALESCE(?, anime_channel_message_id),
          thread_id = COALESCE(?, thread_id),
          thread_card_message_id = COALESCE(?, thread_card_message_id),
          review_card_message_id = COALESCE(?, review_card_message_id),
          updated_at = ?
      WHERE id = ?
    `),
    clearAnimeEntryMessageBindings: sqlite.prepare(`
      UPDATE anime_entries
      SET anime_channel_id = NULL,
          anime_channel_message_id = NULL,
          thread_id = NULL,
          thread_card_message_id = NULL,
          review_card_message_id = NULL,
          updated_at = ?
      WHERE id = ?
    `),
    deleteAnimeCastByEntryId: sqlite.prepare(`
      DELETE FROM anime_cast_cache
      WHERE anime_entry_id = ?
    `),
    insertAnimeCastRow: sqlite.prepare(`
      INSERT INTO anime_cast_cache (
        anime_entry_id,
        character_name,
        character_name_native,
        character_image_url,
        voice_actor_name,
        voice_actor_language,
        voice_actor_image_url,
        sort_order,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listAnimeCastByEntryId: sqlite.prepare(`
      SELECT
        id,
        anime_entry_id AS animeEntryId,
        character_name AS characterName,
        character_name_native AS characterNameNative,
        character_image_url AS characterImageUrl,
        voice_actor_name AS voiceActorName,
        voice_actor_language AS voiceActorLanguage,
        voice_actor_image_url AS voiceActorImageUrl,
        sort_order AS sortOrder,
        created_at AS createdAt
      FROM anime_cast_cache
      WHERE anime_entry_id = ?
      ORDER BY sort_order ASC, id ASC
    `),
    upsertAnimeUserStatus: sqlite.prepare(`
      INSERT INTO anime_user_status (
        guild_id,
        anime_entry_id,
        user_id,
        interested,
        watched,
        interested_at,
        watched_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, anime_entry_id, user_id) DO UPDATE SET
        interested = excluded.interested,
        watched = excluded.watched,
        interested_at = excluded.interested_at,
        watched_at = excluded.watched_at,
        updated_at = excluded.updated_at
    `),
    getAnimeUserStatus: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        anime_entry_id AS animeEntryId,
        user_id AS userId,
        interested,
        watched,
        interested_at AS interestedAt,
        watched_at AS watchedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_user_status
      WHERE guild_id = ? AND anime_entry_id = ? AND user_id = ?
      LIMIT 1
    `),
    countAnimeInterestedUsers: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_user_status
      WHERE guild_id = ? AND anime_entry_id = ? AND interested = 1
    `),
    countAnimeWatchedUsers: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_user_status
      WHERE guild_id = ? AND anime_entry_id = ? AND watched = 1
    `),
    countAnimeUserInterested: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_user_status
      WHERE guild_id = ? AND user_id = ? AND interested = 1
    `),
    countAnimeUserWatched: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_user_status
      WHERE guild_id = ? AND user_id = ? AND watched = 1
    `),
    upsertAnimeReview: sqlite.prepare(`
      INSERT INTO anime_reviews (
        guild_id,
        anime_entry_id,
        user_id,
        review_text,
        spoiler,
        source_channel_id,
        source_message_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, anime_entry_id, user_id) DO UPDATE SET
        review_text = excluded.review_text,
        spoiler = excluded.spoiler,
        source_channel_id = excluded.source_channel_id,
        source_message_id = excluded.source_message_id,
        updated_at = excluded.updated_at
    `),
    getAnimeReviewByUser: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        anime_entry_id AS animeEntryId,
        user_id AS userId,
        review_text AS reviewText,
        spoiler,
        source_channel_id AS sourceChannelId,
        source_message_id AS sourceMessageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_reviews
      WHERE guild_id = ? AND anime_entry_id = ? AND user_id = ?
      LIMIT 1
    `),
    listAnimeReviewsByEntryId: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        anime_entry_id AS animeEntryId,
        user_id AS userId,
        review_text AS reviewText,
        spoiler,
        source_channel_id AS sourceChannelId,
        source_message_id AS sourceMessageId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_reviews
      WHERE guild_id = ? AND anime_entry_id = ?
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, id DESC
      LIMIT ?
    `),
    countAnimeReviewsByEntryId: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_reviews
      WHERE guild_id = ? AND anime_entry_id = ?
    `),
    countAnimeSpoilerReviewsByEntryId: sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM anime_reviews
      WHERE guild_id = ? AND anime_entry_id = ? AND spoiler = 1
    `),
    countAnimeReviewedDistinctByUser: sqlite.prepare(`
      SELECT COUNT(DISTINCT anime_entry_id) AS count
      FROM anime_reviews
      WHERE guild_id = ? AND user_id = ?
    `),
    upsertAnimeReviewRole: sqlite.prepare(`
      INSERT INTO anime_review_roles (
        guild_id,
        threshold,
        role_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, threshold) DO UPDATE SET
        role_id = excluded.role_id,
        updated_at = excluded.updated_at
    `),
    listAnimeReviewRoles: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        threshold,
        role_id AS roleId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_review_roles
      WHERE guild_id = ?
      ORDER BY threshold ASC
    `),
    getAnimeRoleAward: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        user_id AS userId,
        threshold,
        role_id AS roleId,
        awarded_at AS awardedAt,
        dm_sent_at AS dmSentAt
      FROM anime_role_awards
      WHERE guild_id = ? AND user_id = ? AND threshold = ?
      LIMIT 1
    `),
    upsertAnimeRoleAward: sqlite.prepare(`
      INSERT INTO anime_role_awards (
        guild_id,
        user_id,
        threshold,
        role_id,
        awarded_at,
        dm_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, threshold) DO UPDATE SET
        role_id = COALESCE(excluded.role_id, anime_role_awards.role_id),
        awarded_at = COALESCE(anime_role_awards.awarded_at, excluded.awarded_at),
        dm_sent_at = COALESCE(anime_role_awards.dm_sent_at, excluded.dm_sent_at)
    `),
    setAnimeRoleAwardDmSentAt: sqlite.prepare(`
      UPDATE anime_role_awards
      SET dm_sent_at = ?
      WHERE guild_id = ? AND user_id = ? AND threshold = ?
    `),
    upsertAnimeReviewPromptState: sqlite.prepare(`
      INSERT INTO anime_review_prompt_state (
        guild_id,
        anime_entry_id,
        user_id,
        prompt_type,
        prompt_message_id,
        thread_id,
        prompted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, anime_entry_id, user_id, prompt_type) DO UPDATE SET
        prompt_message_id = excluded.prompt_message_id,
        thread_id = excluded.thread_id,
        prompted_at = excluded.prompted_at
    `),
    getAnimeReviewPromptState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        anime_entry_id AS animeEntryId,
        user_id AS userId,
        prompt_type AS promptType,
        prompt_message_id AS promptMessageId,
        thread_id AS threadId,
        prompted_at AS promptedAt
      FROM anime_review_prompt_state
      WHERE guild_id = ? AND anime_entry_id = ? AND user_id = ? AND prompt_type = ?
      LIMIT 1
    `),
    getAnimeReviewPromptStateByMessageId: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        anime_entry_id AS animeEntryId,
        user_id AS userId,
        prompt_type AS promptType,
        prompt_message_id AS promptMessageId,
        thread_id AS threadId,
        prompted_at AS promptedAt
      FROM anime_review_prompt_state
      WHERE guild_id = ? AND prompt_message_id = ? AND prompt_type = ?
      LIMIT 1
    `),
    deleteAnimeReviewPromptStateByEntryId: sqlite.prepare(`
      DELETE FROM anime_review_prompt_state
      WHERE anime_entry_id = ?
    `),
    deleteAnimeReviewPromptStateByMessageId: sqlite.prepare(`
      DELETE FROM anime_review_prompt_state
      WHERE guild_id = ? AND prompt_message_id = ?
    `),
    upsertAnimeHashtagSource: sqlite.prepare(`
      INSERT INTO anime_hashtag_sources (
        guild_id,
        source_message_id,
        source_channel_id,
        source_author_id,
        relayed_timeline_message_id,
        relayed_route_message_ids_json,
        cleaned_content,
        display_tags_json,
        detected_candidate,
        anime_entry_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, source_message_id) DO UPDATE SET
        source_channel_id = excluded.source_channel_id,
        source_author_id = COALESCE(excluded.source_author_id, anime_hashtag_sources.source_author_id),
        relayed_timeline_message_id = COALESCE(excluded.relayed_timeline_message_id, anime_hashtag_sources.relayed_timeline_message_id),
        relayed_route_message_ids_json = COALESCE(excluded.relayed_route_message_ids_json, anime_hashtag_sources.relayed_route_message_ids_json),
        cleaned_content = COALESCE(excluded.cleaned_content, anime_hashtag_sources.cleaned_content),
        display_tags_json = COALESCE(excluded.display_tags_json, anime_hashtag_sources.display_tags_json),
        detected_candidate = COALESCE(excluded.detected_candidate, anime_hashtag_sources.detected_candidate),
        anime_entry_id = COALESCE(excluded.anime_entry_id, anime_hashtag_sources.anime_entry_id),
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
    getAnimeHashtagSourceByMessageId: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        source_message_id AS sourceMessageId,
        source_channel_id AS sourceChannelId,
        source_author_id AS sourceAuthorId,
        relayed_timeline_message_id AS relayedTimelineMessageId,
        relayed_route_message_ids_json AS relayedRouteMessageIdsJson,
        cleaned_content AS cleanedContent,
        display_tags_json AS displayTagsJson,
        detected_candidate AS detectedCandidate,
        anime_entry_id AS animeEntryId,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_hashtag_sources
      WHERE guild_id = ? AND source_message_id = ?
      LIMIT 1
    `),
    listRecentUnresolvedAnimeHashtagSourcesByUser: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        source_message_id AS sourceMessageId,
        source_channel_id AS sourceChannelId,
        source_author_id AS sourceAuthorId,
        relayed_timeline_message_id AS relayedTimelineMessageId,
        relayed_route_message_ids_json AS relayedRouteMessageIdsJson,
        cleaned_content AS cleanedContent,
        display_tags_json AS displayTagsJson,
        detected_candidate AS detectedCandidate,
        anime_entry_id AS animeEntryId,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_hashtag_sources
      WHERE guild_id = ?
        AND source_author_id = ?
        AND status IN ('pending', 'unresolved')
        AND datetime(updated_at) >= datetime(?)
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT ?
    `),
    updateAnimeHashtagSourceLink: sqlite.prepare(`
      UPDATE anime_hashtag_sources
      SET anime_entry_id = ?,
          status = ?,
          detected_candidate = COALESCE(?, detected_candidate),
          updated_at = ?
      WHERE id = ?
    `),
    deleteAnimeHashtagSourcesByEntryId: sqlite.prepare(`
      DELETE FROM anime_hashtag_sources
      WHERE anime_entry_id = ?
    `),
    deleteAnimeHashtagSourceByMessageId: sqlite.prepare(`
      DELETE FROM anime_hashtag_sources
      WHERE guild_id = ? AND source_message_id = ?
    `),
    deleteAnimeReviewsByEntryId: sqlite.prepare(`
      DELETE FROM anime_reviews
      WHERE anime_entry_id = ?
    `),
    deleteAnimeUserStatusByEntryId: sqlite.prepare(`
      DELETE FROM anime_user_status
      WHERE anime_entry_id = ?
    `),
    deleteAnimeEntryById: sqlite.prepare(`
      DELETE FROM anime_entries
      WHERE id = ?
    `),
    listAllAnimeEntries: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        provider,
        provider_media_id AS providerMediaId,
        title_native AS titleNative,
        title_kana AS titleKana,
        title_romaji AS titleRomaji,
        title_english AS titleEnglish,
        title_user_preferred AS titleUserPreferred,
        aliases_json AS aliasesJson,
        description,
        site_url AS siteUrl,
        official_site_url AS officialSiteUrl,
        mal_anime_id AS malAnimeId,
        cover_image_url AS coverImageUrl,
        banner_image_url AS bannerImageUrl,
        season,
        season_year AS seasonYear,
        status,
        episodes,
        duration,
        next_airing_at AS nextAiringAt,
        anime_channel_id AS animeChannelId,
        anime_channel_message_id AS animeChannelMessageId,
        thread_id AS threadId,
        thread_card_message_id AS threadCardMessageId,
        review_card_message_id AS reviewCardMessageId,
        has_spoiler_reviews AS hasSpoilerReviews,
        created_by_user_id AS createdByUserId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM anime_entries
      WHERE guild_id = ?
      ORDER BY id ASC
    `),
    upsertAnnictConnection: sqlite.prepare(`
      INSERT INTO annict_user_connections (
        guild_id,
        discord_user_id,
        annict_resource_owner_id,
        encrypted_access_token,
        token_iv,
        token_auth_tag,
        encryption_version,
        encryption_key_id,
        scopes_json,
        connected_at,
        updated_at,
        last_successful_sync_at,
        sync_cursor_json,
        token_status,
        last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
        annict_resource_owner_id = excluded.annict_resource_owner_id,
        encrypted_access_token = excluded.encrypted_access_token,
        token_iv = excluded.token_iv,
        token_auth_tag = excluded.token_auth_tag,
        encryption_version = excluded.encryption_version,
        encryption_key_id = excluded.encryption_key_id,
        scopes_json = excluded.scopes_json,
        updated_at = excluded.updated_at,
        last_successful_sync_at = excluded.last_successful_sync_at,
        sync_cursor_json = excluded.sync_cursor_json,
        token_status = excluded.token_status,
        last_error_code = excluded.last_error_code
    `),
    getAnnictConnection: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        annict_resource_owner_id AS annictResourceOwnerId,
        encrypted_access_token AS encryptedAccessToken,
        token_iv AS tokenIv,
        token_auth_tag AS tokenAuthTag,
        encryption_version AS encryptionVersion,
        encryption_key_id AS encryptionKeyId,
        scopes_json AS scopesJson,
        connected_at AS connectedAt,
        updated_at AS updatedAt,
        last_successful_sync_at AS lastSuccessfulSyncAt,
        sync_cursor_json AS syncCursorJson,
        token_status AS tokenStatus,
        last_error_code AS lastErrorCode
      FROM annict_user_connections
      WHERE guild_id = ? AND discord_user_id = ?
      LIMIT 1
    `),
    listAnnictActiveConnections: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        annict_resource_owner_id AS annictResourceOwnerId,
        encrypted_access_token AS encryptedAccessToken,
        token_iv AS tokenIv,
        token_auth_tag AS tokenAuthTag,
        encryption_version AS encryptionVersion,
        encryption_key_id AS encryptionKeyId,
        scopes_json AS scopesJson,
        connected_at AS connectedAt,
        updated_at AS updatedAt,
        last_successful_sync_at AS lastSuccessfulSyncAt,
        sync_cursor_json AS syncCursorJson,
        token_status AS tokenStatus,
        last_error_code AS lastErrorCode
      FROM annict_user_connections
      WHERE guild_id = ? AND token_status = 'active'
      ORDER BY updated_at ASC
    `),
    deleteAnnictConnection: sqlite.prepare(`
      DELETE FROM annict_user_connections
      WHERE guild_id = ? AND discord_user_id = ?
    `),
    updateAnnictConnectionSync: sqlite.prepare(`
      UPDATE annict_user_connections
      SET last_successful_sync_at = ?,
          sync_cursor_json = ?,
          token_status = ?,
          last_error_code = ?,
          updated_at = ?
      WHERE guild_id = ? AND discord_user_id = ?
    `),
    insertAnnictOauthState: sqlite.prepare(`
      INSERT INTO annict_oauth_states (
        state,
        guild_id,
        discord_user_id,
        redirect_uri,
        scopes_json,
        created_at,
        expires_at,
        consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, null)
    `),
    getAnnictOauthState: sqlite.prepare(`
      SELECT
        state,
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        redirect_uri AS redirectUri,
        scopes_json AS scopesJson,
        created_at AS createdAt,
        expires_at AS expiresAt,
        consumed_at AS consumedAt
      FROM annict_oauth_states
      WHERE state = ?
      LIMIT 1
    `),
    consumeAnnictOauthState: sqlite.prepare(`
      UPDATE annict_oauth_states
      SET consumed_at = ?
      WHERE state = ? AND consumed_at IS NULL
    `),
    deleteExpiredAnnictOauthStates: sqlite.prepare(`
      DELETE FROM annict_oauth_states
      WHERE expires_at < ?
    `),
    upsertAnnictUserWorkState: sqlite.prepare(`
      INSERT INTO annict_user_work_states (
        guild_id,
        discord_user_id,
        annict_work_id,
        anime_entry_id,
        status,
        source,
        source_updated_at,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_user_id, annict_work_id) DO UPDATE SET
        anime_entry_id = COALESCE(excluded.anime_entry_id, annict_user_work_states.anime_entry_id),
        status = excluded.status,
        source = excluded.source,
        source_updated_at = excluded.source_updated_at,
        synced_at = excluded.synced_at
    `),
    getAnnictUserWorkState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        annict_work_id AS annictWorkId,
        anime_entry_id AS animeEntryId,
        status,
        source,
        source_updated_at AS sourceUpdatedAt,
        synced_at AS syncedAt
      FROM annict_user_work_states
      WHERE guild_id = ? AND discord_user_id = ? AND annict_work_id = ?
      LIMIT 1
    `),
    getAnnictWatchedImportJob: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        status,
        graphql_cursor AS graphqlCursor,
        has_next_page AS hasNextPage,
        scanned_count AS scannedCount,
        posted_count AS postedCount,
        skipped_existing_count AS skippedExistingCount,
        repaired_count AS repairedCount,
        failed_count AS failedCount,
        started_at AS startedAt,
        last_processed_at AS lastProcessedAt,
        next_run_at AS nextRunAt,
        completed_at AS completedAt,
        cancelled_at AS cancelledAt,
        last_error_code AS lastErrorCode,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM annict_watched_import_jobs
      WHERE guild_id = ? AND discord_user_id = ?
      LIMIT 1
    `),
    listDueAnnictWatchedImportJobs: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        status,
        graphql_cursor AS graphqlCursor,
        has_next_page AS hasNextPage,
        scanned_count AS scannedCount,
        posted_count AS postedCount,
        skipped_existing_count AS skippedExistingCount,
        repaired_count AS repairedCount,
        failed_count AS failedCount,
        started_at AS startedAt,
        last_processed_at AS lastProcessedAt,
        next_run_at AS nextRunAt,
        completed_at AS completedAt,
        cancelled_at AS cancelledAt,
        last_error_code AS lastErrorCode,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM annict_watched_import_jobs
      WHERE status = 'active'
        AND (next_run_at IS NULL OR datetime(next_run_at) <= datetime(?))
      ORDER BY datetime(COALESCE(next_run_at, started_at, created_at)) ASC
      LIMIT ?
    `),
    upsertAnnictWatchedImportJob: sqlite.prepare(`
      INSERT INTO annict_watched_import_jobs (
        guild_id,
        discord_user_id,
        status,
        graphql_cursor,
        has_next_page,
        scanned_count,
        posted_count,
        skipped_existing_count,
        repaired_count,
        failed_count,
        started_at,
        last_processed_at,
        next_run_at,
        completed_at,
        cancelled_at,
        last_error_code,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
        status = excluded.status,
        next_run_at = excluded.next_run_at,
        completed_at = excluded.completed_at,
        cancelled_at = excluded.cancelled_at,
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `),
    updateAnnictWatchedImportJobProgress: sqlite.prepare(`
      UPDATE annict_watched_import_jobs
      SET status = ?,
          graphql_cursor = ?,
          has_next_page = ?,
          scanned_count = scanned_count + ?,
          posted_count = posted_count + ?,
          skipped_existing_count = skipped_existing_count + ?,
          repaired_count = repaired_count + ?,
          failed_count = failed_count + ?,
          last_processed_at = ?,
          next_run_at = ?,
          completed_at = ?,
          cancelled_at = ?,
          last_error_code = ?,
          updated_at = ?
      WHERE guild_id = ? AND discord_user_id = ?
    `),
    upsertAnnictWatchedImportItem: sqlite.prepare(`
      INSERT INTO annict_watched_import_items (
        guild_id,
        discord_user_id,
        annict_work_id,
        status,
        anime_entry_id,
        attempts,
        last_error_code,
        first_seen_at,
        processed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_user_id, annict_work_id) DO UPDATE SET
        status = excluded.status,
        anime_entry_id = COALESCE(excluded.anime_entry_id, annict_watched_import_items.anime_entry_id),
        attempts = annict_watched_import_items.attempts + excluded.attempts,
        last_error_code = excluded.last_error_code,
        processed_at = COALESCE(excluded.processed_at, annict_watched_import_items.processed_at),
        updated_at = excluded.updated_at
    `),
    getAnnictWatchedImportItem: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        annict_work_id AS annictWorkId,
        anime_entry_id AS animeEntryId,
        status,
        attempts,
        last_error_code AS lastErrorCode,
        first_seen_at AS firstSeenAt,
        processed_at AS processedAt,
        updated_at AS updatedAt
      FROM annict_watched_import_items
      WHERE guild_id = ? AND discord_user_id = ? AND annict_work_id = ?
      LIMIT 1
    `),
    getXProfileHeaderCache: sqlite.prepare(`
      SELECT
        normalized_handle AS normalizedHandle,
        header_url AS headerUrl,
        resolved_at AS resolvedAt,
        expires_at AS expiresAt,
        last_error_code AS lastErrorCode,
        updated_at AS updatedAt
      FROM x_profile_header_cache
      WHERE normalized_handle = ?
      LIMIT 1
    `),
    upsertXProfileHeaderCache: sqlite.prepare(`
      INSERT INTO x_profile_header_cache (
        normalized_handle,
        header_url,
        resolved_at,
        expires_at,
        last_error_code,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_handle) DO UPDATE SET
        header_url = excluded.header_url,
        resolved_at = excluded.resolved_at,
        expires_at = excluded.expires_at,
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `),
    upsertAnnictStatusWriteLog: sqlite.prepare(`
      INSERT INTO annict_status_write_log (
        guild_id,
        discord_user_id,
        annict_work_id,
        target_status,
        idempotency_key,
        status,
        created_at,
        updated_at,
        last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_user_id, annict_work_id, target_status) DO UPDATE SET
        idempotency_key = excluded.idempotency_key,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_error_code = excluded.last_error_code
    `),
    getAnnictFeatureIntroDmState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        discord_user_id AS discordUserId,
        trigger_message_id AS triggerMessageId,
        trigger_type AS triggerType,
        matched_term AS matchedTerm,
        matched_anime_entry_id AS matchedAnimeEntryId,
        first_triggered_at AS firstTriggeredAt,
        sent_at AS sentAt,
        dm_message_id AS dmMessageId,
        status,
        last_error_code AS lastErrorCode,
        updated_at AS updatedAt
      FROM annict_feature_intro_dm_state
      WHERE guild_id = ? AND discord_user_id = ?
      LIMIT 1
    `),
    upsertAnnictFeatureIntroDmState: sqlite.prepare(`
      INSERT INTO annict_feature_intro_dm_state (
        guild_id,
        discord_user_id,
        trigger_message_id,
        trigger_type,
        matched_term,
        matched_anime_entry_id,
        first_triggered_at,
        sent_at,
        dm_message_id,
        status,
        last_error_code,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_user_id) DO UPDATE SET
        trigger_message_id = excluded.trigger_message_id,
        trigger_type = excluded.trigger_type,
        matched_term = excluded.matched_term,
        matched_anime_entry_id = excluded.matched_anime_entry_id,
        sent_at = excluded.sent_at,
        dm_message_id = excluded.dm_message_id,
        status = excluded.status,
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `),
    upsertBotDeletableMessage: sqlite.prepare(`
      INSERT INTO bot_deletable_messages (
        guild_id,
        channel_id,
        message_id,
        owner_user_id,
        purpose,
        metadata_json,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id,
        purpose = excluded.purpose,
        metadata_json = excluded.metadata_json,
        expires_at = excluded.expires_at
    `),
    getBotDeletableMessage: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        channel_id AS channelId,
        message_id AS messageId,
        owner_user_id AS ownerUserId,
        purpose,
        metadata_json AS metadataJson,
        expires_at AS expiresAt,
        created_at AS createdAt
      FROM bot_deletable_messages
      WHERE message_id = ?
      LIMIT 1
    `),
    deleteBotDeletableMessage: sqlite.prepare(`
      DELETE FROM bot_deletable_messages
      WHERE message_id = ?
    `),
    deleteExpiredBotDeletableMessages: sqlite.prepare(`
      DELETE FROM bot_deletable_messages
      WHERE expires_at IS NOT NULL
        AND datetime(expires_at) <= datetime(?)
    `),
    getTimelineMergeState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        source_channel_id AS sourceChannelId,
        source_thread_id AS sourceThreadId,
        author_id AS authorId,
        destination_channel_id AS destinationChannelId,
        last_source_message_id AS lastSourceMessageId,
        relayed_message_id AS relayedMessageId,
        merged_text_json AS mergedTextJson,
        merged_count AS mergedCount,
        last_message_at AS lastMessageAt
      FROM timeline_merge_state
      WHERE guild_id = ? AND source_channel_id = ? AND author_id = ? AND destination_channel_id = ?
      LIMIT 1
    `),
    upsertTimelineMergeState: sqlite.prepare(`
      INSERT INTO timeline_merge_state (
        guild_id,
        source_channel_id,
        source_thread_id,
        author_id,
        destination_channel_id,
        last_source_message_id,
        relayed_message_id,
        merged_text_json,
        merged_count,
        last_message_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, source_channel_id, author_id, destination_channel_id) DO UPDATE SET
        source_thread_id = excluded.source_thread_id,
        last_source_message_id = excluded.last_source_message_id,
        relayed_message_id = excluded.relayed_message_id,
        merged_text_json = excluded.merged_text_json,
        merged_count = excluded.merged_count,
        last_message_at = excluded.last_message_at
    `),
    deleteTimelineMergeState: sqlite.prepare(`
      DELETE FROM timeline_merge_state
      WHERE guild_id = ? AND source_channel_id = ? AND author_id = ? AND destination_channel_id = ?
    `),
    getTimelineDestinationState: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        destination_channel_id AS destinationChannelId,
        relayed_message_id AS relayedMessageId,
        source_message_id AS sourceMessageId,
        source_thread_id AS sourceThreadId,
        author_id AS authorId,
        updated_at AS updatedAt
      FROM timeline_destination_state
      WHERE guild_id = ? AND destination_channel_id = ?
      LIMIT 1
    `),
    upsertTimelineDestinationState: sqlite.prepare(`
      INSERT INTO timeline_destination_state (
        guild_id,
        destination_channel_id,
        relayed_message_id,
        source_message_id,
        source_thread_id,
        author_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, destination_channel_id) DO UPDATE SET
        relayed_message_id = excluded.relayed_message_id,
        source_message_id = excluded.source_message_id,
        source_thread_id = excluded.source_thread_id,
        author_id = excluded.author_id,
        updated_at = excluded.updated_at
    `),
    deleteTimelineDestinationStateIfCurrent: sqlite.prepare(`
      DELETE FROM timeline_destination_state
      WHERE guild_id = ?
        AND destination_channel_id = ?
        AND relayed_message_id = ?
    `),
    listTimelineDestinationStatesByRelayedMessageId: sqlite.prepare(`
      SELECT
        guild_id AS guildId,
        destination_channel_id AS destinationChannelId,
        relayed_message_id AS relayedMessageId,
        source_message_id AS sourceMessageId,
        source_thread_id AS sourceThreadId,
        author_id AS authorId,
        updated_at AS updatedAt
      FROM timeline_destination_state
      WHERE relayed_message_id = ?
      ORDER BY updated_at ASC
    `),
    deleteTimelineDestinationStatesByRelayedMessageId: sqlite.prepare(`
      DELETE FROM timeline_destination_state
      WHERE relayed_message_id = ?
    `),
    getPosthocRelayRejection: sqlite.prepare(`
      SELECT
        id,
        guild_id AS guildId,
        source_message_id AS sourceMessageId,
        source_channel_id AS sourceChannelId,
        original_author_id AS originalAuthorId,
        rejected_by_user_id AS rejectedByUserId,
        destination_channel_id AS destinationChannelId,
        relay_kind AS relayKind,
        display_tags_json AS displayTagsJson,
        rejected_relayed_message_id AS rejectedRelayedMessageId,
        rejection_count AS rejectionCount,
        last_rejected_at AS lastRejectedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM posthoc_relay_rejections
      WHERE guild_id = ? AND source_message_id = ?
      LIMIT 1
    `),
    upsertPosthocRelayRejection: sqlite.prepare(`
      INSERT INTO posthoc_relay_rejections (
        guild_id,
        source_message_id,
        source_channel_id,
        original_author_id,
        rejected_by_user_id,
        destination_channel_id,
        relay_kind,
        display_tags_json,
        rejected_relayed_message_id,
        rejection_count,
        last_rejected_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(guild_id, source_message_id) DO UPDATE SET
        source_channel_id = COALESCE(excluded.source_channel_id, posthoc_relay_rejections.source_channel_id),
        original_author_id = COALESCE(excluded.original_author_id, posthoc_relay_rejections.original_author_id),
        rejected_by_user_id = excluded.rejected_by_user_id,
        destination_channel_id = excluded.destination_channel_id,
        relay_kind = excluded.relay_kind,
        display_tags_json = excluded.display_tags_json,
        rejected_relayed_message_id = excluded.rejected_relayed_message_id,
        rejection_count = posthoc_relay_rejections.rejection_count + 1,
        last_rejected_at = excluded.last_rejected_at,
        updated_at = excluded.updated_at
    `),
    upsertUserLlmMemory: sqlite.prepare(`
      INSERT INTO user_llm_memories (
        guild_id, user_id, memory_key, memory_text, source, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, memory_key) DO UPDATE SET
        memory_text = excluded.memory_text,
        source = excluded.source,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `),
    getUserLlmMemory: sqlite.prepare(`
      SELECT
        guild_id AS guildId, user_id AS userId, memory_key AS memoryKey,
        memory_text AS memoryText, source, confidence,
        created_at AS createdAt, updated_at AS updatedAt
      FROM user_llm_memories
      WHERE guild_id = ? AND user_id = ? AND memory_key = ?
      LIMIT 1
    `),
    listUserLlmMemoriesByUser: sqlite.prepare(`
      SELECT
        guild_id AS guildId, user_id AS userId, memory_key AS memoryKey,
        memory_text AS memoryText, source, confidence,
        created_at AS createdAt, updated_at AS updatedAt
      FROM user_llm_memories
      WHERE guild_id = ? AND user_id = ?
      ORDER BY updated_at DESC
    `),
    deleteUserLlmMemoryByKey: sqlite.prepare(`
      DELETE FROM user_llm_memories WHERE guild_id = ? AND user_id = ? AND memory_key = ?
    `),
    deleteAllUserLlmMemoriesByUser: sqlite.prepare(`
      DELETE FROM user_llm_memories WHERE guild_id = ? AND user_id = ?
    `),
    countUserLlmMemoriesByUser: sqlite.prepare(`
      SELECT COUNT(*) AS count FROM user_llm_memories WHERE guild_id = ? AND user_id = ?
    `),
    countAllUserLlmMemories: sqlite.prepare(`
      SELECT COUNT(*) AS count FROM user_llm_memories WHERE guild_id = ?
    `)
  };

  function parseJsonArray(value) {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function parseJsonObject(value) {
    try {
      const parsed = JSON.parse(value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function parseAnnictConnection(row) {
    if (!row) {
      return null;
    }

    return {
      ...row,
      scopes: parseJsonArray(row.scopesJson),
      syncCursor: parseJsonObject(row.syncCursorJson)
    };
  }

  function extractUrls(text) {
    return Array.from(String(text || '').matchAll(/https?:\/\/[^\s>]+/giu))
      .map((match) => String(match[0] || '').replace(/[.,、。!?！？;；]+$/u, ''))
      .filter(Boolean);
  }

  function stripLegacyIntroAddendumSection(introText) {
    const text = String(introText || '').trim();
    if (!text) {
      return '';
    }

    const lines = text.split(/\r?\n/u);
    const index = lines.findIndex((line) => /^SNS\s*\/\s*Links\s*:\s*$/iu.test(String(line || '').trim()));
    if (index < 0) {
      return text;
    }

    return lines.slice(0, index).join('\n').trim();
  }

  function renderIntroProfileRow(row) {
    if (!row) {
      return null;
    }

    const baseIntroText = stripLegacyIntroAddendumSection(row.introText);
    const addendums = statements.listActiveIntroProfileAddendumsForProfile.all(
      row.guildId,
      row.userId,
      row.introMessageId
    );
    const addendumTexts = addendums
      .map((entry) => String(entry.absorbedText || '').trim())
      .filter(Boolean);
    const renderedIntroText = [baseIntroText, ...addendumTexts]
      .filter(Boolean)
      .join('\n\n');

    const mergedLinks = [
      ...extractUrls(baseIntroText),
      ...addendums.flatMap((entry) => parseJsonArray(entry.absorbedUrlsJson))
    ].filter(Boolean);

    return {
      ...row,
      introText: renderedIntroText,
      linksJson: JSON.stringify([...new Set(mergedLinks)])
    };
  }

  function renderIntroProfileRows(rows) {
    return rows.map(renderIntroProfileRow).filter(Boolean);
  }

  return {
    sqlite,
    logDashboards: {
      get(guildId, dashboardKind) {
        return statements.getLogDashboardMessage.get(guildId, dashboardKind) || null;
      },
      list(guildId) {
        return statements.listLogDashboardMessages.all(guildId);
      },
      upsert({
        guildId,
        channelId,
        dashboardKind,
        messageId = null,
        lastPayloadJson = null,
        recentEventsJson = '[]'
      }) {
        const existing = statements.getLogDashboardMessage.get(guildId, dashboardKind) || null;
        const now = new Date().toISOString();
        statements.upsertLogDashboardMessage.run(
          guildId,
          channelId,
          dashboardKind,
          messageId,
          lastPayloadJson,
          recentEventsJson,
          existing?.createdAt || now,
          now
        );
      }
    },
    relays: {
      hasThreadRelay(threadId) {
        return Boolean(statements.hasThreadRelay.get(threadId));
      },
      getThreadRelay(threadId) {
        return statements.getThreadRelay.get(threadId) || null;
      },
      insertThreadRelay({ threadId, parentChannelId, starterMessageId, timelineMessageId, authorId }) {
        statements.insertThreadRelay.run(
          threadId,
          parentChannelId,
          starterMessageId,
          timelineMessageId,
          authorId,
          new Date().toISOString()
        );
      },
      hasMessageRelay(messageId) {
        return Boolean(statements.hasMessageRelay.get(messageId));
      },
      getMessageRelay(messageId) {
        return statements.getMessageRelay.get(messageId) || null;
      },
      listMessageRelayTargets(messageId) {
        return statements.listMessageRelayTargets.all(messageId);
      },
      getMessageRelayTarget(messageId, destinationChannelId) {
        return statements.getMessageRelayTarget.get(messageId, destinationChannelId) || null;
      },
      listMessageRelayTargetsByRelayedMessageId(relayedMessageId) {
        return statements.listMessageRelayTargetsByRelayedMessageId.all(relayedMessageId);
      },
      upsertMessageRelayTarget({
        sourceMessageId,
        destinationChannelId,
        threadId,
        parentChannelId,
        forumType,
        relayKind,
        relayedMessageId,
        authorId
      }) {
        const now = new Date().toISOString();
        statements.upsertMessageRelayTarget.run(
          sourceMessageId,
          destinationChannelId,
          threadId,
          parentChannelId,
          forumType,
          relayKind,
          relayedMessageId,
          authorId,
          now,
          now
        );
      },
      deleteMessageRelayTarget(messageId, destinationChannelId) {
        return statements.deleteMessageRelayTarget.run(messageId, destinationChannelId).changes;
      },
      deleteMessageRelayTargetsByRelayedMessageId(relayedMessageId) {
        return statements.deleteMessageRelayTargetsByRelayedMessageId.run(relayedMessageId).changes;
      },
      insertMessageRelay({ messageId, threadId, parentChannelId, forumType, timelineMessageId, authorId }) {
        statements.insertMessageRelay.run(
          messageId,
          threadId,
          parentChannelId,
          forumType,
          timelineMessageId,
          authorId,
          new Date().toISOString()
        );
      },
      listMessageRelaysByTimelineMessageId(timelineMessageId) {
        return statements.listMessageRelaysByTimelineMessageId.all(timelineMessageId);
      },
      deleteMessageRelaysByTimelineMessageId(timelineMessageId) {
        return statements.deleteMessageRelaysByTimelineMessageId.run(timelineMessageId).changes;
      }
    },
    questions: {
      upsertQuestionThread({ threadId, authorId }) {
        statements.upsertQuestionThread.run(threadId, authorId, new Date().toISOString());
      },
      ensureQuestionThread(threadId, authorId = null) {
        statements.ensureQuestionThread.run(threadId, authorId, new Date().toISOString());
      },
      getQuestionThread(threadId) {
        return statements.getQuestionThread.get(threadId) || null;
      },
      markResolved(threadId, resolvedAt = new Date()) {
        statements.markResolved.run(
          resolvedAt instanceof Date ? resolvedAt.toISOString() : resolvedAt,
          threadId
        );
      },
      clearResolved(threadId) {
        statements.clearResolved.run(threadId);
      },
      setGuideMessage(threadId, guideMessageId) {
        statements.setQuestionGuideMessage.run(
          guideMessageId,
          new Date().toISOString(),
          threadId
        );
      }
    },
    questionRolePrompts: {
      upsert({
        threadId,
        guildId,
        authorUserId,
        promptMessageId = null,
        selectedRoleIds = [],
        status = 'pending',
        relayedMessageId = null,
        expiresAt = null
      }) {
        const now = new Date().toISOString();
        statements.upsertQuestionRolePrompt.run(
          threadId,
          guildId,
          authorUserId,
          promptMessageId,
          JSON.stringify(Array.isArray(selectedRoleIds) ? selectedRoleIds : []),
          status,
          relayedMessageId,
          expiresAt,
          now,
          now
        );
      },
      get(threadId) {
        const row = statements.getQuestionRolePrompt.get(threadId) || null;
        if (!row) {
          return null;
        }
        return {
          ...row,
          selectedRoleIds: (() => {
            try {
              const parsed = JSON.parse(row.selectedRoleIdsJson || '[]');
              return Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
              return [];
            }
          })()
        };
      },
      listPending() {
        return statements.listPendingQuestionRolePrompts.all().map((row) => ({
          ...row,
          selectedRoleIds: (() => {
            try {
              const parsed = JSON.parse(row.selectedRoleIdsJson || '[]');
              return Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
              return [];
            }
          })()
        }));
      },
      markStatus(threadId, {
        selectedRoleIds = [],
        status,
        relayedMessageId = null
      }) {
        statements.markQuestionRolePromptStatus.run(
          JSON.stringify(Array.isArray(selectedRoleIds) ? selectedRoleIds.map(String) : []),
          status,
          relayedMessageId,
          new Date().toISOString(),
          threadId
        );
      }
    },
    rolePanels: {
      upsert({ guildId, panelKind, channelId, messageId }) {
        const now = new Date().toISOString();
        statements.upsertRolePanelMessage.run(
          guildId,
          panelKind,
          channelId,
          messageId,
          now,
          now
        );
      },
      get(guildId, panelKind) {
        return statements.getRolePanelMessage.get(guildId, panelKind) || null;
      },
      getByMessageId(messageId) {
        return statements.getRolePanelMessageByMessageId.get(messageId) || null;
      }
    },
    vcProfiles: {
      getCategoryMessage({ guildId, categoryId, profileChannelId }) {
        return statements.getVcCategoryProfileMessage.get(guildId, categoryId, profileChannelId) || null;
      },
      upsertCategoryMessage({ guildId, categoryId, profileChannelId, messageId }) {
        statements.upsertVcCategoryProfileMessage.run(
          guildId,
          categoryId,
          profileChannelId,
          messageId,
          new Date().toISOString()
        );
      },
      deleteCategoryMessage({ guildId, categoryId, profileChannelId }) {
        return statements.deleteVcCategoryProfileMessage.run(guildId, categoryId, profileChannelId).changes;
      },
      listCategoryPages({ guildId, categoryId, profileChannelId }) {
        return statements.listVcCategoryProfilePages.all(guildId, categoryId, profileChannelId);
      },
      upsertCategoryPage({ guildId, categoryId, profileChannelId, pageIndex, messageId }) {
        statements.upsertVcCategoryProfilePage.run(
          guildId,
          categoryId,
          profileChannelId,
          pageIndex,
          messageId,
          new Date().toISOString()
        );
      },
      deleteCategoryPage({ guildId, categoryId, profileChannelId, pageIndex }) {
        return statements.deleteVcCategoryProfilePage.run(guildId, categoryId, profileChannelId, pageIndex).changes;
      },
      deleteCategoryPages({ guildId, categoryId, profileChannelId }) {
        return statements.deleteVcCategoryProfilePages.run(guildId, categoryId, profileChannelId).changes;
      },
      deleteCategoryPagesFromIndex({ guildId, categoryId, profileChannelId, pageIndex }) {
        return statements.deleteVcCategoryProfilePagesFromIndex.run(
          guildId,
          categoryId,
          profileChannelId,
          pageIndex
        ).changes;
      },
      getMemberSession({ guildId, userId, categoryId, profileChannelId }) {
        return statements.getVcProfileMemberSession.get(
          guildId,
          userId,
          categoryId,
          profileChannelId
        ) || null;
      },
      listMemberSessions({ guildId, categoryId, profileChannelId }) {
        return statements.listVcProfileMemberSessions.all(guildId, categoryId, profileChannelId);
      },
      upsertMemberSession({ guildId, userId, categoryId, profileChannelId, voiceChannelId, joinedAt, joinedAtEstimated = false }) {
        const now = new Date().toISOString();
        statements.upsertVcProfileMemberSession.run(
          guildId,
          userId,
          categoryId,
          profileChannelId,
          voiceChannelId,
          joinedAt || now,
          joinedAtEstimated ? 1 : 0,
          now
        );
      },
      deleteMemberSession({ guildId, userId, categoryId, profileChannelId }) {
        return statements.deleteVcProfileMemberSession.run(
          guildId,
          userId,
          categoryId,
          profileChannelId
        ).changes;
      },
      deleteMemberSessionsForCategory({ guildId, categoryId, profileChannelId }) {
        return statements.deleteVcProfileMemberSessionsForCategory.run(
          guildId,
          categoryId,
          profileChannelId
        ).changes;
      },
      upsertRecentLeave({
        guildId,
        categoryId,
        profileChannelId,
        voiceChannelId,
        userId,
        leftAt,
        displayNameSnapshot = null,
        avatarUrlSnapshot = null
      }) {
        const now = new Date().toISOString();
        statements.upsertVcProfileRecentLeave.run(
          guildId,
          categoryId,
          profileChannelId,
          voiceChannelId,
          userId,
          leftAt || now,
          displayNameSnapshot,
          avatarUrlSnapshot,
          now,
          now
        );
      },
      deleteRecentLeave({ guildId, categoryId, profileChannelId, voiceChannelId, userId }) {
        return statements.deleteVcProfileRecentLeave.run(
          guildId,
          categoryId,
          profileChannelId,
          voiceChannelId,
          userId
        ).changes;
      },
      listRecentLeavesForChannel({ guildId, categoryId, profileChannelId, voiceChannelId, sinceIso }) {
        return statements.listVcProfileRecentLeavesForChannel.all(
          guildId,
          categoryId,
          profileChannelId,
          voiceChannelId,
          sinceIso
        );
      },
      deleteExpiredRecentLeaves(cutoffIso) {
        return statements.deleteExpiredVcProfileRecentLeaves.run(cutoffIso).changes;
      },
      getColorSession({ guildId, categoryId, profileChannelId }) {
        return statements.getVcProfileColorSession.get(guildId, categoryId, profileChannelId) || null;
      },
      upsertColorSession({ guildId, categoryId, profileChannelId, color, activeSince }) {
        const now = new Date().toISOString();
        statements.upsertVcProfileColorSession.run(
          guildId,
          categoryId,
          profileChannelId,
          Number(color),
          activeSince || now,
          now
        );
      },
      deleteColorSession({ guildId, categoryId, profileChannelId }) {
        return statements.deleteVcProfileColorSession.run(guildId, categoryId, profileChannelId).changes;
      },
      getRoomMessage(voiceChannelId) {
        return statements.getVcChannelProfileMessage.get(voiceChannelId) || null;
      },
      listRoomMessagesByCategory(categoryId) {
        return statements.listVcChannelProfileMessagesByCategory.all(categoryId);
      },
      upsertRoomMessage({ categoryId, voiceChannelId, profileChannelId, messageId }) {
        statements.upsertVcChannelProfileMessage.run(
          categoryId,
          voiceChannelId,
          profileChannelId,
          messageId,
          new Date().toISOString()
        );
      },
      deleteRoomMessage(voiceChannelId) {
        statements.deleteVcChannelProfileMessage.run(voiceChannelId);
      },
      deleteRoomMessagesByCategoryProfile(categoryId, profileChannelId) {
        return statements.deleteVcChannelProfileMessagesByCategoryProfile.run(categoryId, profileChannelId).changes;
      },
      listLegacyProfileMessagesByCategory(categoryId) {
        return statements.listLegacyVcProfileMessagesByCategory.all(categoryId);
      },
      deleteLegacyProfileMessagesByCategory(categoryId) {
        statements.deleteLegacyVcProfileMessagesByCategory.run(categoryId);
      }
    },
    vcVoiceSessions: {
      getOpen({ guildId, categoryId, profileChannelId }) {
        return statements.getOpenVcVoiceSession.get(guildId, categoryId, profileChannelId) || null;
      },
      getOpenForChannel({ guildId, categoryId, profileChannelId, mainVoiceChannelId }) {
        return statements.getOpenVcVoiceSessionForChannel.get(
          guildId,
          categoryId,
          profileChannelId,
          mainVoiceChannelId
        ) || null;
      },
      get({ guildId, sessionId }) {
        return statements.getVcVoiceSession.get(guildId, sessionId) || null;
      },
      upsert(session) {
        const now = new Date().toISOString();
        statements.upsertVcVoiceSession.run(
          session.guildId,
          session.sessionId,
          session.categoryId,
          session.profileChannelId || null,
          session.status,
          session.startedAt,
          session.endedAt || null,
          session.firstTwoPlusAt || null,
          session.lastTwoPlusAt || null,
          session.soloSince || null,
          session.lastActiveAt || null,
          Number(session.maxHumanCount || 0),
          session.peakStartedAt || null,
          session.peakEndedAt || null,
          session.peakMemberIdsJson || '[]',
          session.allParticipantIdsJson || '[]',
          session.firstJoinUserId || null,
          session.firstJoinAt || null,
          session.lastLeaveUserId || null,
          session.lastLeaveAt || null,
          session.mainVoiceChannelId || null,
          session.voiceChannelIdsJson || '[]',
          Number(session.twoPlusTotalSeconds || 0),
          session.createdAt || now,
          session.updatedAt || now
        );
      },
      listOpen(guildId) {
        return statements.listOpenVcVoiceSessions.all(guildId);
      },
      listOpenForCategory({ guildId, categoryId, profileChannelId }) {
        return statements.listOpenVcVoiceSessionsForCategory.all(guildId, categoryId, profileChannelId);
      },
      listClosedForSummary({ guildId, sinceIso, categoryId = null, mode = 'peak', limit = 1 }) {
        const statement = mode === 'latest'
          ? statements.listClosedVcVoiceSessionsLatest
          : statements.listClosedVcVoiceSessionsPeak;
        return statement.all(guildId, sinceIso, categoryId || null, categoryId || null, Number(limit || 1));
      },
      listMembers(guildId, sessionId) {
        return statements.listVcVoiceSessionMembers.all(guildId, sessionId);
      },
      upsertMember(member) {
        const now = new Date().toISOString();
        statements.upsertVcVoiceSessionMember.run(
          member.guildId,
          member.sessionId,
          member.userId,
          member.displayNameSnapshot || null,
          member.avatarUrlSnapshot || null,
          member.firstJoinedAt || null,
          member.lastLeftAt || null,
          Number(member.totalPresentSeconds || 0),
          member.wasPresentAtPeak ? 1 : 0,
          member.joinedWhileSessionActive ? 1 : 0,
          member.presentSince || null,
          member.isPresent ? 1 : 0,
          member.currentVoiceChannelId || null,
          member.createdAt || now,
          member.updatedAt || now
        );
      },
      insertEvent(event) {
        return statements.insertVcVoiceSessionEvent.run(
          event.guildId,
          event.sessionId,
          event.eventType,
          event.userId || null,
          event.fromChannelId || null,
          event.toChannelId || null,
          event.occurredAt || new Date().toISOString(),
          event.humanCountAfter == null ? null : Number(event.humanCountAfter),
          event.memberIdsAfterJson || '[]',
          event.metadataJson || '{}'
        ).lastInsertRowid;
      },
      listEvents(guildId, sessionId, limit = 10) {
        return statements.listVcVoiceSessionEvents.all(guildId, sessionId, Number(limit || 10));
      },
      upsertSummaryMessage(record) {
        const now = new Date().toISOString();
        statements.upsertVcVoiceSessionSummaryMessage.run(
          record.guildId,
          record.sessionId,
          record.categoryId,
          record.profileChannelId,
          record.messageId,
          record.expiresAt,
          record.status || 'active',
          record.createdAt || now,
          record.updatedAt || now
        );
      },
      listActiveSummaryMessages() {
        return statements.listActiveVcVoiceSessionSummaryMessages.all();
      },
      listActiveSummaryMessagesForCategory({ guildId, categoryId, profileChannelId }) {
        return statements.listActiveVcVoiceSessionSummaryMessagesForCategory.all(
          guildId,
          categoryId,
          profileChannelId
        );
      },
      updateSummaryMessageStatus({ guildId, sessionId, profileChannelId, status }) {
        return statements.updateVcVoiceSessionSummaryMessageStatus.run(
          status,
          new Date().toISOString(),
          guildId,
          sessionId,
          profileChannelId
        ).changes;
      }
    },
    vcShortActivity: {
      insertEpisode(record) {
        const now = new Date().toISOString();
        return statements.insertVcShortActivityEpisode.run(
          record.stableEpisodeKey,
          record.guildId,
          record.categoryId,
          record.profileChannelId,
          record.voiceChannelId,
          record.startedAt,
          record.endedAt,
          Number(record.durationSeconds || 0),
          JSON.stringify(record.participantIds || []),
          Number(record.peakHumanCount || 0),
          record.closeReason || null,
          record.status || 'active',
          now,
          now
        ).changes;
      },
      listEpisodes({ guildId, categoryId, profileChannelId, limit = 50 }) {
        return statements.listVcShortActivityEpisodes.all(guildId, categoryId, profileChannelId, Number(limit || 50));
      },
      clearChannel({ guildId, categoryId, profileChannelId, voiceChannelId }) {
        return statements.clearVcShortActivityForChannel.run(
          new Date().toISOString(),
          guildId,
          categoryId,
          profileChannelId,
          voiceChannelId
        ).changes;
      },
      expireBefore(cutoffIso) {
        return statements.expireVcShortActivityBefore.run(new Date().toISOString(), cutoffIso).changes;
      },
      getMessage({ guildId, categoryId, profileChannelId }) {
        return statements.getVcShortActivityMessage.get(guildId, categoryId, profileChannelId) || null;
      },
      upsertMessage({ guildId, categoryId, profileChannelId, messageId, status = 'active' }) {
        statements.upsertVcShortActivityMessage.run(guildId, categoryId, profileChannelId, messageId, status, new Date().toISOString());
      },
      updateMessageStatus({ guildId, categoryId, profileChannelId, status }) {
        return statements.updateVcShortActivityMessageStatus.run(status, new Date().toISOString(), guildId, categoryId, profileChannelId).changes;
      }
    },
    vcWorkTime: {
      getOpenInterval(guildId, userId) {
        return statements.getOpenVcWorkInterval.get(guildId, userId) || null;
      },
      listOpenIntervals() {
        return statements.listOpenVcWorkIntervals.all();
      },
      openInterval(record) {
        const now = new Date().toISOString();
        return statements.insertVcWorkInterval.run(
          record.stableIntervalKey,
          record.guildId,
          record.userId,
          record.categoryId,
          record.voiceChannelId,
          record.listenChatChannelId || null,
          record.startedAt,
          record.source || 'voice_state_update',
          record.sourceSessionId || null,
          record.sourceMemberKey || null,
          record.startEstimated ? 1 : 0,
          now,
          now
        ).changes;
      },
      closeInterval({ intervalId, endedAt, durationSeconds, endEstimated = false }) {
        return statements.closeVcWorkInterval.run(
          endedAt,
          Number(durationSeconds || 0),
          endEstimated ? 1 : 0,
          new Date().toISOString(),
          intervalId
        ).changes;
      },
      addTotalDelta({ guildId, userId, liveTrackedSeconds = 0, historicalBackfillSeconds = 0, countedAt = new Date().toISOString() }) {
        const total = Number(liveTrackedSeconds || 0) + Number(historicalBackfillSeconds || 0);
        statements.upsertVcWorkTotalDelta.run(
          guildId,
          userId,
          total,
          Number(historicalBackfillSeconds || 0),
          Number(liveTrackedSeconds || 0),
          countedAt,
          new Date().toISOString()
        );
      },
      getTotal(guildId, userId) {
        return statements.getVcWorkTotal.get(guildId, userId) || null;
      },
      listTotals(guildId) {
        return statements.listVcWorkTotals.all(guildId);
      },
      listRankingRows(guildId) {
        return statements.listVcWorkRankingRows.all(guildId, guildId);
      },
      claimMilestone(record) {
        const now = new Date().toISOString();
        return statements.insertVcWorkMilestoneAward.run(
          record.guildId,
          record.userId,
          Number(record.milestoneHours),
          record.reachedAt || now,
          record.voiceChannelId || null,
          record.categoryId || null,
          now,
          now
        ).changes;
      },
      updateMilestoneDelivery(record) {
        return statements.updateVcWorkMilestoneDelivery.run(
          record.dmStatus ?? null,
          record.dmMessageId ?? null,
          record.dmSentAt ?? null,
          record.publicStatus ?? null,
          record.publicMessageChannelId ?? null,
          record.publicMessageId ?? null,
          record.publicSentAt ?? null,
          record.cardStatus ?? null,
          record.cardError ?? null,
          new Date().toISOString(),
          record.guildId,
          record.userId,
          Number(record.milestoneHours)
        ).changes;
      },
      listAwardsForUser(guildId, userId) {
        return statements.listVcWorkMilestoneAwardsForUser.all(guildId, userId);
      }
    },
    guides: {
      getGuidePost(channelId, guideKey) {
        return statements.getGuidePost.get(channelId, guideKey) || null;
      },
      listGuidePosts(channelId) {
        return statements.listGuidePostsByChannel.all(channelId);
      },
      upsertGuidePost({ channelId, guideKey, messageId }) {
        statements.upsertGuidePost.run(
          channelId,
          guideKey,
          messageId,
          new Date().toISOString()
        );
      },
      deleteGuidePost(channelId, guideKey) {
        statements.deleteGuidePost.run(channelId, guideKey);
      }
    },
    musicLinks: {
      get(sourceUrl) {
        return statements.getMusicLinkCache.get(sourceUrl) || null;
      },
      upsert({ sourceUrl, universalUrl, title, artist, artworkUrl, platformNames, platformLinksJson, rawJson }) {
        const now = new Date().toISOString();
        statements.upsertMusicLinkCache.run(
          sourceUrl,
          universalUrl || null,
          title || null,
          artist || null,
          artworkUrl || null,
          platformNames || null,
          platformLinksJson || null,
          rawJson || null,
          now,
          now
        );
      }
    },
    welcomeReactions: {
      list(guildId) {
        return statements.listWelcomeReactions.all(guildId);
      },
      get(guildId, emojiKey) {
        return statements.getWelcomeReaction.get(guildId, emojiKey) || null;
      },
      count(guildId) {
        return Number(statements.getWelcomeReactionCount.get(guildId)?.count || 0);
      },
      insert({ guildId, emojiKey, emojiName, emojiId, animated, sortOrder }) {
        statements.insertWelcomeReaction.run(
          guildId,
          emojiKey,
          emojiName || null,
          emojiId || null,
          animated ? 1 : 0,
          sortOrder,
          new Date().toISOString()
        );
      },
      clear(guildId) {
        statements.clearWelcomeReactions.run(guildId);
      }
    },
    archives: {
      upsertMessage(record) {
        statements.upsertArchivedMessage.run(
          record.messageId,
          record.guildId,
          record.channelId,
          record.parentId,
          record.threadId,
          record.authorId,
          record.authorName,
          record.authorIsBot ? 1 : 0,
          record.content,
          record.cleanContent,
          record.attachmentsJson,
          record.embedsJson,
          record.referencedMessageId,
          record.messageType,
          record.createdAt,
          record.editedAt,
          new Date().toISOString()
        );
      },
      getMessage(messageId) {
        return statements.getArchivedMessage.get(messageId) || null;
      },
      listRecentMessages(channelId, limit) {
        return statements.listRecentArchivedMessagesByChannel.all(channelId, limit);
      },
      listRecentMessagesByAuthor(guildId, authorId, limit) {
        return statements.listRecentArchivedMessagesByAuthorInGuild.all(guildId, authorId, limit);
      },
      getThreadStarterMessage(channelId) {
        return statements.getThreadStarterArchivedMessage.get(channelId, channelId) || null;
      },
      countMessages() {
        return Number(statements.countArchivedMessages.get()?.count || 0);
      },
      deleteMessage(messageId) {
        statements.deleteArchivedMessage.run(messageId);
      },
      deleteMessages(messageIds = []) {
        const transaction = sqlite.transaction((ids) => {
          for (const messageId of ids) {
            statements.deleteArchivedMessages.run(messageId);
          }
        });
        transaction(messageIds);
      }
    },
    llmResponses: {
      insert({ responseMessageId, requestMessageId, channelId, authorId }) {
        statements.insertLlmResponse.run(
          responseMessageId,
          requestMessageId,
          channelId,
          authorId,
          new Date().toISOString()
        );
      },
      get(responseMessageId) {
        return statements.getLlmResponseByMessageId.get(responseMessageId) || null;
      },
      count() {
        return Number(statements.countLlmResponses.get()?.count || 0);
      },
      deleteByMessageId(messageId) {
        statements.deleteLlmResponseByMessageId.run(messageId, messageId);
      },
      deleteByMessageIds(messageIds = []) {
        const transaction = sqlite.transaction((ids) => {
          for (const messageId of ids) {
            statements.deleteLlmResponsesByMessageId.run(messageId, messageId);
          }
        });
        transaction(messageIds);
      }
    },
    introDm: {
      upsertState({ guildId, userId, promptType, status = null, sentAt, repliedCount = 0, optOut = false, lastError = null }) {
        const normalizedStatus = status || (sentAt ? 'sent' : lastError ? 'failed' : 'pending');
        statements.upsertIntroDmState.run(
          guildId,
          userId,
          promptType,
          normalizedStatus,
          sentAt || null,
          repliedCount,
          optOut ? 1 : 0,
          lastError,
          new Date().toISOString()
        );
      },
      getState(guildId, userId, promptType) {
        return statements.getIntroDmState.get(guildId, userId, promptType) || null;
      },
      listStatesByUser(guildId, userId) {
        return statements.listIntroDmStatesByUser.all(guildId, userId);
      },
      markOptOutByUser(guildId, userId) {
        statements.markIntroDmOptOutByUser.run(new Date().toISOString(), guildId, userId);
      },
      incrementReplyCountByUser(guildId, userId) {
        statements.incrementIntroDmReplyCountByUser.run(new Date().toISOString(), guildId, userId);
      },
      countStates() {
        return Number(statements.countIntroDmStates.get()?.count || 0);
      },
      countStatesByPromptType() {
        return statements.countIntroDmStatesByPromptType.all();
      },
      countOptOutStates() {
        return Number(statements.countIntroDmOptOutStates.get()?.count || 0);
      }
    },
    introDmQueue: {
      enqueue({ guildId, userId, promptType, reason, scheduledAt, status = 'pending', attempts = 0, lastError = null }) {
        const now = new Date().toISOString();
        statements.insertIntroDmQueue.run(
          guildId,
          userId,
          promptType,
          reason || null,
          scheduledAt,
          status,
          attempts,
          lastError,
          now,
          now
        );
      },
      getPendingForUserPrompt(guildId, userId, promptType) {
        return statements.getPendingIntroDmQueueForUserPrompt.get(guildId, userId, promptType) || null;
      },
      listDue(guildId, dueAtIso, limit = 10) {
        return statements.listIntroDmQueueDue.all(guildId, dueAtIso, limit);
      },
      listDueAllGuilds(dueAtIso, limit = 10) {
        return statements.listIntroDmQueueDueAllGuilds.all(dueAtIso, limit);
      },
      updateStatus(id, { status, attempts = 0, lastError = null }) {
        statements.updateIntroDmQueueStatus.run(status, attempts, lastError, new Date().toISOString(), id);
      },
      markStatus(id, status) {
        statements.markIntroDmQueueStatusById.run(status, new Date().toISOString(), id);
      },
      resetStaleProcessing(staleBeforeIso) {
        return statements.resetStaleIntroDmQueueProcessing.run(new Date().toISOString(), staleBeforeIso).changes;
      },
      countByStatus() {
        return statements.countIntroDmQueueByStatus.all();
      },
      getNextScheduledAt() {
        return statements.getIntroDmQueueNextScheduledAt.get()?.nextScheduledAt || null;
      },
      countDue(dueAtIso) {
        return Number(statements.countIntroDmQueueDueAllGuilds.get(dueAtIso)?.count || 0);
      }
    },
    introVcReminder: {
      get(guildId, userId) {
        return statements.getIntroVcReminderState.get(guildId, userId) || null;
      },
      recordJoin({ guildId, userId, channelId, joinedAt = new Date().toISOString() }) {
        const now = new Date().toISOString();
        const existing = statements.getIntroVcReminderState.get(guildId, userId) || null;
        statements.upsertIntroVcReminderJoin.run(
          guildId,
          userId,
          Number(existing?.qualifyingJoinCount || 0) + 1,
          joinedAt,
          joinedAt,
          channelId || null,
          now,
          now
        );
      },
      recordDisconnect({ guildId, userId, leftAt = new Date().toISOString() }) {
        const now = new Date().toISOString();
        statements.markIntroVcReminderDisconnected.run(guildId, userId, leftAt, now, now);
      },
      markSent({ guildId, userId, channelId, dmMessageId = null, sentAt = new Date().toISOString(), voiceJoinAt = null }) {
        const now = new Date().toISOString();
        statements.markIntroVcReminderSent.run(
          guildId,
          userId,
          sentAt,
          sentAt,
          voiceJoinAt || sentAt,
          channelId || null,
          dmMessageId || null,
          now,
          now
        );
      },
      markError({ guildId, userId, channelId, error, voiceJoinAt = new Date().toISOString() }) {
        const now = new Date().toISOString();
        statements.markIntroVcReminderError.run(
          guildId,
          userId,
          voiceJoinAt,
          now,
          channelId || null,
          String(error || 'unknown'),
          now,
          now
        );
      },
      markCompleted(guildId, userId, completedAt = new Date().toISOString()) {
        return statements.markIntroVcReminderCompleted.run(completedAt, new Date().toISOString(), guildId, userId).changes;
      }
    },
    introProfiles: {
      upsert(record) {
        statements.upsertIntroProfile.run(
          record.guildId,
          record.userId,
          record.introChannelId,
          record.introMessageId,
          record.displayName,
          record.username,
          record.globalName,
          record.nickname,
          record.introText,
          record.linksJson,
          record.embedsJson,
          record.attachmentsJson,
          record.searchAliasesJson,
          record.postedAt,
          record.updatedAt,
          new Date().toISOString()
        );
      },
      deleteByMessageId(messageId) {
        statements.deleteIntroProfileByMessageId.run(messageId);
      },
      deleteByUserInChannel(guildId, userId, introChannelId) {
        statements.deleteIntroProfileByUserInChannel.run(guildId, userId, introChannelId);
      },
      deleteByChannel(guildId, introChannelId) {
        statements.deleteIntroProfilesByChannel.run(guildId, introChannelId);
      },
      getByMessageId(messageId) {
        return renderIntroProfileRow(statements.getIntroProfileByMessageId.get(messageId) || null);
      },
      getLatestByUser(guildId, userId, introChannelId) {
        return renderIntroProfileRow(statements.getLatestIntroProfileByUser.get(guildId, userId, introChannelId) || null);
      },
      listByUser(guildId, userId, introChannelId) {
        return renderIntroProfileRows(statements.listIntroProfilesByUser.all(guildId, userId, introChannelId));
      },
      search(guildId, introChannelId, query, limit) {
        const like = `%${String(query || '').toLowerCase()}%`;
        return renderIntroProfileRows(statements.searchIntroProfiles.all(guildId, introChannelId, like, like, like, like, like, limit));
      },
      count(guildId, introChannelId) {
        return Number(statements.countIntroProfiles.get(guildId, introChannelId)?.count || 0);
      },
      getLatestDate(guildId, introChannelId) {
        return statements.getLatestIntroProfileDate.get(guildId, introChannelId)?.latestDate || null;
      },
      listByChannel(guildId, introChannelId, limit = 1000) {
        return renderIntroProfileRows(statements.listIntroProfilesByChannel.all(guildId, introChannelId, limit));
      }
    },
    introProfileAddendums: {
      upsert(record) {
        const now = new Date().toISOString();
        statements.upsertIntroProfileAddendum.run(
          record.guildId,
          record.userId,
          record.addendumMessageId,
          record.channelId,
          record.targetIntroMessageId,
          record.absorbedText,
          record.absorbedUrlsJson,
          record.status || 'active',
          record.createdAt || now,
          record.updatedAt || now,
          record.removedAt || null
        );
      },
      get(guildId, addendumMessageId) {
        return statements.getIntroProfileAddendum.get(guildId, addendumMessageId) || null;
      },
      listActiveForProfile(guildId, userId, targetIntroMessageId) {
        return statements.listActiveIntroProfileAddendumsForProfile.all(
          guildId,
          userId,
          targetIntroMessageId
        );
      },
      listActiveByChannel(guildId, channelId, limit = 2000) {
        return statements.listActiveIntroProfileAddendumsByChannel.all(guildId, channelId, limit);
      },
      markStatus(guildId, addendumMessageId, status, removedAt = null) {
        return statements.markIntroProfileAddendumStatus.run(
          status,
          new Date().toISOString(),
          removedAt,
          guildId,
          addendumMessageId
        ).changes;
      }
    },
    introReactions: {
      insert({ guildId, emojiKey, emojiName, emojiId, animated = false, sortOrder }) {
        statements.insertIntroReaction.run(
          guildId,
          emojiKey,
          emojiName,
          emojiId,
          animated ? 1 : 0,
          sortOrder,
          new Date().toISOString()
        );
      },
      list(guildId) {
        return statements.listIntroReactions.all(guildId);
      },
      clear(guildId) {
        statements.clearIntroReactions.run(guildId);
      },
      count(guildId) {
        return Number(statements.countIntroReactions.get(guildId)?.count || 0);
      }
    },
    guildMembers: {
      upsert(record) {
        const now = new Date().toISOString();
        statements.upsertGuildMember.run(
          record.guildId,
          record.userId,
          record.username || null,
          record.globalName || null,
          record.displayName || null,
          record.nickname || null,
          record.joinedAt || null,
          record.isBot ? 1 : 0,
          record.leftAt || null,
          record.lastSeenAt || now,
          record.lastVcJoinedAt || null,
          record.createdAt || now,
          now
        );
      },
      markLeft(guildId, userId, leftAt = new Date().toISOString()) {
        statements.markGuildMemberLeft.run(leftAt, new Date().toISOString(), guildId, userId);
      },
      updateVcJoined(guildId, userId, joinedAt = new Date().toISOString()) {
        statements.updateGuildMemberVcJoined.run(joinedAt, joinedAt, new Date().toISOString(), guildId, userId);
      },
      get(guildId, userId) {
        return statements.getGuildMember.get(guildId, userId) || null;
      },
      getWithoutIntroOlderThan(guildId, olderThanIso, introChannelId, limit = 20) {
        return statements.listGuildMembersWithoutIntroOlderThan.all(guildId, olderThanIso, introChannelId, limit);
      },
      count(guildId) {
        return Number(statements.countGuildMembers.get(guildId)?.count || 0);
      },
      countWithoutIntro(guildId, introChannelId) {
        return Number(statements.countGuildMembersWithoutIntro.get(guildId, introChannelId)?.count || 0);
      }
    },
    anime: {
      upsertEntry(record) {
        const now = new Date().toISOString();
        statements.upsertAnimeEntry.run(
          record.guildId,
          record.provider,
          record.providerMediaId,
          record.titleNative || null,
          record.titleKana || null,
          record.titleRomaji || null,
          record.titleEnglish || null,
          record.titleUserPreferred || null,
          record.aliasesJson || null,
          record.description || null,
          record.siteUrl || null,
          record.officialSiteUrl || null,
          record.malAnimeId || null,
          record.coverImageUrl || null,
          record.bannerImageUrl || null,
          record.season || null,
          Number.isFinite(record.seasonYear) ? record.seasonYear : null,
          record.status || null,
          Number.isFinite(record.episodes) ? record.episodes : null,
          Number.isFinite(record.duration) ? record.duration : null,
          record.nextAiringAt || null,
          record.animeChannelId || null,
          record.animeChannelMessageId || null,
          record.threadId || null,
          record.threadCardMessageId || null,
          record.reviewCardMessageId || null,
          record.hasSpoilerReviews ? 1 : 0,
          record.createdByUserId || null,
          record.createdAt || now,
          now
        );
      },
      getEntryByProviderMediaId(guildId, provider, providerMediaId) {
        return statements.getAnimeEntryByProviderMediaId.get(guildId, provider, providerMediaId) || null;
      },
      getEntryById(id) {
        return statements.getAnimeEntryById.get(id) || null;
      },
      getEntryByThreadId(guildId, threadId) {
        return statements.getAnimeEntryByThreadId.get(guildId, threadId) || null;
      },
      getEntryByChannelMessageId(guildId, messageId) {
        return statements.getAnimeEntryByChannelMessageId.get(guildId, messageId) || null;
      },
      updateBindings(id, { animeChannelId = null, animeChannelMessageId = null, threadId = null, threadCardMessageId = null, reviewCardMessageId = null }) {
        statements.updateAnimeEntryMessageBindings.run(
          animeChannelId,
          animeChannelMessageId,
          threadId,
          threadCardMessageId,
          reviewCardMessageId,
          new Date().toISOString(),
          id
        );
      },
      clearBindings(id) {
        statements.clearAnimeEntryMessageBindings.run(new Date().toISOString(), id);
      },
      updateSpoilerFlag(id, hasSpoilerReviews) {
        statements.replaceAnimeEntrySpoilerFlag.run(hasSpoilerReviews ? 1 : 0, new Date().toISOString(), id);
      },
      listEntriesPage(guildId, limit = 25, offset = 0) {
        return statements.listAnimeEntriesPage.all(guildId, limit, offset);
      },
      countEntries(guildId) {
        return Number(statements.countAnimeEntries.get(guildId)?.count || 0);
      },
      searchEntries(guildId, query, limit = 10) {
        const like = `%${String(query || '').toLowerCase()}%`;
        return statements.searchAnimeEntriesLocal.all(guildId, like, like, like, like, like, like, limit);
      },
      replaceCastCache(animeEntryId, rows = []) {
        const transaction = sqlite.transaction((entryId, castRows) => {
          statements.deleteAnimeCastByEntryId.run(entryId);
          for (const row of castRows) {
            statements.insertAnimeCastRow.run(
              entryId,
              row.characterName || null,
              row.characterNameNative || null,
              row.characterImageUrl || null,
              row.voiceActorName || null,
              row.voiceActorLanguage || null,
              row.voiceActorImageUrl || null,
              row.sortOrder || 0,
              new Date().toISOString()
            );
          }
        });
        transaction(animeEntryId, rows);
      },
      listCast(animeEntryId) {
        return statements.listAnimeCastByEntryId.all(animeEntryId);
      },
      upsertUserStatus({ guildId, animeEntryId, userId, interested = 0, watched = 0, interestedAt = null, watchedAt = null }) {
        const now = new Date().toISOString();
        statements.upsertAnimeUserStatus.run(
          guildId,
          animeEntryId,
          userId,
          interested ? 1 : 0,
          watched ? 1 : 0,
          interestedAt,
          watchedAt,
          now,
          now
        );
      },
      getUserStatus(guildId, animeEntryId, userId) {
        return statements.getAnimeUserStatus.get(guildId, animeEntryId, userId) || null;
      },
      countInterested(guildId, animeEntryId) {
        return Number(statements.countAnimeInterestedUsers.get(guildId, animeEntryId)?.count || 0);
      },
      countWatched(guildId, animeEntryId) {
        return Number(statements.countAnimeWatchedUsers.get(guildId, animeEntryId)?.count || 0);
      },
      countUserInterested(guildId, userId) {
        return Number(statements.countAnimeUserInterested.get(guildId, userId)?.count || 0);
      },
      countUserWatched(guildId, userId) {
        return Number(statements.countAnimeUserWatched.get(guildId, userId)?.count || 0);
      },
      upsertReview({ guildId, animeEntryId, userId, reviewText, spoiler = false, sourceChannelId = null, sourceMessageId = null }) {
        const now = new Date().toISOString();
        statements.upsertAnimeReview.run(
          guildId,
          animeEntryId,
          userId,
          reviewText,
          spoiler ? 1 : 0,
          sourceChannelId,
          sourceMessageId,
          now,
          now
        );
      },
      getReviewByUser(guildId, animeEntryId, userId) {
        return statements.getAnimeReviewByUser.get(guildId, animeEntryId, userId) || null;
      },
      listReviews(guildId, animeEntryId, limit = 20) {
        return statements.listAnimeReviewsByEntryId.all(guildId, animeEntryId, limit);
      },
      countReviews(guildId, animeEntryId) {
        return Number(statements.countAnimeReviewsByEntryId.get(guildId, animeEntryId)?.count || 0);
      },
      countSpoilerReviews(guildId, animeEntryId) {
        return Number(statements.countAnimeSpoilerReviewsByEntryId.get(guildId, animeEntryId)?.count || 0);
      },
      countReviewedByUser(guildId, userId) {
        return Number(statements.countAnimeReviewedDistinctByUser.get(guildId, userId)?.count || 0);
      },
      upsertReviewRole({ guildId, threshold, roleId = null }) {
        const now = new Date().toISOString();
        statements.upsertAnimeReviewRole.run(guildId, threshold, roleId, now, now);
      },
      listReviewRoles(guildId) {
        return statements.listAnimeReviewRoles.all(guildId);
      },
      getRoleAward(guildId, userId, threshold) {
        return statements.getAnimeRoleAward.get(guildId, userId, threshold) || null;
      },
      upsertRoleAward({ guildId, userId, threshold, roleId = null, awardedAt = new Date().toISOString(), dmSentAt = null }) {
        statements.upsertAnimeRoleAward.run(guildId, userId, threshold, roleId, awardedAt, dmSentAt);
      },
      setRoleAwardDmSentAt(guildId, userId, threshold, dmSentAt = new Date().toISOString()) {
        statements.setAnimeRoleAwardDmSentAt.run(dmSentAt, guildId, userId, threshold);
      },
      upsertReviewPromptState({
        guildId,
        animeEntryId,
        userId,
        promptType,
        promptMessageId = null,
        threadId = null,
        promptedAt = new Date().toISOString()
      }) {
        statements.upsertAnimeReviewPromptState.run(
          guildId,
          animeEntryId,
          userId,
          promptType,
          promptMessageId,
          threadId,
          promptedAt
        );
      },
      getReviewPromptState(guildId, animeEntryId, userId, promptType) {
        return statements.getAnimeReviewPromptState.get(guildId, animeEntryId, userId, promptType) || null;
      },
      getReviewPromptStateByMessageId(guildId, promptMessageId, promptType) {
        return statements.getAnimeReviewPromptStateByMessageId.get(guildId, promptMessageId, promptType) || null;
      },
      deleteReviewPromptStateByMessageId(guildId, promptMessageId) {
        statements.deleteAnimeReviewPromptStateByMessageId.run(guildId, promptMessageId);
      },
      upsertHashtagSource(record) {
        const now = new Date().toISOString();
        statements.upsertAnimeHashtagSource.run(
          record.guildId,
          record.sourceMessageId,
          record.sourceChannelId,
          record.sourceAuthorId || null,
          record.relayedTimelineMessageId || null,
          record.relayedRouteMessageIdsJson || null,
          record.cleanedContent || null,
          record.displayTagsJson || null,
          record.detectedCandidate || null,
          record.animeEntryId || null,
          record.status || 'pending',
          record.createdAt || now,
          now
        );
      },
      getHashtagSourceByMessageId(guildId, sourceMessageId) {
        return statements.getAnimeHashtagSourceByMessageId.get(guildId, sourceMessageId) || null;
      },
      listRecentUnresolvedHashtagSourcesByUser(guildId, userId, sinceIso, limit = 5) {
        return statements.listRecentUnresolvedAnimeHashtagSourcesByUser.all(guildId, userId, sinceIso, limit);
      },
      updateHashtagSourceLink(id, { animeEntryId = null, status = 'linked', detectedCandidate = null }) {
        statements.updateAnimeHashtagSourceLink.run(animeEntryId, status, detectedCandidate, new Date().toISOString(), id);
      },
      listAllEntries(guildId) {
        return statements.listAllAnimeEntries.all(guildId);
      },
      deleteEntryCascade(entryId) {
        const transaction = sqlite.transaction((targetEntryId) => {
          statements.deleteAnimeCastByEntryId.run(targetEntryId);
          statements.deleteAnimeReviewsByEntryId.run(targetEntryId);
          statements.deleteAnimeUserStatusByEntryId.run(targetEntryId);
          statements.deleteAnimeReviewPromptStateByEntryId.run(targetEntryId);
          statements.deleteAnimeHashtagSourcesByEntryId.run(targetEntryId);
          statements.deleteAnimeEntryById.run(targetEntryId);
        });
        transaction(entryId);
      }
    },
    annictUserIntegration: {
      upsertConnection(record) {
        const now = new Date().toISOString();
        statements.upsertAnnictConnection.run(
          record.guildId,
          record.discordUserId,
          record.annictResourceOwnerId,
          record.encryptedAccessToken,
          record.tokenIv,
          record.tokenAuthTag,
          Number(record.encryptionVersion || 1),
          record.encryptionKeyId || 'default',
          JSON.stringify(record.scopes || []),
          record.connectedAt || now,
          now,
          record.lastSuccessfulSyncAt || null,
          JSON.stringify(record.syncCursor || {}),
          record.tokenStatus || 'active',
          record.lastErrorCode || null
        );
      },
      getConnection(guildId, discordUserId) {
        return parseAnnictConnection(statements.getAnnictConnection.get(guildId, discordUserId) || null);
      },
      listActiveConnections(guildId) {
        return statements.listAnnictActiveConnections.all(guildId).map(parseAnnictConnection);
      },
      deleteConnection(guildId, discordUserId) {
        statements.deleteAnnictConnection.run(guildId, discordUserId);
      },
      updateConnectionSync({ guildId, discordUserId, lastSuccessfulSyncAt = null, syncCursor = null, tokenStatus = 'active', lastErrorCode = null }) {
        const now = new Date().toISOString();
        statements.updateAnnictConnectionSync.run(
          lastSuccessfulSyncAt,
          syncCursor == null ? null : JSON.stringify(syncCursor),
          tokenStatus,
          lastErrorCode,
          now,
          guildId,
          discordUserId
        );
      },
      insertOauthState({ state, guildId, discordUserId, redirectUri, scopes, expiresAt }) {
        statements.insertAnnictOauthState.run(
          state,
          guildId,
          discordUserId,
          redirectUri,
          JSON.stringify(scopes || []),
          new Date().toISOString(),
          expiresAt
        );
      },
      getOauthState(state) {
        const row = statements.getAnnictOauthState.get(state) || null;
        if (!row) {
          return null;
        }
        return {
          ...row,
          scopes: parseJsonArray(row.scopesJson)
        };
      },
      consumeOauthState(state) {
        return statements.consumeAnnictOauthState.run(new Date().toISOString(), state).changes > 0;
      },
      deleteExpiredOauthStates(nowIso = new Date().toISOString()) {
        statements.deleteExpiredAnnictOauthStates.run(nowIso);
      },
      upsertUserWorkState({ guildId, discordUserId, annictWorkId, animeEntryId = null, status, source, sourceUpdatedAt = null, syncedAt = new Date().toISOString() }) {
        statements.upsertAnnictUserWorkState.run(
          guildId,
          discordUserId,
          annictWorkId,
          animeEntryId,
          status,
          source,
          sourceUpdatedAt,
          syncedAt
        );
      },
      getUserWorkState(guildId, discordUserId, annictWorkId) {
        return statements.getAnnictUserWorkState.get(guildId, discordUserId, annictWorkId) || null;
      },
      getWatchedImportJob(guildId, discordUserId) {
        return statements.getAnnictWatchedImportJob.get(guildId, discordUserId) || null;
      },
      listDueWatchedImportJobs(nowIso = new Date().toISOString(), limit = 5) {
        return statements.listDueAnnictWatchedImportJobs.all(nowIso, limit);
      },
      startOrResumeWatchedImportJob({ guildId, discordUserId, nextRunAt = new Date().toISOString() }) {
        const now = new Date().toISOString();
        const existing = statements.getAnnictWatchedImportJob.get(guildId, discordUserId) || null;
        statements.upsertAnnictWatchedImportJob.run(
          guildId,
          discordUserId,
          'active',
          existing?.graphqlCursor || null,
          existing?.hasNextPage == null ? 1 : (existing.hasNextPage ? 1 : 0),
          Number(existing?.scannedCount || 0),
          Number(existing?.postedCount || 0),
          Number(existing?.skippedExistingCount || 0),
          Number(existing?.repairedCount || 0),
          Number(existing?.failedCount || 0),
          existing?.startedAt || now,
          existing?.lastProcessedAt || null,
          nextRunAt,
          null,
          null,
          null,
          existing?.createdAt || now,
          now
        );
        return statements.getAnnictWatchedImportJob.get(guildId, discordUserId) || null;
      },
      cancelWatchedImportJob(guildId, discordUserId) {
        const now = new Date().toISOString();
        const existing = statements.getAnnictWatchedImportJob.get(guildId, discordUserId) || null;
        if (!existing) {
          return null;
        }
        statements.updateAnnictWatchedImportJobProgress.run(
          'cancelled',
          existing.graphqlCursor || null,
          existing.hasNextPage == null ? 1 : (existing.hasNextPage ? 1 : 0),
          0,
          0,
          0,
          0,
          0,
          existing.lastProcessedAt || null,
          null,
          existing.completedAt || null,
          now,
          null,
          now,
          guildId,
          discordUserId
        );
        return statements.getAnnictWatchedImportJob.get(guildId, discordUserId) || null;
      },
      updateWatchedImportJobProgress({
        guildId,
        discordUserId,
        status = 'active',
        graphqlCursor = null,
        hasNextPage = true,
        scannedDelta = 0,
        postedDelta = 0,
        skippedExistingDelta = 0,
        repairedDelta = 0,
        failedDelta = 0,
        lastProcessedAt = null,
        nextRunAt = null,
        completedAt = null,
        cancelledAt = null,
        lastErrorCode = null
      }) {
        const now = new Date().toISOString();
        return statements.updateAnnictWatchedImportJobProgress.run(
          status,
          graphqlCursor,
          hasNextPage ? 1 : 0,
          Number(scannedDelta || 0),
          Number(postedDelta || 0),
          Number(skippedExistingDelta || 0),
          Number(repairedDelta || 0),
          Number(failedDelta || 0),
          lastProcessedAt,
          nextRunAt,
          completedAt,
          cancelledAt,
          lastErrorCode,
          now,
          guildId,
          discordUserId
        ).changes;
      },
      upsertWatchedImportItem({
        guildId,
        discordUserId,
        annictWorkId,
        status,
        animeEntryId = null,
        attemptsDelta = 0,
        lastErrorCode = null,
        processedAt = null
      }) {
        const now = new Date().toISOString();
        statements.upsertAnnictWatchedImportItem.run(
          guildId,
          discordUserId,
          annictWorkId,
          status,
          animeEntryId,
          Number(attemptsDelta || 0),
          lastErrorCode,
          now,
          processedAt,
          now
        );
      },
      getWatchedImportItem(guildId, discordUserId, annictWorkId) {
        return statements.getAnnictWatchedImportItem.get(guildId, discordUserId, annictWorkId) || null;
      },
      upsertStatusWriteLog({ guildId, discordUserId, annictWorkId, targetStatus, idempotencyKey, status, lastErrorCode = null }) {
        const now = new Date().toISOString();
        statements.upsertAnnictStatusWriteLog.run(
          guildId,
          discordUserId,
          annictWorkId,
          targetStatus,
          idempotencyKey,
          status,
          now,
          now,
          lastErrorCode
        );
      },
      getIntroDmState(guildId, discordUserId) {
        return statements.getAnnictFeatureIntroDmState.get(guildId, discordUserId) || null;
      },
      upsertIntroDmState(record) {
        const now = new Date().toISOString();
        const existing = statements.getAnnictFeatureIntroDmState.get(record.guildId, record.discordUserId) || null;
        statements.upsertAnnictFeatureIntroDmState.run(
          record.guildId,
          record.discordUserId,
          record.triggerMessageId || existing?.triggerMessageId || null,
          record.triggerType || existing?.triggerType || null,
          record.matchedTerm || existing?.matchedTerm || null,
          record.matchedAnimeEntryId || existing?.matchedAnimeEntryId || null,
          record.firstTriggeredAt || existing?.firstTriggeredAt || now,
          record.sentAt || null,
          record.dmMessageId || null,
          record.status || 'pending',
          record.lastErrorCode || null,
          now
        );
      }
    },
    xProfileHeaders: {
      get(normalizedHandle) {
        return statements.getXProfileHeaderCache.get(normalizedHandle) || null;
      },
      upsert({ normalizedHandle, headerUrl = null, resolvedAt = null, expiresAt, lastErrorCode = null }) {
        statements.upsertXProfileHeaderCache.run(
          normalizedHandle,
          headerUrl,
          resolvedAt,
          expiresAt,
          lastErrorCode,
          new Date().toISOString()
        );
      }
    },
    deletableMessages: {
      upsert({
        guildId,
        channelId,
        messageId,
        ownerUserId,
        purpose = null,
        metadataJson = null,
        expiresAt = null,
        createdAt = new Date().toISOString()
      }) {
        statements.upsertBotDeletableMessage.run(
          guildId,
          channelId,
          messageId,
          ownerUserId,
          purpose,
          metadataJson,
          expiresAt,
          createdAt
        );
      },
      get(messageId) {
        return statements.getBotDeletableMessage.get(messageId) || null;
      },
      delete(messageId) {
        return statements.deleteBotDeletableMessage.run(messageId).changes;
      },
      deleteExpired(nowIso = new Date().toISOString()) {
        statements.deleteExpiredBotDeletableMessages.run(nowIso);
      }
    },
    timelineMerge: {
      get(guildId, sourceChannelId, authorId, destinationChannelId) {
        return statements.getTimelineMergeState.get(guildId, sourceChannelId, authorId, destinationChannelId) || null;
      },
      upsert({
        guildId,
        sourceChannelId,
        sourceThreadId,
        authorId,
        destinationChannelId,
        lastSourceMessageId,
        relayedMessageId,
        mergedTextJson,
        mergedCount,
        lastMessageAt
      }) {
        statements.upsertTimelineMergeState.run(
          guildId,
          sourceChannelId,
          sourceThreadId,
          authorId,
          destinationChannelId,
          lastSourceMessageId,
          relayedMessageId,
          mergedTextJson,
          mergedCount,
          lastMessageAt
        );
      },
      delete(guildId, sourceChannelId, authorId, destinationChannelId) {
        statements.deleteTimelineMergeState.run(guildId, sourceChannelId, authorId, destinationChannelId);
      }
    },
    timelineDestination: {
      get(guildId, destinationChannelId) {
        return statements.getTimelineDestinationState.get(guildId, destinationChannelId) || null;
      },
      upsert({
        guildId,
        destinationChannelId,
        relayedMessageId,
        sourceMessageId,
        sourceThreadId,
        authorId
      }) {
        statements.upsertTimelineDestinationState.run(
          guildId,
          destinationChannelId,
          relayedMessageId,
          sourceMessageId,
          sourceThreadId,
          authorId,
          new Date().toISOString()
        );
      },
      deleteIfCurrent(guildId, destinationChannelId, relayedMessageId) {
        return statements.deleteTimelineDestinationStateIfCurrent.run(guildId, destinationChannelId, relayedMessageId).changes;
      },
      listByRelayedMessageId(relayedMessageId) {
        return statements.listTimelineDestinationStatesByRelayedMessageId.all(relayedMessageId);
      },
      deleteByRelayedMessageId(relayedMessageId) {
        return statements.deleteTimelineDestinationStatesByRelayedMessageId.run(relayedMessageId).changes;
      }
    },
    posthocRelayRejections: {
      get(guildId, sourceMessageId) {
        return statements.getPosthocRelayRejection.get(guildId, sourceMessageId) || null;
      },
      record({
        guildId,
        sourceMessageId,
        sourceChannelId = null,
        originalAuthorId = null,
        rejectedByUserId,
        destinationChannelId = null,
        relayKind = null,
        displayTagsJson = null,
        rejectedRelayedMessageId = null
      }) {
        const now = new Date().toISOString();
        statements.upsertPosthocRelayRejection.run(
          guildId,
          sourceMessageId,
          sourceChannelId,
          originalAuthorId,
          rejectedByUserId,
          destinationChannelId,
          relayKind,
          displayTagsJson,
          rejectedRelayedMessageId,
          now,
          now,
          now
        );
        return statements.getPosthocRelayRejection.get(guildId, sourceMessageId) || null;
      }
    },
    userMemories: {
      upsert({ guildId, userId, memoryKey, memoryText, source = 'explicit_user_request', confidence = 100 }) {
        const now = new Date().toISOString();
        statements.upsertUserLlmMemory.run(guildId, userId, memoryKey, memoryText, source, confidence, now, now);
      },
      get(guildId, userId, memoryKey) {
        return statements.getUserLlmMemory.get(guildId, userId, memoryKey) || null;
      },
      listByUser(guildId, userId) {
        return statements.listUserLlmMemoriesByUser.all(guildId, userId);
      },
      deleteByKey(guildId, userId, memoryKey) {
        statements.deleteUserLlmMemoryByKey.run(guildId, userId, memoryKey);
      },
      deleteAllByUser(guildId, userId) {
        statements.deleteAllUserLlmMemoriesByUser.run(guildId, userId);
      },
      countByUser(guildId, userId) {
        return Number(statements.countUserLlmMemoriesByUser.get(guildId, userId)?.count || 0);
      },
      countAll(guildId) {
        return Number(statements.countAllUserLlmMemories.get(guildId)?.count || 0);
      }
    }
  };
}

module.exports = {
  createDatabase
};
