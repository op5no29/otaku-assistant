const { AttachmentBuilder } = require('discord.js');
const sharp = require('sharp');
const { appendOperationLog } = require('../logDashboard');

const FALLBACK_AVATAR_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';

function getConfig(client) {
  return client.appConfig.voiceWorkTime || { enabled: false, channels: [] };
}

function getChannelConfig(client, voiceChannelId) {
  const id = String(voiceChannelId || '');
  return (getConfig(client).channels || []).find((entry) => String(entry.voiceChannelId) === id) || null;
}

function getMilestoneHours(config = {}) {
  const explicit = Array.isArray(config.milestoneHours) ? config.milestoneHours : [];
  const generated = config.generatedMilestones || {};
  const milestones = new Set(explicit.map(Number).filter((value) => Number.isFinite(value) && value > 0));
  const start = Number(generated.startExclusiveHours || 1000);
  const every = Number(generated.everyHours || 500);
  const through = Number(generated.throughHours || 10000);
  if (every > 0 && through > start) {
    for (let hour = start + every; hour <= through; hour += every) {
      milestones.add(hour);
    }
  }
  return [...milestones].sort((left, right) => left - right);
}

function formatDuration(seconds, { largeCompact = false } = {}) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (largeCompact && hours >= 1000) {
    return `${hours.toLocaleString('ja-JP')}時間`;
  }
  if (hours > 0) {
    return `${hours.toLocaleString('ja-JP')}時間${minutes}分`;
  }
  return `${minutes}分`;
}

function getMilestoneLabel(hours) {
  const value = Number(hours);
  if (value === 24) return '累計1日';
  if (value === 48) return '累計2日';
  if (value === 72) return '累計3日';
  if (value === 168) return '累計1週間';
  if (value === 336) return '累計2週間';
  if (value === 720) return '累計30日・1か月相当';
  if (value === 1000) return '累計1000時間';
  if (value === 10000) return '累計10000時間';
  return `${value.toLocaleString('ja-JP')}時間`;
}

