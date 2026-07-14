const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionsBitField } = require('discord.js');
const { createDatabase } = require('../src/db/database');
const {
  handleVoiceActivityWindowStateUpdate,
  reconcileVoiceActivityWindows,
  getScope
} = require('../src/modules/vcActivityWindows');
const {
  updateShortActivityCard,
  hideShortActivityCardForLiveProfile,
  recordShortActivityForIgnoredSession
} = require('../src/modules/vcShortActivity');
function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}
async function probeSoloVcWindow(db) {
  const sentMessages = [];
  const messageStore = new Map();
  let editCount = 0;
  const profileChannel = {
    id: 'profile',
    isTextBased: () => true,
    messages: { fetch: async (id) => messageStore.get(String(id)) || null },
    async send(payload) {
      const message = {
        id: `short-${sentMessages.length + 1}`,
        payload,
        async edit(nextPayload) { editCount += 1; message.payload = nextPayload; return message; },
        async delete() { messageStore.delete(message.id); }
      };
      sentMessages.push(message);
      messageStore.set(message.id, message);
      return message;
    }
  };
  const guild = {
    id: 'guild',
    afkChannelId: 'afk',
    channels: {
      cache: new Map(),
      async fetch(id) { return id ? this.cache.get(String(id)) || null : this.cache; }
    }
  };
  const voiceChannel = {
    id: 'voice',
    name: '作業通話',
    parentId: 'category',
    guild,
    members: new Map(),
    isVoiceBased: () => true
  };
  const moveChannel = {
    id: 'voice-y',
    name: '移動先通話',
    parentId: 'category',
    guild,
    members: new Map(),
    isVoiceBased: () => true
  };
  guild.channels.cache.set(voiceChannel.id, voiceChannel);
  guild.channels.cache.set(moveChannel.id, moveChannel);
  guild.channels.cache.set(profileChannel.id, profileChannel);
  const client = {
    appConfig: {
      voiceSessionSummary: {
        enabled: true,
        minSessionActiveMinutes: 5,
        shortActivity: {
          enabled: true,
          trackSoloVisits: true,
          visibleDuringLiveProfile: true,
          includeAfk: false,
          maxDisplayedEpisodes: 5,
          maxStoredEpisodes: 50,
          retentionDays: 7
        }
      },
      voiceWorkTime: { timezone: 'Asia/Tokyo' }
    },
    db,
    logger: noopLogger(),
    voiceProfileCategoryMap: new Map([['category', { profileChannelId: 'profile', name: '作業' }]]),
    vcActivityWindowQueues: new Map(),
    guilds: { cache: new Map([['guild', guild]]), fetch: async () => guild },
    channels: { fetch: async (id) => guild.channels.cache.get(String(id)) || null }
  };
  const member = { id: 'human', user: { bot: false } };
  voiceChannel.members.set(member.id, member);
  await handleVoiceActivityWindowStateUpdate(
    { channelId: null, channel: null, member, guild },
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild, client }
  );
  const soloOpen = db.vcActivityWindows.getOpen({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile', voiceChannelId: 'voice' });
  assert.ok(soloOpen);
  assert.equal(JSON.parse(soloOpen.participantIdsJson)[0], 'human');
  voiceChannel.members.clear();
  await handleVoiceActivityWindowStateUpdate(
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild },
    { channelId: null, channel: null, member, guild, client }
  );
  const episodes = db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' });
  assert.equal(episodes.length, 1);
  assert.deepEqual(JSON.parse(episodes[0].participantIdsJson), ['human']);
  assert.equal(sentMessages.length, 1);

  voiceChannel.members.set(member.id, member);
  await handleVoiceActivityWindowStateUpdate(
    { channelId: null, channel: null, member, guild },
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild, client }
  );
  const restartOpen = db.vcActivityWindows.getOpen({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile', voiceChannelId: 'voice' });
  await reconcileVoiceActivityWindows(client, { reason: 'probe_restart' });
  const restartResumed = db.vcActivityWindows.getOpen({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile', voiceChannelId: 'voice' });
  assert.equal(restartResumed.windowId, restartOpen.windowId);
  assert.equal(restartResumed.startedAt, restartOpen.startedAt);
  assert.equal(sentMessages.length, 1, 'ready reconciliation must edit the tracked short card instead of duplicating it');
  voiceChannel.members.clear();
  await handleVoiceActivityWindowStateUpdate(
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild },
    { channelId: null, channel: null, member, guild, client }
  );
  const restartEpisodes = db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' });
  assert.equal(restartEpisodes.filter((episode) => episode.stableEpisodeKey.includes(restartOpen.windowId)).length, 1);

  voiceChannel.members.set(member.id, member);
  await handleVoiceActivityWindowStateUpdate(
    { channelId: null, channel: null, member, guild },
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild, client }
  );
  voiceChannel.members.clear();
  moveChannel.members.set(member.id, member);
  await handleVoiceActivityWindowStateUpdate(
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild },
    { channelId: moveChannel.id, channel: moveChannel, member, guild, client }
  );
  const moveEpisodes = db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' });
  assert.equal(moveEpisodes[0].voiceChannelId, 'voice');
  assert.ok(db.vcActivityWindows.getOpen({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile', voiceChannelId: 'voice-y' }));
  moveChannel.members.clear();
  await handleVoiceActivityWindowStateUpdate(
    { channelId: moveChannel.id, channel: moveChannel, member, guild },
    { channelId: null, channel: null, member, guild, client }
  );

  const memberB = { id: 'human-b', user: { bot: false } };
  voiceChannel.members.set(member.id, member);
  voiceChannel.members.set(memberB.id, memberB);
  await handleVoiceActivityWindowStateUpdate(
    { channelId: null, channel: null, member, guild },
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild, client }
  );
  await handleVoiceActivityWindowStateUpdate(
    { channelId: null, channel: null, member: memberB, guild },
    { channelId: voiceChannel.id, channel: voiceChannel, member: memberB, guild, client }
  );
  voiceChannel.members.clear();
  await handleVoiceActivityWindowStateUpdate(
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild },
    { channelId: null, channel: null, member, guild, client }
  );
  await handleVoiceActivityWindowStateUpdate(
    { channelId: voiceChannel.id, channel: voiceChannel, member: memberB, guild },
    { channelId: null, channel: null, member: memberB, guild, client }
  );
  const groupedEpisodes = db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' });
  const groupedEpisode = groupedEpisodes.find((episode) => {
    const ids = JSON.parse(episode.participantIdsJson);
    return ids.length === 2 && ids.includes('human') && ids.includes('human-b');
  });
  assert.ok(groupedEpisode);
  assert.equal(groupedEpisodes.filter((episode) => {
    const ids = JSON.parse(episode.participantIdsJson);
    return ids.length === 2 && ids.includes('human') && ids.includes('human-b');
  }).length, 1, 'one real-world two-human short call must create exactly one episode');
  assert.equal(sentMessages.length, 1, 'rolling card must be edited rather than scattered');
  assert.ok(editCount >= 1);
  const episodeCountBeforeLegacyAttempt = groupedEpisodes.length;
  assert.equal(await recordShortActivityForIgnoredSession(client, {
    guildId: 'guild',
    sessionId: 'legacy-duplicate-attempt',
    categoryId: 'category',
    profileChannelId: 'profile',
    mainVoiceChannelId: 'voice',
    startedAt: '2026-07-14T00:00:00.000Z',
    endedAt: '2026-07-14T00:01:00.000Z',
    allParticipantIdsJson: '["human","human-b"]',
    maxHumanCount: 2
  }), false, 'legacy ignored-session insertion must be disabled when activity windows are authoritative');
  assert.equal(
    db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' }).length,
    episodeCountBeforeLegacyAttempt
  );
  const trackedShortMessage = sentMessages[0];
  assert.equal(await hideShortActivityCardForLiveProfile(client, {
    guildId: 'guild', categoryId: 'category', profileChannelId: 'profile'
  }), false);
  assert.equal(trackedShortMessage.deleted, undefined, 'live profile coexistence must not delete the rolling short card');

  client.db.vcShortActivity.insertEpisode({
    stableEpisodeKey: 'probe-old-short-voice',
    guildId: 'guild',
    categoryId: 'category',
    profileChannelId: 'profile',
    voiceChannelId: 'voice',
    startedAt: '2026-07-14T00:00:00.000Z',
    endedAt: '2026-07-14T00:03:00.000Z',
    durationSeconds: 180,
    participantIds: ['old'],
    peakHumanCount: 1,
    closeReason: 'probe'
  });
  client.db.vcShortActivity.insertEpisode({
    stableEpisodeKey: 'probe-old-short-voice-y',
    guildId: 'guild',
    categoryId: 'category',
    profileChannelId: 'profile',
    voiceChannelId: 'voice-y',
    startedAt: '2026-07-14T00:00:00.000Z',
    endedAt: '2026-07-14T00:03:00.000Z',
    durationSeconds: 180,
    participantIds: ['old-y'],
    peakHumanCount: 1,
    closeReason: 'probe'
  });
  const meaningfulStart = '2026-07-14T01:00:00.000Z';
  const meaningfulEnd = '2026-07-14T01:10:00.000Z';
  client.db.vcVoiceSessions.upsert({
    guildId: 'guild',
    sessionId: 'meaningful-session',
    categoryId: 'category',
    profileChannelId: 'profile',
    status: 'closed',
    startedAt: meaningfulStart,
    endedAt: meaningfulEnd,
    firstTwoPlusAt: meaningfulStart,
    lastTwoPlusAt: meaningfulEnd,
    maxHumanCount: 2,
    peakMemberIdsJson: '["human","human-b"]',
    allParticipantIdsJson: '["human","human-b"]',
    mainVoiceChannelId: 'voice',
    voiceChannelIdsJson: '["voice"]',
    twoPlusTotalSeconds: 600,
    createdAt: meaningfulStart,
    updatedAt: meaningfulEnd
  });
  voiceChannel.members.set(member.id, member);
  voiceChannel.members.set(memberB.id, memberB);
  await handleVoiceActivityWindowStateUpdate(
    { channelId: null, channel: null, member, guild },
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild, client }
  );
  const meaningfulWindow = db.vcActivityWindows.getOpen({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile', voiceChannelId: 'voice' });
  db.sqlite.prepare(`
    UPDATE vc_activity_windows
    SET started_at = ?, participant_ids_json = ?, participant_intervals_json = ?, peak_human_count = ?
    WHERE guild_id = ? AND window_id = ?
  `).run(
    meaningfulStart,
    JSON.stringify(['human', 'human-b']),
    JSON.stringify({
      human: [{ joinedAt: meaningfulStart, leftAt: null }],
      'human-b': [{ joinedAt: meaningfulStart, leftAt: null }]
    }),
    2,
    'guild',
    meaningfulWindow.windowId
  );
  voiceChannel.members.clear();
  await handleVoiceActivityWindowStateUpdate(
    { channelId: voiceChannel.id, channel: voiceChannel, member, guild },
    { channelId: null, channel: null, member, guild, client }
  );
  const meaningfulClosed = db.sqlite.prepare(`
    SELECT qualified_meaningful AS qualifiedMeaningful, meaningful_session_id AS meaningfulSessionId
    FROM vc_activity_windows WHERE guild_id = ? AND window_id = ?
  `).get('guild', meaningfulWindow.windowId);
  assert.equal(meaningfulClosed.qualifiedMeaningful, 1);
  assert.equal(meaningfulClosed.meaningfulSessionId, 'meaningful-session');
  assert.equal(
    db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' })
      .filter((episode) => episode.stableEpisodeKey.includes(meaningfulWindow.windowId)).length,
    0,
    'meaningful activity window must not create a short episode'
  );
  await client.db.vcShortActivity.clearChannel({
    guildId: 'guild',
    categoryId: 'category',
    profileChannelId: 'profile',
    voiceChannelId: 'voice'
  });
  const afterChannelClear = db.vcShortActivity.listEpisodes({ guildId: 'guild', categoryId: 'category', profileChannelId: 'profile', limit: 100 });
  assert.ok(afterChannelClear.some((episode) => episode.voiceChannelId === 'voice-y' && episode.stableEpisodeKey === 'probe-old-short-voice-y'));
  assert.ok(!afterChannelClear.some((episode) => episode.voiceChannelId === 'voice' && episode.stableEpisodeKey === 'probe-old-short-voice'));

  messageStore.clear();
  await updateShortActivityCard(client, { guildId: 'guild', categoryId: 'category', profileChannelId: 'profile' });
  assert.equal(sentMessages.length, 2, 'a manually deleted rolling card must be recreated');
  const afkChannel = { ...voiceChannel, id: 'afk' };
  assert.equal(getScope(client, afkChannel), null);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otaku-focused-probe-'));
  const db = createDatabase(path.join(tempRoot, 'probe.sqlite'));
  try {
    await probeSoloVcWindow(db);
    process.stdout.write('focused follow-up probes passed\n');
  } finally {
    db.sqlite.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
