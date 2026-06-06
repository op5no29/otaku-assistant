const {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder
} = require('discord.js');
const pkg = require('../../../package.json');

const DASHBOARD_KINDS = {
  SYSTEM: 'system',
  OPERATIONS: 'operations'
};

const ACCENT_COLORS = {
  system: 0x2563eb,
  operations: 0x16a34a,
  warn: 0xf59e0b,
  error: 0xef4444
};

function getDashboardConfig(client) {
  const dashboard = client.appConfig?.moderatorLogs?.dashboard || {};
  const channelId = String(dashboard.channelId || client.appConfig?.ops?.logChannelId || '');
  return {
    enabled: dashboard.enabled !== false && Boolean(channelId),
    channelId,
    maxEvents: Math.max(1, Math.min(Number(dashboard.maxEvents || 3), 10)),
    recreateOnStartup: dashboard.recreateOnStartup === true,
    debounceMs: Math.max(1000, Number(dashboard.debounceMs || 5000))
  };
}

function formatClock(iso) {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return String(iso || '');
  }
}

function formatDateTime(iso) {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(iso));
  } catch {
    return String(iso || '');
  }
}

function parseRecentEvents(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function stringifyRecentEvents(events, maxEvents) {
  return JSON.stringify((events || []).slice(0, maxEvents));
}

function truncate(text, maxLength) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatEvent(event) {
  const severity = String(event.severity || 'info').toUpperCase();
  const body = truncate(event.body || '', 260);
  return [
    `**${formatClock(event.createdAt)} ${severity} ${truncate(event.title || event.eventType || 'event', 80)}**`,
    body || null
  ].filter(Boolean).join('\n');
}

function getSystemStatus(client) {
  return client.logDashboardStatus || 'running';
}

function getEnabledModuleLines(client) {
  const config = client.appConfig || {};
  return [
    `Timeline relay: ${config.timelineChannelId ? 'enabled' : 'disabled'}`,
    `Question relay: ${config.watchedForums?.question?.length ? 'enabled' : 'disabled'}`,
    `Media relay: ${Number(config.mediaRelay?.maxReuploadBytes || 0) > 0 ? 'enabled' : 'disabled'}`,
    `VC profile categories: ${client.voiceProfileCategoryMap?.size || 0}`,
    `Anime: ${config.anime?.enabled !== false ? 'enabled' : 'disabled'}`
  ];
}

function buildDashboardPayload(client, kind, record) {
  const events = parseRecentEvents(record?.recentEventsJson);
  const status = getSystemStatus(client);
  const startedAt = client.logDashboardStartedAt || new Date().toISOString();
  const title = kind === DASHBOARD_KINDS.SYSTEM
    ? '## Otaku Assistant System'
    : '## Otaku Assistant Recent Operations';
  const accentColor = events.some((event) => event.severity === 'error')
    ? ACCENT_COLORS.error
    : events.some((event) => event.severity === 'warn')
      ? ACCENT_COLORS.warn
      : kind === DASHBOARD_KINDS.SYSTEM
        ? ACCENT_COLORS.system
        : ACCENT_COLORS.operations;

  const container = new ContainerBuilder().setAccentColor(accentColor);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(title));

  if (kind === DASHBOARD_KINDS.SYSTEM) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        `**状態:** ${status}`,
        `**起動:** ${formatDateTime(startedAt)}`,
        `**uptime:** ${Math.floor(process.uptime() / 60)}分`,
        `**version:** ${pkg.version}`,
        `**node:** ${process.version}`
      ].join('\n'))
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Modules**\n${getEnabledModuleLines(client).join('\n')}`)
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      kind === DASHBOARD_KINDS.SYSTEM
        ? `**最近のシステムログ**\n${events.length ? events.map(formatEvent).join('\n\n') : 'まだ記録はありません。'}`
        : `**最近の重要ログ**\n${events.length ? events.map(formatEvent).join('\n\n') : 'まだ重要ログはありません。'}`
    )
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: {
      parse: [],
      users: [],
      roles: []
    }
  };
}

function getDashboardTimers(client) {
  if (!client.logDashboardUpdateTimers) {
    client.logDashboardUpdateTimers = new Map();
  }
  return client.logDashboardUpdateTimers;
}

function upsertRecord(client, kind, {
  channelId,
  messageId = null,
  recentEventsJson = '[]',
  lastPayloadJson = null
}) {
  const guildId = process.env.GUILD_ID || '';
  client.db.logDashboards.upsert({
    guildId,
    channelId,
    dashboardKind: kind,
    messageId,
    recentEventsJson,
    lastPayloadJson
  });
  return client.db.logDashboards.get(guildId, kind);
}

async function fetchDashboardChannel(client, channelId) {
  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

async function updateDashboardMessage(client, kind, {
  reason = 'update',
  recreate = false
} = {}) {
  const config = getDashboardConfig(client);
  if (!config.enabled) {
    return null;
  }

  const guildId = process.env.GUILD_ID || '';
  let record = client.db.logDashboards.get(guildId, kind) || upsertRecord(client, kind, {
    channelId: config.channelId
  });
  if (record.channelId !== config.channelId) {
    record = upsertRecord(client, kind, {
      channelId: config.channelId,
      messageId: null,
      recentEventsJson: record.recentEventsJson || '[]'
    });
  }

  const channel = await fetchDashboardChannel(client, config.channelId);
  if (!channel) {
    client.logger.warn('log dashboard update failed', {
      kind,
      channelId: config.channelId,
      reason: 'channel_unavailable'
    });
    return null;
  }

  let message = null;
  if (record.messageId && !recreate) {
    message = await channel.messages.fetch(record.messageId).catch(() => null);
  } else if (record.messageId && recreate) {
    const oldMessage = await channel.messages.fetch(record.messageId).catch(() => null);
    await oldMessage?.delete?.().catch(() => null);
  }

  const payload = buildDashboardPayload(client, kind, record);
  const lastPayloadJson = JSON.stringify({
    kind,
    updatedAt: new Date().toISOString(),
    eventCount: parseRecentEvents(record.recentEventsJson).length
  });

  try {
    const updatedMessage = message
      ? await message.edit(payload)
      : await channel.send(payload);
    record = upsertRecord(client, kind, {
      channelId: config.channelId,
      messageId: updatedMessage.id,
      recentEventsJson: record.recentEventsJson || '[]',
      lastPayloadJson
    });
    client.logger.info(message ? 'log dashboard message edited' : 'log dashboard message created', {
      guildId,
      kind,
      channelId: config.channelId,
      messageId: updatedMessage.id,
      reason
    });
    return updatedMessage;
  } catch (error) {
    client.logger.warn('log dashboard update failed', {
      guildId,
      kind,
      channelId: config.channelId,
      messageId: record.messageId || null,
      reason,
      error: error.message
    });
    return null;
  }
}

function scheduleDashboardUpdate(client, kind, { reason = 'event' } = {}) {
  const config = getDashboardConfig(client);
  if (!config.enabled) {
    return;
  }
  const timers = getDashboardTimers(client);
  const key = `${process.env.GUILD_ID || ''}:${kind}`;
  if (timers.has(key)) {
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    void updateDashboardMessage(client, kind, { reason }).catch((error) => {
      client.logger.warn('log dashboard update failed', {
        kind,
        reason,
        error: error.message
      });
    });
  }, config.debounceMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  timers.set(key, timer);
}

async function ensureLogDashboards(client, { reason = 'startup' } = {}) {
  const config = getDashboardConfig(client);
  if (!config.enabled) {
    client.logger.info('log dashboard disabled', {
      reason,
      channelId: config.channelId || null
    });
    return { enabled: false };
  }
  await updateDashboardMessage(client, DASHBOARD_KINDS.SYSTEM, {
    reason,
    recreate: config.recreateOnStartup && reason === 'startup'
  });
  await updateDashboardMessage(client, DASHBOARD_KINDS.OPERATIONS, {
    reason,
    recreate: config.recreateOnStartup && reason === 'startup'
  });
  return { enabled: true };
}

function appendDashboardLog(client, kind, event) {
  const config = getDashboardConfig(client);
  if (!config.enabled) {
    return null;
  }
  const guildId = process.env.GUILD_ID || '';
  const existing = client.db.logDashboards.get(guildId, kind) || null;
  const recentEvents = parseRecentEvents(existing?.recentEventsJson);
  const normalizedEvent = {
    severity: String(event.severity || 'info'),
    eventType: String(event.eventType || event.title || 'event'),
    title: String(event.title || event.eventType || 'event'),
    body: String(event.body || ''),
    metadata: event.metadata || null,
    createdAt: event.createdAt || new Date().toISOString()
  };
  const updatedEvents = [normalizedEvent, ...recentEvents]
    .slice(0, config.maxEvents);

  const record = upsertRecord(client, kind, {
    channelId: config.channelId,
    messageId: existing?.messageId || null,
    recentEventsJson: stringifyRecentEvents(updatedEvents, config.maxEvents),
    lastPayloadJson: existing?.lastPayloadJson || null
  });
  scheduleDashboardUpdate(client, kind, { reason: normalizedEvent.eventType });
  return record;
}

function appendSystemLog(client, event) {
  return appendDashboardLog(client, DASHBOARD_KINDS.SYSTEM, event);
}

function appendOperationLog(client, event) {
  return appendDashboardLog(client, DASHBOARD_KINDS.OPERATIONS, event);
}

module.exports = {
  DASHBOARD_KINDS,
  appendOperationLog,
  appendSystemLog,
  ensureLogDashboards,
  updateDashboardMessage
};
