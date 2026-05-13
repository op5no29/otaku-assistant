function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'unknown';
  }

  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`);
  }

  parts.push(`${secs}s`);
  return parts.join(' ');
}

function getBotHealth(client) {
  const memory = process.memoryUsage();
  const guildId = process.env.GUILD_ID || '';
  const guild = guildId ? client.guilds.cache.get(guildId) : null;

  return {
    ready: typeof client.isReady === 'function' ? client.isReady() : Boolean(client.user),
    uptimeSeconds: process.uptime(),
    uptime: formatDuration(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    memoryRss: formatBytes(memory.rss),
    memoryHeapUsed: formatBytes(memory.heapUsed),
    memoryHeapTotal: formatBytes(memory.heapTotal),
    guildId,
    guildAvailable: Boolean(guild),
    wsPing: Number.isFinite(client.ws?.ping) ? client.ws.ping : null,
    voiceProfileCategoryCount: client.voiceProfileCategoryMap?.size ?? 0
  };
}

module.exports = {
  getBotHealth,
  formatBytes,
  formatDuration
};
