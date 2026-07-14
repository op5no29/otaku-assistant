const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../src/db/database');
const {
  calculateAnimeStatusAfterReactionRemoval,
  getAnimeStatusReactionEmojis,
  handleAnimeReactionRemove,
  reconcileAnimeCardControls
} = require('../src/modules/anime');
const { buildAnimeChannelCard, buildAnimeReviewUiCard } = require('../src/modules/anime/buildAnimeMessages');
const { encryptAccessToken, updateAnnictStatusForAnimeEntry } = require('../src/modules/annictUserIntegration');

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function collectLabels(value, labels = []) {
  if (!value || typeof value !== 'object') return labels;
  if (typeof value.label === 'string') labels.push(value.label);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectLabels(child, labels);
  }
  return labels;
}

function buildCardEntry(overrides = {}) {
  return {
    id: 1,
    guildId: 'guild',
    provider: 'annict',
    providerMediaId: '123',
    titleNative: '日本語作品',
    siteUrl: 'https://annict.com/works/123',
    ...overrides
  };
}

function buildStats() {
  return {
    interestedCount: 2,
    watchedCount: 1,
    reviewCount: 1,
    threadUrl: 'https://discord.com/channels/1/2',
    parentUrl: 'https://discord.com/channels/1/3/4',
    maxCastInCard: 5
  };
}

function probeCardControls() {
  const parentLabels = collectLabels(buildAnimeChannelCard(buildCardEntry(), buildStats()).components[0].toJSON());
  const reviewLabels = collectLabels(buildAnimeReviewUiCard(buildCardEntry(), buildStats()).components[0].toJSON());
  for (const labels of [parentLabels, reviewLabels]) {
    assert.ok(!labels.includes('気になる'));
    assert.ok(!labels.includes('視聴済み'));
  }
  assert.ok(parentLabels.includes('作品スレッドへ飛ぶ'));
  assert.ok(parentLabels.includes('Annictで開く'));
  assert.ok(reviewLabels.includes('作品カードへ飛ぶ'));
  assert.ok(reviewLabels.includes('Annictで開く'));

  const emojis = getAnimeStatusReactionEmojis({
    appConfig: { anime: { interestEmoji: '👀', watchedEmoji: '✅' } }
  });
  assert.deepEqual(emojis, { interested: '👀', watched: '✅' });
}

function probeEffectiveRemovalStates() {
  assert.equal(calculateAnimeStatusAfterReactionRemoval({ interested: 1, watched: 0 }, 'interested').targetKind, 'no_status');
  assert.equal(calculateAnimeStatusAfterReactionRemoval({ interested: 0, watched: 1 }, 'watched').targetKind, 'no_status');
  assert.equal(calculateAnimeStatusAfterReactionRemoval({ interested: 1, watched: 1 }, 'interested').targetKind, 'watched');
  assert.equal(calculateAnimeStatusAfterReactionRemoval({ interested: 1, watched: 1 }, 'watched').targetKind, 'wanna_watch');
}

function installConnection(db, { guildId, userId, token, key }) {
  const encrypted = encryptAccessToken(token, { guildId, discordUserId: userId, key });
  db.annictUserIntegration.upsertConnection({
    guildId,
    discordUserId: userId,
    annictResourceOwnerId: `owner-${userId}`,
    ...encrypted,
    scopes: ['read', 'write'],
    tokenStatus: 'active'
  });
}

function makeClient(db) {
  return {
    appConfig: {
      anime: {
        enabled: true,
        interestEmoji: '👀',
        watchedEmoji: '✅',
        maxCastInCard: 5,
        maxReviewsInCard: 5,
        cardReconcileDelayMs: 250
      },
      annict: { timeoutMs: 1000 },
      annictUserIntegration: {
        enabled: true,
        oauthClientIdEnv: 'PROBE_ANNICT_CLIENT_ID',
        oauthClientSecretEnv: 'PROBE_ANNICT_CLIENT_SECRET',
        tokenEncryptionKeyEnv: 'PROBE_ANNICT_ENCRYPTION_KEY'
      }
    },
    annictStatusLocks: new Set(),
    db,
    logger: noopLogger(),
    channels: { fetch: async () => null },
    guilds: { cache: new Map(), fetch: async () => ({}) }
  };
}

