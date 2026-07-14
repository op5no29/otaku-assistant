const resolveCommand = require('./resolve');
const unresolveCommand = require('./unresolve');
const profileCommand = require('./profile');
const guidePostCommand = require('./guidePost');
const maintenanceCommand = require('./maintenance');
const welcomeCommand = require('./welcome');
const introCommand = require('./intro');
const animeCommand = require('./anime');
const rolePanelCommand = require('./rolePanel');
const vcSummaryCommand = require('./vcSummary');
const workTimeCommand = require('./workTime');
const workRankingCommand = require('./workRanking');
const knowledgeExportCommand = require('./knowledgeExport');
const annictCommand = require('./annict');
const timelineRestoreCommand = require('./timelineRestore');

const list = [
  resolveCommand,
  unresolveCommand,
  profileCommand,
  guidePostCommand,
  maintenanceCommand,
  welcomeCommand,
  introCommand,
  animeCommand,
  rolePanelCommand,
  vcSummaryCommand,
  workTimeCommand,
  workRankingCommand,
  knowledgeExportCommand,
  annictCommand,
  timelineRestoreCommand
];

module.exports = {
  list,
  registrationData: list
    .filter((command) => command.enabled !== false)
    .map((command) => command.data.toJSON())
};
