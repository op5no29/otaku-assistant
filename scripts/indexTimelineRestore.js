require('dotenv').config();

const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');
const { loadConfig } = require('../src/config/loadConfig');
const { createDatabase } = require('../src/db/database');
const { createLogger } = require('../src/services/logger');
const { indexLegacyTimelineRestore } = require('../src/modules/timelineRestoration/legacyIndexer');

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run') || !apply;
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose either --dry-run or --apply');
  const config = loadConfig(path.resolve(process.cwd(), 'config.json'));
  const db = createDatabase(path.resolve(process.cwd(), 'data', 'otaku-assistant.db'));
  const logger = createLogger('timeline-restore-index');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.appConfig = config;
  client.db = db;
  client.logger = logger;
  await client.login(process.env.DISCORD_TOKEN);
  await new Promise((resolve) => client.isReady() ? resolve() : client.once('clientReady', resolve));
  try {
    const report = await indexLegacyTimelineRestore(client, { apply: !dryRun });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    client.destroy();
    db.sqlite.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, code: error.code || 'index_failed' }));
  process.exitCode = 1;
});
