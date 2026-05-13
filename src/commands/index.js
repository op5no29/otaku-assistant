const resolveCommand = require('./resolve');
const unresolveCommand = require('./unresolve');
const profileCommand = require('./profile');
const guidePostCommand = require('./guidePost');
const maintenanceCommand = require('./maintenance');

const list = [resolveCommand, unresolveCommand, profileCommand, guidePostCommand, maintenanceCommand];

module.exports = {
  list,
  registrationData: list
    .filter((command) => command.enabled !== false)
    .map((command) => command.data.toJSON())
};
