const {
  searchAnimeByTitle,
  getAnimeById: getAniListAnimeById,
  getAnimeCastById: getAniListAnimeCastById,
  getCurrentSeasonAnime: getAniListCurrentSeasonAnime,
  getNextSeasonAnime: getAniListNextSeasonAnime
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
const { rankResolvedWorks, normalizeSearchText, extractSearchAliases } = require('./search');
const { registerDeletableMessage } = require('../deletableMessages');
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

function buildEntryRecord(media, extras = {}) {
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
    coverImageUrl: media.coverImageUrl || null,
    bannerImageUrl: media.bannerImageUrl || null,
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

async function validateAnimeImageUrl(client, url) {
  const normalizedUrl = String(url || '').trim();
  if (!/^https:\/\//iu.test(normalizedUrl)) {
    return false;
  }

  const cache = ensureAnimeImageValidationStore(client);
  const cached = cache.get(normalizedUrl);
  if (cached && (Date.now() - cached.checkedAt) < IMAGE_VALIDATION_TTL_MS) {
    return cached.valid;
  }

  try {
    const response = await fetch(normalizedUrl, {
      headers: {
        Accept: 'image/*'
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const valid = response.ok && contentType.startsWith('image/');
    response.body?.cancel?.();
    cache.set(normalizedUrl, {
      checkedAt: Date.now(),
      valid
    });
    return valid;
  } catch {
    cache.set(normalizedUrl, {
      checkedAt: Date.now(),
      valid: false
    });
    return false;
  }
}

async function resolveAnimeCardImageEntry(client, entry) {
  const normalizedEntry = normalizeEntry(entry);
  const imageChoice = selectAnimeImageUrls(normalizedEntry);
  client.logger.info('anime image candidates', {
    animeEntryId: normalizedEntry?.id || null,
    coverImageUrl: normalizedEntry?.coverImageUrl || null,
    bannerImageUrl: normalizedEntry?.bannerImageUrl || null,
    thumbnailUrl: imageChoice.thumbnailUrl || null,
    selectedImageSource: imageChoice.selectedImageSource,
    selectedImageUrl: imageChoice.thumbnailUrl || null,
    imageOmitted: !imageChoice.thumbnailUrl
  });

  const candidates = [
    ['cover', imageChoice.coverImageUrl],
    ['banner', imageChoice.bannerImageUrl]
  ].filter(([, candidateUrl]) => Boolean(candidateUrl));

  for (const [source, candidateUrl] of candidates) {
    const valid = await validateAnimeImageUrl(client, candidateUrl);
    if (valid) {
      client.logger.info('anime image candidate selected', {
        animeEntryId: normalizedEntry?.id || null,
        source,
        url: candidateUrl
      });
      return {
        ...normalizedEntry,
        coverImageUrl: source === 'cover' ? candidateUrl : null,
        bannerImageUrl: source === 'banner' ? candidateUrl : null
      };
    }
    client.logger.warn('anime image validation failed', {
      animeEntryId: normalizedEntry?.id || null,
      source,
      url: candidateUrl
    });
  }

  client.logger.info('anime image fallback used', {
    animeEntryId: normalizedEntry?.id || null,
    selectedImageSource: 'none',
    reason: 'all_candidates_invalid'
  });
  return {
    ...normalizedEntry,
    coverImageUrl: null,
    bannerImageUrl: null
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
  const provider = getConfiguredProvider(client);
  if (provider === 'annict') {
    const direct = await searchWorks(client, title, { perPage: 10 });
    const normalizedQuery = normalizeSearchText(title);
    const normalizedResults = normalizedQuery && normalizeSearchText(title) !== normalizedQuery
      ? await searchWorks(client, normalizedQuery, { perPage: 10 }).catch(() => [])
      : [];
    const merged = mergeProviderResults([...direct, ...normalizedResults]);
    return rankResolvedWorks(title, merged).map((row) => row.entry).slice(0, 10);
  }
  return searchAnimeByTitle(client, title, 10);
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
  const localMatches = guildId ? client.db.anime.searchEntries(guildId, title, 10).map(normalizeEntry) : [];
  const remoteMatches = await searchAnime(client, title);
  const merged = mergeProviderResults([
    ...localMatches.map((entry) => ({
      ...entry,
      aliases: mergeAliases(entry.aliases, extractSearchAliases(entry))
    })),
    ...remoteMatches
  ]);
  const ranked = rankResolvedWorks(title, merged);
  return {
    media: ranked[0]?.entry || merged[0] || null,
    candidates: ranked.length ? ranked.map((row) => row.entry) : merged
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
    await sentMessage.react(client.appConfig.anime.interestEmoji).catch(() => null);
    await sentMessage.react(client.appConfig.anime.watchedEmoji).catch(() => null);
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

  await addAnimeUserReactionStatus(client, message.guildId, entry.id, user.id, interestedMatch ? 'interested' : 'watched', true);
  await updateAnimeChannelCard(client, entry).catch(() => null);
  await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
  client.logger.info('anime reaction added', {
    guildId: message.guildId,
    animeEntryId: entry.id,
    userId: user.id,
    reactionType: interestedMatch ? 'interested' : 'watched'
  });

  if (watchedMatch) {
    const promptState = client.db.anime.getReviewPromptState(message.guildId, entry.id, user.id, REVIEW_PROMPT_TYPES.WATCHED);
    if (!promptState && entry.threadId) {
      const thread = await safeFetchChannel(client, entry.threadId);
      if (thread?.isTextBased?.()) {
        const promptMessage = await thread.send({
          content: `<@${user.id}> さんが「視聴済み」にしました。\n感想があれば、このスレッドで \`/anime review\` を使って投稿できます。`,
          allowedMentions: { parse: [], users: [user.id] }
        }).catch(() => null);
        if (promptMessage) {
          await registerDeletableMessage(promptMessage, user.id, 'anime_watched_prompt', 1000 * 60 * 60 * 24 * 30).catch(() => null);
          client.db.anime.upsertReviewPromptState({
            guildId: message.guildId,
            animeEntryId: entry.id,
            userId: user.id,
            promptType: REVIEW_PROMPT_TYPES.WATCHED
          });
        }
      }
    }
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

  await addAnimeUserReactionStatus(client, message.guildId, entry.id, user.id, interestedMatch ? 'interested' : 'watched', false);
  await updateAnimeChannelCard(client, entry).catch(() => null);
  await updateAnimeReviewCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
  client.logger.info('anime reaction removed', {
    guildId: message.guildId,
    animeEntryId: entry.id,
    userId: user.id,
    reactionType: interestedMatch ? 'interested' : 'watched'
  });
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
  await appendAnimeThreadButtonToTimelineMessage(client, sourceRecord.relayedTimelineMessageId, entry).catch(() => false);
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
  updateReviewRoles,
  handleAnimeReactionAdd,
  handleAnimeReactionRemove,
  findRegisteredAnime,
  listAnimeIndex,
  cleanupAnimeEntry,
  handleAnimeParentMessageDeleted,
  runAnimeOrphanScan,
  appendAnimeThreadButtonToTimelineMessage,
  linkAnimeHashtagSourceToEntry,
  maybeLinkRecentAnimeHashtagSource,
  getProviderTokenMissingMessage,
  getAnimeById,
  getAnimeCastById,
  getCurrentSeasonAnime,
  getNextSeasonAnime
};
