async function notifyOpsChannel(client, content, options = {}) {
  const channelId = client.appConfig?.ops?.logChannelId;

  if (!channelId) {
    return null;
  }

  try {
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
      ...options
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
