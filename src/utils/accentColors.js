const ACCENT_COLORS = {
  urgent: 0xef4444,
  important: 0xfacc15,
  guide: 0x22c55e,
  timeline: 0x2563eb,
  question: 0xef4444,
  questionResolved: 0x22c55e,
  knowledge: 0xf59e0b,
  anime: 0xf3f4f6,
  goodVideo: 0x06b6d4,
  goodMusic: 0xdb2777,
  tech: 0x6366f1,
  food: 0xf97316,
  vcDefault: 0x3b82f6
};

const VC_ACCENT_PALETTE = [
  0x3b82f6,
  0x14b8a6,
  0xa855f7,
  0xf59e0b,
  0xef4444,
  0x22c55e,
  0xec4899,
  0x0ea5e9
];

function parseAccentColor(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(0xffffff, Math.trunc(value)));
  }

  const raw = String(value || '').trim();
  if (!raw) {
    return fallback;
  }

  const hex = raw.startsWith('#')
    ? raw.slice(1)
    : raw.toLowerCase().startsWith('0x')
      ? raw.slice(2)
      : raw;

  if (!/^[0-9a-f]{6}$/iu.test(hex)) {
    return fallback;
  }

  return Number.parseInt(hex, 16);
}

function normalizeRouteText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[#\s_・:：\-ー]/gu, '');
}

function collectRouteTokens(routeKey, route, type) {
  const values = [routeKey, type];
  if (Array.isArray(route?.tags)) {
    values.push(...route.tags);
  }
  if (Array.isArray(route?.aliases)) {
    values.push(...route.aliases);
  }
  values.push(route?.display, route?.displayTag, route?.channelId);
  return values.map(normalizeRouteText).filter(Boolean);
}

function routeHasAnyToken(tokens, patterns) {
  return tokens.some((token) => patterns.some((pattern) => token.includes(pattern)));
}

function findRouteMatch({ globalRouteKeys = [], botRouteKeys = [], config = {}, priority }) {
  const animeChannelId = String(config.anime?.channelId || '');

  for (const routeKey of globalRouteKeys || []) {
    const route = config.globalHashtagRoutes?.[routeKey];
    const tokens = collectRouteTokens(routeKey, route, 'global');
    const isAnimeRoute = animeChannelId && String(route?.channelId || '') === animeChannelId;
    if (
      priority.key === 'anime' &&
      (isAnimeRoute || routeHasAnyToken(tokens, ['anime', 'アニメ']))
    ) {
      return { routeKey, route, type: 'global' };
    }
    if (priority.key === 'tech' && routeHasAnyToken(tokens, ['技術', 'tech', 'tool', 'tips', '開発', 'ツール'])) {
      return { routeKey, route, type: 'global' };
    }
    if (priority.key === 'food' && routeHasAnyToken(tokens, ['飯', 'ご飯', 'ごはん', 'food', 'meshi', 'ramen', 'ラーメン'])) {
      return { routeKey, route, type: 'global' };
    }
  }

  for (const routeKey of botRouteKeys || []) {
    const route = config.botHashtagRoutes?.[routeKey];
    const tokens = collectRouteTokens(routeKey, route, 'bot');
    if (priority.key === 'goodVideo' && routeHasAnyToken(tokens, ['いい映像', '良い映像', '映像', 'video'])) {
      return { routeKey, route, type: 'bot' };
    }
    if (priority.key === 'goodMusic' && routeHasAnyToken(tokens, ['いい音楽', '良い音楽', '音楽', 'music'])) {
      return { routeKey, route, type: 'bot' };
    }
  }

  return null;
}

function resolveRouteAccentColor({
  globalRouteKeys = [],
  botRouteKeys = [],
  config = {},
  logger = null,
  sourceMessageId = null
} = {}) {
  const priority = [
    { key: 'anime', color: ACCENT_COLORS.anime },
    { key: 'goodVideo', color: ACCENT_COLORS.goodVideo },
    { key: 'goodMusic', color: ACCENT_COLORS.goodMusic },
    { key: 'tech', color: ACCENT_COLORS.tech },
    { key: 'food', color: ACCENT_COLORS.food }
  ];

  for (const entry of priority) {
    const match = findRouteMatch({
      globalRouteKeys,
      botRouteKeys,
      config,
      priority: entry
    });
    if (!match) {
      continue;
    }

    const configured = parseAccentColor(match.route?.accentColor, null);
    const color = entry.key === 'anime' ? ACCENT_COLORS.anime : (configured ?? entry.color);
    logger?.info?.('route accent color priority applied', {
      sourceMessageId,
      priorityKey: entry.key,
      routeKey: match.routeKey,
      routeType: match.type,
      configuredAccentColor: configured,
      resolvedAccentColor: color
    });
    logger?.info?.('route accent color resolved', {
      sourceMessageId,
      globalRouteKeys,
      botRouteKeys,
      resolvedKey: entry.key,
      accentColor: color
    });
    return color;
  }

  logger?.info?.('route accent color resolved', {
    sourceMessageId,
    globalRouteKeys,
    botRouteKeys,
    resolvedKey: 'default',
    accentColor: ACCENT_COLORS.timeline
  });
  return ACCENT_COLORS.timeline;
}

function hashStringToIndex(value, length) {
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) >>> 0;
  }
  return length ? hash % length : 0;
}

function resolveVcProfileAccentColor({
  voiceChannelId,
  config = {},
  logger = null
} = {}) {
  const configured = parseAccentColor(
    config.voiceProfile?.channelAccentColors?.[String(voiceChannelId || '')],
    null
  );
  const color = configured ?? VC_ACCENT_PALETTE[
    hashStringToIndex(voiceChannelId, VC_ACCENT_PALETTE.length)
  ] ?? ACCENT_COLORS.vcDefault;

  logger?.info?.('vc profile card color resolved', {
    voiceChannelId: String(voiceChannelId || ''),
    configuredAccentColor: configured,
    accentColor: color
  });

  return color;
}

module.exports = {
  ACCENT_COLORS,
  parseAccentColor,
  resolveRouteAccentColor,
  resolveVcProfileAccentColor
};
