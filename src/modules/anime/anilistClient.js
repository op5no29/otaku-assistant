const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const requestCache = new Map();

function getCacheKey(operationName, variables) {
  return `${operationName}:${JSON.stringify(variables || {})}`;
}

function getCachedValue(client, operationName, variables) {
  const key = getCacheKey(operationName, variables);
  const cached = requestCache.get(key);
  if (!cached) {
    return null;
  }

  const ttlMs = Number(client.appConfig.anime.apiCacheTtlHours || 24) * 60 * 60 * 1000;
  if (Date.now() - cached.cachedAt > ttlMs) {
    requestCache.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedValue(operationName, variables, value) {
  requestCache.set(getCacheKey(operationName, variables), {
    cachedAt: Date.now(),
    value
  });
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&mdash;/gu, '—')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&quot;/gu, '"')
    .replace(/&#039;/gu, '\'')
    .replace(/&amp;/gu, '&')
    .trim();
}

function buildAbortSignal(timeoutMs) {
  if (AbortSignal?.timeout) {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function postGraphql(client, operationName, query, variables) {
  const cached = getCachedValue(client, operationName, variables);
  if (cached) {
    return cached;
  }

  const timeoutMs = Number(client.appConfig.anime.apiTimeoutMs || 15_000);
  client.logger.info('AniList request started', {
    operationName,
    timeoutMs
  });

  const startedAt = Date.now();

  try {
    const response = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal: buildAbortSignal(timeoutMs)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`AniList HTTP ${response.status}`);
    }
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error(body.errors.map((entry) => entry?.message).filter(Boolean).join('; ') || 'AniList GraphQL error');
    }

    setCachedValue(operationName, variables, body.data || null);
    client.logger.info('AniList request finished', {
      operationName,
      durationMs: Date.now() - startedAt
    });
    return body.data || null;
  } catch (error) {
    client.logger.warn('AniList request failed', {
      operationName,
      durationMs: Date.now() - startedAt,
      error: error.message
    });
    throw error;
  }
}

function normalizeMedia(media) {
  if (!media) {
    return null;
  }

  const nextAiringAt = media.nextAiringEpisode?.airingAt
    ? new Date(Number(media.nextAiringEpisode.airingAt) * 1000).toISOString()
    : null;
  const aliases = Array.isArray(media.synonyms) ? media.synonyms.filter(Boolean).map(String) : [];
  const officialSiteUrl = Array.isArray(media.externalLinks)
    ? media.externalLinks.find((entry) => entry?.type === 'INFO' || /official/i.test(String(entry?.site || '')))?.url || null
    : null;

  return {
    provider: 'anilist',
    providerMediaId: String(media.id),
    titleNative: media.title?.native || null,
    titleRomaji: media.title?.romaji || null,
    titleEnglish: media.title?.english || null,
    titleUserPreferred: media.title?.userPreferred || media.title?.romaji || media.title?.native || media.title?.english || null,
    aliases,
    description: stripHtml(media.description),
    siteUrl: media.siteUrl || null,
    officialSiteUrl,
    coverImageUrl: media.coverImage?.extraLarge || media.coverImage?.large || null,
    bannerImageUrl: media.bannerImage || null,
    season: media.season || null,
    seasonYear: Number.isFinite(media.seasonYear) ? media.seasonYear : null,
    status: media.status || null,
    format: media.format || null,
    episodes: Number.isFinite(media.episodes) ? media.episodes : null,
    duration: Number.isFinite(media.duration) ? media.duration : null,
    nextAiringAt,
    cast: normalizeCast(media.characters?.edges || [])
  };
}

function normalizeCast(edges = []) {
  const rows = [];
  let sortOrder = 0;
  for (const edge of edges) {
    const voiceActor = Array.isArray(edge?.voiceActors) ? edge.voiceActors[0] : null;
    rows.push({
      characterName: edge?.node?.name?.full || null,
      characterNameNative: edge?.node?.name?.native || null,
      characterImageUrl: edge?.node?.image?.large || null,
      voiceActorName: voiceActor?.name?.full || voiceActor?.name?.native || null,
      voiceActorLanguage: voiceActor ? 'JAPANESE' : null,
      voiceActorImageUrl: voiceActor?.image?.large || null,
      sortOrder: ++sortOrder
    });
  }
  return rows;
}

const SEARCH_QUERY = `
  query SearchAnime($search: String!, $page: Int!, $perPage: Int!) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
        id
        title { romaji english native userPreferred }
        synonyms
        description(asHtml: false)
        siteUrl
        season
        seasonYear
        status
        format
        episodes
        duration
        coverImage { large extraLarge color }
        bannerImage
        nextAiringEpisode { episode airingAt timeUntilAiring }
        externalLinks { site url type }
      }
    }
  }
`;

