function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeProfileUrl(value) {
  const raw = String(value || '')
    .trim()
    .replace(/[.,、。!?！？;；]+$/u, '');
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function getIntroChannelId(client) {
  return String(client.appConfig.introDm?.introChannelId || client.appConfig.introChannelId || '');
}

function extractUrls(text) {
  return Array.from(String(text || '').matchAll(/https?:\/\/[^\s>]+/giu))
    .map((match) => normalizeProfileUrl(match[0]))
    .filter(Boolean);
}

function isUsefulIntroProfileUrl(value) {
  const normalized = normalizeProfileUrl(value);
  if (!normalized) {
    return false;
  }

  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (
      host === 'discord.com' ||
      host === 'www.discord.com' ||
      host === 'cdn.discordapp.com' ||
      host === 'media.discordapp.net' ||
      host.endsWith('.discordapp.com') ||
      host.endsWith('.discordapp.net')
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

function countLinkFocusedNonUrlChars(content) {
  return Array.from(
    String(content || '')
      .replace(/https?:\/\/[^\s>]+/giu, '')
      .replace(/[：:：→\-–—|｜/／\\()\[\]（）【】<>〈〉「」『』\s]/gu, '')
  ).length;
}

function isLinkFocusedIntroAddendum(content, urls) {
  const text = String(content || '').trim();
  if (!urls.length || !text) {
    return false;
  }

  const nonUrlCharCount = countLinkFocusedNonUrlChars(text);
  const totalCharCount = Array.from(text).length;
  return nonUrlCharCount <= 80 && totalCharCount <= 400;
}

function buildAddendumLines(content, newUrls) {
  const newUrlSet = new Set(newUrls);
  const lines = String(content || '')
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => extractUrls(line).some((url) => newUrlSet.has(url)));

  if (lines.length) {
    return lines;
  }

  return newUrls;
}

function appendIntroAddendumText(existingIntroText, addendumLines) {
  const baseText = String(existingIntroText || '').trim();
  const addendumText = addendumLines.join('\n').trim();
  if (!addendumText) {
    return baseText;
  }

  if (!baseText) {
    return `SNS / Links:\n${addendumText}`;
  }

  if (/SNS\s*\/\s*Links\s*:/iu.test(baseText)) {
    return `${baseText}\n${addendumText}`;
  }

  return `${baseText}\n\nSNS / Links:\n${addendumText}`;
}

function buildSearchAliasesFromIdentity(identity, links) {
  const aliases = new Set();
  const candidates = [
    identity.displayName,
    identity.username,
    identity.globalName,
    identity.nickname
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

function getIntroProfileSkipReason(client, message) {
  if (!message?.inGuild?.()) {
    return 'not_guild';
  }
  if (message.author?.bot) {
    return 'bot';
  }
  if (String(message.channelId || '') !== getIntroChannelId(client)) {
    return 'not_intro_channel';
  }
  if (message.reference?.messageId) {
    return 'reply';
  }
  const hasSubstance = Boolean(
    String(message.content || '').trim() ||
    message.attachments?.size ||
    message.embeds?.length
  );
  if (!hasSubstance) {
    return 'empty';
  }
  return null;
}

function buildSearchAliases(message, links) {
  return buildSearchAliasesFromIdentity({
    displayName: message.member?.displayName,
    username: message.author?.username,
    globalName: message.author?.globalName,
    nickname: message.member?.nickname
  }, links);
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
    introChannelId: getIntroChannelId(client),
    introMessageId: message.id,
    displayName: message.member?.displayName || message.author?.globalName || message.author?.username || null,
    username: message.author?.username || null,
    globalName: message.author?.globalName || null,
    nickname: message.member?.nickname || null,
    sourceType: 'first_top_level_message',
    introText,
    linksJson: JSON.stringify(links),
    embedsJson: JSON.stringify(embedObjects),
    attachmentsJson: JSON.stringify(attachmentObjects),
    searchAliasesJson: JSON.stringify(searchAliases),
    postedAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: message.editedAt ? message.editedAt.toISOString() : (message.createdAt ? message.createdAt.toISOString() : new Date().toISOString())
  };
}

async function refreshVcProfilesForIntroUser(client, message, reason) {
  const guild = message.guild || (message.guildId ? await client.guilds.fetch(message.guildId).catch(() => null) : null);
  if (!guild) {
    return 0;
  }

  try {
    const { queueVoiceProfileRefreshForUser } = require('../vcProfile');
    const queuedCount = await queueVoiceProfileRefreshForUser(client, guild, message.author.id, { reason });
    if (queuedCount > 0) {
      if (reason === 'intro_profile_edit') {
        client.logger.info('intro profile edit refresh queued', {
          guildId: message.guildId || guild.id,
          userId: message.author.id,
          introMessageId: message.id,
          queuedCount
        });
      }
      client.logger.info(
        reason === 'intro_addendum_absorbed'
          ? 'vc profile refresh queued due intro addendum'
          : reason === 'intro_profile_edit'
            ? 'vc profile refresh queued due intro edit'
            : 'vc profile refresh queued due intro profile update',
        {
          guildId: message.guildId || guild.id,
          userId: message.author.id,
          introMessageId: message.id,
          queuedCount
        }
      );
    }
    return queuedCount;
  } catch (error) {
    client.logger.warn('vc profile refresh queue failed after intro profile update', {
      guildId: message.guildId || guild.id,
      userId: message.author.id,
      introMessageId: message.id,
      reason,
      error: error.message
    });
    return 0;
  }
}

async function reactToAbsorbedAddendum(client, message) {
  try {
    await message.react('🔗');
    client.logger.info('intro addendum reaction added', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id,
      reaction: '🔗'
    });
  } catch (error) {
    client.logger.warn('intro addendum reaction failed', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id,
      reaction: '🔗',
      error: error.message
    });
  }
}

async function maybeAbsorbIntroAddendum(client, message, existingProfile) {
  const rawUrls = extractUrls(message.content || '').filter(isUsefulIntroProfileUrl);
  client.logger.info('intro addendum candidate detected', {
    guildId: message.guildId,
    userId: message.author.id,
    introMessageId: message.id,
    currentIntroMessageId: existingProfile?.introMessageId || null,
    urlCount: rawUrls.length,
    nonUrlCharCount: countLinkFocusedNonUrlChars(message.content || '')
  });

  if (!existingProfile) {
    client.logger.info('intro addendum skipped no existing profile', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id
    });
    return {
      absorbed: false,
      skippedReason: 'no_existing_profile'
    };
  }

  if (!isLinkFocusedIntroAddendum(message.content || '', rawUrls)) {
    client.logger.info('intro addendum skipped not link focused', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id,
      urlCount: rawUrls.length,
      totalCharCount: Array.from(String(message.content || '').trim()).length,
      nonUrlCharCount: countLinkFocusedNonUrlChars(message.content || '')
    });
    return {
      absorbed: false,
      skippedReason: 'not_link_focused'
    };
  }

  const existingLinks = parseJsonArray(existingProfile.linksJson).map(normalizeProfileUrl).filter(Boolean);
  const existingUrlSet = new Set([
    ...existingLinks,
    ...extractUrls(existingProfile.introText || '')
  ]);
  const newUrls = [...new Set(rawUrls)].filter((url) => !existingUrlSet.has(url));
  if (!newUrls.length) {
    client.logger.info('intro addendum skipped duplicate url', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id,
      urls: rawUrls
    });
    return {
      absorbed: false,
      skippedReason: 'duplicate_url'
    };
  }

  const mergedLinks = [...new Set([...existingLinks, ...newUrls])];
  const displayName = message.member?.displayName || existingProfile.displayName || message.author?.globalName || message.author?.username || null;
  const username = message.author?.username || existingProfile.username || null;
  const globalName = message.author?.globalName || existingProfile.globalName || null;
  const nickname = message.member?.nickname || existingProfile.nickname || null;
  const addendumLines = buildAddendumLines(message.content || '', newUrls);
  const updatedRecord = {
    guildId: existingProfile.guildId,
    userId: existingProfile.userId,
    introChannelId: existingProfile.introChannelId,
    introMessageId: existingProfile.introMessageId,
    displayName,
    username,
    globalName,
    nickname,
    sourceType: existingProfile.sourceType || 'first_top_level_message',
    introText: appendIntroAddendumText(existingProfile.introText, addendumLines),
    linksJson: JSON.stringify(mergedLinks),
    embedsJson: existingProfile.embedsJson || '[]',
    attachmentsJson: existingProfile.attachmentsJson || '[]',
    searchAliasesJson: JSON.stringify([
      ...new Set([
        ...parseJsonArray(existingProfile.searchAliasesJson),
        ...buildSearchAliasesFromIdentity({ displayName, username, globalName, nickname }, mergedLinks)
      ])
    ]),
    postedAt: existingProfile.postedAt || new Date().toISOString(),
    updatedAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString()
  };

  client.db.introProfiles.upsert(updatedRecord);
  client.logger.info('intro addendum absorbed', {
    guildId: message.guildId,
    userId: message.author.id,
    introMessageId: message.id,
    targetIntroMessageId: existingProfile.introMessageId,
    addedUrls: newUrls
  });
  client.logger.info('intro profile updated from addendum', {
    guildId: updatedRecord.guildId,
    userId: updatedRecord.userId,
    introMessageId: updatedRecord.introMessageId,
    addendumMessageId: message.id
  });
  await reactToAbsorbedAddendum(client, message);
  await refreshVcProfilesForIntroUser(client, message, 'intro_addendum_absorbed');

  return {
    absorbed: true,
    skippedReason: null,
    introMessageId: existingProfile.introMessageId,
    addedUrls: newUrls
  };
}

