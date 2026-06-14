const SUPPORTED_HOST_PATTERNS = [
  /(^|\.)open\.spotify\.com$/i,
  /(^|\.)music\.apple\.com$/i,
  /(^|\.)music\.youtube\.com$/i,
  /(^|\.)soundcloud\.com$/i,
  /(^|\.)song\.link$/i,
  /(^|\.)odesli\.co$/i,
  /(^|\.)tidal\.com$/i,
  /(^|\.)music\.amazon\./i,
  /(^|\.)amazon\.com$/i
];

const PLATFORM_DISPLAY_NAMES = {
  spotify: 'Spotify',
  appleMusic: 'Apple Music',
  youtube: 'YouTube',
  youtubeMusic: 'YouTube Music',
  amazonMusic: 'Amazon Music',
  deezer: 'Deezer',
  tidal: 'TIDAL',
  soundcloud: 'SoundCloud',
  lineMusic: 'LINE MUSIC',
  line: 'LINE MUSIC',
  pandora: 'Pandora',
  napster: 'Napster'
};

const PREFERRED_PLATFORM_ORDER = [
  'spotify',
  'appleMusic',
  'youtubeMusic',
  'youtube',
  'amazonMusic',
  'deezer',
  'tidal',
  'soundcloud',
  'lineMusic',
  'line',
  'pandora',
  'napster'
];

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function isSupportedMusicUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return SUPPORTED_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

function extractMusicSourceUrl(content) {
  const matches = String(content || '').match(/https?:\/\/\S+/g) || [];
  for (const value of matches) {
    if (isSupportedMusicUrl(value)) {
      return value;
    }
  }

  return null;
}

function getEntityFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload?.entityUniqueId && payload?.entitiesByUniqueId?.[payload.entityUniqueId]) {
    return payload.entitiesByUniqueId[payload.entityUniqueId];
  }

  const entities = Object.values(payload.entitiesByUniqueId || {});
  return entities.find((entity) => entity?.title || entity?.thumbnailUrl || entity?.artworkUrl) || entities[0] || null;
}

function extractPlatformLinks(payload) {
  const linksByPlatform = payload?.linksByPlatform || {};
  const entries = Object.entries(linksByPlatform)
    .map(([platformKey, platformData]) => {
      const url = platformData?.url || platformData?.nativeAppUriMobile || platformData?.nativeAppUriDesktop || null;
      if (!url) {
        return null;
      }

      return {
        key: platformKey,
        name: PLATFORM_DISPLAY_NAMES[platformKey] || platformKey,
        url
      };
    })
    .filter(Boolean);

  entries.sort((left, right) => {
    const leftIndex = PREFERRED_PLATFORM_ORDER.indexOf(left.key);
    const rightIndex = PREFERRED_PLATFORM_ORDER.indexOf(right.key);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;

    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }

    return left.name.localeCompare(right.name, 'en');
  });

  return entries;
}

function normalizeOdesliResponse(sourceUrl, payload, strategyLabel) {
  const pageUrl = payload?.pageUrl || payload?.linkPageUrl || null;
  const entity = getEntityFromPayload(payload);
  const title = entity?.title || entity?.name || null;
  const artist = entity?.artistName || entity?.artist || null;
  const artworkUrl = entity?.thumbnailUrl || entity?.artworkUrl || null;
  const platformLinks = extractPlatformLinks(payload);
  const platformNames = platformLinks.map((entry) => entry.name);

  return {
    sourceUrl,
    universalUrl: pageUrl,
    title,
    artist,
    artworkUrl,
    platformLinks,
    platformNames,
    strategyLabel,
    raw: payload
  };
}

function countUsefulPlatforms(musicLink) {
  return Array.isArray(musicLink?.platformLinks) ? musicLink.platformLinks.length : 0;
}

function pickBetterMusicLink(currentBest, candidate) {
  if (!currentBest) {
    return candidate;
  }

  const bestCount = countUsefulPlatforms(currentBest);
  const candidateCount = countUsefulPlatforms(candidate);

  if (candidateCount > bestCount) {
    return candidate;
  }

  if (candidateCount < bestCount) {
    return currentBest;
  }

  const bestCompleteness = Number(Boolean(currentBest.title)) + Number(Boolean(currentBest.artist)) + Number(Boolean(currentBest.artworkUrl));
  const candidateCompleteness = Number(Boolean(candidate.title)) + Number(Boolean(candidate.artist)) + Number(Boolean(candidate.artworkUrl));

  return candidateCompleteness > bestCompleteness ? candidate : currentBest;
}

function mergeMusicLinks(base, fallback) {
  if (!base) {
    return fallback;
  }

  if (!fallback) {
    return base;
  }

  const seenUrls = new Set();
  const mergedPlatformLinks = [];

  for (const entry of [...(base.platformLinks || []), ...(fallback.platformLinks || [])]) {
    const dedupeKey = `${entry.key}:${entry.url}`;
    if (seenUrls.has(dedupeKey)) {
      continue;
    }
    seenUrls.add(dedupeKey);
    mergedPlatformLinks.push(entry);
  }

  mergedPlatformLinks.sort((left, right) => {
    const leftIndex = PREFERRED_PLATFORM_ORDER.indexOf(left.key);
    const rightIndex = PREFERRED_PLATFORM_ORDER.indexOf(right.key);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return normalizedLeft - normalizedRight;
  });

  const platformNames = [...new Set(mergedPlatformLinks.map((entry) => entry.name).filter(Boolean))];

  return {
    ...base,
    universalUrl: base.universalUrl || fallback.universalUrl || null,
    title: base.title || fallback.title || null,
    artist: base.artist || fallback.artist || null,
    artworkUrl: base.artworkUrl || fallback.artworkUrl || null,
    platformLinks: mergedPlatformLinks,
    platformNames
  };
}

