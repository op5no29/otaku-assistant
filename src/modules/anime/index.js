const {
  searchAnimeByTitle,
  getAnimeById: getAniListAnimeById,
  getAnimeCastById: getAniListAnimeCastById,
  getCurrentSeasonAnime: getAniListCurrentSeasonAnime,
  getNextSeasonAnime: getAniListNextSeasonAnime,
  getAnimeByMalId,
  getAnimeImageByTitle
} = require('./anilistClient');
const {
  searchWorks,
  getWorkById,
  getCastsByWorkId,
  getCurrentSeasonWorks,
  getNextSeasonWorks,
  getAnnictAccessToken
} = require('./annictClient');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { rankResolvedWorks, extractSearchAliases } = require('./search');
const {
  normalizeAnimeImageCandidate,
  normalizeAnimeImageCandidates,
  normalizeHttpsUrl,
  getAnimeImageCandidateRejectionReason,
  selectPreferredAnimeImageCandidates
} = require('./imagePolicy');
const { normalizeAnimeSearchQuery, buildAnimeSearchQueries } = require('./titleAliases');
const { registerDeletableMessage } = require('../deletableMessages');
const { extractPlainMessagePost } = require('../timelineRelay/extractFirstPost');
const { buildTimelineMessage } = require('../timelineRelay/buildTimelineMessage');
const { resolveTwitterMedia } = require('../timelineRelay/twitterMediaResolver');
const { prepareVideoThumbnail } = require('../timelineRelay/videoThumbnail');
const { prepareAttachmentRelay } = require('../timelineRelay/attachmentRelay');
const {
  buildAnimeChannelCard,
  buildAnimeReviewUiCard,
  buildAnimeLinks,
  buildReviewPreview,
  getPreferredAnimeDisplayTitle,
  selectAnimeImageUrls
} = require('./buildAnimeMessages');
const { buildAnimeRoleAwardDm } = require('./animeQuoteMessages');

const REVIEW_PROMPT_TYPES = {
  WATCHED: 'watched'
};
const IMAGE_VALIDATION_TTL_MS = 1000 * 60 * 60 * 6;
const WATCHED_PROMPT_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const ANNICT_REACTION_NOTICE_COOLDOWN_MS = 1000 * 60 * 60 * 12;

