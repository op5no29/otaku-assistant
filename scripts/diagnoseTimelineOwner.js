require('dotenv').config();

const path = require('node:path');
const Database = require('better-sqlite3');
const { diagnoseTimelineOwner } = require('../src/modules/timelineRestoration/ownerDiagnostics');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requireSnowflake(name) {
  const value = String(option(name) || '');
  if (!/^\d{17,20}$/u.test(value)) throw new Error(`${name} must be a Discord snowflake`);
  return value;
}

function main() {
  if (process.argv.includes('--apply')) throw new Error('This diagnostic command is read-only and has no apply mode');
  const guildId = requireSnowflake('--guild-id');
  const userId = requireSnowflake('--user-id');
  const databasePath = path.resolve(process.cwd(), option('--database') || 'data/otaku-assistant.db');
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    console.log(JSON.stringify(diagnoseTimelineOwner(sqlite, { guildId, userId }), null, 2));
  } finally {
    sqlite.close();
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ error: error.message, code: error.code || 'diagnosis_failed' }));
  process.exitCode = 1;
}