async function fetchOdesliMusicLink(sourceUrl, logger) {
  const requestUrl = new URL('https://api.song.link/v1-alpha.1/links');
  requestUrl.searchParams.set('url', sourceUrl);
  const apiKey = process.env.ODESLI_API_KEY?.trim();
  const strategies = [
    { label: 'JP', userCountry: 'JP' },
    { label: 'default', userCountry: null },
    { label: 'US', userCountry: 'US' }
  ];

  let bestResult = null;
  let lastError = null;

  for (const strategy of strategies) {
    const strategyUrl = new URL(requestUrl);
    if (strategy.userCountry) {
      strategyUrl.searchParams.set('userCountry', strategy.userCountry);
    }
    if (apiKey) {
      strategyUrl.searchParams.set('key', apiKey);
    }

    logger.info('Attempting Odesli lookup', {
      sourceUrl,
      strategy: strategy.label,
      userCountry: strategy.userCountry
    });

    try {
      const response = await fetch(strategyUrl, {
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Odesli request failed with status ${response.status}`);
      }

      const payload = await response.json();
      const candidate = normalizeOdesliResponse(sourceUrl, payload, strategy.label);
      bestResult = mergeMusicLinks(pickBetterMusicLink(bestResult, candidate), candidate);

      logger.info('Odesli response received', {
        sourceUrl,
        strategy: strategy.label,
        pageUrl: candidate.universalUrl,
        platforms: candidate.platformNames,
        title: candidate.title,
        artist: candidate.artist
      });
    } catch (error) {
      lastError = error;
      logger.warn('Odesli request failed', {
        sourceUrl,
        strategy: strategy.label,
        error: error.message
      });
    }
  }

  if (!bestResult) {
    throw lastError || new Error('Odesli did not return any usable result');
  }

  logger.info('Selected Odesli response', {
    sourceUrl,
    strategy: bestResult.strategyLabel || 'merged',
    pageUrl: bestResult.universalUrl,
    platforms: bestResult.platformNames,
    title: bestResult.title,
    artist: bestResult.artist
  });

  return bestResult;
}

async function enrichPostWithMusicLink(post, { db, logger }) {
  const isMusicTagged = (post.matchedBotHashtagRoutes || []).includes('いい音楽');
  if (!isMusicTagged) {
    return post;
  }

  const sourceUrl = extractMusicSourceUrl(post.content || '');
  if (!sourceUrl) {
    const urls = String(post.content || '').match(/https?:\/\/\S+/g) || [];
    logger.info('music preview skipped non-music url', {
      messageId: post.messageId || null,
      urls,
      hosts: urls.map((url) => {
        try {
          return new URL(url).hostname.toLowerCase();
        } catch {
          return null;
        }
      }).filter(Boolean)
    });
    logger.info('Music route detected but no supported music URL was found', {
      messageId: post.messageId || null
    });
    return post;
  }

  logger.info('Music URL detected for Odesli resolution', {
    messageId: post.messageId || null,
    sourceUrl
  });

  const cached = db?.musicLinks?.get(sourceUrl);
  if (cached) {
    const cachedPlatformNames = safeJsonParse(cached.platformNames, []);
    const cachedPlatformLinks = safeJsonParse(cached.platformLinksJson, []);

    logger.info('Using cached Odesli music link', {
      messageId: post.messageId || null,
      sourceUrl,
      platforms: cachedPlatformNames
    });

    return {
      ...post,
      musicLink: {
        sourceUrl,
        universalUrl: cached.universalUrl,
        title: cached.title,
        artist: cached.artist,
        artworkUrl: cached.artworkUrl,
        platformNames: cachedPlatformNames,
        platformLinks: cachedPlatformLinks,
        raw: safeJsonParse(cached.rawJson, null)
      }
    };
  }

  try {
    const musicLink = await fetchOdesliMusicLink(sourceUrl, logger);
    db?.musicLinks?.upsert({
      sourceUrl,
      universalUrl: musicLink.universalUrl,
      title: musicLink.title,
      artist: musicLink.artist,
      artworkUrl: musicLink.artworkUrl,
      platformNames: JSON.stringify(musicLink.platformNames || []),
      platformLinksJson: JSON.stringify(musicLink.platformLinks || []),
      rawJson: JSON.stringify(musicLink.raw || {})
    });

    return {
      ...post,
      musicLink
    };
  } catch (error) {
    logger.warn('Odesli lookup failed; falling back to normal preview', {
      messageId: post.messageId || null,
      sourceUrl,
      error: error.message
    });
    return post;
  }
}

module.exports = {
  extractMusicSourceUrl,
  enrichPostWithMusicLink
};