function parseAliases(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getConfiguredProvider(client) {
  return String(client.appConfig.anime?.provider || 'annict').toLowerCase();
}

function getProviderTokenMissingMessage(client) {
  if (getConfiguredProvider(client) === 'annict' && !getAnnictAccessToken(client)) {
    return 'Annict APIトークンが設定されていません。';
  }
  return null;
}

function normalizeEntry(entry) {
  if (!entry) {
    return null;
  }

  return {
    ...entry,
    aliases: parseAliases(entry.aliasesJson),
    hasSpoilerReviews: Boolean(entry.hasSpoilerReviews)
  };
}

function mergeAliases(...groups) {
  return Array.from(new Set(groups.flat().filter(Boolean).map(String)));
}

function buildMediaImageCandidates(media) {
  return normalizeAnimeImageCandidates([
    normalizeAnimeImageCandidate(media.coverImageUrl, {
      kind: 'cover',
      source: 'media.coverImageUrl'
    }),
    normalizeAnimeImageCandidate(media.bannerImageUrl, {
      kind: 'banner',
      source: 'media.bannerImageUrl'
    }),
    ...(Array.isArray(media.imageCandidates) ? media.imageCandidates : [])
  ]);
}

function buildEntryRecord(media, extras = {}) {
  const preferredImageCandidates = selectPreferredAnimeImageCandidates(buildMediaImageCandidates(media), 2);
  const resolvedCoverImageUrl = preferredImageCandidates[0]?.url || null;
  const resolvedBannerImageUrl = preferredImageCandidates[1]?.url || null;
  const aliases = mergeAliases(
    Array.isArray(media.aliases) ? media.aliases : [],
    Array.isArray(extras.additionalAliases) ? extras.additionalAliases : [],
    [
      media.titleNative,
      media.titleKana,
      media.titleUserPreferred,
      media.titleRomaji,
      media.titleEnglish
    ]
  );
  return {
    guildId: extras.guildId,
    provider: String(media.provider || extras.provider || 'annict'),
    providerMediaId: String(media.providerMediaId || media.id),
    titleNative: media.titleNative || null,
    titleKana: media.titleKana || null,
    titleRomaji: media.titleRomaji || null,
    titleEnglish: media.titleEnglish || null,
    titleUserPreferred: media.titleUserPreferred || media.titleRomaji || media.titleNative || media.titleEnglish || null,
    aliasesJson: JSON.stringify(aliases),
    description: media.description || null,
    siteUrl: media.siteUrl || null,
    officialSiteUrl: media.officialSiteUrl || null,
    malAnimeId: media.malAnimeId || null,
    coverImageUrl: resolvedCoverImageUrl,
    bannerImageUrl: resolvedBannerImageUrl,
    season: media.season || null,
    seasonYear: Number.isFinite(media.seasonYear) ? media.seasonYear : null,
    status: media.status || null,
    episodes: Number.isFinite(media.episodes) ? media.episodes : null,
    duration: Number.isFinite(media.duration) ? media.duration : null,
    nextAiringAt: media.nextAiringAt || null,
    animeChannelId: extras.animeChannelId || null,
    animeChannelMessageId: extras.animeChannelMessageId || null,
    threadId: extras.threadId || null,
    threadCardMessageId: extras.threadCardMessageId || null,
    reviewCardMessageId: extras.reviewCardMessageId || null,
    hasSpoilerReviews: extras.hasSpoilerReviews === true,
    createdByUserId: extras.createdByUserId || null,
    createdAt: extras.createdAt || new Date().toISOString()
  };
}

function getAnimeChannelId(client) {
  return String(client.appConfig.anime?.channelId || '');
}

function getEmojiKey(emoji) {
  if (!emoji) {
    return '';
  }
  return emoji.id ? `${emoji.animated ? 'a' : 's'}:${emoji.name}:${emoji.id}` : String(emoji.name || '');
}

function matchesConfiguredEmoji(emoji, configured) {
  const raw = String(configured || '');
  if (!raw) {
    return false;
  }
  if (!emoji) {
    return false;
  }
  if (!raw.includes(':')) {
    return String(emoji.name || '') === raw;
  }
  return getEmojiKey(emoji) === raw;
}

function getAnimeStatusReactionEmojis(client) {
  return {
    interested: String(client.appConfig.anime.interestEmoji || '👀'),
    watched: String(client.appConfig.anime.watchedEmoji || '✅')
  };
}

function buildTitle(entry) {
  return getPreferredAnimeDisplayTitle(entry) || `${String(entry.provider || 'anime')} ${entry.providerMediaId}`;
}

async function safeFetchChannel(client, channelId) {
  if (!channelId) {
    return null;
  }
  return client.channels.fetch(channelId).catch(() => null);
}

async function safeFetchMessage(channel, messageId) {
  if (!channel?.messages?.fetch || !messageId) {
    return null;
  }
  return channel.messages.fetch(messageId).catch(() => null);
}

function ensureAnimeImageValidationStore(client) {
  if (!client.animeImageValidationCache) {
    client.animeImageValidationCache = new Map();
  }
  return client.animeImageValidationCache;
}

function ensureAnimeOfficialSiteImageStore(client) {
  if (!client.animeOfficialSiteImageCache) {
    client.animeOfficialSiteImageCache = new Map();
  }
  return client.animeOfficialSiteImageCache;
}

async function validateAnimeImageCandidate(client, candidate, { skipPatternCheck = false } = {}) {
  const normalizedCandidate = normalizeAnimeImageCandidate(candidate);
  const upgradedUrl = normalizeHttpsUrl(normalizedCandidate?.url);
  if (!skipPatternCheck) {
    const rejectionReason = getAnimeImageCandidateRejectionReason({
      ...normalizedCandidate,
      url: upgradedUrl
    });
    if (rejectionReason) {
      return {
        valid: false,
        url: upgradedUrl,
        reason: rejectionReason
      };
    }
  } else if (!/^https:\/\//iu.test(String(upgradedUrl || ''))) {
    return { valid: false, url: upgradedUrl, reason: 'non_https' };
  }

  const cache = ensureAnimeImageValidationStore(client);
  const cached = cache.get(upgradedUrl);
  if (cached && (Date.now() - cached.checkedAt) < IMAGE_VALIDATION_TTL_MS) {
    return cached.result;
  }

  try {
    const response = await fetch(upgradedUrl, {
      headers: {
        Accept: 'image/*'
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const contentLength = Number.parseInt(String(response.headers.get('content-length') || ''), 10);
    const tooSmall = Number.isFinite(contentLength)
      && contentLength > 0
      && contentLength < 4_096
      && !['main_visual', 'recommended', 'ogp', 'cover'].includes(String(normalizedCandidate?.kind || '').toLowerCase());
    const valid = response.ok && contentType.startsWith('image/') && !tooSmall;
    response.body?.cancel?.();
    const result = {
      valid,
      url: upgradedUrl,
      reason: tooSmall ? 'too_small' : (valid ? null : 'non_image_response'),
      contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : null
    };
    cache.set(upgradedUrl, {
      checkedAt: Date.now(),
      result
    });
    if (valid) {
      client.logger.info('anime image validation succeeded', {
        url: upgradedUrl
      });
    }
    return result;
  } catch {
    const result = {
      valid: false,
      url: upgradedUrl,
      reason: 'fetch_failed'
    };
    cache.set(upgradedUrl, {
      checkedAt: Date.now(),
      result
    });
    return result;
  }
}

function parseMetaTagAttributes(rawTag) {
  const attrs = {};
  for (const match of rawTag.matchAll(/([a-zA-Z:_-]+)\s*=\s*["']([^"']*)["']/g)) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

async function fetchOfficialSiteImageCandidates(client, officialSiteUrl) {
  const normalizedUrl = normalizeHttpsUrl(officialSiteUrl);
  if (!/^https:\/\//iu.test(String(normalizedUrl || ''))) {
    return [];
  }

  const cache = ensureAnimeOfficialSiteImageStore(client);
  const cached = cache.get(normalizedUrl);
  if (cached && (Date.now() - cached.checkedAt) < IMAGE_VALIDATION_TTL_MS) {
    return cached.candidates;
  }

  try {
    const response = await fetch(normalizedUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok || !contentType.includes('text/html')) {
      cache.set(normalizedUrl, {
        checkedAt: Date.now(),
        candidates: []
      });
      return [];
    }

    const html = await response.text();
    const candidates = [];
    for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
      const attrs = parseMetaTagAttributes(match[0]);
      const property = String(attrs.property || attrs.name || '').toLowerCase();
      const content = normalizeHttpsUrl(attrs.content);
      if (!content) {
        continue;
      }
      if (property === 'og:image' || property === 'twitter:image') {
        candidates.push({
          url: new URL(content, normalizedUrl).toString(),
          kind: 'ogp',
          source: `official_site.${property}`
        });
      }
    }

    cache.set(normalizedUrl, {
      checkedAt: Date.now(),
      candidates
    });
    return candidates;
  } catch {
    cache.set(normalizedUrl, {
      checkedAt: Date.now(),
      candidates: []
    });
    return [];
  }
}

async function resolveAnimeCardImageEntry(client, entry) {
  const normalizedEntry = normalizeEntry(entry);

  // Log stored DB images filtered by imagePolicy (logo/favicon/avatar)
  const storedCoverUrl = normalizedEntry?.coverImageUrl || null;
  const storedBannerUrl = normalizedEntry?.bannerImageUrl || null;
  const imageChoice = selectAnimeImageUrls(normalizedEntry);
  if (storedCoverUrl && !imageChoice.coverImageUrl) {
    client.logger.info('anime stored image ignored logo_like', {
      animeEntryId: normalizedEntry?.id || null,
      field: 'coverImageUrl',
      storedUrl: storedCoverUrl
    });
  }
  if (storedBannerUrl && !imageChoice.bannerImageUrl) {
    client.logger.info('anime stored image ignored logo_like', {
      animeEntryId: normalizedEntry?.id || null,
      field: 'bannerImageUrl',
      storedUrl: storedBannerUrl
    });
  }

  // Annict non-logo stored candidates
  const annictCandidates = [
    imageChoice.coverImageUrl
      ? normalizeAnimeImageCandidate(imageChoice.coverImageUrl, { kind: 'cover', source: 'stored.coverImageUrl' })
      : null,
    imageChoice.bannerImageUrl
      ? normalizeAnimeImageCandidate(imageChoice.bannerImageUrl, { kind: 'banner', source: 'stored.bannerImageUrl' })
      : null
  ].filter(Boolean);

  // AniList image candidates (by MAL ID first, then by title)
  let anilistMedia = null;
  if (normalizedEntry?.malAnimeId) {
    client.logger.info('anime image anilist fallback by mal started', {
      animeEntryId: normalizedEntry?.id || null,
      malAnimeId: normalizedEntry.malAnimeId
    });
    anilistMedia = await getAnimeByMalId(client, normalizedEntry.malAnimeId).catch(() => null);
  }
  if (!anilistMedia?.coverImage?.extraLarge && !anilistMedia?.bannerImage) {
    const searchTitle = normalizedEntry?.titleNative || normalizedEntry?.titleUserPreferred || normalizedEntry?.titleRomaji || null;
    if (searchTitle) {
      client.logger.info('anime image anilist fallback by title started', {
        animeEntryId: normalizedEntry?.id || null,
        title: searchTitle
      });
      const titleMedia = await getAnimeImageByTitle(client, searchTitle).catch(() => null);
      if (titleMedia?.coverImage?.extraLarge || titleMedia?.bannerImage) {
        anilistMedia = titleMedia;
      }
    }
  }
  const anilistCandidates = anilistMedia ? [
    normalizeAnimeImageCandidate(anilistMedia.bannerImage, { kind: 'banner', source: 'anilist.bannerImage' }),
    normalizeAnimeImageCandidate(anilistMedia.coverImage?.extraLarge, { kind: 'cover', source: 'anilist.coverImage.extraLarge' }),
    normalizeAnimeImageCandidate(anilistMedia.coverImage?.large, { kind: 'cover', source: 'anilist.coverImage.large' })
  ].filter(Boolean) : [];

  // Official site OGP
  const ogpCandidates = normalizedEntry?.officialSiteUrl
    ? await fetchOfficialSiteImageCandidates(client, normalizedEntry.officialSiteUrl)
    : [];

  // Helper: returns first candidate that passes imagePolicy and HTTP validation.
  // When allowLogos is true, skips URL-pattern rejection and passes skipPatternCheck to
  // validateAnimeImageCandidate so logos can reach the HTTP fetch (last-resort for icon only).
  const trySelect = async (candidates, allowLogos = false) => {
    for (const candidate of candidates) {
      if (!allowLogos && getAnimeImageCandidateRejectionReason(candidate)) {
        continue;
      }
      const validation = await validateAnimeImageCandidate(client, candidate, { skipPatternCheck: allowLogos });
      if (validation.valid) {
        return { candidate, url: validation.url };
      }
    }
    return null;
  };

  // --- bannerImageUrl: large visual. No logos ever. ---
  // Priority: AniList banner > AniList cover > Annict > OGP
  const bannerResult = await trySelect([
    ...anilistCandidates.filter((c) => c.kind === 'banner'),
    ...anilistCandidates.filter((c) => c.kind === 'cover'),
    ...annictCandidates,
    ...ogpCandidates
  ], false);
  const resolvedBannerUrl = bannerResult?.url || null;

  if (resolvedBannerUrl) {
    client.logger.info('anime card banner image selected', {
      animeEntryId: normalizedEntry?.id || null,
      source: bannerResult.candidate.source,
      url: resolvedBannerUrl
    });
  } else {
    client.logger.info('anime card banner omitted', {
      animeEntryId: normalizedEntry?.id || null
    });
  }

  // --- iconImageUrl: small top-right thumbnail. Logos allowed as last resort. ---
  // Priority: AniList cover > AniList banner > Annict > OGP (all non-logo first)
  const iconResult = await trySelect([
    ...anilistCandidates.filter((c) => c.kind === 'cover'),
    ...anilistCandidates.filter((c) => c.kind === 'banner'),
    ...annictCandidates,
    ...ogpCandidates
  ], false);
  let resolvedIconUrl = iconResult?.url || null;

  if (!resolvedIconUrl) {
    // Last resort: allow logo/favicon images for icon only (better than nothing for small thumbnail)
    const logoFallbacks = [
      storedCoverUrl ? normalizeAnimeImageCandidate(storedCoverUrl, { kind: 'cover', source: 'stored.coverImageUrl' }) : null,
      storedBannerUrl ? normalizeAnimeImageCandidate(storedBannerUrl, { kind: 'banner', source: 'stored.bannerImageUrl' }) : null,
      ...ogpCandidates
    ].filter(Boolean);
    const logoResult = await trySelect(logoFallbacks, true);
    if (logoResult) {
      resolvedIconUrl = logoResult.url;
      client.logger.info('anime card icon logo fallback used', {
        animeEntryId: normalizedEntry?.id || null,
        source: logoResult.candidate.source,
        url: resolvedIconUrl
      });
    }
  }

  if (resolvedIconUrl) {
    client.logger.info('anime card icon image selected', {
      animeEntryId: normalizedEntry?.id || null,
      source: iconResult?.candidate?.source || 'logo_fallback',
      url: resolvedIconUrl
    });
  }

  if (!resolvedIconUrl && !resolvedBannerUrl) {
    client.logger.info('anime image no suitable main visual found', {
      animeEntryId: normalizedEntry?.id || null,
      officialSiteUrl: normalizedEntry?.officialSiteUrl || null
    });
  }

  return {
    ...normalizedEntry,
    coverImageUrl: resolvedIconUrl || null,
    bannerImageUrl: resolvedBannerUrl || null,
    resolvedIconUrl: resolvedIconUrl || null,
    resolvedBannerUrl: resolvedBannerUrl || null
  };
}

function summarizeAnimePayload(payload) {
  return {
    flags: payload?.flags || null,
    componentCount: Array.isArray(payload?.components) ? payload.components.length : 0,
    componentTypes: Array.isArray(payload?.components)
      ? payload.components.map((component) => component?.constructor?.name || typeof component)
      : []
  };
}

function validateAnimePayload(payload, logger, context = {}) {
  try {
    for (const component of Array.isArray(payload?.components) ? payload.components : []) {
      component?.toJSON?.();
    }
    return payload;
  } catch (error) {
    logger.error('anime component payload validation failed', {
      ...context,
      errorName: error?.name || null,
      errorMessage: error?.message || null,
      errorStack: error?.stack || null,
      payloadSummary: summarizeAnimePayload(payload)
    });
    throw error;
  }
}

async function searchAnime(client, title) {
  const queryInfo = normalizeAnimeSearchQuery(title);
  const searchTitle = queryInfo.canonicalQuery || title;
  const expandedQueries = buildAnimeSearchQueries(title, queryInfo);
  const provider = getConfiguredProvider(client);
  if (provider === 'annict') {
    client.logger.info('anime search query expansion', {
      original: title,
      canonicalQuery: searchTitle,
      aliasMatched: queryInfo.aliasMatched || null,
      aliasKind: queryInfo.aliasKind,
      queries: expandedQueries
    });
    const searchResults = [];
    let successfulSearchCount = 0;
    const searchErrors = [];
    for (const query of expandedQueries) {
      client.logger.info('anime search query attempted', {
        original: title,
        query
      });
      let results = [];
      try {
        results = await searchWorks(client, query, { perPage: 20 });
        successfulSearchCount += 1;
      } catch (error) {
        client.logger.warn('anime search query failed', {
          original: title,
          query,
          error: error.message
        });
        searchErrors.push(error);
      }
      client.logger.info('anime search query result count', {
        original: title,
        query,
        count: results.length
      });
      searchResults.push(...results);
    }
    if (successfulSearchCount === 0 && searchErrors.length) {
      throw searchErrors[0];
    }
    const merged = mergeProviderResults(searchResults);
    client.logger.info('anime search merged result count', {
      original: title,
      canonicalQuery: searchTitle,
      count: merged.length
    });
    const ranked = rankResolvedWorks(title, merged, { queryInfo });
    for (const result of ranked.slice(0, 5)) {
      client.logger.info('anime fuzzy score computed', {
        original: title,
        candidateTitle: result.entry?.titleNative || result.entry?.titleUserPreferred || result.entry?.titleEnglish || null,
        providerMediaId: result.entry?.providerMediaId || null,
        score: result.score,
        matchedAliasCanonical: result.matchedAliasCanonical || false,
        matchedNormalizedSubstring: result.matchedNormalizedSubstring || false
      });
      if (result.matchedAliasCanonical) {
        client.logger.info('anime candidate matched alias canonical', {
          original: title,
          candidateTitle: result.entry?.titleNative || result.entry?.titleUserPreferred || result.entry?.titleEnglish || null,
          providerMediaId: result.entry?.providerMediaId || null
        });
      }
      if (result.matchedNormalizedSubstring) {
        client.logger.info('anime candidate matched normalized substring', {
          original: title,
          candidateTitle: result.entry?.titleNative || result.entry?.titleUserPreferred || result.entry?.titleEnglish || null,
          providerMediaId: result.entry?.providerMediaId || null
        });
      }
    }
    return ranked.map((row) => row.entry).slice(0, 10);
  }
  return searchAnimeByTitle(client, searchTitle, 10);
}

function mergeProviderResults(results = []) {
  const byKey = new Map();
  for (const item of results) {
    if (!item?.providerMediaId) {
      continue;
    }
    byKey.set(`${item.provider}:${item.providerMediaId}`, item);
  }
  return Array.from(byKey.values());
}

async function resolveAnimeFromTitle(client, title, guildId = null) {
  const queryInfo = normalizeAnimeSearchQuery(title);
  const searchTitle = queryInfo.canonicalQuery || title;
  const localMatches = guildId ? client.db.anime.searchEntries(guildId, searchTitle, 10).map(normalizeEntry) : [];
  const remoteMatches = await searchAnime(client, title);
  const merged = mergeProviderResults([
    ...localMatches.map((entry) => ({
      ...entry,
      aliases: mergeAliases(entry.aliases, extractSearchAliases(entry))
    })),
    ...remoteMatches
  ]);
  const ranked = rankResolvedWorks(title, merged, { queryInfo });
  return {
    queryInfo,
    media: ranked[0]?.entry || merged[0] || null,
    candidates: ranked.length ? ranked.map((row) => row.entry) : merged,
    rankedRows: ranked
  };
}

async function getAnimeById(client, providerMediaId, castLimit = 10, provider = null) {
  const resolvedProvider = String(provider || getConfiguredProvider(client) || 'annict');
  if (resolvedProvider === 'annict') {
    const work = await getWorkById(client, providerMediaId);
    if (!work) {
      return null;
    }
    const cast = await getCastsByWorkId(client, providerMediaId).catch(() => []);
    return {
      ...work,
      cast: Array.isArray(cast) ? cast.slice(0, castLimit) : []
    };
  }
  return getAniListAnimeById(client, providerMediaId, castLimit);
}

async function getAnimeCastById(client, providerMediaId, limit = 10, provider = null) {
  const resolvedProvider = String(provider || getConfiguredProvider(client) || 'annict');
  if (resolvedProvider === 'annict') {
    const cast = await getCastsByWorkId(client, providerMediaId).catch(() => []);
    return Array.isArray(cast) ? cast.slice(0, limit) : [];
  }
  return getAniListAnimeCastById(client, providerMediaId, limit);
}

async function getCurrentSeasonAnime(client, limit = 15) {
  if (getConfiguredProvider(client) === 'annict') {
    return getCurrentSeasonWorks(client, limit);
  }
  return getAniListCurrentSeasonAnime(client, limit);
}

async function getNextSeasonAnime(client, limit = 15) {
  if (getConfiguredProvider(client) === 'annict') {
    return getNextSeasonWorks(client, limit);
  }
  return getAniListNextSeasonAnime(client, limit);
}

function syncConfiguredReviewRoles(client, guildId) {
  const roles = Array.isArray(client.appConfig.anime.reviewRoles) ? client.appConfig.anime.reviewRoles : [];
  for (const role of roles) {
    client.db.anime.upsertReviewRole({
      guildId,
      threshold: Number(role.threshold),
      roleId: role.roleId ? String(role.roleId) : null
    });
  }
}

async function ensureAnimeEntryFromAnilistMedia(guild, media, createdByUserId, additionalAliases = []) {
  const client = guild.client;
  const provider = String(media.provider || getConfiguredProvider(client));
  const existing = normalizeEntry(
    client.db.anime.getEntryByProviderMediaId(guild.id, provider, String(media.providerMediaId || media.id))
  );
  const record = buildEntryRecord(media, {
    guildId: guild.id,
    provider,
    animeChannelId: existing?.animeChannelId || getAnimeChannelId(client),
    animeChannelMessageId: existing?.animeChannelMessageId || null,
    threadId: existing?.threadId || null,
    threadCardMessageId: existing?.threadCardMessageId || null,
    reviewCardMessageId: existing?.reviewCardMessageId || existing?.threadCardMessageId || null,
    hasSpoilerReviews: existing?.hasSpoilerReviews || false,
    createdByUserId: existing?.createdByUserId || createdByUserId,
    createdAt: existing?.createdAt || new Date().toISOString(),
    additionalAliases
  });
  if (fallbackImageCandidateUsed(record, media)) {
    const fallbackImageUrl = buildMediaImageCandidates({
      imageCandidates: media.imageCandidates
    })[0]?.url || null;
    client.logger.info('anime image source message fallback used', {
      guildId: guild.id,
      providerMediaId: String(media.providerMediaId || media.id),
      fallbackImageUrl
    });
  }
  client.db.anime.upsertEntry(record);
  const entry = normalizeEntry(
    client.db.anime.getEntryByProviderMediaId(guild.id, provider, String(media.providerMediaId || media.id))
  );

  if (Array.isArray(media.cast) && media.cast.length) {
    client.db.anime.replaceCastCache(entry.id, media.cast);
  }

  client.logger.info(existing ? 'anime entry already exists' : 'anime entry created', {
    guildId: guild.id,
    animeEntryId: entry.id,
    providerMediaId: entry.providerMediaId,
    title: buildTitle(entry)
  });
  return entry;
}

function fallbackImageCandidateUsed(record, media) {
  const fallbackImageCandidate = buildMediaImageCandidates({
    imageCandidates: media.imageCandidates
  })[0]?.url || null;
  return Boolean(
    fallbackImageCandidate
    && (String(record?.coverImageUrl || '') === String(fallbackImageCandidate)
      || String(record?.bannerImageUrl || '') === String(fallbackImageCandidate))
  );
}

async function getAnimeStats(client, entry) {
  const normalizedEntry = normalizeEntry(entry);
  const { parentUrl, threadUrl } = buildAnimeLinks(normalizedEntry);
  return {
    interestedCount: client.db.anime.countInterested(normalizedEntry.guildId, normalizedEntry.id),
    watchedCount: client.db.anime.countWatched(normalizedEntry.guildId, normalizedEntry.id),
    reviewCount: client.db.anime.countReviews(normalizedEntry.guildId, normalizedEntry.id),
    spoilerReviewCount: client.db.anime.countSpoilerReviews(normalizedEntry.guildId, normalizedEntry.id),
    hasSpoilerReviews: client.db.anime.countSpoilerReviews(normalizedEntry.guildId, normalizedEntry.id) > 0,
    parentUrl,
    threadUrl,
    reviewCardMessageId: normalizedEntry.reviewCardMessageId || normalizedEntry.threadCardMessageId || null,
    maxCastInCard: client.appConfig.anime.maxCastInCard,
    maxReviewsInCard: client.appConfig.anime.maxReviewsInCard
  };
}

async function updateAnimeChannelCard(client, entry) {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry?.animeChannelId || !normalizedEntry?.animeChannelMessageId) {
    return null;
  }

  const channel = await safeFetchChannel(client, normalizedEntry.animeChannelId);
  const message = await safeFetchMessage(channel, normalizedEntry.animeChannelMessageId);
  if (!message) {
    client.logger.warn('anime card update failed', {
      animeEntryId: normalizedEntry.id,
      reason: 'anime_channel_message_missing'
    });
    return null;
  }

  const stats = await getAnimeStats(client, normalizedEntry);
  const cast = client.db.anime.listCast(normalizedEntry.id).slice(0, client.appConfig.anime.maxCastInCard);
  const latestReviews = await getLatestReviewPreviews(client, normalizedEntry, client.appConfig.anime.maxReviewsInCard);
  const imageReadyEntry = await resolveAnimeCardImageEntry(client, normalizedEntry);
  const payload = validateAnimePayload(
    buildAnimeChannelCard(imageReadyEntry, stats, cast, latestReviews),
    client.logger,
    {
      animeEntryId: normalizedEntry.id,
      stage: 'updateAnimeChannelCard'
    }
  );
  await message.edit(payload);
  client.logger.info('anime parent card updated', {
    animeEntryId: normalizedEntry.id,
    animeChannelMessageId: normalizedEntry.animeChannelMessageId,
    threadId: normalizedEntry.threadId || null
  });
  return message;
}

async function getLatestReviewPreviews(client, entry, limit = 5) {
  const reviews = client.db.anime.listReviews(entry.guildId, entry.id, limit);
  const guild = client.guilds.cache.get(entry.guildId) || await client.guilds.fetch(entry.guildId).catch(() => null);
  const previews = [];

  for (const review of reviews.slice(0, limit)) {
    let displayName = review.userId;
    const member = guild ? await guild.members.fetch(review.userId).catch(() => null) : null;
    if (member) {
      displayName = member.displayName || member.user?.globalName || member.user?.username || review.userId;
    }
    previews.push(buildReviewPreview(review, displayName));
  }

  return previews.filter(Boolean);
}

async function updateAnimeThreadHeader(client, entry) {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry?.threadId) {
    return null;
  }
  if (normalizedEntry.threadCardMessageId) {
    client.logger.info('anime legacy thread_card_message_id ignored', {
      animeEntryId: normalizedEntry.id,
      threadId: normalizedEntry.threadId,
      threadCardMessageId: normalizedEntry.threadCardMessageId
    });
  }
  client.logger.info('anime thread header skipped because parent card is thread starter', {
    animeEntryId: normalizedEntry.id,
    threadId: normalizedEntry.threadId,
    animeChannelMessageId: normalizedEntry.animeChannelMessageId || null
  });
  return null;
}

async function createAnimeThread(parentMessage, entry) {
  const threadName = buildTitle(entry).slice(0, 90);
  const thread = await parentMessage.startThread({
    name: threadName,
    autoArchiveDuration: 10080,
    reason: `Anime thread created for ${buildTitle(entry)}`
  });
  parentMessage.client.db.anime.updateBindings(entry.id, {
    threadId: thread.id
  });
  parentMessage.client.logger.info('anime thread created', {
    animeEntryId: entry.id,
    threadId: thread.id,
    parentMessageId: parentMessage.id
  });
  return thread;
}

async function createOrUpdateThreadHeader(client, entry) {
  const normalizedEntry = normalizeEntry(entry);
  if (normalizedEntry?.threadCardMessageId) {
    client.logger.info('anime legacy thread_card_message_id ignored', {
      animeEntryId: normalizedEntry.id,
      threadId: normalizedEntry.threadId,
      threadCardMessageId: normalizedEntry.threadCardMessageId
    });
  }
  client.logger.info('anime thread header skipped because parent card is thread starter', {
    animeEntryId: normalizedEntry?.id || null,
    threadId: normalizedEntry?.threadId || null,
    animeChannelMessageId: normalizedEntry?.animeChannelMessageId || null
  });
  return null;
}

async function findExistingReviewCardMessage(thread, client) {
  const recent = await thread.messages.fetch({ limit: 20 }).catch(() => null);
  if (!recent?.size) {
    return null;
  }

  for (const message of recent.values()) {
    if (message.author?.id !== client.user?.id) {
      continue;
    }
    const firstText = Array.isArray(message.components)
      ? message.components.flatMap((component) => component.components || []).find((component) => component?.type === 10)?.content || ''
      : '';
    if (/感想エリア|感想は `\/anime review`/u.test(String(firstText || ''))) {
      return message;
    }
  }

  return null;
}

async function updateAnimeReviewCard(client, entry) {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry?.threadId) {
    return null;
  }

  const thread = await safeFetchChannel(client, normalizedEntry.threadId);
  if (!thread?.isTextBased?.()) {
    client.logger.warn('anime review UI update skipped', {
      animeEntryId: normalizedEntry.id,
      reason: 'thread_missing'
    });
    return null;
  }

  const stats = await getAnimeStats(client, normalizedEntry);
  const latestReviews = await getLatestReviewPreviews(client, normalizedEntry, client.appConfig.anime.maxReviewsInCard);
  const payload = buildAnimeReviewUiCard(normalizedEntry, stats, latestReviews);
  const savedId = normalizedEntry.reviewCardMessageId || normalizedEntry.threadCardMessageId || null;
  let reviewMessage = savedId ? await safeFetchMessage(thread, savedId) : null;

  if (!reviewMessage) {
    reviewMessage = await findExistingReviewCardMessage(thread, client);
    if (reviewMessage) {
      client.db.anime.updateBindings(normalizedEntry.id, {
        reviewCardMessageId: reviewMessage.id
      });
    }
  }

  if (reviewMessage) {
    await reviewMessage.edit(payload);
    client.logger.info('anime review UI card edited', {
      animeEntryId: normalizedEntry.id,
      threadId: normalizedEntry.threadId,
      reviewCardMessageId: reviewMessage.id
    });
    return reviewMessage;
  }

  reviewMessage = await thread.send(payload);
  client.db.anime.updateBindings(normalizedEntry.id, {
    reviewCardMessageId: reviewMessage.id
  });
  client.logger.info('anime review UI card created', {
    animeEntryId: normalizedEntry.id,
    threadId: normalizedEntry.threadId,
    reviewCardMessageId: reviewMessage.id
  });
  return reviewMessage;
}

async function postAnimeToChannel(guild, media, createdByUserId, additionalAliases = []) {
  const client = guild.client;
  client.logger.info('anime post started', {
    guildId: guild.id,
    provider: media.provider || getConfiguredProvider(client),
    providerMediaId: media.providerMediaId || media.id,
    title: buildTitle(media)
  });
  const entry = await ensureAnimeEntryFromAnilistMedia(guild, media, createdByUserId, additionalAliases);
  if (entry.animeChannelMessageId) {
    if (entry.threadId) {
      await updateAnimeReviewCard(client, entry).catch(() => null);
      await updateAnimeChannelCard(client, entry).catch(() => null);
    }
    return {
      entry,
      created: false,
      links: buildAnimeLinks(entry)
    };
  }

  const animeChannelId = getAnimeChannelId(client);
  const channel = await safeFetchChannel(client, animeChannelId);
  if (!channel?.isTextBased?.()) {
    throw new Error('anime_channel_unavailable');
  }

  const stats = await getAnimeStats(client, entry);
  let sentMessage = null;
  let thread = null;
  try {
    const imageReadyEntry = await resolveAnimeCardImageEntry(client, entry);
    client.logger.info('anime parent card send started', {
      animeEntryId: entry.id,
      channelId: animeChannelId
    });
    try {
      const payload = validateAnimePayload(
        buildAnimeChannelCard(imageReadyEntry, stats),
        client.logger,
        {
          animeEntryId: entry.id,
          stage: 'postAnimeToChannel:parentCardSend'
        }
      );
      sentMessage = await channel.send(payload);
    } catch (error) {
      client.logger.error('anime parent card send failed', {
        animeEntryId: entry.id,
        channelId: animeChannelId,
        errorName: error?.name || null,
        errorMessage: error?.message || null,
        errorStack: error?.stack || null,
        errorErrors: error?.errors || null,
        errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error || {}))
      });
      throw error;
    }
    client.db.anime.updateBindings(entry.id, {
      animeChannelId,
      animeChannelMessageId: sentMessage.id
    });
    const statusReactionEmojis = getAnimeStatusReactionEmojis(client);
    await sentMessage.react(statusReactionEmojis.interested).catch(() => null);
    await sentMessage.react(statusReactionEmojis.watched).catch(() => null);
    client.logger.info('anime channel card sent', {
      animeEntryId: entry.id,
      messageId: sentMessage.id,
      channelId: animeChannelId
    });

    const refreshedEntry = normalizeEntry(client.db.anime.getEntryById(entry.id));
    client.logger.info('anime thread create started', {
      animeEntryId: entry.id,
      animeChannelMessageId: sentMessage.id
    });
    try {
      thread = await createAnimeThread(sentMessage, refreshedEntry);
    } catch (error) {
      client.logger.error('anime thread create failed', {
        animeEntryId: entry.id,
        animeChannelMessageId: sentMessage.id,
        errorName: error?.name || null,
        errorMessage: error?.message || null,
        errorStack: error?.stack || null,
        errorErrors: error?.errors || null,
        errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error || {}))
      });
      throw error;
    }
    client.logger.info('anime thread created without extra header', {
      animeEntryId: entry.id,
      animeChannelMessageId: sentMessage.id,
      threadId: thread.id
    });
    await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id)));
    await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id)));

    client.logger.info('anime registration completed', {
      animeEntryId: entry.id,
      animeChannelMessageId: sentMessage.id,
      threadId: thread.id
    });
    return {
      entry: normalizeEntry(client.db.anime.getEntryById(entry.id)),
      created: true,
      thread,
      links: buildAnimeLinks(normalizeEntry(client.db.anime.getEntryById(entry.id)))
    };
  } catch (error) {
    client.logger.error('anime registration failed', {
      animeEntryId: entry.id,
      providerMediaId: entry.providerMediaId,
      errorName: error?.name || null,
      errorMessage: error?.message || null,
      errorStack: error?.stack || null,
      errorErrors: error?.errors || null,
      errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error || {}))
    });
    if (thread) {
      try {
        await thread.delete('anime_registration_failed');
      } catch {
        try {
          if (typeof thread.setArchived === 'function') {
            await thread.setArchived(true, 'anime_registration_failed');
          }
          if (typeof thread.setLocked === 'function') {
            await thread.setLocked(true, 'anime_registration_failed');
          }
        } catch {}
      }
    }
    if (sentMessage) {
      await sentMessage.delete().catch(() => null);
    }
    client.db.anime.deleteEntryCascade(entry.id);
    client.logger.warn('anime registration cleanup after failure', {
      animeEntryId: entry.id,
      providerMediaId: entry.providerMediaId
    });
    throw error;
  }
}

