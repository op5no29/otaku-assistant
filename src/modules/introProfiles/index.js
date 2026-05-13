function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractUrls(text) {
  return Array.from(String(text || '').matchAll(/https?:\/\/[^\s>]+/giu)).map((match) => match[0]);
}

function buildSearchAliases(message, links) {
  const aliases = new Set();
  const candidates = [
    message.member?.displayName,
    message.author?.username,
    message.author?.globalName,
    message.member?.nickname
  ];

  for (const value of candidates) {
    const raw = String(value || '').trim();
    if (!raw) {
      continue;
    }
    aliases.add(raw);
    aliases.add(raw.toLowerCase());
  }

  for (const link of links) {
    const xHandleMatch = String(link).match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/iu);
    const youtubeMatch = String(link).match(/youtube\.com\/@([A-Za-z0-9_.-]+)/iu);
    const handle = xHandleMatch?.[1] || youtubeMatch?.[1] || null;
    if (handle) {
      aliases.add(handle);
      aliases.add(handle.toLowerCase());
    }
  }

  return Array.from(aliases);
}

function buildIntroProfileRecord(client, message) {
  const introText = String(message.content || '');
  const embedObjects = message.embeds.map((embed) => (typeof embed.toJSON === 'function' ? embed.toJSON() : embed.data || {}));
  const attachmentObjects = Array.from(message.attachments.values()).map((attachment) => ({
    id: String(attachment?.id || ''),
    name: attachment?.name || null,
    filename: attachment?.filename || null,
    title: attachment?.title || null,
    url: attachment?.url || null,
    proxyURL: attachment?.proxyURL || attachment?.proxyUrl || null,
    contentType: attachment?.contentType || null,
    size: Number(attachment?.size || 0)
  }));
  const embedUrls = embedObjects.flatMap((embed) => [embed.url, embed.provider?.url].filter(Boolean));
  const links = [...new Set([...extractUrls(introText), ...embedUrls])];
  const searchAliases = buildSearchAliases(message, links);

  return {
    guildId: message.guildId,
    userId: message.author.id,
    introChannelId: client.appConfig.introChannelId,
    introMessageId: message.id,
    displayName: message.member?.displayName || message.author?.globalName || message.author?.username || null,
    username: message.author?.username || null,
    globalName: message.author?.globalName || null,
    nickname: message.member?.nickname || null,
    introText,
    linksJson: JSON.stringify(links),
    embedsJson: JSON.stringify(embedObjects),
    attachmentsJson: JSON.stringify(attachmentObjects),
    searchAliasesJson: JSON.stringify(searchAliases),
    postedAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: message.editedAt ? message.editedAt.toISOString() : (message.createdAt ? message.createdAt.toISOString() : new Date().toISOString())
  };
}

function isIntroProfileMessage(client, message) {
  return Boolean(
    message?.inGuild?.() &&
    !message.author?.bot &&
    String(message.channelId || '') === String(client.appConfig.introChannelId || '')
  );
}

async function saveIntroProfileFromMessage(client, message) {
  if (!isIntroProfileMessage(client, message)) {
    return false;
  }

  const record = buildIntroProfileRecord(client, message);
  client.db.introProfiles.upsert(record);
  client.logger.info('Intro profile saved', {
    guildId: record.guildId,
    userId: record.userId,
    introMessageId: record.introMessageId,
    introChannelId: record.introChannelId
  });
  return true;
}

function deleteIntroProfileByMessageId(client, messageId) {
  client.db.introProfiles.deleteByMessageId(messageId);
}

function normalizeProfile(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    links: parseJsonArray(row.linksJson),
    embeds: parseJsonArray(row.embedsJson),
    attachments: parseJsonArray(row.attachmentsJson),
    searchAliases: parseJsonArray(row.searchAliasesJson)
  };
}

function getLatestIntroProfileByUser(client, guildId, userId) {
  return normalizeProfile(client.db.introProfiles.getLatestByUser(guildId, userId, client.appConfig.introChannelId));
}

function searchIntroProfiles(client, guildId, query, limit = 3) {
  return client.db.introProfiles.search(guildId, client.appConfig.introChannelId, query, limit).map(normalizeProfile);
}

