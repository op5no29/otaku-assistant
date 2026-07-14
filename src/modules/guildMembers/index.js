const crypto = require('node:crypto');

function getIntroChannelId(client) {
  return String(client.appConfig.introDm?.introChannelId || client.appConfig.introChannelId || '');
}

function buildGuildMemberRecord(member) {
  const now = new Date().toISOString();
  return {
    guildId: member.guild.id,
    userId: member.id,
    username: member.user?.username || null,
    globalName: member.user?.globalName || null,
    displayName: member.displayName || member.user?.globalName || member.user?.username || null,
    nickname: member.nickname || null,
    avatarUrl: member.displayAvatarURL?.({ extension: 'png', size: 256 })
      || member.user?.displayAvatarURL?.({ extension: 'png', size: 256 })
      || null,
    avatarHash: member.user?.avatar || member.avatar || null,
    joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
    isBot: member.user?.bot === true,
    leftAt: null,
    lastSeenAt: now,
    lastVcJoinedAt: null,
    createdAt: now
  };
}

function recordMemberIdentity(client, member, eventType, observedAt = new Date().toISOString()) {
  const record = buildGuildMemberRecord(member);
  const identityFingerprint = crypto.createHash('sha256').update(JSON.stringify([
    record.username,
    record.globalName,
    record.displayName,
    record.nickname,
    record.avatarUrl,
    record.avatarHash
  ])).digest('hex');
  client.db.timelineRestoration.identities.record({
    guildId: record.guildId,
    userId: record.userId,
    observedAt,
    eventType,
    username: record.username,
    globalName: record.globalName,
    displayName: record.displayName,
    nickname: record.nickname,
    avatarUrl: record.avatarUrl,
    avatarHash: record.avatarHash,
    identityFingerprint,
    createdAt: observedAt
  });
  return record;
}

function upsertGuildMember(client, member, { eventType = 'member_seen' } = {}) {
  const record = buildGuildMemberRecord(member);
  client.db.guildMembers.upsert(record);
  recordMemberIdentity(client, member, eventType, record.lastSeenAt);
  const existingEpisode = client.db.timelineRestoration.membership.getOpen(record.guildId, record.userId);
  const episode = client.db.timelineRestoration.membership.open({
    guildId: record.guildId,
    userId: record.userId,
    joinedAt: record.joinedAt || record.lastSeenAt,
    username: record.username,
    globalName: record.globalName,
    displayName: record.displayName,
    nickname: record.nickname,
    avatarUrl: record.avatarUrl,
    avatarHash: record.avatarHash,
    createdAt: record.lastSeenAt
  });
  client.logger.info('guild member saved', {
    guildId: record.guildId,
    userId: record.userId,
    joinedAt: record.joinedAt,
    isBot: record.isBot
  });
  if (!existingEpisode) {
    client.logger.info('membership episode opened', {
      guildId: record.guildId,
      userId: record.userId,
      membershipEpisodeId: episode.episodeId,
      joinedAt: episode.joinedAt
    });
  }
  return { ...record, membershipEpisodeId: episode.episodeId };
}

function markGuildMemberLeft(client, memberOrGuildId, maybeUserId) {
  const member = typeof memberOrGuildId === 'object' ? memberOrGuildId : null;
  const guildId = member?.guild?.id || memberOrGuildId;
  const userId = member?.id || maybeUserId;
  const leftAt = new Date().toISOString();
  if (member) recordMemberIdentity(client, member, 'member_leave', leftAt);
  const closed = client.db.timelineRestoration.membership.close(guildId, userId, leftAt);
  client.db.guildMembers.markLeft(guildId, userId, leftAt);
  client.logger.info('guild member marked left', {
    guildId,
    userId
  });
  client.logger.info('guild member retained after leave', {
    guildId,
    userId,
    leftAt,
    userOwnedDataDeleted: false
  });
  client.logger.info('membership episode closed', {
    guildId,
    userId,
    leftAt,
    closedEpisodeCount: closed
  });
}

function updateGuildMemberVcJoined(client, member, joinedAt = new Date()) {
  const existing = client.db.guildMembers.get(member.guild.id, member.id);
  if (!existing) {
    upsertGuildMember(client, member);
  }

  client.db.guildMembers.updateVcJoined(
    member.guild.id,
    member.id,
    joinedAt instanceof Date ? joinedAt.toISOString() : String(joinedAt)
  );
}

function hasUserIntro(client, guildId, userId) {
  return Boolean(client.db.introProfiles.getLatestByUser(guildId, userId, getIntroChannelId(client)));
}

function hasIntroDmOptOut(client, guildId, userId) {
  const states = client.db.introDm.listStatesByUser(guildId, userId);
  return states.some((state) => state.optOut);
}

function hasRecentIntroDm(client, guildId, userId, cooldownDays, promptType = null) {
  const cutoffMs = Date.now() - (Number(cooldownDays || 7) * 24 * 60 * 60 * 1000);
  const states = client.db.introDm.listStatesByUser(guildId, userId);
  return states.some((state) => {
    if (promptType && state.promptType !== promptType) {
      return false;
    }
    return state.sentAt && new Date(state.sentAt).getTime() >= cutoffMs;
  });
}

