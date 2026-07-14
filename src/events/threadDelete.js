const { handleTimelineThreadDelete } = require('../modules/timelineRestoration');

module.exports = {
  async execute(thread) {
    try {
      await handleTimelineThreadDelete(thread.client, thread);
    } catch (error) {
      thread.client.logger.error('Failed to retain deleted personal thread state', {
        guildId: thread.guildId || null,
        threadId: thread.id,
        error: error.message
      });
    }
  }
};
