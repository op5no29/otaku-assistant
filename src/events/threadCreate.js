const { relayForumThread } = require('../modules/timelineRelay');
const { handleTimelineThreadCreate } = require('../modules/timelineRestoration');

module.exports = {
  async execute(thread) {
    const client = thread.client;
    client.logger.info('threadCreate received', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      ownerId: thread.ownerId || null
    });

    try {
      await handleTimelineThreadCreate(client, thread);
    } catch (error) {
      client.logger.error('Failed to retain personal timeline thread binding', {
        threadId: thread.id,
        error: error.message
      });
    }

    try {
      await relayForumThread(thread, {
        config: client.appConfig,
        db: client.db,
        logger: client.logger
      });
    } catch (error) {
      client.logger.error('Failed to handle threadCreate', {
        threadId: thread.id,
        error: error.message
      });
    }
  }
};