function getAnimeByThreadId(guildId, threadId, client) {
  return normalizeEntry(client.db.anime.getEntryByThreadId(guildId, threadId));
}

function getAnimeByMessageId(guildId, messageId, client) {
  return normalizeEntry(client.db.anime.getEntryByChannelMessageId(guildId, messageId));
}

async function addAnimeUserReactionStatus(client, guildId, animeEntryId, userId, type, enabled = true) {
  const current = client.db.anime.getUserStatus(guildId, animeEntryId, userId) || null;
  const now = new Date().toISOString();
  const next = {
    guildId,
    animeEntryId,
    userId,
    interested: current?.interested ? 1 : 0,
    watched: current?.watched ? 1 : 0,
    interestedAt: current?.interestedAt || null,
    watchedAt: current?.watchedAt || null
  };

  if (type === 'interested') {
    next.interested = enabled ? 1 : 0;
    next.interestedAt = enabled ? now : null;
  }
  if (type === 'watched') {
    next.watched = enabled ? 1 : 0;
    next.watchedAt = enabled ? now : null;
  }

  client.db.anime.upsertUserStatus(next);
  return next;
}

function calculateAnimeStatusAfterReactionRemoval(current, removedType) {
  const next = {
    interested: current?.interested ? 1 : 0,
    watched: current?.watched ? 1 : 0,
    interestedAt: current?.interestedAt || null,
    watchedAt: current?.watchedAt || null
  };
  if (removedType === 'interested') {
    next.interested = 0;
    next.interestedAt = null;
  } else if (removedType === 'watched') {
    next.watched = 0;
    next.watchedAt = null;
  }
  const targetKind = next.watched ? 'watched' : (next.interested ? 'wanna_watch' : 'no_status');
  return { next, targetKind };
}