function isIntroProfileMessage(client, message) {
  return getIntroProfileSkipReason(client, message) === null;
}

async function saveIntroProfileFromMessage(client, message) {
  const skipReason = getIntroProfileSkipReason(client, message);
  if (skipReason) {
    if (skipReason === 'reply') {
      client.logger.info('intro profile save skipped reply', {
        guildId: message.guildId || null,
        userId: message.author?.id || null,
        introMessageId: message.id
      });
    }
    if (skipReason === 'reply' || skipReason === 'empty') {
      client.logger.info('intro profile false-positive guard triggered', {
        guildId: message.guildId || null,
        userId: message.author?.id || null,
        introMessageId: message.id,
        skipReason
      });
    }
    return {
      saved: false,
      skippedReason: skipReason
    };
  }

  const existingProfile = getLatestIntroProfileByUser(client, message.guildId, message.author.id);
  if (existingProfile && existingProfile.introMessageId !== message.id) {
    client.logger.info('duplicate/additional intro-channel post', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id,
      currentIntroMessageId: existingProfile.introMessageId
    });
    const addendumResult = await maybeAbsorbIntroAddendum(client, message, existingProfile);
    if (addendumResult.absorbed) {
      return {
        saved: true,
        skippedReason: null,
        updatedExisting: true,
        absorbedAddendum: true,
        introMessageId: addendumResult.introMessageId,
        addedUrls: addendumResult.addedUrls
      };
    }
    return {
      saved: false,
      skippedReason: addendumResult.skippedReason || 'duplicate_user_intro'
    };
  }

  const firstProfileUrls = extractUrls(message.content || '').filter(isUsefulIntroProfileUrl);
  if (!existingProfile && isLinkFocusedIntroAddendum(message.content || '', firstProfileUrls)) {
    client.logger.info('intro addendum skipped no existing profile', {
      guildId: message.guildId,
      userId: message.author.id,
      introMessageId: message.id,
      urlCount: firstProfileUrls.length,
      continuedAsPrimaryIntro: true
    });
  }

  const record = buildIntroProfileRecord(client, message);
  client.db.introProfiles.upsert(record);
  client.logger.info(existingProfile ? 'intro profile updated' : 'Intro profile saved', {
    guildId: record.guildId,
    userId: record.userId,
    introMessageId: record.introMessageId,
    introChannelId: record.introChannelId
  });
  if (!existingProfile || existingProfile.introMessageId === message.id) {
    try {
      await require('../introReactions').applyIntroReactionsToMessage(message);
    } catch (error) {
      client.logger.warn('failed to apply intro reactions after save', {
        guildId: record.guildId,
        userId: record.userId,
        introMessageId: record.introMessageId,
        error: error.message
      });
    }
  }
  await refreshVcProfilesForIntroUser(
    client,
    message,
    existingProfile ? 'intro_profile_edit' : 'intro_profile_saved'
  );
  return {
    saved: true,
    skippedReason: null,
    updatedExisting: Boolean(existingProfile),
    introMessageId: record.introMessageId
  };
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
  return normalizeProfile(client.db.introProfiles.getLatestByUser(guildId, userId, getIntroChannelId(client)));
}

