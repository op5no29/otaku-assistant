function createVcActivityWindowStore(sqlite) {
  const statements = {
    getOpen: sqlite.prepare(`
      SELECT guild_id AS guildId, category_id AS categoryId,
        profile_channel_id AS profileChannelId, voice_channel_id AS voiceChannelId,
        window_id AS windowId, status, started_at AS startedAt, ended_at AS endedAt,
        participant_ids_json AS participantIdsJson,
        participant_intervals_json AS participantIntervalsJson,
        peak_human_count AS peakHumanCount, meaningful_session_id AS meaningfulSessionId,
        qualified_meaningful AS qualifiedMeaningful, close_reason AS closeReason, start_estimated AS startEstimated,
        end_estimated AS endEstimated, created_at AS createdAt, updated_at AS updatedAt
      FROM vc_activity_windows
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
        AND voice_channel_id = ? AND status = 'open'
      LIMIT 1
    `),
    listOpen: sqlite.prepare(`
      SELECT guild_id AS guildId, category_id AS categoryId,
        profile_channel_id AS profileChannelId, voice_channel_id AS voiceChannelId,
        window_id AS windowId, status, started_at AS startedAt, ended_at AS endedAt,
        participant_ids_json AS participantIdsJson,
        participant_intervals_json AS participantIntervalsJson,
        peak_human_count AS peakHumanCount, meaningful_session_id AS meaningfulSessionId,
        qualified_meaningful AS qualifiedMeaningful, close_reason AS closeReason, start_estimated AS startEstimated,
        end_estimated AS endEstimated, created_at AS createdAt, updated_at AS updatedAt
      FROM vc_activity_windows
      WHERE status = 'open'
      ORDER BY datetime(started_at) ASC
    `),
    insert: sqlite.prepare(`
      INSERT OR IGNORE INTO vc_activity_windows (
        guild_id, category_id, profile_channel_id, voice_channel_id, window_id,
        status, started_at, ended_at, participant_ids_json,
        participant_intervals_json, peak_human_count, meaningful_session_id,
        close_reason, start_estimated, end_estimated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)
    `),
    updateOpen: sqlite.prepare(`
      UPDATE vc_activity_windows
      SET participant_ids_json = ?, participant_intervals_json = ?,
        peak_human_count = ?, updated_at = ?
      WHERE guild_id = ? AND window_id = ? AND status = 'open'
    `),
    close: sqlite.prepare(`
      UPDATE vc_activity_windows
      SET status = 'closed', ended_at = ?, participant_ids_json = ?,
        participant_intervals_json = ?, peak_human_count = ?,
        meaningful_session_id = ?, qualified_meaningful = ?, close_reason = ?, end_estimated = ?, updated_at = ?
      WHERE guild_id = ? AND window_id = ? AND status = 'open'
    `),
    findMeaningfulSession: sqlite.prepare(`
      SELECT session_id AS sessionId
      FROM vc_voice_sessions
      WHERE guild_id = ? AND category_id = ? AND profile_channel_id = ?
        AND main_voice_channel_id = ? AND status = 'closed'
        AND two_plus_total_seconds >= ?
        AND datetime(started_at) <= datetime(?)
        AND datetime(ended_at) >= datetime(?)
      ORDER BY datetime(ended_at) DESC
      LIMIT 1
    `)
  };

  return {
    getOpen(scope) {
      return statements.getOpen.get(
        scope.guildId,
        scope.categoryId,
        scope.profileChannelId,
        scope.voiceChannelId
      ) || null;
    },
    listOpen() {
      return statements.listOpen.all();
    },
    open(record) {
      const now = new Date().toISOString();
      return statements.insert.run(
        record.guildId,
        record.categoryId,
        record.profileChannelId,
        record.voiceChannelId,
        record.windowId,
        record.startedAt,
        JSON.stringify(record.participantIds || []),
        JSON.stringify(record.participantIntervals || {}),
        Number(record.peakHumanCount || 0),
        record.startEstimated ? 1 : 0,
        now,
        now
      ).changes;
    },
    update(record) {
      return statements.updateOpen.run(
        JSON.stringify(record.participantIds || []),
        JSON.stringify(record.participantIntervals || {}),
        Number(record.peakHumanCount || 0),
        new Date().toISOString(),
        record.guildId,
        record.windowId
      ).changes;
    },
    close(record) {
      const now = new Date().toISOString();
      return statements.close.run(
        record.endedAt,
        JSON.stringify(record.participantIds || []),
        JSON.stringify(record.participantIntervals || {}),
        Number(record.peakHumanCount || 0),
        record.meaningfulSessionId || null,
        record.qualifiedMeaningful ? 1 : 0,
        record.closeReason || null,
        record.endEstimated ? 1 : 0,
        now,
        record.guildId,
        record.windowId
      ).changes;
    },
    findMeaningfulSession(record) {
      return statements.findMeaningfulSession.get(
        record.guildId,
        record.categoryId,
        record.profileChannelId,
        record.voiceChannelId,
        Number(record.minMeaningfulSeconds || 0),
        record.endedAt,
        record.startedAt
      ) || null;
    }
  };
}

module.exports = {
  createVcActivityWindowStore
};