function persistCalculatedAnimeStatus(client, guildId, animeEntryId, userId, next) {
  client.db.anime.upsertUserStatus({
    guildId,
    animeEntryId,
    userId,
    interested: next.interested ? 1 : 0,
    watched: next.watched ? 1 : 0,
    interestedAt: next.interestedAt || null,
    watchedAt: next.watchedAt || null
  });
}

async function updateReviewRoles(member) {
  const client = member.client;
  syncConfiguredReviewRoles(client, member.guild.id);
  const reviewedCount = client.db.anime.countReviewedByUser(member.guild.id, member.id);
  const thresholds = Array.isArray(client.appConfig.anime.reviewRoles)
    ? client.appConfig.anime.reviewRoles
        .map((entry) => ({
          threshold: Number(entry.threshold),
          roleId: entry.roleId ? String(entry.roleId) : null,
          name: entry.name ? String(entry.name) : null
        }))
        .filter((entry) => entry.threshold > 0 && entry.roleId)
        .sort((left, right) => left.threshold - right.threshold)
    : [];
  const granted = [];
  const newlyAwarded = [];

  for (const threshold of thresholds) {
    const existingAward = client.db.anime.getRoleAward(member.guild.id, member.id, threshold.threshold);
    if (reviewedCount < threshold.threshold) {
      continue;
    }
    const role = member.guild.roles.cache.get(threshold.roleId) || await member.guild.roles.fetch(threshold.roleId).catch(() => null);
    if (!role) {
      continue;
    }
    if (member.roles.cache.has(role.id)) {
      if (!existingAward) {
        client.db.anime.upsertRoleAward({
          guildId: member.guild.id,
          userId: member.id,
          threshold: threshold.threshold,
          roleId: role.id,
          awardedAt: new Date().toISOString(),
          dmSentAt: new Date().toISOString()
        });
      }
      continue;
    }
    try {
      await member.roles.add(role);
      granted.push(role.id);
      if (!existingAward) {
        client.db.anime.upsertRoleAward({
          guildId: member.guild.id,
          userId: member.id,
          threshold: threshold.threshold,
          roleId: role.id
        });
        newlyAwarded.push({
          ...threshold,
          roleId: role.id
        });
      }
      client.logger.info('anime review role granted', {
        guildId: member.guild.id,
        userId: member.id,
        roleId: role.id,
        threshold: threshold.threshold
      });
    } catch (error) {
      client.logger.warn('anime review role grant failed', {
        guildId: member.guild.id,
        userId: member.id,
        roleId: threshold.roleId,
        threshold: threshold.threshold,
        error: error.message
      });
    }
  }

  const highestNewAward = newlyAwarded.length ? newlyAwarded[newlyAwarded.length - 1] : null;
  if (highestNewAward) {
    await sendAnimeRoleCongratulations(member, highestNewAward, { reviewedCount });
  }

  return {
    reviewedCount,
    grantedRoleIds: granted
  };
}