function searchIntroProfiles(client, guildId, query, limit = 3) {
  return client.db.introProfiles.search(guildId, getIntroChannelId(client), query, limit).map(normalizeProfile);
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
    getIntroChannelId(client),
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
  const introChannelId = getIntroChannelId(client);
  const introChannel = await client.channels.fetch(introChannelId).catch(() => null);
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
    introChannelId,
    requestedLimit: limit
  });

  let scannedCount = 0;
  let savedCount = 0;
  let skippedBotCount = 0;
  let skippedReplyCount = 0;
  let skippedEmptyCount = 0;
  let failedCount = 0;
  let before = null;
  const collectedMessages = [];

  while (scannedCount < limit) {
    const batchSize = Math.min(100, limit - scannedCount);
    const batch = await introChannel.messages.fetch({ limit: batchSize, before }).catch(() => null);
    if (!batch?.size) {
      break;
    }

    for (const message of batch.values()) {
      scannedCount += 1;
      before = message.id;
      collectedMessages.push(message);
    }
  }

  for (const message of collectedMessages.reverse()) {
    if (message.author?.bot) {
      skippedBotCount += 1;
      continue;
    }

    try {
      const result = await saveIntroProfileFromMessage(client, message);
      if (result?.saved) {
        savedCount += 1;
      } else if (result?.skippedReason === 'reply') {
        skippedReplyCount += 1;
      } else if (result?.skippedReason === 'empty') {
        skippedEmptyCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      logger.warn('Intro profile backfill save failed', {
        messageId: message.id,
        channelId: introChannelId,
        error: error.message
      });
    }
  }

  logger.info('Intro profile backfill finished', {
    guildId,
    introChannelId,
    scannedCount,
    savedCount,
    skippedBotCount,
    skippedReplyCount,
    skippedEmptyCount,
    failedCount
  });

  return {
    scannedCount,
    savedCount,
    skippedBotCount,
    skippedReplyCount,
    skippedGreetingLikeCount: 0,
    skippedEmptyCount,
    failedCount
  };
}

