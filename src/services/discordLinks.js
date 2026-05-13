function getMessageJumpUrl({ guildId, channelId, messageId }) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function getChannelJumpUrl({ guildId, channelId }) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

module.exports = {
  getMessageJumpUrl,
  getChannelJumpUrl
};