function getUsersWithoutIntroOlderThan(client, guildId, hours, limit = 20) {
  const olderThanIso = new Date(Date.now() - (Number(hours || 48) * 60 * 60 * 1000)).toISOString();
  const introChannelId = getIntroChannelId(client);
  const config = client.appConfig.introDm;
  if (config.devTestMode) {
    const devMember = client.db.guildMembers.get(guildId, config.devUserId);
    if (!devMember || devMember.isBot || devMember.leftAt) {
      return [];
    }
    if (devMember.joinedAt && new Date(devMember.joinedAt).getTime() > new Date(olderThanIso).getTime()) {
      return [];
    }
    if (hasIntroDmOptOut(client, guildId, devMember.userId)) {
      return [];
    }
    if (hasRecentIntroDm(client, guildId, devMember.userId, config.vcReminderCooldownDays, 'join_48h_no_intro')) {
      return [];
    }
    return [devMember].slice(0, limit);
  }

  const baseRows = client.db.guildMembers.getWithoutIntroOlderThan(
    guildId,
    olderThanIso,
    introChannelId,
    Math.max(limit * 3, limit)
  );

  const filtered = baseRows.filter((row) => {
    if (row.isBot) {
      return false;
    }
    if (row.leftAt) {
      return false;
    }
    if (hasUserIntro(client, guildId, row.userId)) {
      return false;
    }
    if (hasIntroDmOptOut(client, guildId, row.userId)) {
      return false;
    }
    if (hasRecentIntroDm(client, guildId, row.userId, config.vcReminderCooldownDays, 'join_48h_no_intro')) {
      return false;
    }
    return true;
  });

  return filtered.slice(0, limit);
}

async function backfillGuildMembers(client, guild) {
  client.logger.info('guild member backfill started', {
    guildId: guild.id
  });

  let fetchedCount = 0;
  let savedCount = 0;
  let botCount = 0;
  let failedCount = 0;

  const members = await guild.members.fetch().catch((error) => {
    client.logger.warn('guild member backfill fetch failed', {
      guildId: guild.id,
      error: error.message
    });
    return null;
  });

  if (!members) {
    return {
      fetchedCount: 0,
      savedCount: 0,
      botCount: 0,
      failedCount: 1
    };
  }

  fetchedCount = members.size;
  for (const member of members.values()) {
    try {
      upsertGuildMember(client, member);
      savedCount += 1;
      if (member.user?.bot) {
        botCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      client.logger.warn('guild member save failed', {
        guildId: guild.id,
        userId: member.id,
        error: error.message
      });
    }
  }

  client.logger.info('guild member backfill finished', {
    guildId: guild.id,
    fetchedCount,
    savedCount,
    botCount,
    failedCount
  });

  return {
    fetchedCount,
    savedCount,
    botCount,
    failedCount
  };
}

async function reconcileGuildMembersOnReady(client, guild) {
  const { handleReturningMember, scheduleDepartedMemberPreservation } = require('../timelineRestoration');
  const members = await guild.members.fetch();
  const currentIds = new Set(members.keys());
  let opened = 0;
  let closed = 0;
  let returns = 0;
  for (const member of members.values()) {
    const previous = client.db.guildMembers.get(guild.id, member.id);
    const record = upsertGuildMember(client, member, { eventType: 'ready_reconciliation' });
    if (!client.db.timelineRestoration.membership.list(guild.id, member.id).some((episode) => episode.episodeId === record.membershipEpisodeId && episode.leftAt)) {
      opened += previous ? 0 : 1;
    }
    if (previous?.leftAt && !member.user?.bot) {
      returns += 1;
      await handleReturningMember(client, member, previous, { episodeId: record.membershipEpisodeId });
    }
  }
  const activeRows = client.db.sqlite.prepare(`
    SELECT guild_id AS guildId, user_id AS userId
    FROM guild_members
    WHERE guild_id = ? AND left_at IS NULL
  `).all(guild.id);
  for (const row of activeRows) {
    if (currentIds.has(row.userId)) continue;
    markGuildMemberLeft(client, row.guildId, row.userId);
    client.db.timelineRestoration.userThreads.markOwnerLeft(row.guildId, row.userId, new Date().toISOString());
    scheduleDepartedMemberPreservation(client, row.guildId, row.userId);
    closed += 1;
  }
  client.logger.info('guild membership ready reconciliation completed', {
    guildId: guild.id,
    currentMemberCount: members.size,
    openedCount: opened,
    closedCount: closed,
    returningMemberCount: returns
  });
  return { currentMemberCount: members.size, opened, closed, returns };
}

module.exports = {
  upsertGuildMember,
  markGuildMemberLeft,
  updateGuildMemberVcJoined,
  hasUserIntro,
  getUsersWithoutIntroOlderThan,
  backfillGuildMembers,
  recordMemberIdentity,
  reconcileGuildMembersOnReady
};
