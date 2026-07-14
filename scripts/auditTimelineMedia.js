require('dotenv').config();

const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');
const { loadConfig } = require('../src/config/loadConfig');
const { createDatabase } = require('../src/db/database');
const { createLogger } = require('../src/services/logger');
const { auditTimelineMedia } = require('../src/modules/timelineRestoration/mediaAudit');

async function main() {
  const repair = process.argv.includes('--repair');
  if (repair && process.argv.includes('--dry-run')) throw new Error('Choose either --dry-run or --repair');
  const config = loadConfig(path.resolve(process.cwd(), 'config.json'));
  const db = createDatabase(path.resolve(process.cwd(), 'data', 'otaku-assistant.db'));
  const logger = createLogger('timeline-media-audit');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.appConfig = config;
  client.db = db;
  client.logger = logger;
  await client.login(process.env.DISCORD_TOKEN);
  await new Promise((resolve) => client.isReady() ? resolve() : client.once('clientReady', resolve));
  try {
    const report = await auditTimelineMedia(client, { repair });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    client.destroy();
    db.sqlite.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, code: error.code || 'audit_failed' }));
  process.exitCode = 1;
});
