const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const commands = require('./commands');
const readyEvent = require('./events/ready');
const threadCreateEvent = require('./events/threadCreate');
const messageCreateEvent = require('./events/messageCreate');
const messageUpdateEvent = require('./events/messageUpdate');
const messageDeleteEvent = require('./events/messageDelete');
const messageBulkDeleteEvent = require('./events/messageBulkDelete');
const messageReactionAddEvent = require('./events/messageReactionAdd');
const messageReactionRemoveEvent = require('./events/messageReactionRemove');
const interactionCreateEvent = require('./events/interactionCreate');
const voiceStateUpdateEvent = require('./events/voiceStateUpdate');
const guildMemberAddEvent = require('./events/guildMemberAdd');
const guildMemberRemoveEvent = require('./events/guildMemberRemove');

function createBotClient({ appConfig, database, logger }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
  });

  client.commands = new Collection();
  client.appConfig = appConfig;
  client.db = database;
  client.logger = logger;
  client.voiceProfileCategoryMap = new Map();

  for (const command of commands.list) {
    if (command.enabled === false) {
      continue;
    }

    client.commands.set(command.data.name, command);
  }

  client.timelineRelayInFlight = new Set();
  client.timelineRelayMessageInFlight = new Set();
  client.recentInteractionExecutions = new Map();
  client.activeWelcomeReactionSetups = new Map();
  client.activeIntroReactionSetups = new Map();
  client.activeLlmUsers = new Set();
  client.llmGlobalRequestActive = false;
  client.questionResolveLocks = new Set();
  client.knowledgeExportThreadLocks = new Set();
  client.knowledgeExportActiveCount = 0;
  client.knowledgeExportUserCooldowns = new Map();
  client.annictOauthStates = new Map();
  client.annictStatusLocks = new Set();
  client.annictSyncRunning = false;
  client.annictSyncInterval = null;
  client.annictIntroDmLocks = new Set();
  client.annictIntroDmLastSentAt = 0;
  client.annictIntroDmDelayedChecks = new Map();
  client.annictIntroDmPreviewCache = new Map();
  client.questionRolePromptTimers = new Map();
  client.introDmQueueProcessing = false;
  client.introDmQueueInterval = null;
  client.introVcReminderLocks = new Map();
  client.logDashboardStartedAt = new Date().toISOString();
  client.logDashboardStatus = 'starting';
  client.logDashboardUpdateTimers = new Map();
  client.voiceSessionSummaryQueues = new Map();
  client.voiceSessionSummaryReconcileInterval = null;
  client.vcSummarySelectionState = new Map();
  client.vcSummarySelectionTimers = new Map();
  client.vcSessionEndCardTimers = new Map();
  client.voiceProfileReconcileInterval = null;
  client.voiceProfileUpdateQueues = new Map();
  client.voiceWorkTimeLocks = new Set();
  client.voiceWorkTimeInterval = null;

  client.once('clientReady', (...args) => readyEvent.execute(...args));
  client.on('threadCreate', (...args) => threadCreateEvent.execute(...args));
  client.on('messageCreate', (...args) => messageCreateEvent.execute(...args));
  client.on('messageUpdate', (...args) => messageUpdateEvent.execute(...args));
  client.on('messageDelete', (...args) => messageDeleteEvent.execute(...args));
  client.on('messageBulkDelete', (...args) => messageBulkDeleteEvent.execute(...args));
  client.on('messageReactionAdd', (...args) => messageReactionAddEvent.execute(...args));
  client.on('messageReactionRemove', (...args) => messageReactionRemoveEvent.execute(...args));
  client.on('interactionCreate', (...args) => interactionCreateEvent.execute(...args));
  client.on('voiceStateUpdate', (...args) => voiceStateUpdateEvent.execute(...args));
  client.on('guildMemberAdd', (...args) => guildMemberAddEvent.execute(...args));
  client.on('guildMemberRemove', (...args) => guildMemberRemoveEvent.execute(...args));

  return client;
}

module.exports = {
  createBotClient
};
