require('dotenv').config();

const path = require('node:path');
const { Client, GatewayIntentBits } = require('discord.js');
const { loadConfig } = require('../src/config/loadConfig');
const { createLogger } = require('../src/services/logger');
const { applyQuestionStatusTag } = require('../src/modules/questionResolver/threadTags');
const { backfillQuestionTags } = require('../src/modules/questionResolver/backfillQuestionTags');

async function main() {
  const logger = createLogger('backfill-question-tags');
  const configPath = path.resolve(process.cwd(), 'config.json');
  const config = loadConfig(configPath);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once('clientReady', async () => {
    try {
      await backfillQuestionTags({
        client,
        guildId: process.env.GUILD_ID,
        config,
        logger,
        applyQuestionStatusTag
      });
    } finally {
      await client.destroy();
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((error) => {
  const logger = createLogger('backfill-question-tags');
  logger.error('Failed to run question tag backfill', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});
