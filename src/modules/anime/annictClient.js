const requestCache = new Map();

function getCacheKey(operationName, params) {
  return `${operationName}:${JSON.stringify(params || {})}`;
}

function getCachedValue(client, operationName, params) {
  const key = getCacheKey(operationName, params);
  const cached = requestCache.get(key);
  if (!cached) {
    return null;
  }
  const ttlMs = Number(client.appConfig.annict?.cacheTtlHours || 24) * 60 * 60 * 1000;
  if (Date.now() - cached.cachedAt > ttlMs) {
    requestCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedValue(operationName, params, value) {
  requestCache.set(getCacheKey(operationName, params), {
    cachedAt: Date.now(),
    value
  });
}

function buildAbortSignal(timeoutMs) {
  if (AbortSignal?.timeout) {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function getAnnictAccessToken(client) {
  const envName = client.appConfig.annict?.accessTokenEnv || 'ANNICT_ACCESS_TOKEN';
  return String(process.env[envName] || '').trim();
}

function getSeasonNameFromText(value) {
  const text = String(value || '').toLowerCase();
  if (/winter|冬/u.test(text)) return 'winter';
  if (/spring|春/u.test(text)) return 'spring';
  if (/summer|夏/u.test(text)) return 'summer';
  if (/autumn|fall|秋/u.test(text)) return 'autumn';
  return null;
}

function getCurrentSeasonPair() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month <= 3) return { year, season: 'winter' };
  if (month <= 6) return { year, season: 'spring' };
  if (month <= 9) return { year, season: 'summer' };
  return { year, season: 'autumn' };
}

function getShiftedSeason(offset = 0) {
  const order = ['winter', 'spring', 'summer', 'autumn'];
  const current = getCurrentSeasonPair();
  let index = order.indexOf(current.season);
  let year = current.year;
  index += offset;
  while (index >= order.length) {
    index -= order.length;
    year += 1;
  }
  while (index < 0) {
    index += order.length;
    year -= 1;
  }
  return { year, season: order[index] };
}

function normalizeText(value) {
  return String(value || '').trim();
}

function resolveAbsoluteUrl(value, baseUrl) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//iu.test(raw)) {
    if (/^http:\/\//iu.test(raw)) {
      const upgraded = raw.replace(/^http:\/\//iu, 'https://');
      return upgraded;
    }
    return raw;
  }
  if (!baseUrl) {
    return raw;
  }
  try {
    const resolved = new URL(raw, baseUrl).toString();
    return resolved.replace(/^http:\/\//iu, 'https://');
  } catch {
    return raw;
  }
}

function toKatakana(value) {
  return String(value || '').replace(/[ぁ-ゖ]/gu, (char) => String.fromCodePoint(char.codePointAt(0) + 0x60));
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

function buildAnnictWorkUrl(workId) {
  return workId ? `https://annict.com/works/${workId}` : null;
}

function normalizeAnnictWork(work = {}) {
  const title = normalizeText(work.title);
  const officialSiteUrl = normalizeText(work.official_site_url || work.officialSiteUrl) || null;
  const annictUrl = normalizeText(work.annict_url || work.annictUrl) || buildAnnictWorkUrl(work.id);
  const imageBaseUrl = officialSiteUrl || annictUrl || null;
  const seasonYear = Number.parseInt(
    String(work.season_year || work.seasonYear || work.season_name_text || '').match(/\d{4}/)?.[0] || '',
    10
  );
  const season = getSeasonNameFromText(work.season_name || work.seasonName || work.season_name_text || work.seasonNameText);
  const aliases = [
    work.title,
    work.title_kana,
    work.titleKana,
    work.official_title,
    work.officialTitle,
    ...(Array.isArray(work.aliases) ? work.aliases : []),
    ...(Array.isArray(work.synonyms) ? work.synonyms : [])
  ].filter(Boolean).map(String);

  return {
    provider: 'annict',
    providerMediaId: String(work.id),
    titleNative: title || null,
    titleKana: normalizeText(work.title_kana || work.titleKana) || null,
    titleRomaji: null,
    titleEnglish: normalizeText(work.title_en || work.titleEn) || null,
    titleUserPreferred: title || normalizeText(work.title_kana || work.titleKana) || null,
    aliases,
    description: stripHtml(work.description),
    siteUrl: annictUrl,
    officialSiteUrl,
    malAnimeId: work.mal_anime_id ? String(work.mal_anime_id) : null,
    coverImageUrl: resolveAbsoluteUrl(
      work.images?.recommended_url
      || work.images?.facebook?.og_image_url
      || work.images?.twitter?.mini_avatar_url
      || work.image?.url,
      imageBaseUrl
    ) || null,
    bannerImageUrl: resolveAbsoluteUrl(
      work.images?.facebook?.og_image_url
      || work.images?.twitter?.normal_avatar_url,
      imageBaseUrl
    ) || null,
    season,
    seasonYear: Number.isFinite(seasonYear) ? seasonYear : null,
    status: normalizeText(work.media_text || work.media || work.status) || null,
    format: normalizeText(work.media || work.media_text) || null,
    episodes: Number.isFinite(Number(work.no_episodes || work.episodes_count)) ? Number(work.no_episodes || work.episodes_count) : null,
    duration: Number.isFinite(Number(work.duration)) ? Number(work.duration) : null,
    nextAiringAt: null,
    cast: []
  };
}

function normalizeAnnictCast(cast = {}, sortOrder = 0) {
  const character = cast.character || cast.character_resource || {};
  const person = cast.person || cast.person_resource || {};
  return {
    characterName: normalizeText(character.name) || null,
    characterNameNative: normalizeText(character.name_kana || character.nameKana) || null,
    characterImageUrl: normalizeText(character.image_url || character.image?.url) || null,
    voiceActorName: normalizeText(person.name) || null,
    voiceActorLanguage: 'JAPANESE',
    voiceActorImageUrl: normalizeText(person.image_url || person.avatar_url || person.image?.url) || null,
    sortOrder
  };
}

async function getJson(client, operationName, path, params = {}) {
  const cached = getCachedValue(client, operationName, params);
  if (cached) {
    return cached;
  }

  const token = getAnnictAccessToken(client);
  if (!token) {
    const error = new Error('annict_access_token_missing');
    error.code = 'ANNICT_TOKEN_MISSING';
    throw error;
  }

  const timeoutMs = Number(client.appConfig.annict?.timeoutMs || 15_000);
  const baseUrl = String(client.appConfig.annict?.baseUrl || 'https://api.annict.com/v1').replace(/\/$/, '');
  const url = new URL(`${baseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') {
      return;
    }
    url.searchParams.set(key, String(value));
  });

  client.logger.info('Annict request started', {
    operationName,
    path,
    timeoutMs
  });
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      signal: buildAbortSignal(timeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Annict HTTP ${response.status}`);
    }
    setCachedValue(operationName, params, body);
    client.logger.info('Annict request finished', {
      operationName,
      durationMs: Date.now() - startedAt
    });
    return body;
  } catch (error) {
    client.logger.warn('Annict request failed', {
      operationName,
      durationMs: Date.now() - startedAt,
      error: error.message
    });
    throw error;
  }
}

async function searchWorks(client, query, options = {}) {
  const body = await getJson(client, 'searchWorks', '/works', {
    filter_title: query,
    page: options.page || 1,
    per_page: options.perPage || 10
  });
  const works = Array.isArray(body?.works) ? body.works : [];
  client.logger.info('Annict work search result count', {
    query,
    count: works.length
  });
  return works.map(normalizeAnnictWork);
}

async function getWorkById(client, workId) {
  const body = await getJson(client, 'getWorkById', '/works', {
    filter_ids: workId,
    per_page: 1
  });
  const work = Array.isArray(body?.works) ? body.works[0] : null;
  return work ? normalizeAnnictWork(work) : null;
}

async function getCastsByWorkId(client, workId) {
  const body = await getJson(client, 'getCastsByWorkId', '/casts', {
    filter_work_id: workId,
    per_page: 50
  });
  const casts = Array.isArray(body?.casts) ? body.casts : [];
  client.logger.info('Annict cast result count', {
    workId: String(workId),
    count: casts.length
  });
  return casts.map((cast, index) => normalizeAnnictCast(cast, index + 1));
}

async function getSeasonWorks(client, seasonPair, perPage = 15) {
  const body = await getJson(client, `seasonWorks:${seasonPair.year}-${seasonPair.season}`, '/works', {
    filter_season: `${seasonPair.year}-${seasonPair.season}`,
    per_page: perPage
  });
  const works = Array.isArray(body?.works) ? body.works : [];
  return {
    season: seasonPair.season,
    seasonYear: seasonPair.year,
    items: works.map(normalizeAnnictWork)
  };
}

async function getCurrentSeasonWorks(client, limit = 15) {
  return getSeasonWorks(client, getShiftedSeason(0), limit);
}

async function getNextSeasonWorks(client, limit = 15) {
  return getSeasonWorks(client, getShiftedSeason(1), limit);
}

module.exports = {
  getAnnictAccessToken,
  searchWorks,
  getWorkById,
  getCastsByWorkId,
  getCurrentSeasonWorks,
  getNextSeasonWorks,
  normalizeAnnictWork,
  normalizeAnnictCast,
  toKatakana
};
