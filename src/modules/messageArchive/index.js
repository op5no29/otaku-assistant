const { saveMessageToArchive } = require('./saveMessage');
const {
  getRecentArchivedMessages,
  getRecentArchivedMessagesByAuthor,
  getThreadStarterArchivedMessage
} = require('./getRecentMessages');

module.exports = {
  saveMessageToArchive,
  getRecentArchivedMessages,
  getRecentArchivedMessagesByAuthor,
  getThreadStarterArchivedMessage
};