function scoreProfileMatch(profile, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) {
    return { score: 0, reason: 'empty_query' };
  }

  const exactFields = [
    { value: profile.displayName, reason: 'exact_display_name', score: 100 },
    { value: profile.username, reason: 'exact_username', score: 90 },
    { value: profile.globalName, reason: 'exact_global_name', score: 90 },
    { value: profile.nickname, reason: 'exact_nickname', score: 85 }
  ];

  for (const { value, reason, score } of exactFields) {
    if (value && value.toLowerCase() === q) {
      return { score, reason };
    }
  }

  const aliases = Array.isArray(profile.searchAliases) ? profile.searchAliases : [];
  for (const alias of aliases) {
    if (alias && alias.toLowerCase() === q) {
      return { score: 80, reason: 'exact_alias' };
    }
  }

  for (const { value, reason } of exactFields) {
    if (value && value.toLowerCase().startsWith(q)) {
      return { score: 50, reason: `prefix_${reason.replace('exact_', '')}` };
    }
  }
  for (const alias of aliases) {
    if (alias && alias.toLowerCase().startsWith(q)) {
      return { score: 45, reason: 'prefix_alias' };
    }
  }

  return { score: 10, reason: 'partial_match' };
}

function searchIntroProfilesScored(client, guildId, query, limit = 3) {
  const raw = client.db.introProfiles.search(
    guildId,
    client.appConfig.introChannelId,
    query,
    Math.min(limit * 4, 20)
  ).map(normalizeProfile);

  const scored = raw.map((profile) => {
    const { score, reason } = scoreProfileMatch(profile, query);
    return { ...profile, matchScore: score, matchReason: reason };
  });

  scored.sort((left, right) => right.matchScore - left.matchScore);

  const topScore = scored[0]?.matchScore ?? 0;
  if (topScore >= 80) {
    return scored.filter((profile) => profile.matchScore >= 80).slice(0, limit);
  }

  return scored.slice(0, limit);
}

function hasUserIntro(client, guildId, userId) {
  return Boolean(getLatestIntroProfileByUser(client, guildId, userId));
}

async function backfillIntroProfiles(client, guildId, limit = 500) {
  const logger = client.logger;
  const channelId = client.appConfig.introChannelId;
  const introChannel = await client.channels.fetch(channelId).catch(() => null);
  if (!introChannel?.isTextBased?.()) {
    return {
      skippedReason: 'intro_channel_unavailable',
      scannedCount: 0,
      savedCount: 0,
      skippedBotCount: 0,
      failedCount: 0
    };
  }

  logger.info('Intro profile backfill started', {
    guildId,
    introChannelId: channelId,
    requestedLimit: limit
  });

  let scannedCount = 0;
  let savedCount = 0;
  let skippedBotCount = 0;
  let failedCount = 0;
  let before = null;

  while (scannedCount < limit) {
    const batchSize = Math.min(100, limit - scannedCount);
    const batch = await introChannel.messages.fetch({ limit: batchSize, before }).catch(() => null);
    if (!batch?.size) {
      break;
    }

    for (const message of batch.values()) {
      scannedCount += 1;
      before = message.id;
      if (message.author?.bot) {
        skippedBotCount += 1;
        continue;
      }

      try {
        await saveIntroProfileFromMessage(client, message);
        savedCount += 1;
      } catch (error) {
        failedCount += 1;
        logger.warn('Intro profile backfill save failed', {
          messageId: message.id,
          channelId,
          error: error.message
        });
      }
    }
  }

  logger.info('Intro profile backfill finished', {
    guildId,
    introChannelId: channelId,
    scannedCount,
    savedCount,
    skippedBotCount,
    failedCount
  });

  return {
    scannedCount,
    savedCount,
    skippedBotCount,
    failedCount
  };
}

function getIntroProfileStatus(client, guildId) {
  return {
    introChannelId: client.appConfig.introChannelId,
    savedProfileCount: client.db.introProfiles.count(guildId, client.appConfig.introChannelId),
    latestArchivedProfileDate: client.db.introProfiles.getLatestDate(guildId, client.appConfig.introChannelId)
  };
}

async function getMembersWithoutIntroOlderThan(guild, hours, client) {
  const config = client.appConfig.introDm;
  const devUserId = config.devUserId;
  if (config.devTestMode) {
    const member = await guild.members.fetch(devUserId).catch(() => null);
    return member ? [member] : [];
  }

  const cutoff = Date.now() - (Number(hours || 48) * 60 * 60 * 1000);
  const members = await guild.members.fetch().catch(() => null);
  if (!members) {
    return [];
  }

  return members.filter((member) => {
    if (member.user?.bot) {
      return false;
    }
    if (!member.joinedTimestamp || member.joinedTimestamp > cutoff) {
      return false;
    }
    return !hasUserIntro(client, guild.id, member.id);
  }).map((entry) => entry);
}

module.exports = {
  saveIntroProfileFromMessage,
  deleteIntroProfileByMessageId,
  getLatestIntroProfileByUser,
  searchIntroProfiles,
  searchIntroProfilesScored,
  hasUserIntro,
  getMembersWithoutIntroOlderThan,
  backfillIntroProfiles,
  getIntroProfileStatus
};
