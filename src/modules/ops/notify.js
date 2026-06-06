const { DASHBOARD_KINDS, appendSystemLog, updateDashboardMessage } = require('../logDashboard');

async function notifyOpsChannel(client, content, options = {}) {
  const channelId = client.appConfig?.ops?.logChannelId;
  const text = String(content || '');
  const lines = text.split(/\r?\n/u);
  const title = String(options.title || lines[0] || 'ops notification').trim();
  const body = String(options.body || lines.slice(1).join('\n')).trim();

  appendSystemLog(client, {
    severity: options.severity || (/❌|error|failed/i.test(title) ? 'error' : /⚠|warn|shutting down/i.test(title) ? 'warn' : 'info'),
    eventType: options.eventType || 'ops_notification',
    title,
    body,
    metadata: options.metadata || null
  });

  if (options.immediateDashboard) {
    await updateDashboardMessage(client, DASHBOARD_KINDS.SYSTEM, {
      reason: options.eventType || 'ops_notification'
    }).catch((error) => {
      client.logger.warn('Failed to update ops dashboard immediately', {
        error: error.message
      });
    });
  }

  if (!options.standalone) {
    return null;
  }

  if (!channelId) {
    return null;
  }

  try {
    const {
      standalone,
      immediateDashboard,
      severity,
      eventType,
      title: _title,
      body: _body,
      metadata,
      ...sendOptions
    } = options;
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);

    if (!channel?.isTextBased?.()) {
      client.logger.warn('Ops log channel is not text-based', { channelId });
      return null;
    }

    return await channel.send({
      content,
      allowedMentions: {
        parse: [],
        repliedUser: false
      },
      ...sendOptions
    });
  } catch (error) {
    client.logger.warn('Failed to send ops notification', {
      channelId,
      error: error.message
    });
    return null;
  }
}

module.exports = {
  notifyOpsChannel
};