async function rebuildIntroProfiles(client, guildId, { dryRun = true, limit = 1000 } = {}) {
  const logger = client.logger;
  const introChannelId = getIntroChannelId(client);
  const introChannel = await client.channels.fetch(introChannelId).catch(() => null);
  if (!introChannel?.isTextBased?.()) {
    return {
      scannedCount: 0,
      selectedIntroCount: 0,
      skippedReplyCount: 0,
      skippedDuplicateUserCount: 0,
      skippedBotCount: 0,
      skippedEmptyCount: 0,
      failedCount: 0,
      skippedReason: 'intro_channel_unavailable'
    };
  }

  const targetLimit = Math.max(1, Math.min(Number(limit) || 1000, 2000));
  const collected = [];
  let before;
  while (collected.length < targetLimit) {
    const batchSize = Math.min(100, targetLimit - collected.length);
    const batch = await introChannel.messages.fetch(before ? { limit: batchSize, before } : { limit: batchSize }).catch(() => null);
    if (!batch?.size) {
      break;
    }
    const ordered = Array.from(batch.values());
    collected.push(...ordered);
    before = ordered[ordered.length - 1]?.id;
    if (batch.size < batchSize) {
      break;
    }
  }

  const orderedMessages = collected.slice(0, targetLimit).reverse();
  const selectedRecords = [];
  const selectedUserIds = new Set();
  let skippedReplyCount = 0;
  let skippedDuplicateUserCount = 0;
  let skippedBotCount = 0;
  let skippedEmptyCount = 0;
  let failedCount = 0;

  for (const message of orderedMessages) {
    try {
      if (message.author?.bot) {
        skippedBotCount += 1;
        continue;
      }
      if (message.reference?.messageId) {
        skippedReplyCount += 1;
        continue;
      }
      const hasSubstance = Boolean(
        String(message.content || '').trim() ||
        message.attachments.size ||
        message.embeds.length
      );
      if (!hasSubstance) {
        skippedEmptyCount += 1;
        continue;
      }
      if (selectedUserIds.has(message.author.id)) {
        skippedDuplicateUserCount += 1;
        continue;
      }
      selectedUserIds.add(message.author.id);
      selectedRecords.push(buildIntroProfileRecord(client, message));
    } catch (error) {
      failedCount += 1;
      logger.warn('intro profile rebuild candidate failed', {
        guildId,
        messageId: message.id,
        error: error.message
      });
    }
  }

  if (!dryRun) {
    client.db.introProfiles.deleteByChannel(guildId, introChannelId);
    for (const record of selectedRecords) {
      client.db.introProfiles.upsert(record);
    }
  }

  return {
    scannedCount: orderedMessages.length,
    selectedIntroCount: selectedRecords.length,
    skippedReplyCount,
    skippedDuplicateUserCount,
    skippedBotCount,
    skippedEmptyCount,
    failedCount,
    skippedReason: null
  };
}

