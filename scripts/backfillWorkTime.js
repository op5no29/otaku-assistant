#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { getMilestoneHours } = require('../src/modules/voiceWorkTime');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const dryRun = args.has('--dry-run') || !apply;
const version = 'work-time-v1';
const projectRoot = process.cwd();
const configPath = path.resolve(projectRoot, 'config.json');
const dbPath = path.resolve(projectRoot, 'data', 'otaku-assistant.db');

function readConfig() {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  return raw.voiceWorkTime || { channels: [] };
}

function secondsBetween(startIso, endIso) {
  const start = new Date(startIso || 0).getTime();
  const end = new Date(endIso || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

const config = readConfig();
const workChannels = new Map((config.channels || []).map((entry) => [String(entry.voiceChannelId), entry]));
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
runMigrations(db);

const cutoffAt = new Date().toISOString();
const existing = db.prepare('SELECT 1 FROM vc_work_backfill_state WHERE guild_id = ? AND version = ? LIMIT 1');
const sessions = db.prepare(`
  SELECT
    s.guild_id,
    s.session_id,
    s.category_id,
    s.profile_channel_id,
    s.main_voice_channel_id,
    m.user_id,
    m.first_joined_at,
    m.last_left_at,
    m.total_present_seconds
  FROM vc_voice_sessions s
  JOIN vc_voice_session_members m
    ON m.guild_id = s.guild_id AND m.session_id = s.session_id
  WHERE s.status = 'closed'
    AND s.main_voice_channel_id IS NOT NULL
    AND m.user_id IS NOT NULL
`);
const rows = sessions.all();
const totals = new Map();
let skipped = 0;
let earliest = null;
let latest = null;

for (const row of rows) {
  if (!workChannels.has(String(row.main_voice_channel_id))) {
    skipped += 1;
    continue;
  }
  const seconds = Number(row.total_present_seconds || 0) > 0
    ? Number(row.total_present_seconds || 0)
    : secondsBetween(row.first_joined_at, row.last_left_at);
  if (seconds <= 0) {
    skipped += 1;
    continue;
  }
  const key = `${row.guild_id}:${row.user_id}`;
  totals.set(key, (totals.get(key) || 0) + seconds);
  if (!earliest || new Date(row.first_joined_at).getTime() < new Date(earliest).getTime()) earliest = row.first_joined_at;
  if (!latest || new Date(row.last_left_at).getTime() > new Date(latest).getTime()) latest = row.last_left_at;
}

const report = {
  mode: dryRun ? 'dry-run' : 'apply',
  usersRecoverable: totals.size,
  totalSecondsRecoverable: [...totals.values()].reduce((sum, value) => sum + value, 0),
  sourceRowsExamined: rows.length,
  rowsSkippedAmbiguousOrNonWork: skipped,
  earliestRecoveredAt: earliest,
  latestRecoveredAt: latest,
  limitation: 'Uses closed vc_voice_sessions/vc_voice_session_members only. Older solo or short activity that was never recorded cannot be recovered.'
};

if (dryRun) {
  console.log(JSON.stringify(report, null, 2));
  db.close();
  process.exit(0);
}

const insertState = db.prepare(`
  INSERT INTO vc_work_backfill_state (
    guild_id, version, cutoff_at, completed_at, source_row_count, skipped_row_count, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const addTotal = db.prepare(`
  INSERT INTO vc_work_user_totals (
    guild_id, user_id, total_seconds, historical_backfill_seconds, live_tracked_seconds, last_counted_at, updated_at
  ) VALUES (?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    total_seconds = vc_work_user_totals.total_seconds + excluded.total_seconds,
    historical_backfill_seconds = vc_work_user_totals.historical_backfill_seconds + excluded.historical_backfill_seconds,
    last_counted_at = excluded.last_counted_at,
    updated_at = excluded.updated_at
`);
const insertAward = db.prepare(`
  INSERT OR IGNORE INTO vc_work_milestone_awards (
    guild_id, user_id, milestone_hours, reached_at, dm_status, public_status, card_status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'baseline', 'baseline', 'not_rendered', ?, ?)
`);

const tx = db.transaction(() => {
  const byGuild = new Map();
  for (const key of totals.keys()) {
    const [guildId] = key.split(':');
    byGuild.set(guildId, true);
  }
  for (const guildId of byGuild.keys()) {
    if (existing.get(guildId, version)) {
      throw new Error(`Backfill ${version} already applied for guild ${guildId}`);
    }
  }
  const now = new Date().toISOString();
  for (const [key, seconds] of totals.entries()) {
    const [guildId, userId] = key.split(':');
    addTotal.run(guildId, userId, seconds, seconds, cutoffAt, now);
    for (const hours of getMilestoneHours(config)) {
      if (seconds >= hours * 3600) {
        insertAward.run(guildId, userId, hours, cutoffAt, now, now);
      }
    }
  }
  for (const guildId of byGuild.keys()) {
    insertState.run(guildId, version, cutoffAt, now, rows.length, skipped, JSON.stringify(report));
  }
});

tx();
console.log(JSON.stringify({ ...report, applied: true }, null, 2));
db.close();