async function sendAnimeRoleCongratulations(member, role, { reviewedCount = role.threshold } = {}) {
  const client = member.client;
  const dm = buildAnimeRoleAwardDm({
    threshold: role.threshold,
    roleName: role.name || role.roleId,
    reviewedCount,
    userDisplayName: member.displayName || member.user?.globalName || member.user?.username || member.id,
    userId: member.id,
    logger: client.logger
  });

  client.logger.info('anime role award DM quote selected', {
    guildId: member.guild.id,
    userId: member.id,
    threshold: role.threshold,
    roleId: role.roleId || null,
    quoteId: dm.quote?.id || null,
    fallback: dm.usedFallback === true
  });

  try {
    const message = await member.send({
      content: dm.content,
      allowedMentions: { parse: [] }
    });
    client.db.anime.setRoleAwardDmSentAt(member.guild.id, member.id, role.threshold, new Date().toISOString());
    client.logger.info('anime role award DM sent', {
      guildId: member.guild.id,
      userId: member.id,
      threshold: role.threshold,
      roleId: role.roleId || null,
      quoteId: dm.quote?.id || null,
      dmMessageId: message.id
    });
    return true;
  } catch (error) {
    client.logger.warn('anime role award DM failed', {
      guildId: member.guild.id,
      userId: member.id,
      threshold: role.threshold,
      roleId: role.roleId || null,
      quoteId: dm.quote?.id || null,
      error: error.message
    });
    return false;
  }
}

async function saveAnimeReview(client, guildId, animeEntryId, userId, text, spoiler, sourceMessageId, sourceChannelId = null) {
  client.db.anime.upsertReview({
    guildId,
    animeEntryId,
    userId,
    reviewText: String(text || '').trim(),
    spoiler: Boolean(spoiler),
    sourceChannelId: sourceChannelId || null,
    sourceMessageId: sourceMessageId || null
  });

  const spoilerCount = client.db.anime.countSpoilerReviews(guildId, animeEntryId);
  client.db.anime.updateSpoilerFlag(animeEntryId, spoilerCount > 0);
  const entry = normalizeEntry(client.db.anime.getEntryById(animeEntryId));
  await updateAnimeChannelCard(client, entry).catch((error) => {
    client.logger.warn('anime card update failed', {
      animeEntryId,
      error: error.message
    });
  });
  await updateAnimeReviewCard(client, entry).catch((error) => {
    client.logger.warn('anime review UI card update failed', {
      animeEntryId,
      error: error.message
    });
  });

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  const roleResult = member ? await updateReviewRoles(member) : {
    reviewedCount: client.db.anime.countReviewedByUser(guildId, userId),
    grantedRoleIds: []
  };

  client.logger.info('anime review saved', {
    guildId,
    animeEntryId,
    userId,
    spoiler: Boolean(spoiler),
    reviewedCount: roleResult.reviewedCount
  });

  return roleResult;
}

function buildAnimeReviewSavedLines(result) {
  return [
    '感想を保存しました。',
    `感想投稿済み作品数: ${result.reviewedCount}`,
    result.grantedRoleIds.length ? `新規付与ロール数: ${result.grantedRoleIds.length}` : null
  ].filter(Boolean);
}

