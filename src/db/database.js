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
        sent_at,
        replied_count,
        opt_out,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, prompt_type) DO UPDATE SET
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
      ORDER BY datetime(COALESCE(updated_at, posted_at)) DESC, intro_message_id DESC
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

  return {
    sqlite,
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
        statements.deleteMessageRelayTarget.run(messageId, destinationChannelId);
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
    vcProfiles: {
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
      listLegacyProfileMessagesByCategory(categoryId) {
        return statements.listLegacyVcProfileMessagesByCategory.all(categoryId);
      },
      deleteLegacyProfileMessagesByCategory(categoryId) {
        statements.deleteLegacyVcProfileMessagesByCategory.run(categoryId);
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
      upsertState({ guildId, userId, promptType, sentAt, repliedCount = 0, optOut = false, lastError = null }) {
        statements.upsertIntroDmState.run(
          guildId,
          userId,
          promptType,
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
      getLatestByUser(guildId, userId, introChannelId) {
        return statements.getLatestIntroProfileByUser.get(guildId, userId, introChannelId) || null;
      },
      listByUser(guildId, userId, introChannelId) {
        return statements.listIntroProfilesByUser.all(guildId, userId, introChannelId);
      },
      search(guildId, introChannelId, query, limit) {
        const like = `%${String(query || '').toLowerCase()}%`;
        return statements.searchIntroProfiles.all(guildId, introChannelId, like, like, like, like, like, limit);
      },
      count(guildId, introChannelId) {
        return Number(statements.countIntroProfiles.get(guildId, introChannelId)?.count || 0);
      },
      getLatestDate(guildId, introChannelId) {
        return statements.getLatestIntroProfileDate.get(guildId, introChannelId)?.latestDate || null;
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