function secondsBetween(startIso, endIso) {
  const start = new Date(startIso || 0).getTime();
  const end = new Date(endIso || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return Math.floor((end - start) / 1000);
}

function getProjectedTotalSeconds(client, guildId, userId, now = new Date()) {
  const total = client.db.vcWorkTime?.getTotal?.(guildId, userId) || null;
  const open = client.db.vcWorkTime?.getOpenInterval?.(guildId, userId) || null;
  const projected = Number(total?.totalSeconds || 0) + (open ? secondsBetween(open.started_at || open.startedAt, now.toISOString()) : 0);
  return {
    totalSeconds: projected,
    storedTotalSeconds: Number(total?.totalSeconds || 0),
    historicalBackfillSeconds: Number(total?.historicalBackfillSeconds || 0),
    liveTrackedSeconds: Number(total?.liveTrackedSeconds || 0),
    openInterval: open
  };
}

function createIntervalKey({ guildId, userId, voiceChannelId, startedAt }) {
  return `${guildId}:${userId}:${voiceChannelId}:${startedAt}`;
}

function getWorkLocks(client) {
  if (!client.voiceWorkTimeLocks) {
    client.voiceWorkTimeLocks = new Set();
  }
  return client.voiceWorkTimeLocks;
}

async function withUserLock(client, guildId, userId, callback) {
  const locks = getWorkLocks(client);
  const key = `${guildId}:${userId}`;
  while (locks.has(key)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  locks.add(key);
  try {
    return await callback();
  } finally {
    locks.delete(key);
  }
}

function openWorkInterval(client, { guildId, userId, channelConfig, startedAt, source = 'voice_state_update', startEstimated = false }) {
  const stableIntervalKey = createIntervalKey({
    guildId,
    userId,
    voiceChannelId: channelConfig.voiceChannelId,
    startedAt
  });
  const changes = client.db.vcWorkTime.openInterval({
    stableIntervalKey,
    guildId,
    userId,
    categoryId: channelConfig.categoryId,
    voiceChannelId: channelConfig.voiceChannelId,
    listenChatChannelId: channelConfig.listenChatChannelId || null,
    startedAt,
    source,
    startEstimated
  });
  client.logger.info(changes ? 'work vc interval opened' : 'work vc interval open duplicate prevented', {
    guildId,
    userId,
    voiceChannelId: channelConfig.voiceChannelId,
    startedAt,
    source,
    startEstimated
  });
  return changes > 0;
}

async function closeWorkInterval(client, { guildId, userId, endedAt, endEstimated = false, reason = 'voice_state_update' }) {
  const interval = client.db.vcWorkTime.getOpenInterval(guildId, userId);
  if (!interval) {
    return null;
  }
  const durationSeconds = secondsBetween(interval.started_at, endedAt);
  const changes = client.db.vcWorkTime.closeInterval({
    intervalId: interval.id,
    endedAt,
    durationSeconds,
    endEstimated
  });
  if (!changes) {
    return null;
  }
  client.db.vcWorkTime.addTotalDelta({
    guildId,
    userId,
    liveTrackedSeconds: durationSeconds,
    countedAt: endedAt
  });
  client.logger.info('work vc interval closed', {
    guildId,
    userId,
    voiceChannelId: interval.voice_channel_id,
    startedAt: interval.started_at,
    endedAt,
    durationSeconds,
    endEstimated,
    reason
  });
  await checkAndDeliverMilestones(client, {
    guildId,
    userId,
    voiceChannelId: interval.voice_channel_id,
    categoryId: interval.category_id,
    reachedAt: endedAt
  });
  return { interval, durationSeconds };
}

async function handleVoiceWorkTimeStateUpdate(oldState, newState) {
  const client = newState.client;
  const config = getConfig(client);
  if (!config.enabled) {
    return;
  }
  const member = newState.member || oldState.member || null;
  if (!member?.guild || member.user?.bot) {
    return;
  }
  const guildId = member.guild.id;
  const userId = member.id;
  const oldConfig = getChannelConfig(client, oldState.channelId);
  const newConfig = getChannelConfig(client, newState.channelId);
  if (!oldConfig && !newConfig) {
    return;
  }
  if (oldConfig && newConfig && String(oldConfig.voiceChannelId) === String(newConfig.voiceChannelId)) {
    return;
  }
  const nowIso = new Date().toISOString();
  await withUserLock(client, guildId, userId, async () => {
    if (oldConfig) {
      await closeWorkInterval(client, {
        guildId,
        userId,
        endedAt: nowIso,
        reason: newConfig ? 'work_channel_move' : 'left_work_channel'
      });
    }
    if (newConfig) {
      const open = client.db.vcWorkTime.getOpenInterval(guildId, userId);
      if (open) {
        await closeWorkInterval(client, {
          guildId,
          userId,
          endedAt: nowIso,
          reason: 'replace_overlapping_open_interval'
        });
      }
      openWorkInterval(client, {
        guildId,
        userId,
        channelConfig: newConfig,
        startedAt: nowIso,
        source: oldConfig ? 'work_channel_move' : 'voice_state_update'
      });
      if (oldConfig) {
        client.logger.info('work vc channel move recorded', {
          guildId,
          userId,
          fromVoiceChannelId: oldConfig.voiceChannelId,
          toVoiceChannelId: newConfig.voiceChannelId
        });
      }
    }
  });
}

async function reconcileVoiceWorkIntervals(client, { reason = 'ready_resync' } = {}) {
  const config = getConfig(client);
  if (!config.enabled || !config.channels?.length) {
    return { restoredCount: 0, closedCount: 0, openedCount: 0 };
  }
  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (!guild) {
    return { restoredCount: 0, closedCount: 0, openedCount: 0, skippedReason: 'guild_missing' };
  }
  await guild.channels.fetch().catch(() => null);
  const nowIso = new Date().toISOString();
  const currentByUser = new Map();
  for (const state of guild.voiceStates.cache.values()) {
    const member = state.member || await guild.members.fetch(state.id).catch(() => null);
    if (!member || member.user?.bot) continue;
    const channelConfig = getChannelConfig(client, state.channelId);
    if (channelConfig) {
      currentByUser.set(String(member.id), { member, channelConfig });
    }
  }

  let restoredCount = 0;
  let closedCount = 0;
  let openedCount = 0;
  for (const interval of client.db.vcWorkTime.listOpenIntervals()) {
    if (String(interval.guild_id) !== String(guild.id)) continue;
    const current = currentByUser.get(String(interval.user_id));
    if (current && String(current.channelConfig.voiceChannelId) === String(interval.voice_channel_id)) {
      restoredCount += 1;
      client.logger.info('work vc open interval restored after restart', {
        guildId: guild.id,
        userId: interval.user_id,
        voiceChannelId: interval.voice_channel_id,
        startedAt: interval.started_at,
        reason
      });
      currentByUser.delete(String(interval.user_id));
      continue;
    }
    await closeWorkInterval(client, {
      guildId: guild.id,
      userId: interval.user_id,
      endedAt: nowIso,
      endEstimated: true,
      reason: 'restart_reconcile_absent_or_moved'
    });
    closedCount += 1;
  }

  for (const [userId, current] of currentByUser) {
    openWorkInterval(client, {
      guildId: guild.id,
      userId,
      channelConfig: current.channelConfig,
      startedAt: nowIso,
      source: 'ready_reconcile',
      startEstimated: true
    });
    openedCount += 1;
  }
  return { restoredCount, closedCount, openedCount };
}

function getNextMilestoneInfo(client, guildId, userId) {
  const config = getConfig(client);
  const projected = getProjectedTotalSeconds(client, guildId, userId);
  const currentHours = projected.totalSeconds / 3600;
  const next = getMilestoneHours(config).find((hours) => hours > currentHours) || null;
  return {
    ...projected,
    nextMilestoneHours: next,
    remainingSeconds: next ? Math.max(0, Math.ceil(next * 3600 - projected.totalSeconds)) : null
  };
}

async function fetchLimitedBuffer(url, { timeoutMs = 10_000, maxBytes = 10_000_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
  if (!response.ok) {
    throw new Error(`asset_http_${response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '');
  if (!/^image\//i.test(contentType)) {
    throw new Error('asset_content_type_invalid');
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error('asset_too_large');
  }
  return Buffer.from(arrayBuffer);
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderMilestoneCard(client, { user, member, milestoneHours, channelLabel }) {
  const config = getConfig(client).milestoneCard || {};
  const width = Number(config.width || 1200);
  const height = Number(config.height || 630);
  const displayName = member?.displayName || user.globalName || user.username || user.id;
  const avatarUrl = member?.displayAvatarURL?.({ extension: 'png', size: 256 }) ||
    user.displayAvatarURL?.({ extension: 'png', size: 256 }) ||
    FALLBACK_AVATAR_URL;
  let avatarBuffer = null;
  let backgroundBuffer = null;
  let backgroundSource = 'black_fallback';
  try {
    const fetchedUser = config.useDiscordBanner ? await user.fetch(true).catch(() => user) : user;
    const bannerUrl = fetchedUser.bannerURL?.({ extension: 'png', size: 1024 }) || null;
    if (bannerUrl) {
      backgroundBuffer = await fetchLimitedBuffer(bannerUrl, config);
      backgroundSource = 'discord_banner';
    }
  } catch (error) {
    client.logger.warn('discord banner fetch failed', { userId: user.id, error: error.message });
  }
  try {
    avatarBuffer = await fetchLimitedBuffer(avatarUrl, config);
  } catch (error) {
    client.logger.warn('work milestone avatar fetch failed; using default avatar', { userId: user.id, error: error.message });
    avatarBuffer = await fetchLimitedBuffer(FALLBACK_AVATAR_URL, config).catch(() => null);
  }

  if (!backgroundBuffer) {
    client.logger.info('black fallback background used', { userId: user.id, milestoneHours });
  } else {
    client.logger.info('work milestone card banner source selected', { userId: user.id, milestoneHours, source: backgroundSource });
  }

  const base = backgroundBuffer
    ? sharp(backgroundBuffer).resize(width, height, { fit: 'cover' }).blur(config.blurBackground === false ? 0 : 8)
    : sharp({ create: { width, height, channels: 4, background: '#050505' } });
  const avatarSize = 220;
  const avatarPng = avatarBuffer
    ? await sharp(avatarBuffer)
      .resize(avatarSize, avatarSize, { fit: 'cover' })
      .composite([{ input: Buffer.from(`<svg width="${avatarSize}" height="${avatarSize}"><circle cx="${avatarSize / 2}" cy="${avatarSize / 2}" r="${avatarSize / 2}" fill="#fff"/></svg>`), blend: 'dest-in' }])
      .png()
      .toBuffer()
    : null;
  const headline = `累計作業時間 ${Number(milestoneHours).toLocaleString('ja-JP')}時間 達成`;
  const special = getMilestoneLabel(milestoneHours);
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="rgba(0,0,0,${Number(config.darkOverlayOpacity ?? 0.42)})"/>
      <circle cx="${width / 2}" cy="220" r="126" fill="white"/>
      <text x="50%" y="405" text-anchor="middle" font-family="sans-serif" font-size="58" font-weight="800" fill="white">${escapeXml(headline)}</text>
      <text x="50%" y="466" text-anchor="middle" font-family="sans-serif" font-size="32" font-weight="700" fill="#dbeafe">${escapeXml(special)}</text>
      <text x="50%" y="525" text-anchor="middle" font-family="sans-serif" font-size="38" font-weight="700" fill="white">${escapeXml(displayName)}</text>
      <text x="50%" y="575" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#e5e7eb">${escapeXml(channelLabel || config.footerBranding || 'Otaku Assistant')}</text>
    </svg>`;
  const composites = [{ input: Buffer.from(svg), top: 0, left: 0 }];
  if (avatarPng) {
    composites.push({ input: avatarPng, top: 110, left: Math.round(width / 2 - avatarSize / 2) });
  }
  const buffer = await base.composite(composites).png().toBuffer();
  client.logger.info('milestone card rendered', { userId: user.id, milestoneHours, backgroundSource });
  return new AttachmentBuilder(buffer, { name: `work-milestone-${user.id}-${milestoneHours}.png` });
}

async function sendMilestoneNotification(client, award) {
  const guild = await client.guilds.fetch(award.guildId).catch(() => null);
  const user = await client.users.fetch(award.userId).catch(() => null);
  if (!guild || !user) return;
  const member = await guild.members.fetch(award.userId).catch(() => null);
  const channelConfig = getChannelConfig(client, award.voiceChannelId);
  const channelLabel = channelConfig?.label || award.voiceChannelId || '作業通話';
  let attachment = null;
  let cardStatus = 'failed';
  let cardError = null;
  try {
    attachment = await renderMilestoneCard(client, { user, member, milestoneHours: award.milestoneHours, channelLabel });
    cardStatus = 'rendered';
  } catch (error) {
    cardError = error.message;
    client.logger.error('milestone card render failed', { guildId: award.guildId, userId: award.userId, milestoneHours: award.milestoneHours, error: error.message });
  }
  const label = getMilestoneLabel(award.milestoneHours);
  const dmContent = [`🎉 累計作業時間${Number(award.milestoneHours).toLocaleString('ja-JP')}時間達成！`, `このサーバーの作業通話での累計参加時間が${label}に到達しました。いつも作業お疲れ様です。`].join('\n');
  const publicContent = [`🎉 <@${award.userId}> さんの作業通話累計時間が${label}に到達しました！`, `${channelLabel}で達成しました。おめでとうございます！`].join('\n');

  try {
    const dm = await user.send({ content: dmContent, files: attachment ? [attachment] : [], allowedMentions: { parse: [] } });
    client.db.vcWorkTime.updateMilestoneDelivery({ guildId: award.guildId, userId: award.userId, milestoneHours: award.milestoneHours, dmStatus: 'sent', dmMessageId: dm.id, dmSentAt: new Date().toISOString(), cardStatus, cardError });
  } catch (error) {
    client.db.vcWorkTime.updateMilestoneDelivery({ guildId: award.guildId, userId: award.userId, milestoneHours: award.milestoneHours, dmStatus: 'failed', cardStatus, cardError });
  }
  const publicChannelId = channelConfig?.listenChatChannelId || null;
  if (publicChannelId) {
    const channel = await client.channels.fetch(publicChannelId).catch(() => null);
    if (channel?.isTextBased?.()) {
      try {
        const message = await channel.send({ content: publicContent, files: attachment ? [attachment] : [], allowedMentions: { parse: [], users: [award.userId], roles: [] } });
        client.db.vcWorkTime.updateMilestoneDelivery({ guildId: award.guildId, userId: award.userId, milestoneHours: award.milestoneHours, publicStatus: 'sent', publicMessageChannelId: publicChannelId, publicMessageId: message.id, publicSentAt: new Date().toISOString(), cardStatus, cardError });
      } catch {
        client.db.vcWorkTime.updateMilestoneDelivery({ guildId: award.guildId, userId: award.userId, milestoneHours: award.milestoneHours, publicStatus: 'failed', cardStatus, cardError });
      }
    }
  }
}

async function checkAndDeliverMilestones(client, { guildId, userId, voiceChannelId, categoryId, reachedAt = new Date().toISOString() }) {
  const config = getConfig(client);
  if (!config.enabled) return;
  const total = getProjectedTotalSeconds(client, guildId, userId);
  const awards = client.db.vcWorkTime.listAwardsForUser(guildId, userId);
  const awarded = new Set(awards.map((row) => Number(row.milestone_hours)));
  const crossed = getMilestoneHours(config).filter((hours) => total.totalSeconds >= hours * 3600 && !awarded.has(hours));
  if (!crossed.length) return;
  const highest = crossed[crossed.length - 1];
  for (const lower of crossed.slice(0, -1)) {
    const claimed = client.db.vcWorkTime.claimMilestone({ guildId, userId, milestoneHours: lower, reachedAt, voiceChannelId, categoryId });
    if (claimed) {
      client.db.vcWorkTime.updateMilestoneDelivery({ guildId, userId, milestoneHours: lower, dmStatus: 'consolidated', publicStatus: 'consolidated', cardStatus: 'not_rendered' });
    }
  }
  if (crossed.length > 1) {
    client.logger.info('work vc milestone crossings consolidated', { guildId, userId, crossed, announced: highest });
  }
  const claimed = client.db.vcWorkTime.claimMilestone({ guildId, userId, milestoneHours: highest, reachedAt, voiceChannelId, categoryId });
  if (!claimed) {
    client.logger.info('work vc milestone duplicate prevented', { guildId, userId, milestoneHours: highest });
    return;
  }
  client.logger.info('work vc milestone claimed', { guildId, userId, milestoneHours: highest, totalSeconds: total.totalSeconds });
  appendOperationLog(client, {
    severity: 'info',
    eventType: 'work_vc_milestone_claimed',
    title: 'Work VC milestone claimed',
    body: `<@${userId}> ${highest}h`,
    metadata: { guildId, userId, milestoneHours: highest }
  });
  await sendMilestoneNotification(client, { guildId, userId, milestoneHours: highest, voiceChannelId, categoryId });
}

function startVoiceWorkTimeTicker(client) {
  const config = getConfig(client);
  if (client.voiceWorkTimeInterval) {
    clearInterval(client.voiceWorkTimeInterval);
    client.voiceWorkTimeInterval = null;
  }
  if (!config.enabled) return;
  const run = async () => {
    for (const interval of client.db.vcWorkTime.listOpenIntervals()) {
      await checkAndDeliverMilestones(client, {
        guildId: interval.guild_id,
        userId: interval.user_id,
        voiceChannelId: interval.voice_channel_id,
        categoryId: interval.category_id
      }).catch((error) => client.logger.warn('work vc milestone periodic check failed', { error: error.message }));
    }
  };
  client.voiceWorkTimeInterval = setInterval(() => void run(), Math.max(30, Number(config.tickIntervalSeconds || 60)) * 1000);
  client.voiceWorkTimeInterval.unref?.();
}

module.exports = {
  getChannelConfig,
  getProjectedTotalSeconds,
  getNextMilestoneInfo,
  formatDuration,
  getMilestoneLabel,
  handleVoiceWorkTimeStateUpdate,
  reconcileVoiceWorkIntervals,
  startVoiceWorkTimeTicker,
  checkAndDeliverMilestones,
  getMilestoneHours,
  renderMilestoneCard
};
