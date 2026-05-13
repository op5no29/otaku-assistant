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