async function probeAnnictBoundaryAndIsolation(db) {
  const key = Buffer.alloc(32, 11);
  process.env.PROBE_ANNICT_CLIENT_ID = 'probe-client';
  process.env.PROBE_ANNICT_CLIENT_SECRET = 'probe-secret';
  process.env.PROBE_ANNICT_ENCRYPTION_KEY = key.toString('base64');
  installConnection(db, { guildId: 'guild', userId: 'user-a', token: 'token-a', key });
  installConnection(db, { guildId: 'guild', userId: 'user-b', token: 'token-b', key });

  const client = makeClient(db);
  const entry = buildCardEntry({ id: 99 });
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({
      kind: new URL(String(url)).searchParams.get('kind'),
      authorization: options?.headers?.Authorization || null
    });
    return { status: 204 };
  };
  try {
    await updateAnnictStatusForAnimeEntry(client, {
      guildId: 'guild', userId: 'user-a', entry, action: 'interested',
      idempotencyKey: 'add-interested-a', source: 'probe', updateLocal: false
    });
    await updateAnnictStatusForAnimeEntry(client, {
      guildId: 'guild', userId: 'user-b', entry, action: 'watched',
      idempotencyKey: 'add-watched-b', source: 'probe', updateLocal: false
    });
    await updateAnnictStatusForAnimeEntry(client, {
      guildId: 'guild', userId: 'user-a', entry, targetKind: 'no_status',
      idempotencyKey: 'remove-final-a', source: 'probe', updateLocal: false
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { kind: 'wanna_watch', authorization: 'Bearer token-a' },
    { kind: 'watched', authorization: 'Bearer token-b' },
    { kind: 'no_status', authorization: 'Bearer token-a' }
  ]);
  assert.equal(db.annictUserIntegration.getUserWorkState('guild', 'user-a', '123').status, 'no_status');
  return client;
}

async function probeFailedRemovalPreservesLocalState(db, client, entry) {
  db.anime.upsertUserStatus({
    guildId: 'guild', animeEntryId: entry.id, userId: 'user-a',
    interested: 1, watched: 0, interestedAt: new Date().toISOString()
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 500 });
  let restoredUserId = null;
  let privateNoticeCount = 0;
  try {
    await handleAnimeReactionRemove({
      emoji: { name: '👀' },
      users: { add: async (userId) => { restoredUserId = userId; } },
      message: {
        id: entry.animeChannelMessageId,
        guildId: 'guild',
        partial: false,
        client
      }
    }, {
      id: 'user-a',
      bot: false,
      send: async () => { privateNoticeCount += 1; }
    });
  } finally {
    global.fetch = originalFetch;
  }
  const status = db.anime.getUserStatus('guild', entry.id, 'user-a');
  assert.equal(status.interested, 1);
  assert.equal(status.watched, 0);
  assert.equal(restoredUserId, 'user-a');
  assert.equal(privateNoticeCount, 1);
}

async function probeControlledExistingCardReconciliation(db, client, entry) {
  const nativeReactions = new Map([['👀', { count: 2 }], ['✅', { count: 1 }]]);
  let releaseEdit;
  const editGate = new Promise((resolve) => { releaseEdit = resolve; });
  let editedPayload = null;
  const message = {
    id: entry.animeChannelMessageId,
    reactions: { cache: nativeReactions },
    async edit(payload) {
      await editGate;
      editedPayload = payload;
      return this;
    }
  };
  client.channels.fetch = async (channelId) => (
    channelId === entry.animeChannelId
      ? { messages: { fetch: async (messageId) => messageId === message.id ? message : null } }
      : null
  );
  client.guilds.fetch = async () => ({});

  const first = reconcileAnimeCardControls(client, { guildId: 'guild', delayMs: 0 });
  const overlapping = await reconcileAnimeCardControls(client, { guildId: 'guild', delayMs: 0 });
  assert.deepEqual(overlapping, { skipped: true, reason: 'already_running' });
  releaseEdit();
  const result = await first;
  assert.equal(result.updated, 1);
  assert.ok(editedPayload);
  assert.equal(message.id, entry.animeChannelMessageId);
  assert.equal(message.reactions.cache, nativeReactions);
  const refreshed = db.anime.getEntryById(entry.id);
  assert.equal(refreshed.threadId, entry.threadId);
  assert.equal(db.anime.countEntries('guild'), 1);
  const labels = collectLabels(editedPayload.components[0].toJSON());
  assert.ok(!labels.includes('気になる'));
  assert.ok(!labels.includes('視聴済み'));
}

async function main() {
  probeCardControls();
  probeEffectiveRemovalStates();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-reaction-controls-'));
  const dbPath = path.join(tempRoot, 'probe.sqlite');
  const db = createDatabase(dbPath);
  try {
    db.anime.upsertEntry({
      guildId: 'guild',
      provider: 'annict',
      providerMediaId: '123',
      siteUrl: 'https://annict.com/works/123',
      animeChannelId: 'anime-channel',
      animeChannelMessageId: 'anime-message',
      threadId: 'anime-thread'
    });
    const entry = db.anime.getEntryByProviderMediaId('guild', 'annict', '123');
    const client = await probeAnnictBoundaryAndIsolation(db);
    await probeFailedRemovalPreservesLocalState(db, client, entry);
    await probeControlledExistingCardReconciliation(db, client, entry);
  } finally {
    db.sqlite.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.PROBE_ANNICT_CLIENT_ID;
    delete process.env.PROBE_ANNICT_CLIENT_SECRET;
    delete process.env.PROBE_ANNICT_ENCRYPTION_KEY;
  }

  console.log(JSON.stringify({
    ok: true,
    probe: 'anime-reaction-controls',
    mockedAnnictApi: true,
    mockedDiscordCardEdit: true,
    liveDiscordTest: false,
    liveAnnictTest: false
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
