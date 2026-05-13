require('dotenv').config();

const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');
const { loadConfig } = require('../src/config/loadConfig');
const { createDatabase } = require('../src/db/database');
const { createLogger } = require('../src/services/logger');
const { postEntranceGuide } = require('../src/modules/entranceGuide');

async function main() {
  const logger = createLogger('post-entrance-guide');
  const configPath = path.resolve(process.cwd(), 'config.json');
  const appConfig = loadConfig(configPath);
  const database = createDatabase(path.resolve(process.cwd(), 'data', 'otaku-assistant.db'));
  const sourceArg = process.argv[2];
  const sourcePath = sourceArg ? path.resolve(process.cwd(), sourceArg) : undefined;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.appConfig = appConfig;
  client.db = database;
  client.logger = logger;

  client.once('clientReady', async () => {
    try {
      await postEntranceGuide({
        client,
        sourcePath,
        logger
      });
    } finally {
      await client.destroy();
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((error) => {
  const logger = createLogger('post-entrance-guide');
  logger.error('Failed to post entrance guide', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});
