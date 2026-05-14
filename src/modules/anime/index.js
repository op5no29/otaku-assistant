const {
  searchAnimeByTitle,
  getAnimeById,
  getAnimeCastById,
  getCurrentSeasonAnime,
  getNextSeasonAnime
} = require('./anilistClient');
const {
  buildAnimeChannelCard,
  buildAnimeThreadHeaderCard,
  buildAnimeLinks,
  buildReviewPreview,
  getPreferredAnimeDisplayTitle
} = require('./buildAnimeMessages');

function parseAliases(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function buildEntryRecord(media, extras = {}) {
  return {
    guildId: extras.guildId,
    provider: 'anilist',
    providerMediaId: String(media.providerMediaId || media.id),
    titleNative: media.titleNative || null,
    titleRomaji: media.titleRomaji || null,
    titleEnglish: media.titleEnglish || null,
    titleUserPreferred: media.titleUserPreferred || media.titleRomaji || media.titleNative || media.titleEnglish || null,
    aliasesJson: JSON.stringify(Array.isArray(media.aliases) ? media.aliases : []),
    description: media.description || null,
    siteUrl: media.siteUrl || null,
    officialSiteUrl: media.officialSiteUrl || null,
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
  return getPreferredAnimeDisplayTitle(entry) || `AniList ${entry.providerMediaId}`;
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

async function findExistingThreadHeaderMessage(thread, client, animeEntryId) {
  const recent = await thread.messages.fetch({ limit: 15 }).catch(() => null);
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
    if (/メインキャスト|最新感想|作品カードへ飛ぶ|AniListで開く/u.test(String(firstText || ''))) {
      return message;
    }
  }

  return null;
}

async function searchAnime(client, title) {
  return searchAnimeByTitle(client, title, 5);
}

async function resolveAnimeFromTitle(client, title) {
  const results = await searchAnime(client, title);
  return {
    media: results[0] || null,
    candidates: results
  };
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

async function ensureAnimeEntryFromAnilistMedia(guild, media, createdByUserId) {
  const client = guild.client;
  const existing = normalizeEntry(
    client.db.anime.getEntryByProviderMediaId(guild.id, 'anilist', String(media.providerMediaId || media.id))
  );
  const record = buildEntryRecord(media, {
    guildId: guild.id,
    animeChannelId: existing?.animeChannelId || getAnimeChannelId(client),
    animeChannelMessageId: existing?.animeChannelMessageId || null,
    threadId: existing?.threadId || null,
    threadCardMessageId: existing?.threadCardMessageId || null,
    hasSpoilerReviews: existing?.hasSpoilerReviews || false,
    createdByUserId: existing?.createdByUserId || createdByUserId,
    createdAt: existing?.createdAt || new Date().toISOString()
  });
  client.db.anime.upsertEntry(record);
  const entry = normalizeEntry(
    client.db.anime.getEntryByProviderMediaId(guild.id, 'anilist', String(media.providerMediaId || media.id))
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
  const payload = buildAnimeChannelCard(normalizedEntry, stats);
  await message.edit(payload);
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
  const thread = await safeFetchChannel(client, normalizedEntry.threadId);
  if (!thread?.isTextBased?.()) {
    client.logger.warn('anime thread header update skipped', {
      animeEntryId: normalizedEntry.id,
      reason: 'thread_missing'
    });
    return null;
  }

  const cast = client.db.anime.listCast(normalizedEntry.id).slice(0, client.appConfig.anime.maxCastInCard);
  const stats = await getAnimeStats(client, normalizedEntry);
  const latestReviews = await getLatestReviewPreviews(client, normalizedEntry, client.appConfig.anime.maxReviewsInCard);
  const payload = buildAnimeThreadHeaderCard(normalizedEntry, stats, cast, latestReviews);

  let headerMessage = null;
  if (normalizedEntry.threadCardMessageId) {
    headerMessage = await safeFetchMessage(thread, normalizedEntry.threadCardMessageId);
    if (headerMessage) {
      client.logger.info('anime thread header create skipped existing', {
        animeEntryId: normalizedEntry.id,
        threadId: normalizedEntry.threadId,
        threadCardMessageId: headerMessage.id
      });
    }
  }

  if (!headerMessage) {
    const discoveredMessage = await findExistingThreadHeaderMessage(thread, client, normalizedEntry.id);
    if (discoveredMessage) {
      client.db.anime.updateBindings(normalizedEntry.id, {
        threadCardMessageId: discoveredMessage.id
      });
      headerMessage = discoveredMessage;
      client.logger.info('anime thread header duplicate prevented', {
        animeEntryId: normalizedEntry.id,
        threadId: normalizedEntry.threadId,
        threadCardMessageId: discoveredMessage.id
      });
    }
  }

  if (headerMessage) {
    await headerMessage.edit(payload);
    client.logger.info('anime thread header edited', {
      animeEntryId: normalizedEntry.id,
      threadId: normalizedEntry.threadId,
      threadCardMessageId: headerMessage.id
    });
    return headerMessage;
  }

  headerMessage = await thread.send(payload);
  client.db.anime.updateBindings(normalizedEntry.id, {
    threadCardMessageId: headerMessage.id
  });
  client.logger.info('anime thread header created', {
    animeEntryId: normalizedEntry.id,
    threadId: normalizedEntry.threadId,
    threadCardMessageId: headerMessage.id
  });
  return headerMessage;
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
  return updateAnimeThreadHeader(client, entry);
}

async function postAnimeToChannel(guild, media, createdByUserId) {
  const client = guild.client;
  const entry = await ensureAnimeEntryFromAnilistMedia(guild, media, createdByUserId);
  if (entry.animeChannelMessageId) {
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
  const sentMessage = await channel.send(buildAnimeChannelCard(entry, stats));
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
  const thread = await createAnimeThread(sentMessage, refreshedEntry);
  await createOrUpdateThreadHeader(client, normalizeEntry(client.db.anime.getEntryById(entry.id)));
  await updateAnimeChannelCard(client, normalizeEntry(client.db.anime.getEntryById(entry.id)));

  return {
    entry: normalizeEntry(client.db.anime.getEntryById(entry.id)),
    created: true,
    thread,
    links: buildAnimeLinks(normalizeEntry(client.db.anime.getEntryById(entry.id)))
  };
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
        .map((entry) => ({ threshold: Number(entry.threshold), roleId: entry.roleId ? String(entry.roleId) : null }))
        .filter((entry) => entry.threshold > 0 && entry.roleId)
        .sort((left, right) => left.threshold - right.threshold)
    : [];
  const granted = [];

  for (const threshold of thresholds) {
    if (reviewedCount < threshold.threshold) {
      continue;
    }
    const role = member.guild.roles.cache.get(threshold.roleId) || await member.guild.roles.fetch(threshold.roleId).catch(() => null);
    if (!role || member.roles.cache.has(role.id)) {
      continue;
    }
    try {
      await member.roles.add(role);
      granted.push(role.id);
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

  return {
    reviewedCount,
    grantedRoleIds: granted
  };
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
  await updateAnimeThreadHeader(client, entry).catch((error) => {
    client.logger.warn('anime thread header update failed', {
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
  await updateAnimeThreadHeader(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
  client.logger.info('anime reaction added', {
    guildId: message.guildId,
    animeEntryId: entry.id,
    userId: user.id,
    reactionType: interestedMatch ? 'interested' : 'watched'
  });

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
  await updateAnimeThreadHeader(client, normalizeEntry(client.db.anime.getEntryById(entry.id))).catch(() => null);
  client.logger.info('anime reaction removed', {
    guildId: message.guildId,
    animeEntryId: entry.id,
    userId: user.id,
    reactionType: interestedMatch ? 'interested' : 'watched'
  });
}

async function findRegisteredAnime(client, guildId, query, limit = 10) {
  return client.db.anime.searchEntries(guildId, query, limit).map(normalizeEntry);
}

async function listAnimeIndex(client, guildId, page = 1) {
  const pageSize = Number(client.appConfig.anime.indexPageSize || 25);
  const safePage = Math.max(1, Number(page || 1));
  const total = client.db.anime.countEntries(guildId);
  const entries = client.db.anime.listEntriesPage(guildId, pageSize, (safePage - 1) * pageSize).map(normalizeEntry);
  return {
    page: safePage,
    pageSize,
    total,
    entries
  };
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
  getAnimeById,
  getAnimeCastById,
  getCurrentSeasonAnime,
  getNextSeasonAnime
};
