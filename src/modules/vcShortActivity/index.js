const {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder
} = require('discord.js');

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function secondsBetween(startIso, endIso) {
  const start = new Date(startIso || 0).getTime();
  const end = new Date(endIso || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return `${minutes}分`;
}

function formatTimeRange(startIso, endIso, timezone = 'Asia/Tokyo') {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const start = formatter.format(new Date(startIso));
  const endParts = formatter.formatToParts(new Date(endIso));
  const byType = new Map(endParts.map((part) => [part.type, part.value]));
  return `${start}〜${byType.get('hour')}:${byType.get('minute')}`;
}

function getConfig(client) {
  return client.appConfig.voiceSessionSummary?.shortActivity || {
    enabled: true,
    maxDisplayedEpisodes: 5,
    maxStoredEpisodes: 50,
    retentionDays: 7,
    includeAfk: false,
    visibleDuringLiveProfile: true,
    trackSoloVisits: true
  };
}

function getChannelName(guild, voiceChannelId) {
  return guild?.channels?.cache?.get(String(voiceChannelId))?.name || String(voiceChannelId || '通話チャンネル');
}

function buildShortActivityPayload(client, guild, { guildId, categoryId, profileChannelId }) {
  const config = getConfig(client);
  const episodes = client.db.vcShortActivity.listEpisodes({
    guildId,
    categoryId,
    profileChannelId,
    limit: Math.max(Number(config.maxStoredEpisodes || 50), Number(config.maxDisplayedEpisodes || 5))
  });
  const visibleLimit = Math.max(1, Number(config.maxDisplayedEpisodes || 5));
  const byChannel = new Map();
  for (const episode of episodes) {
    const key = String(episode.voiceChannelId);
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push(episode);
  }

  const container = new ContainerBuilder().setAccentColor(0x64748b);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent('## 最近の短時間利用'));
  let rendered = 0;
  for (const [voiceChannelId, rows] of [...byChannel.entries()].sort((left, right) => getChannelName(guild, left[0]).localeCompare(getChannelName(guild, right[0]), 'ja'))) {
    if (rendered >= visibleLimit) break;
    const lines = [];
    for (const row of rows) {
      if (rendered >= visibleLimit) break;
      const participants = parseJsonArray(row.participantIdsJson).map((userId) => `<@${userId}>`).join(' / ') || '参加者不明';
      lines.push(`- ${formatTimeRange(row.startedAt, row.endedAt, client.appConfig.voiceWorkTime?.timezone || 'Asia/Tokyo')}（${formatDuration(row.durationSeconds)}） ${participants}`);
      rendered += 1;
    }
    if (lines.length) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${getChannelName(guild, voiceChannelId)}**\n${lines.join('\n')}`));
    }
  }
  const extra = Math.max(0, episodes.length - rendered);
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    extra > 0 ? `ほか${extra}件` : null,
    '一定時間以上の通話が成立すると、該当チャンネルの短時間履歴はリセットされます。'
  ].filter(Boolean).join('\n')));

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

async function updateShortActivityCard(client, { guildId, categoryId, profileChannelId }) {
  const config = getConfig(client);
  if (!config.enabled) return null;
  const cutoff = new Date(Date.now() - Number(config.retentionDays || 7) * 24 * 60 * 60 * 1000).toISOString();
  const expired = client.db.vcShortActivity.expireBefore(cutoff);
  if (expired) {
    client.logger.info('vc short activity expired', { guildId, categoryId, profileChannelId, expired });
  }
  const pruned = client.db.vcShortActivity.pruneScope({
    guildId,
    categoryId,
    profileChannelId,
    limit: Number(config.maxStoredEpisodes || 50)
  });
  if (pruned) {
    client.logger.info('vc short activity expired', { guildId, categoryId, profileChannelId, pruned });
  }
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const channel = await client.channels.fetch(profileChannelId).catch(() => null);
  if (!guild || !channel?.isTextBased?.()) return null;
  await guild.channels.fetch().catch(() => null);
  const episodes = client.db.vcShortActivity.listEpisodes({ guildId, categoryId, profileChannelId, limit: 1 });
  const record = client.db.vcShortActivity.getMessage({ guildId, categoryId, profileChannelId });
  if (!episodes.length) {
    if (record?.messageId && record.status === 'active') {
      await channel.messages.fetch(record.messageId).then((message) => message.delete()).catch(() => null);
      client.db.vcShortActivity.updateMessageStatus({ guildId, categoryId, profileChannelId, status: 'deleted' });
    }
    return null;
  }
  const payload = buildShortActivityPayload(client, guild, { guildId, categoryId, profileChannelId });
  if (record?.messageId && record.status === 'active') {
    const message = await channel.messages.fetch(record.messageId).catch(() => null);
    if (message) {
      await message.edit(payload);
      client.logger.info('vc short activity card updated', { guildId, categoryId, profileChannelId, messageId: message.id });
      return message;
    }
  }
  const message = await channel.send(payload);
  client.db.vcShortActivity.upsertMessage({ guildId, categoryId, profileChannelId, messageId: message.id, status: 'active' });
  client.logger.info('vc short activity card created', { guildId, categoryId, profileChannelId, messageId: message.id });
  return message;
}

async function hideShortActivityCardForLiveProfile(client, { guildId, categoryId, profileChannelId }) {
  if (getConfig(client).visibleDuringLiveProfile !== false) {
    return false;
  }
  const record = client.db.vcShortActivity.getMessage({ guildId, categoryId, profileChannelId });
  if (!record?.messageId || record.status !== 'active') {
    return false;
  }
  const channel = await client.channels.fetch(profileChannelId).catch(() => null);
  const message = channel?.isTextBased?.()
    ? await channel.messages.fetch(record.messageId).catch(() => null)
    : null;
  if (message) {
    await message.delete().catch(() => null);
  }
  client.db.vcShortActivity.updateMessageStatus({ guildId, categoryId, profileChannelId, status: 'hidden_live' });
  return true;
}

async function recordShortActivityForIgnoredSession(client, session, { reason = 'ignored_session' } = {}) {
  const config = getConfig(client);
  if (!config.enabled
    || config.trackSoloVisits !== false
    || !session?.guildId
    || !session?.mainVoiceChannelId) {
    return false;
  }
  if (!config.includeAfk && /afk/i.test(String(session.mainVoiceChannelName || session.voiceChannelName || ''))) {
    return false;
  }
  const endedAt = session.endedAt || new Date().toISOString();
  const durationSeconds = secondsBetween(session.startedAt, endedAt);
  const participantIds = parseJsonArray(session.allParticipantIdsJson);
  const stableEpisodeKey = `${session.guildId}:${session.sessionId}:${session.mainVoiceChannelId}:${session.startedAt}:${endedAt}`;
  const inserted = client.db.vcShortActivity.insertEpisode({
    stableEpisodeKey,
    guildId: session.guildId,
    categoryId: session.categoryId,
    profileChannelId: session.profileChannelId,
    voiceChannelId: session.mainVoiceChannelId,
    startedAt: session.startedAt,
    endedAt,
    durationSeconds,
    participantIds,
    peakHumanCount: session.maxHumanCount,
    closeReason: reason
  });
  client.logger.info(inserted ? 'vc short activity episode recorded' : 'vc short activity duplicate prevented', {
    guildId: session.guildId,
    categoryId: session.categoryId,
    profileChannelId: session.profileChannelId,
    voiceChannelId: session.mainVoiceChannelId,
    sessionId: session.sessionId,
    stableEpisodeKey,
    durationSeconds
  });
  await updateShortActivityCard(client, {
    guildId: session.guildId,
    categoryId: session.categoryId,
    profileChannelId: session.profileChannelId
  });
  return inserted > 0;
}

async function clearShortActivityForMeaningfulSession(client, session) {
  if (!session?.mainVoiceChannelId) return 0;
  const cleared = client.db.vcShortActivity.clearChannel({
    guildId: session.guildId,
    categoryId: session.categoryId,
    profileChannelId: session.profileChannelId,
    voiceChannelId: session.mainVoiceChannelId
  });
  if (cleared) {
    client.logger.info('vc short activity cleared by meaningful session', {
      guildId: session.guildId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId,
      voiceChannelId: session.mainVoiceChannelId,
      cleared
    });
    await updateShortActivityCard(client, {
      guildId: session.guildId,
      categoryId: session.categoryId,
      profileChannelId: session.profileChannelId
    });
  }
  return cleared;
}

module.exports = {
  recordShortActivityForIgnoredSession,
  clearShortActivityForMeaningfulSession,
  updateShortActivityCard,
  hideShortActivityCardForLiveProfile,
  buildShortActivityPayload
};