function getIntroProfileStatus(client, guildId) {
  return {
    introChannelId: getIntroChannelId(client),
    savedProfileCount: client.db.introProfiles.count(guildId, getIntroChannelId(client)),
    latestArchivedProfileDate: client.db.introProfiles.getLatestDate(guildId, getIntroChannelId(client))
  };
}

async function getMembersWithoutIntroOlderThan(guild, hours, client) {
  return require('../guildMembers').getUsersWithoutIntroOlderThan(client, guild.id, hours, 20);
}

async function cleanupIntroProfiles(client, guildId, { dryRun = true, limit = 1000 } = {}) {
  const introChannelId = getIntroChannelId(client);
  const introChannel = await client.channels.fetch(introChannelId).catch(() => null);
  const rows = client.db.introProfiles.listByChannel(guildId, introChannelId, limit);
  let removedCount = 0;
  let replyCount = 0;

  for (const row of rows) {
    let shouldRemove = false;
    let removeReason = null;

    if (introChannel?.isTextBased?.()) {
      const sourceMessage = await introChannel.messages.fetch(row.introMessageId).catch(() => null);
      if (sourceMessage?.reference?.messageId) {
        shouldRemove = true;
        removeReason = 'reply';
      }
    }

    if (!shouldRemove) {
      continue;
    }

    if (removeReason === 'reply') {
      replyCount += 1;
    }
    if (!dryRun) {
      client.db.introProfiles.deleteByMessageId(row.introMessageId);
    }
    removedCount += 1;
  }

  return {
    dryRun,
    scannedCount: rows.length,
    removedCount,
    replyCount,
    greetingLikeCount: 0
  };
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
  getIntroProfileStatus,
  cleanupIntroProfiles,
  rebuildIntroProfiles
};