function buildWatchedPromptContent(userId) {
  return [
    `<@${userId}> さんが「視聴済み」にしました。`,
    '感想があれば、このスレッドで `/anime review` を使って投稿できます。',
    'もしくは、このメッセージに返信してもらえれば、その内容を感想として記録できます。',
    '感想を投稿すると、視聴作品がカウントされ、数に応じて記念のロールが付与されます。'
  ].join('\n');
}

function parseAnimeReplyReview(message) {
  const raw = String(message?.content || '').trim();
  if (!raw) {
    return {
      text: '',
      spoiler: false
    };
  }

  const spoilerMatch = raw.match(/^(?:\[spoiler\]|\[ネタバレ\]|spoiler[:：]|ネタバレ[:：])\s*/iu);
  if (!spoilerMatch) {
    return {
      text: raw,
      spoiler: false
    };
  }

  return {
    text: raw.slice(spoilerMatch[0].length).trim(),
    spoiler: true
  };
}

async function sendAnimeReplyReviewNotice(message, ownerUserId, lines, purpose) {
  const replyMessage = await message.reply({
    content: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || ''),
    allowedMentions: { repliedUser: false, parse: [] }
  }).catch(() => null);
  if (replyMessage) {
    await registerDeletableMessage(replyMessage, ownerUserId, purpose).catch(() => null);
  }
  return replyMessage;
}

async function handleAnimeWatchedPromptReply(message) {
  if (!message?.inGuild?.() || message.author?.bot) {
    return false;
  }

  const referencedMessageId = message.reference?.messageId;
  if (!referencedMessageId) {
    return false;
  }

  const promptState = message.client.db.anime.getReviewPromptStateByMessageId(
    message.guildId,
    referencedMessageId,
    REVIEW_PROMPT_TYPES.WATCHED
  );
  if (!promptState) {
    return false;
  }

  const client = message.client;
  client.logger.info('anime watched prompt reply detected', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    referencedMessageId,
    animeEntryId: promptState.animeEntryId,
    targetUserId: promptState.userId
  });
  client.logger.info('anime watched prompt reply suppressed llm', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    referencedMessageId
  });

  if (String(promptState.userId) !== String(message.author.id)) {
    client.logger.info('anime watched prompt reply ignored wrong user', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      referencedMessageId,
      targetUserId: promptState.userId,
      replyingUserId: message.author.id
    });
    await sendAnimeReplyReviewNotice(
      message,
      message.author.id,
      'この感想入力は「視聴済み」にした本人用です。自分の感想は `/anime review` から投稿してください。',
      'anime_watched_prompt_wrong_user'
    );
    return true;
  }

  const parsedReview = parseAnimeReplyReview(message);
  if (!parsedReview.text) {
    await sendAnimeReplyReviewNotice(
      message,
      message.author.id,
      '感想本文が空です。感想を書いて、このメッセージに返信してください。',
      'anime_watched_prompt_empty_review'
    );
    return true;
  }

  const result = await saveAnimeReview(
    client,
    message.guildId,
    promptState.animeEntryId,
    message.author.id,
    parsedReview.text,
    parsedReview.spoiler,
    message.id,
    message.channelId
  );
  client.logger.info('anime watched prompt reply saved as review', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    referencedMessageId,
    animeEntryId: promptState.animeEntryId,
    userId: message.author.id,
    spoiler: parsedReview.spoiler
  });

  await sendAnimeReplyReviewNotice(
    message,
    message.author.id,
    buildAnimeReviewSavedLines(result),
    'anime_review_saved_reply_confirmation'
  );

  client.db.anime.deleteReviewPromptStateByMessageId(message.guildId, referencedMessageId);
  try {
    const referencedMessage = await message.channel.messages.fetch(referencedMessageId).catch(() => null);
    if (referencedMessage) {
      await referencedMessage.delete().catch((error) => {
        throw error;
      });
      client.logger.info('anime watched prompt deleted after review', {
        promptMessageId: referencedMessageId,
        animeEntryId: promptState.animeEntryId,
        userId: message.author.id
      });
    }
  } catch (error) {
    client.logger.warn('anime watched prompt delete failed', {
      promptMessageId: referencedMessageId,
      animeEntryId: promptState.animeEntryId,
      userId: message.author.id,
      error: error.message
    });
  }

  return true;
}

async function handleAnimeReactionAdd(reaction, user) {
  if (user?.bot) {
    return;
  }
  const message = reaction.message.partial ? await reaction.message.fetch().catch(() => reaction.message) : reaction.message;
  if (!message?.guildId) {
    return;
  }

  const client = message.client;
  const entry = getAnimeByMessageId(message.guildId, message.id, client);
  if (!entry) {
    return;
  }

  const interestedMatch = matchesConfiguredEmoji(reaction.emoji, client.appConfig.anime.interestEmoji);
  const watchedMatch = matchesConfiguredEmoji(reaction.emoji, client.appConfig.anime.watchedEmoji);
  if (!interestedMatch && !watchedMatch) {
    return;
  }

  const action = interestedMatch ? 'interested' : 'watched';
  const connection = client.db.annictUserIntegration.getConnection(message.guildId, user.id);
  if (!connection || connection.tokenStatus !== 'active') {
    await addAnimeUserReactionStatus(client, message.guildId, entry.id, user.id, action, true);
    await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
    await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
    const notConnectedError = new Error('Annict connection missing');
    notConnectedError.code = 'not_connected';
    await maybeNotifyAnnictReactionFailure(client, user, notConnectedError);
    client.logger.info('anime reaction stored locally without annict connection', {
      guildId: message.guildId,
      animeEntryId: entry.id,
      userId: user.id,
      reactionType: action
    });
  } else {
    try {
      const { updateAnnictStatusForAnimeEntry } = require('../annictUserIntegration');
      await updateAnnictStatusForAnimeEntry(client, {
        guildId: message.guildId,
        userId: user.id,
        entry,
        action,
        idempotencyKey: `reaction:${message.id}:${user.id}:${action}`,
        source: 'discord_reaction',
        updateLocal: true
      });
      await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
      await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
      client.logger.info('anime reaction annict status updated', {
        guildId: message.guildId,
        animeEntryId: entry.id,
        userId: user.id,
        reactionType: action
      });
    } catch (error) {
      await maybeNotifyAnnictReactionFailure(client, user, error);
      await reaction.users?.remove?.(user.id).catch(() => null);
      client.logger.warn('anime reaction annict status update failed', {
        guildId: message.guildId,
        animeEntryId: entry.id,
        userId: user.id,
        reactionType: action,
        annictWorkId: String(entry.provider || '') === 'annict' ? entry.providerMediaId || null : null,
        errorCode: error.code || null,
        error: error.message
      });
      return;
    }
  }

  if (watchedMatch) {
    const promptState = client.db.anime.getReviewPromptState(message.guildId, entry.id, user.id, REVIEW_PROMPT_TYPES.WATCHED);
    if (entry.threadId) {
      const thread = await safeFetchChannel(client, entry.threadId);
      const existingPromptMessage = promptState?.promptMessageId
        ? await safeFetchMessage(thread, promptState.promptMessageId)
        : null;
      if (!existingPromptMessage && promptState?.promptMessageId) {
        client.db.anime.deleteReviewPromptStateByMessageId(message.guildId, promptState.promptMessageId);
      }
      if (!existingPromptMessage && thread?.isTextBased?.()) {
        const promptMessage = await thread.send({
          content: buildWatchedPromptContent(user.id),
          allowedMentions: { parse: [], users: [user.id] }
        }).catch(() => null);
        if (promptMessage) {
          await registerDeletableMessage(promptMessage, user.id, 'anime_watched_prompt', WATCHED_PROMPT_TTL_MS).catch(() => null);
          client.db.anime.upsertReviewPromptState({
            guildId: message.guildId,
            animeEntryId: entry.id,
            userId: user.id,
            promptType: REVIEW_PROMPT_TYPES.WATCHED,
            promptMessageId: promptMessage.id,
            threadId: entry.threadId
          });
        }
      }
    }
  }

}

async function maybeNotifyAnnictReactionFailure(client, user, error) {
  if (!user?.id) {
    return;
  }
  const cooldowns = client.annictReactionNoticeCooldowns || new Map();
  client.annictReactionNoticeCooldowns = cooldowns;
  const reason = error?.code === 'not_connected' ? 'not_connected' : 'failed';
  const key = `${user.id}:${reason}`;
  const lastSentAt = Number(cooldowns.get(key) || 0);
  if (Date.now() - lastSentAt < ANNICT_REACTION_NOTICE_COOLDOWN_MS) {
    return;
  }
  cooldowns.set(key, Date.now());
  const content = reason === 'not_connected'
    ? 'アニメカードのリアクションをAnnictへ反映するには `/annict connect` で連携してください。'
    : 'アニメカードのリアクションをAnnictへ反映できませんでした。時間をおいてもう一度お試しください。';
  await user.send({ content, allowedMentions: { parse: [] } }).catch((dmError) => {
    client.logger.warn('anime reaction annict private notice failed', {
      userId: user.id,
      reason,
      error: dmError.message
    });
  });
}

async function restoreRemovedReactionBestEffort(reaction, userId) {
  // Discord does not normally allow a bot to recreate another user's reaction.
  // Keep an injectable path for compatible adapters while treating failure as non-fatal.
  if (typeof reaction?.users?.add !== 'function') {
    return false;
  }
  try {
    await reaction.users.add(userId);
    return true;
  } catch {
    return false;
  }
}

