const resolveCommand = require('./resolve');
const unresolveCommand = require('./unresolve');
const profileCommand = require('./profile');
const guidePostCommand = require('./guidePost');
const maintenanceCommand = require('./maintenance');
const welcomeCommand = require('./welcome');
const introCommand = require('./intro');
const animeCommand = require('./anime');

const list = [
  resolveCommand,
  unresolveCommand,
  profileCommand,
  guidePostCommand,
  maintenanceCommand,
  welcomeCommand,
  introCommand,
  animeCommand
];

module.exports = {
  list,
  registrationData: list
    .filter((command) => command.enabled !== false)
    .map((command) => command.data.toJSON())
};
