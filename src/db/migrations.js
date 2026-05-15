function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS relayed_threads (
      thread_id TEXT PRIMARY KEY,
      parent_channel_id TEXT NOT NULL,
      starter_message_id TEXT NOT NULL,
      timeline_message_id TEXT,
      author_id TEXT,
      relayed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS question_threads (
      thread_id TEXT PRIMARY KEY,
      author_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      last_checked_at TEXT,
      reminder_sent_at TEXT,
      guide_message_id TEXT,
      guide_sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS relayed_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      forum_type TEXT NOT NULL DEFAULT 'tweet',
      timeline_message_id TEXT NOT NULL,
      author_id TEXT,
      relayed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vc_profile_messages (
      category_id TEXT NOT NULL,
      profile_channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      voice_channel_id TEXT,
      voice_channel_name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (category_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS vc_channel_profile_messages (
      category_id TEXT NOT NULL,
      voice_channel_id TEXT PRIMARY KEY,
      profile_channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relayed_message_targets (
      source_message_id TEXT NOT NULL,
      destination_channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      parent_channel_id TEXT NOT NULL,
      forum_type TEXT NOT NULL DEFAULT 'tweet',
      relay_kind TEXT NOT NULL DEFAULT 'timeline',
      relayed_message_id TEXT NOT NULL,
      author_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_message_id, destination_channel_id)
    );

    CREATE TABLE IF NOT EXISTS guide_posts (
      channel_id TEXT NOT NULL,
      guide_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, guide_key)
    );

    CREATE TABLE IF NOT EXISTS music_link_cache (
      source_url TEXT PRIMARY KEY,
      universal_url TEXT,
      title TEXT,
      artist TEXT,
      artwork_url TEXT,
      platform_names TEXT,
      platform_links_json TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS welcome_reactions (
      guild_id TEXT NOT NULL,
      emoji_key TEXT NOT NULL,
      emoji_name TEXT,
      emoji_id TEXT,
      animated INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, emoji_key)
    );

    CREATE TABLE IF NOT EXISTS intro_reactions (
      guild_id TEXT NOT NULL,
      emoji_key TEXT NOT NULL,
      emoji_name TEXT,
      emoji_id TEXT,
      animated INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, emoji_key)
    );

    CREATE TABLE IF NOT EXISTS archived_messages (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT,
      channel_id TEXT,
      parent_id TEXT,
      thread_id TEXT,
      author_id TEXT,
      author_name TEXT,
      author_is_bot INTEGER NOT NULL DEFAULT 0,
      content TEXT,
      clean_content TEXT,
      attachments_json TEXT,
      embeds_json TEXT,
      referenced_message_id TEXT,
      message_type INTEGER,
      created_at TEXT,
      edited_at TEXT,
      archived_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_responses (
      response_message_id TEXT PRIMARY KEY,
      request_message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intro_dm_state (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      prompt_type TEXT NOT NULL,
      sent_at TEXT,
      replied_count INTEGER NOT NULL DEFAULT 0,
      opt_out INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id, prompt_type)
    );

    CREATE TABLE IF NOT EXISTS intro_dm_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      prompt_type TEXT NOT NULL,
      reason TEXT,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intro_dm_queue_status_scheduled
      ON intro_dm_queue (status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_intro_dm_queue_guild_prompt
      ON intro_dm_queue (guild_id, prompt_type);

    CREATE TABLE IF NOT EXISTS intro_profiles (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      intro_channel_id TEXT NOT NULL,
      intro_message_id TEXT PRIMARY KEY,
      display_name TEXT,
      username TEXT,
      global_name TEXT,
      nickname TEXT,
      intro_text TEXT,
      links_json TEXT,
      embeds_json TEXT,
      attachments_json TEXT,
      search_aliases_json TEXT,
      posted_at TEXT,
      updated_at TEXT,
      archived_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intro_profiles_guild_user
      ON intro_profiles (guild_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_intro_profiles_guild_channel
      ON intro_profiles (guild_id, intro_channel_id);
    CREATE INDEX IF NOT EXISTS idx_intro_profiles_guild_display_name
      ON intro_profiles (guild_id, display_name);
    CREATE INDEX IF NOT EXISTS idx_intro_profiles_guild_username
      ON intro_profiles (guild_id, username);

    CREATE TABLE IF NOT EXISTS guild_members (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      global_name TEXT,
      display_name TEXT,
      nickname TEXT,
      joined_at TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      left_at TEXT,
      last_seen_at TEXT,
      last_vc_joined_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_guild_members_joined_at
      ON guild_members (guild_id, joined_at);
    CREATE INDEX IF NOT EXISTS idx_guild_members_left_at
      ON guild_members (guild_id, left_at);
    CREATE INDEX IF NOT EXISTS idx_guild_members_is_bot
      ON guild_members (guild_id, is_bot);

    CREATE TABLE IF NOT EXISTS anime_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_media_id TEXT NOT NULL,
      title_native TEXT,
      title_kana TEXT,
      title_romaji TEXT,
      title_english TEXT,
      title_user_preferred TEXT,
      aliases_json TEXT,
      description TEXT,
      site_url TEXT,
      official_site_url TEXT,
      mal_anime_id TEXT,
      cover_image_url TEXT,
      banner_image_url TEXT,
      season TEXT,
      season_year INTEGER,
      status TEXT,
      episodes INTEGER,
      duration INTEGER,
      next_airing_at TEXT,
      anime_channel_id TEXT,
      anime_channel_message_id TEXT,
      thread_id TEXT,
      thread_card_message_id TEXT,
      review_card_message_id TEXT,
      has_spoiler_reviews INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(guild_id, provider, provider_media_id)
    );

    CREATE INDEX IF NOT EXISTS idx_anime_entries_guild_message
      ON anime_entries (guild_id, anime_channel_message_id);
    CREATE INDEX IF NOT EXISTS idx_anime_entries_guild_thread
      ON anime_entries (guild_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_anime_entries_guild_title
      ON anime_entries (guild_id, title_user_preferred, title_romaji, title_native, title_english);

    CREATE TABLE IF NOT EXISTS anime_cast_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anime_entry_id INTEGER NOT NULL,
      character_name TEXT,
      character_name_native TEXT,
      character_image_url TEXT,
      voice_actor_name TEXT,
      voice_actor_language TEXT,
      voice_actor_image_url TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_anime_cast_cache_entry
      ON anime_cast_cache (anime_entry_id, sort_order);

    CREATE TABLE IF NOT EXISTS anime_user_status (
      guild_id TEXT NOT NULL,
      anime_entry_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      interested INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      interested_at TEXT,
      watched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, anime_entry_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_anime_user_status_user
      ON anime_user_status (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS anime_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      anime_entry_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      review_text TEXT NOT NULL,
      spoiler INTEGER NOT NULL DEFAULT 0,
      source_channel_id TEXT,
      source_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(guild_id, anime_entry_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_anime_reviews_entry
      ON anime_reviews (guild_id, anime_entry_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_anime_reviews_user
      ON anime_reviews (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS anime_review_roles (
      guild_id TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      role_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, threshold)
    );

    CREATE TABLE IF NOT EXISTS anime_review_prompt_state (
      guild_id TEXT NOT NULL,
      anime_entry_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      prompt_type TEXT NOT NULL,
      prompted_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, anime_entry_id, user_id, prompt_type)
    );

    CREATE TABLE IF NOT EXISTS anime_role_awards (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      role_id TEXT,
      awarded_at TEXT NOT NULL,
      dm_sent_at TEXT,
      PRIMARY KEY (guild_id, user_id, threshold)
    );

    CREATE TABLE IF NOT EXISTS anime_hashtag_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      source_author_id TEXT,
      relayed_timeline_message_id TEXT,
      relayed_route_message_ids_json TEXT,
      cleaned_content TEXT,
      display_tags_json TEXT,
      detected_candidate TEXT,
      anime_entry_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(guild_id, source_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_anime_hashtag_sources_status
      ON anime_hashtag_sources (guild_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS bot_deletable_messages (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      purpose TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bot_deletable_messages_owner
      ON bot_deletable_messages (guild_id, owner_user_id, expires_at);

    CREATE TABLE IF NOT EXISTS user_llm_memories (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      memory_key TEXT NOT NULL,
      memory_text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'explicit_user_request',
      confidence INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id, memory_key)
    );

    CREATE INDEX IF NOT EXISTS idx_user_llm_memories_guild_user
      ON user_llm_memories (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS timeline_merge_state (
      guild_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      source_thread_id TEXT,
      author_id TEXT NOT NULL,
      destination_channel_id TEXT NOT NULL,
      last_source_message_id TEXT NOT NULL,
      relayed_message_id TEXT NOT NULL,
      merged_text_json TEXT NOT NULL,
      merged_count INTEGER NOT NULL DEFAULT 1,
      last_message_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, source_channel_id, author_id, destination_channel_id)
    );

    CREATE TABLE IF NOT EXISTS timeline_destination_state (
      guild_id TEXT NOT NULL,
      destination_channel_id TEXT NOT NULL,
      relayed_message_id TEXT NOT NULL,
      source_message_id TEXT,
      source_thread_id TEXT,
      author_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, destination_channel_id)
    );
  `);

  const vcProfileColumns = new Set(
    database
      .prepare('PRAGMA table_info(vc_profile_messages)')
      .all()
      .map((column) => column.name)
  );

  if (!vcProfileColumns.has('voice_channel_id')) {
    database.exec('ALTER TABLE vc_profile_messages ADD COLUMN voice_channel_id TEXT');
  }

  if (!vcProfileColumns.has('voice_channel_name')) {
    database.exec('ALTER TABLE vc_profile_messages ADD COLUMN voice_channel_name TEXT');
  }

  const questionThreadColumns = new Set(
    database
      .prepare('PRAGMA table_info(question_threads)')
      .all()
      .map((column) => column.name)
  );

  if (questionThreadColumns.size && !questionThreadColumns.has('guide_message_id')) {
    database.exec('ALTER TABLE question_threads ADD COLUMN guide_message_id TEXT');
  }

  if (questionThreadColumns.size && !questionThreadColumns.has('guide_sent_at')) {
    database.exec('ALTER TABLE question_threads ADD COLUMN guide_sent_at TEXT');
  }

  const animeEntryColumns = new Set(
    database
      .prepare('PRAGMA table_info(anime_entries)')
      .all()
      .map((column) => column.name)
  );

  if (animeEntryColumns.size && !animeEntryColumns.has('review_card_message_id')) {
    database.exec('ALTER TABLE anime_entries ADD COLUMN review_card_message_id TEXT');
  }
  if (animeEntryColumns.size && !animeEntryColumns.has('title_kana')) {
    database.exec('ALTER TABLE anime_entries ADD COLUMN title_kana TEXT');
  }
  if (animeEntryColumns.size && !animeEntryColumns.has('mal_anime_id')) {
    database.exec('ALTER TABLE anime_entries ADD COLUMN mal_anime_id TEXT');
  }

  const relayedMessageColumns = new Set(
    database
      .prepare('PRAGMA table_info(relayed_messages)')
      .all()
      .map((column) => column.name)
  );

  if (relayedMessageColumns.size && !relayedMessageColumns.has('forum_type')) {
    database.exec("ALTER TABLE relayed_messages ADD COLUMN forum_type TEXT NOT NULL DEFAULT 'tweet'");
  }

  const relayedMessageTargetCount = database
    .prepare('SELECT COUNT(*) AS count FROM relayed_message_targets')
    .get().count;

  if (relayedMessageTargetCount === 0 && relayedMessageColumns.size) {
    database.exec(`
      INSERT OR IGNORE INTO relayed_message_targets (
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
      )
      SELECT
        message_id,
        '',
        thread_id,
        parent_channel_id,
        forum_type,
        'legacy',
        timeline_message_id,
        author_id,
        relayed_at,
        relayed_at
      FROM relayed_messages
    `);
  }

  const musicLinkCacheColumns = new Set(
    database
      .prepare('PRAGMA table_info(music_link_cache)')
      .all()
      .map((column) => column.name)
  );

  if (musicLinkCacheColumns.size && !musicLinkCacheColumns.has('platform_names')) {
    database.exec('ALTER TABLE music_link_cache ADD COLUMN platform_names TEXT');
  }

  if (musicLinkCacheColumns.size && !musicLinkCacheColumns.has('platform_links_json')) {
    database.exec('ALTER TABLE music_link_cache ADD COLUMN platform_links_json TEXT');
  }
}

module.exports = {
  runMigrations
};