async function handleAnimeReactionRemove(reaction, user) {
  if (user?.bot) {
    return;
  }
  const message = reaction.message.partial ? await reaction.message.fetch().catch(() => reaction.message) : reaction.message;
  if (!message?.guildId) {
    return;
  }

  const client = message.client;
  const entry = getAnimeByMessageId(message.guildId, message.id, client);
  if (!entry) {
    return;
  }

  const interestedMatch = matchesConfiguredEmoji(reaction.emoji, client.appConfig.anime.interestEmoji);
  const watchedMatch = matchesConfiguredEmoji(reaction.emoji, client.appConfig.anime.watchedEmoji);
  if (!interestedMatch && !watchedMatch) {
    return;
  }

  const removedType = interestedMatch ? 'interested' : 'watched';
  const current = client.db.anime.getUserStatus(message.guildId, entry.id, user.id) || null;
  const { next, targetKind } = calculateAnimeStatusAfterReactionRemoval(current, removedType);
  client.logger.info(targetKind === 'no_status' ? 'annict anime status clear requested' : 'annict anime status removal recalculated', {
    guildId: message.guildId,
    animeEntryId: entry.id,
    userId: user.id,
    reactionType: removedType,
    targetKind
  });

  const connection = client.db.annictUserIntegration.getConnection(message.guildId, user.id);
  if (!connection || connection.tokenStatus !== 'active') {
    persistCalculatedAnimeStatus(client, message.guildId, entry.id, user.id, next);
    await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
    await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
    const notConnectedError = new Error('Annict connection missing');
    notConnectedError.code = 'not_connected';
    await maybeNotifyAnnictReactionFailure(client, user, notConnectedError);
    return;
  }

  try {
    const { updateAnnictStatusForAnimeEntry } = require('../annictUserIntegration');
    await updateAnnictStatusForAnimeEntry(client, {
      guildId: message.guildId,
      userId: user.id,
      entry,
      targetKind,
      idempotencyKey: `reaction-remove:${message.id}:${user.id}:${removedType}:${targetKind}`,
      source: 'discord_reaction_remove',
      updateLocal: false
    });
    persistCalculatedAnimeStatus(client, message.guildId, entry.id, user.id, next);
    await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
    await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
    client.logger.info(targetKind === 'no_status' ? 'annict anime status cleared' : 'anime reaction removed', {
      guildId: message.guildId,
      animeEntryId: entry.id,
      userId: user.id,
      reactionType: removedType,
      targetKind
    });
  } catch (error) {
    if (error.code === 'not_connected') {
      persistCalculatedAnimeStatus(client, message.guildId, entry.id, user.id, next);
      await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
      await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
      await maybeNotifyAnnictReactionFailure(client, user, error);
      return;
    }
    const reactionRestored = await restoreRemovedReactionBestEffort(reaction, user.id);
    await maybeNotifyAnnictReactionFailure(client, user, error);
    if (reactionRestored) {
      client.logger.info('annict reaction restored after removal failure', {
        guildId: message.guildId,
        animeEntryId: entry.id,
        userId: user.id,
        reactionType: removedType
      });
    }
    client.logger.warn('annict anime status removal failed', {
      guildId: message.guildId,
      animeEntryId: entry.id,
      userId: user.id,
      reactionType: removedType,
      targetKind,
      annictWorkId: String(entry.provider || '') === 'annict' ? entry.providerMediaId || null : null,
      errorCode: error.code || null,
      reactionRestored,
      error: error.message
    });
  }
}

async function findRegisteredAnime(client, guildId, query, limit = 10) {
  const entries = client.db.anime.searchEntries(guildId, query, Math.max(limit, 25)).map(normalizeEntry);
  return rankResolvedWorks(query, entries)
    .map((row) => row.entry)
    .filter((entry) => entry.animeChannelMessageId && entry.threadId)
    .slice(0, limit);
}

async function listAnimeIndex(client, guildId, page = 1) {
  const pageSize = Number(client.appConfig.anime.indexPageSize || 25);
  const safePage = Math.max(1, Number(page || 1));
  const allEntries = client.db.anime.listAllEntries(guildId).map(normalizeEntry);
  const validEntries = [];
  for (const entry of allEntries) {
    if (entry.animeChannelMessageId && entry.threadId) {
      validEntries.push(entry);
      continue;
    }
    client.logger.warn('anime incomplete registration cleanup candidate', {
      animeEntryId: entry.id,
      animeChannelMessageId: entry.animeChannelMessageId || null,
      threadId: entry.threadId || null,
      reason: 'incomplete_registration'
    });
    client.db.anime.deleteEntryCascade(entry.id);
    client.logger.info('anime incomplete entry cleanup completed', {
      animeEntryId: entry.id,
      reason: 'incomplete_registration'
    });
  }
  const total = validEntries.length;
  const entries = validEntries.slice((safePage - 1) * pageSize, ((safePage - 1) * pageSize) + pageSize);
  return {
    page: safePage,
    pageSize,
    total,
    entries
  };
}

async function cleanupAnimeEntry(client, entry, reason = 'manual_cleanup') {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry?.id) {
    return false;
  }

  const thread = normalizedEntry.threadId ? await safeFetchChannel(client, normalizedEntry.threadId) : null;
  if (thread) {
    try {
      await thread.delete(`Anime cleanup: ${reason}`);
    } catch (error) {
      try {
        if (typeof thread.setArchived === 'function') {
          await thread.setArchived(true, `Anime cleanup fallback: ${reason}`);
        }
        if (typeof thread.setLocked === 'function') {
          await thread.setLocked(true, `Anime cleanup fallback: ${reason}`);
        }
      } catch {
        client.logger.warn('anime thread cleanup fallback failed', {
          animeEntryId: normalizedEntry.id,
          threadId: normalizedEntry.threadId,
          error: error.message
        });
      }
    }
  }

  client.db.anime.deleteEntryCascade(normalizedEntry.id);
  client.logger.info('anime entry cleanup completed', {
    animeEntryId: normalizedEntry.id,
    providerMediaId: normalizedEntry.providerMediaId,
    reason
  });
  return true;
}

async function handleAnimeParentMessageDeleted(client, message) {
  if (!message?.guildId || !message?.id) {
    return false;
  }
  client.db.anime.deleteReviewPromptStateByMessageId(message.guildId, message.id);
  const entry = normalizeEntry(client.db.anime.getEntryByChannelMessageId(message.guildId, message.id));
  if (!entry) {
    return false;
  }
  await cleanupAnimeEntry(client, entry, 'parent_message_deleted');
  return true;
}

async function runAnimeOrphanScan(client) {
  if (!client.appConfig.anime?.enabled) {
    return;
  }
  const guildId = process.env.GUILD_ID || '';
  if (!guildId) {
    return;
  }
  client.logger.info('anime orphan scan started', { guildId });
  const entries = client.db.anime.listAllEntries(guildId);
  for (const rawEntry of entries) {
    const entry = normalizeEntry(rawEntry);
    if (!entry?.animeChannelMessageId || !entry?.threadId) {
      client.logger.warn('anime incomplete entry found during orphan scan', {
        animeEntryId: entry?.id || null,
        animeChannelMessageId: entry?.animeChannelMessageId || null,
        threadId: entry?.threadId || null,
        reason: 'incomplete_registration'
      });
      client.db.anime.deleteEntryCascade(entry.id);
      client.logger.info('anime incomplete entry cleanup completed', {
        animeEntryId: entry?.id || null,
        reason: 'incomplete_registration'
      });
      continue;
    }
    if (!entry?.animeChannelId || !entry?.animeChannelMessageId) {
      continue;
    }
    const channel = await safeFetchChannel(client, entry.animeChannelId);
    if (!channel?.messages?.fetch) {
      continue;
    }
    try {
      const message = await channel.messages.fetch(entry.animeChannelMessageId);
      if (message) {
        continue;
      }
    } catch (error) {
      if (error?.code === 10008 || /unknown message/i.test(String(error.message || ''))) {
        client.logger.warn('anime parent missing', {
          animeEntryId: entry.id,
          animeChannelMessageId: entry.animeChannelMessageId,
          threadId: entry.threadId || null
        });
        await cleanupAnimeEntry(client, entry, 'orphan_scan_missing_parent');
        continue;
      }
      client.logger.warn('anime orphan scan fetch skipped', {
        animeEntryId: entry.id,
        animeChannelMessageId: entry.animeChannelMessageId,
        error: error.message
      });
    }
  }
  client.logger.info('anime orphan scan finished', {
    guildId,
    scannedCount: entries.length
  });
}

