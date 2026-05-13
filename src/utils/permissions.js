const { PermissionsBitField } = require('discord.js');

function isAdministrator(member) {
  return Boolean(member?.permissions?.has(PermissionsBitField.Flags.Administrator));
}

function canManageQuestionThread({ member, thread, config }) {
  if (member?.id === thread.ownerId) {
    return true;
  }

  if (isAdministrator(member)) {
    return true;
  }

  return false;
}

module.exports = {
  isAdministrator,
  canManageQuestionThread
};
