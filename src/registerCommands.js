require('dotenv').config();

const { REST, Routes } = require('discord.js');
const commands = require('./commands');
const { createLogger } = require('./services/logger');

async function registerCommands() {
  const logger = createLogger('commands');
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId || !guildId) {
    throw new Error('DISCORD_TOKEN, CLIENT_ID, GUILD_ID must be set in .env');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const payload = commands.registrationData;

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: payload
  });

  logger.info('Command registered', {
    guildId,
    commandNames: payload.map((command) => command.name)
  });
}

registerCommands().catch((error) => {
  const logger = createLogger('commands');
  logger.error('Failed to register commands', {
    error: error.message,
    stack: error.stack
  });
  process.exitCode = 1;
});