async function reconcileAnimeCardControls(client, options = {}) {
  if (!client.appConfig.anime?.enabled) {
    return { skipped: true, reason: 'disabled' };
  }
  if (client.animeCardReconcileRunning) {
    client.logger.info('anime card control reconciliation skipped', { reason: 'already_running' });
    return { skipped: true, reason: 'already_running' };
  }

  const guildId = String(options.guildId || process.env.GUILD_ID || '');
  if (!guildId) {
    return { skipped: true, reason: 'guild_missing' };
  }

  const delayMs = options.delayMs == null
    ? Math.max(250, Number(client.appConfig.anime.cardReconcileDelayMs || 1000))
    : Math.max(0, Number(options.delayMs));
  const entries = client.db.anime.listAllEntries(guildId).map(normalizeEntry);
  const result = { scanned: entries.length, updated: 0, skipped: 0, failed: 0 };
  client.animeCardReconcileRunning = true;
  client.logger.info('anime card control reconciliation started', {
    guildId,
    entryCount: entries.length,
    delayMs
  });

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry?.animeChannelMessageId) {
        result.skipped += 1;
        continue;
      }
      try {
        const message = await updateAnimeChannelCard(client, entry);
        if (!message) {
          result.skipped += 1;
        } else {
          result.updated += 1;
          if (entry.reviewCardMessageId || entry.threadCardMessageId) {
            await updateAnimeReviewCard(client, entry).catch((error) => {
              client.logger.warn('anime review card control reconciliation failed', {
                guildId,
                animeEntryId: entry.id,
                error: error.message
              });
            });
          }
          client.logger.info('anime card controls reconciled', {
            guildId,
            animeEntryId: entry.id,
            animeChannelMessageId: entry.animeChannelMessageId,
            threadId: entry.threadId || null
          });
        }
      } catch (error) {
        result.failed += 1;
        client.logger.warn('anime card control reconciliation failed', {
          guildId,
          animeEntryId: entry?.id || null,
          animeChannelMessageId: entry?.animeChannelMessageId || null,
          error: error.message
        });
      }
      if (delayMs > 0 && index < entries.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  } finally {
    client.animeCardReconcileRunning = false;
  }

  client.logger.info('anime card control reconciliation completed', { guildId, ...result });
  return result;
}

async function appendAnimeThreadButtonToTimelineMessage(client, timelineMessageId, entry) {
  const normalizedEntry = normalizeEntry(entry);
  const timelineChannelId = String(client.appConfig.timelineChannelId || '');
  const threadUrl = buildAnimeLinks(normalizedEntry).threadUrl;
  if (!timelineChannelId || !timelineMessageId || !threadUrl) {
    return false;
  }

  const channel = await safeFetchChannel(client, timelineChannelId);
  const message = await safeFetchMessage(channel, timelineMessageId);
  if (!message) {
    return false;
  }

  const hasThreadButton = Array.isArray(message.components) && message.components.some((row) =>
    Array.isArray(row.components) && row.components.some((component) => component?.label === '作品スレッドへ飛ぶ')
  );
  if (hasThreadButton) {
    return true;
  }

  const components = Array.isArray(message.components)
    ? message.components.map((row) => ActionRowBuilder.from(row))
    : [];
  const threadButton = new ButtonBuilder()
    .setLabel('作品スレッドへ飛ぶ')
    .setStyle(ButtonStyle.Link)
    .setURL(threadUrl);
  const lastRow = components[components.length - 1];
  if (lastRow?.components?.length && lastRow.components.length < 5) {
    lastRow.addComponents(threadButton);
  } else {
    components.push(new ActionRowBuilder().addComponents(threadButton));
  }
  await message.edit({ components, allowedMentions: { parse: [] } });

  client.logger.info('anime timeline relay card linked to thread', {
    animeEntryId: normalizedEntry.id,
    timelineMessageId,
    threadUrl
  });
  return true;
}

async function updateAnimeRelayedCards(client, sourceRecord, entry) {
  if (!sourceRecord?.sourceMessageId || !sourceRecord?.sourceChannelId) {
    return false;
  }

  const relayTargets = client.db.relays.listMessageRelayTargets(sourceRecord.sourceMessageId);
  if (!relayTargets.length) {
    client.logger.info('anime relayed card update skipped no relay records', {
      sourceMessageId: sourceRecord.sourceMessageId,
      animeEntryId: entry.id
    });
    return false;
  }

  const sourceChannel = await safeFetchChannel(client, sourceRecord.sourceChannelId);
  const sourceMessage = await safeFetchMessage(sourceChannel, sourceRecord.sourceMessageId);
  if (!sourceMessage) {
    client.logger.warn('anime relayed card update failed', {
      sourceMessageId: sourceRecord.sourceMessageId,
      animeEntryId: entry.id,
      reason: 'source_message_missing'
    });
    return false;
  }

  client.logger.info('anime relayed card update started', {
    sourceMessageId: sourceRecord.sourceMessageId,
    animeEntryId: entry.id,
    relayTargetCount: relayTargets.length
  });

  const post = await extractPlainMessagePost(sourceMessage, client.appConfig, client.logger);
  const links = buildAnimeLinks(entry);
  post.extraLinkButtons = [{
    label: '作品スレッドへ飛ぶ',
    url: links.threadUrl
  }];
  post.accentColor = 0xf3f4f6;
  const twitterResolved = await resolveTwitterMedia(post, client.appConfig, client.logger);
  const videoPrepared = await prepareVideoThumbnail(twitterResolved.post, client.logger);
  const attachmentPrepared = await prepareAttachmentRelay(videoPrepared.post, client.appConfig, client.logger);
  const payload = buildTimelineMessage({
    post: {
      ...attachmentPrepared.post,
      accentColor: 0xf3f4f6
    },
    config: client.appConfig,
    forumType: 'tweet'
  });

  try {
    for (const relayTarget of relayTargets) {
      client.logger.info('anime relayed card update target', {
        sourceMessageId: sourceRecord.sourceMessageId,
        animeEntryId: entry.id,
        destinationChannelId: relayTarget.destinationChannelId,
        relayedMessageId: relayTarget.relayedMessageId
      });
      const destinationChannel = await safeFetchChannel(client, relayTarget.destinationChannelId);
      const relayedMessage = await safeFetchMessage(destinationChannel, relayTarget.relayedMessageId);
      if (!relayedMessage) {
        client.logger.warn('anime relayed card update failed', {
          sourceMessageId: sourceRecord.sourceMessageId,
          animeEntryId: entry.id,
          destinationChannelId: relayTarget.destinationChannelId,
          relayedMessageId: relayTarget.relayedMessageId,
          reason: 'relayed_message_missing'
        });
        continue;
      }

      const alreadyHasButton = Array.isArray(relayedMessage.components) && relayedMessage.components.some((row) =>
        Array.isArray(row.components) && row.components.some((component) => component?.label === '作品スレッドへ飛ぶ')
      );
      if (alreadyHasButton) {
        client.logger.info('anime relayed card update skipped already_has_button', {
          sourceMessageId: sourceRecord.sourceMessageId,
          animeEntryId: entry.id,
          destinationChannelId: relayTarget.destinationChannelId,
          relayedMessageId: relayTarget.relayedMessageId
        });
        continue;
      }

      await relayedMessage.edit(payload);
      client.logger.info('anime relayed card update finished', {
        sourceMessageId: sourceRecord.sourceMessageId,
        animeEntryId: entry.id,
        destinationChannelId: relayTarget.destinationChannelId,
        relayedMessageId: relayTarget.relayedMessageId
      });
    }
    return true;
  } finally {
    await attachmentPrepared.cleanup();
    await videoPrepared.cleanup();
    await twitterResolved.cleanup();
  }
}

async function linkAnimeHashtagSourceToEntry(client, sourceRecord, animeEntryId, detectedCandidate = null) {
  if (!sourceRecord?.id || !animeEntryId) {
    return false;
  }
  const entry = normalizeEntry(client.db.anime.getEntryById(animeEntryId));
  if (!entry) {
    return false;
  }

  client.db.anime.updateHashtagSourceLink(sourceRecord.id, {
    animeEntryId,
    status: 'linked',
    detectedCandidate
  });
  await updateAnimeRelayedCards(client, sourceRecord, entry).catch((error) => {
    client.logger.warn('anime relayed card update failed', {
      sourceMessageId: sourceRecord.sourceMessageId,
      animeEntryId,
      error: error.message
    });
    return false;
  });
  return true;
}

async function maybeLinkRecentAnimeHashtagSource(client, guildId, userId, animeEntryId) {
  const sinceIso = new Date(Date.now() - (30 * 60 * 1000)).toISOString();
  const sources = client.db.anime.listRecentUnresolvedHashtagSourcesByUser(guildId, userId, sinceIso, 5);
  if (!sources.length) {
    return false;
  }
  return linkAnimeHashtagSourceToEntry(client, sources[0], animeEntryId, sources[0].detectedCandidate || null);
}

module.exports = {
  searchAnime,
  resolveAnimeFromTitle,
  ensureAnimeEntryFromAnilistMedia,
  postAnimeToChannel,
  createAnimeThread,
  createOrUpdateThreadHeader,
  updateAnimeChannelCard,
  updateAnimeThreadHeader,
  updateAnimeReviewCard,
  getAnimeByThreadId,
  getAnimeByMessageId,
  getAnimeStats,
  addAnimeUserReactionStatus,
  saveAnimeReview,
  buildAnimeReviewSavedLines,
  updateReviewRoles,
  handleAnimeReactionAdd,
  handleAnimeReactionRemove,
  calculateAnimeStatusAfterReactionRemoval,
  getAnimeStatusReactionEmojis,
  handleAnimeWatchedPromptReply,
  findRegisteredAnime,
  listAnimeIndex,
  cleanupAnimeEntry,
  handleAnimeParentMessageDeleted,
  runAnimeOrphanScan,
  reconcileAnimeCardControls,
  appendAnimeThreadButtonToTimelineMessage,
  updateAnimeRelayedCards,
  linkAnimeHashtagSourceToEntry,
  maybeLinkRecentAnimeHashtagSource,
  getProviderTokenMissingMessage,
  getAnimeById,
  getAnimeCastById,
  getCurrentSeasonAnime,
  getNextSeasonAnime
};