const DETAIL_QUERY = `
  query AnimeById($id: Int!, $castLimit: Int!) {
    Media(id: $id, type: ANIME) {
      id
      title { romaji english native userPreferred }
      synonyms
      description(asHtml: false)
      siteUrl
      season
      seasonYear
      status
      format
      episodes
      duration
      coverImage { large extraLarge color }
      bannerImage
      nextAiringEpisode { episode airingAt timeUntilAiring }
      externalLinks { site url type }
      characters(sort: [ROLE, RELEVANCE], page: 1, perPage: $castLimit) {
        edges {
          role
          node {
            name { full native }
            image { large }
          }
          voiceActors(language: JAPANESE) {
            name { full native }
            image { large }
          }
        }
      }
    }
  }
`;

const SEASON_QUERY = `
  query SeasonAnime($season: MediaSeason!, $seasonYear: Int!, $page: Int!, $perPage: Int!) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: [POPULARITY_DESC]) {
        id
        title { romaji english native userPreferred }
        synonyms
        description(asHtml: false)
        siteUrl
        season
        seasonYear
        status
        format
        episodes
        duration
        coverImage { large extraLarge color }
        bannerImage
        nextAiringEpisode { episode airingAt timeUntilAiring }
        externalLinks { site url type }
      }
    }
  }
`;

function getSeasonPair(offset = 0) {
  const now = new Date();
  const seasons = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const month = now.getUTCMonth() + 1;
  let seasonIndex = 0;
  if (month >= 1 && month <= 3) {
    seasonIndex = 0;
  } else if (month >= 4 && month <= 6) {
    seasonIndex = 1;
  } else if (month >= 7 && month <= 9) {
    seasonIndex = 2;
  } else {
    seasonIndex = 3;
  }

  let year = now.getUTCFullYear();
  seasonIndex += offset;
  while (seasonIndex >= seasons.length) {
    seasonIndex -= seasons.length;
    year += 1;
  }
  while (seasonIndex < 0) {
    seasonIndex += seasons.length;
    year -= 1;
  }

  return {
    season: seasons[seasonIndex],
    seasonYear: year
  };
}

async function searchAnimeByTitle(client, title, perPage = 5) {
  const data = await postGraphql(client, 'SearchAnime', SEARCH_QUERY, {
    search: String(title || '').trim(),
    page: 1,
    perPage
  });
  const list = Array.isArray(data?.Page?.media) ? data.Page.media.map(normalizeMedia).filter(Boolean) : [];
  client.logger.info('anime search result count', {
    title,
    count: list.length
  });
  return list;
}

async function getAnimeById(client, id, castLimit = 10) {
  const data = await postGraphql(client, 'AnimeById', DETAIL_QUERY, {
    id: Number(id),
    castLimit: Number(castLimit)
  });
  return normalizeMedia(data?.Media || null);
}

async function getAnimeCastById(client, id, limit = 10) {
  const media = await getAnimeById(client, id, limit);
  const cast = Array.isArray(media?.cast) ? media.cast.slice(0, limit) : [];
  client.logger.info('anime cast result count', {
    id: String(id),
    count: cast.length
  });
  return cast;
}

async function getSeasonAnime(client, offset = 0, limit = 10) {
  const { season, seasonYear } = getSeasonPair(offset);
  const data = await postGraphql(client, 'SeasonAnime', SEASON_QUERY, {
    season,
    seasonYear,
    page: 1,
    perPage: Number(limit)
  });
  return {
    season,
    seasonYear,
    items: Array.isArray(data?.Page?.media) ? data.Page.media.map(normalizeMedia).filter(Boolean) : []
  };
}

async function getCurrentSeasonAnime(client, limit = 10) {
  return getSeasonAnime(client, 0, limit);
}

async function getNextSeasonAnime(client, limit = 10) {
  return getSeasonAnime(client, 1, limit);
}

const MALID_QUERY = `
  query AnimeByMalId($malId: Int!) {
    Media(idMal: $malId, type: ANIME) {
      id
      coverImage { large extraLarge }
      bannerImage
    }
  }
`;

async function getAnimeByMalId(client, malId) {
  const data = await postGraphql(client, 'AnimeByMalId', MALID_QUERY, {
    malId: Number(malId)
  });
  return data?.Media || null;
}

module.exports = {
  searchAnimeByTitle,
  getAnimeById,
  getAnimeCastById,
  getCurrentSeasonAnime,
  getNextSeasonAnime,
  getAnimeByMalId
};
