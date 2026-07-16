const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('../src/db/database');
const { extractTimelineComponentData } = require('../src/modules/timelineRestoration/componentsParser');
const { stableUploadName, detectType } = require('../src/modules/timelineRestoration/mediaMirror');
const { buildCompletionPayload, buildProgressPayload } = require('../src/modules/timelineRestoration/ui');
const {
  sanitizeWebhookUsername,
  moveProgressCardToBottom,
  postRestorationItem,
  persistJobCounts,
  finalizeRestoration
} = require('../src/modules/timelineRestoration/worker');
const {
  handleTimelineRestoreCommand,
  handleTimelineRestorationInteraction
} = require('../src/modules/timelineRestoration');
const { sanitizeLogValue } = require('../src/services/logger');
const { diagnoseTimelineOwner } = require('../src/modules/timelineRestoration/ownerDiagnostics');
const commands = require('../src/commands');

const IDS = Object.freeze({
  guild: '1224747669122056232',
  forum: '1501111111111111111',
  outsideForum: '1501111111111111112',
  guildOwner: '323456789012345678',
  historicalA: '1454160830487728391',
  historicalB: '1454160830487728392',
  historicalUnmapped: '609027783246741515',
  authorB: '1454160830487728393',
  authorC: '1454160830487728394',
  admin: '423456789012345678',
  oldThreadA: '1502111111111111111',
  oldThreadOwner: '1502111111111111112',
  testThread: '1503111111111111111',
  secondTestThread: '1503111111111111112',
  ownerSelfTestThread: '1503111111111111113',
  legacyTestThread: '1503111111111111114',
  legacyConflictThread: '1503111111111111115',
  normalThread: '1504111111111111111',
  sourceA: '1505111111111111111',
  sourceB: '1505111111111111112',
  sourceC: '1505111111111111113',
  sourceOwner: '1505111111111111114',
  legacyUnknownThread: '1503795619293036694',
  legacyUnrelatedThread: '1510995196987310110'
});

function snapshotRecord(overrides = {}) {
  const now = overrides.sourceCreatedAt || new Date().toISOString();
  return {
    guildId: IDS.guild,
    sourceForumId: IDS.forum,
    sourceThreadId: overrides.sourceThreadId || IDS.oldThreadA,
    sourceMessageId: overrides.sourceMessageId || IDS.sourceA,
    threadOwnerUserId: overrides.threadOwnerUserId || IDS.historicalA,
    authorUserId: overrides.authorUserId || IDS.historicalA,
    authorUsernameSnapshot: overrides.authorUsernameSnapshot || 'user',
    authorGlobalNameSnapshot: null, authorDisplayNameSnapshot: overrides.authorDisplayNameSnapshot || '投稿者',
    authorNicknameSnapshot: null,
    authorAvatarUrlSnapshot: overrides.authorAvatarUrlSnapshot || 'https://cdn.discordapp.com/avatar.png',
    authorAvatarHashSnapshot: 'hash', authorAvatarSource: 'source_message_snapshot', authorIsBot: 0,
    content: overrides.content || '本文', cleanContent: overrides.content || '本文',
    attachmentsJson: '[]', embedsJson: '[]', componentsJson: '[]', stickersJson: '[]', reactionsJson: '[]',
    referencedSourceMessageId: overrides.referencedSourceMessageId || null,
    referencedAuthorUserId: null, referencedAuthorNameSnapshot: null, referencedContentSnapshot: null,
    replyKind: overrides.referencedSourceMessageId ? 'discord_reply' : 'not_a_reply', messageType: 0,
    sequenceSnowflake: overrides.sourceMessageId || '100', sourceCreatedAt: now, sourceEditedAt: null,
    sourceDeletedAt: null, timelineMessageId: null, timelineChannelId: null,
    timelineCardPayloadJson: null, timelineCardAuthorAvatarUrl: null,
    snapshotSource: 'probe', restorationFidelity: 'exact_historical_snapshot', restoreEligible: 1,
    qualityJson: '{}', createdAt: now, updatedAt: now
  };
}

function createProbeThread({ id, ownerId, parentId = IDS.forum, sendFailure = null }) {
  const sent = [];
  const messages = new Map();
  return {
    id,
    guildId: IDS.guild,
    parentId,
    parent: { id: parentId },
    ownerId,
    archived: false,
    locked: false,
    rateLimitPerUser: 0,
    appliedTags: [],
    sent,
    messageStore: messages,
    isThread: () => true,
    async fetchOwner() { return { id: ownerId }; },
    async setArchived(value) { this.archived = value; },
    async setLocked(value) { this.locked = value; },
    async setRateLimitPerUser(value) { this.rateLimitPerUser = value; },
    async setAppliedTags(value) { this.appliedTags = value; },
    async send(payload) {
      if (sendFailure) throw sendFailure;
      const message = {
        id: `${id.slice(0, 14)}${String(sent.length + 1).padStart(5, '0')}`,
        payload,
        components: payload.components || [],
        author: { id: '999999999999999999' },
        deleted: false,
        async delete() {
          this.deleted = true;
          messages.delete(this.id);
        }
      };
      sent.push(message);
      messages.set(message.id, message);
      return message;
    },
    messages: {
      async fetch(target) {
        if (typeof target === 'string') return messages.get(target) || null;
        return null;
      }
    }
  };
}

function createProbeInteraction({
  client,
  guild,
  userId,
  destinationThread,
  historicalUserId = null,
  sourceThreadId = null,
  subcommand = 'force-start'
}) {
  const replies = [];
  return {
    id: `interaction-${userId}`,
    guildId: IDS.guild,
    guild,
    user: { id: userId },
    member: {
      permissions: { has: () => true }
    },
    client,
    channel: subcommand === 'start' ? destinationThread : { isThread: () => false },
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => {
        if (name === 'historical-user') return historicalUserId;
        if (name === 'source-thread') return sourceThreadId;
        throw new Error(`Unexpected string option: ${name}`);
      },
      getChannel: (name) => {
        assert.equal(name, 'destination-thread');
        return destinationThread;
      }
    },
    async deferReply(options) { this.deferred = options; },
    async editReply(payload) { replies.push(payload); this.lastReply = payload; return payload; },
    replies
  };
}

async function main() {
  const dbPath = path.join('/tmp', `otaku-timeline-probe-${process.pid}.db`);
  try { fs.unlinkSync(dbPath); } catch {}
  let db = createDatabase(dbPath);
  const now = new Date().toISOString();
  const firstEpisode = db.timelineRestoration.membership.open({
    guildId: IDS.guild, userId: IDS.historicalA, joinedAt: now, username: 'owner-a', globalName: null,
    displayName: '所有者A', nickname: null, avatarUrl: null, avatarHash: null, createdAt: now
  });
  const duplicateOpen = db.timelineRestoration.membership.open({
    guildId: IDS.guild, userId: IDS.historicalA, joinedAt: now, username: 'owner-a', globalName: null,
    displayName: '所有者A', nickname: null, avatarUrl: null, avatarHash: null, createdAt: now
  });
  assert.equal(firstEpisode.episodeId, duplicateOpen.episodeId, 'ready reconciliation must not duplicate open episodes');
  db.timelineRestoration.membership.close(IDS.guild, IDS.historicalA, now);
  const secondEpisode = db.timelineRestoration.membership.open({
    guildId: IDS.guild, userId: IDS.historicalA, joinedAt: now, username: 'owner-a', globalName: null,
    displayName: '所有者A', nickname: null, avatarUrl: null, avatarHash: null, createdAt: now
  });
  assert.equal(secondEpisode.episodeId, firstEpisode.episodeId + 1, 'rejoin must open a new episode');

  db.timelineRestoration.userThreads.upsert({
    guildId: IDS.guild, ownerUserId: IDS.historicalA, forumChannelId: IDS.forum,
    threadId: IDS.oldThreadA, threadName: '過去A', starterMessageId: IDS.sourceA,
    status: 'legacy_missing', deletionReason: 'legacy_missing', createdAt: now,
    archivedAt: null, lockedAt: null, membershipEpisodeId: firstEpisode.episodeId, updatedAt: now
  });
  db.timelineRestoration.userThreads.upsert({
    guildId: IDS.guild, ownerUserId: IDS.guildOwner, forumChannelId: IDS.forum,
    threadId: IDS.oldThreadOwner, threadName: '過去GuildOwner', starterMessageId: IDS.sourceOwner,
    status: 'legacy_missing', deletionReason: 'legacy_missing', createdAt: now,
    archivedAt: null, lockedAt: null, membershipEpisodeId: null, updatedAt: now
  });
  const a = db.timelineRestoration.snapshots.upsert(snapshotRecord({
    sourceMessageId: IDS.sourceA,
    authorUserId: IDS.historicalA,
    authorDisplayNameSnapshot: 'A',
    authorAvatarUrlSnapshot: 'https://cdn.example/a.png',
    content: 'A本文'
  }));
  const b = db.timelineRestoration.snapshots.upsert(snapshotRecord({
    sourceMessageId: IDS.sourceB,
    authorUserId: IDS.authorB,
    authorDisplayNameSnapshot: 'B',
    authorAvatarUrlSnapshot: 'https://cdn.example/b.png',
    content: 'B本文',
    referencedSourceMessageId: IDS.sourceA
  }));
  const c = db.timelineRestoration.snapshots.upsert(snapshotRecord({
    sourceMessageId: IDS.sourceC,
    authorUserId: IDS.authorC,
    authorDisplayNameSnapshot: 'C',
    authorAvatarUrlSnapshot: 'https://cdn.example/c.png',
    content: 'C本文'
  }));
  db.timelineRestoration.media.upsert({
    guildId: IDS.guild,
    snapshotId: c.snapshotId,
    sourceMessageId: IDS.sourceC,
    sourceUrl: 'https://media.invalid.example/c.png',
    proxyUrl: null,
    timelineMessageId: null,
    timelineAttachmentId: null,
    timelineAttachmentUrl: null,
    componentMediaUrl: null,
    originalFilename: 'c.png',
    safeFilename: `${IDS.sourceC}-1-c.png`,
    contentType: 'image/png',
    byteSize: 0,
    sha256: null,
    localPath: null,
    mediaKind: 'image',
    sourceKind: 'source_attachment',
    spoiler: 0,
    width: null,
    height: null,
    durationSeconds: null,
    downloadStatus: 'pending',
    lastErrorCode: null,
    firstDownloadedAt: null,
    lastVerifiedAt: null,
    createdAt: now,
    updatedAt: now
  });
  db.timelineRestoration.snapshots.upsert(snapshotRecord({
    sourceThreadId: IDS.oldThreadOwner,
    sourceMessageId: IDS.sourceOwner,
    threadOwnerUserId: IDS.guildOwner,
    authorUserId: IDS.guildOwner,
    authorDisplayNameSnapshot: 'GuildOwner',
    authorAvatarUrlSnapshot: 'https://cdn.example/guild-owner.png',
    content: 'Owner本文'
  }));
  const ordered = db.timelineRestoration.snapshots.listByThreads(IDS.guild, [IDS.oldThreadA]);
  assert.deepEqual(
    ordered.map((row) => row.authorUserId),
    [IDS.historicalA, IDS.authorB, IDS.authorC],
    'A/B/C identities and order must be retained'
  );
  db.timelineRestoration.snapshots.markDeleted(IDS.guild, IDS.sourceB, now);
  assert.ok(db.timelineRestoration.snapshots.get(IDS.guild, IDS.sourceB).sourceDeletedAt, 'source deletion must retain and mark snapshot');

  const componentData = extractTimelineComponentData({
    components: [{
      type: 17,
      components: [
        { type: 10, content: '**B さんが投稿しました**' },
        { type: 9, components: [{ type: 10, content: '本文' }], accessory: { type: 11, media: { url: 'https://cdn.example/avatar.png' }, description: 'B のアイコン' } },
        { type: 12, items: [{ media: { url: 'attachment://100-1-image.png' } }] }
      ]
    }]
  });
  assert.equal(componentData.authorName, 'B');
  assert.equal(componentData.authorAvatarUrl, 'https://cdn.example/avatar.png');
  assert.equal(componentData.attachmentReferences[0].filename, '100-1-image.png');

  assert.notEqual(stableUploadName('100', 0, 'same.png'), stableUploadName('101', 0, 'same.png'));
  assert.equal(detectType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png').kind, 'image');
  assert.equal(sanitizeWebhookUsername('日本語ユーザー'), '日本語ユーザー');
  assert.notEqual(sanitizeWebhookUsername('Discord Clyde'), 'Discord Clyde');
  assert.equal(sanitizeLogValue({ attachmentUrl: 'https://cdn.example/a.png?secret=1' }).attachmentUrl, 'https://cdn.example/a.png');
  assert.equal(
    sanitizeLogValue({ error: 'fetch https://cdn.example/a.png?secret=1 failed' }).error,
    'fetch https://cdn.example/a.png failed'
  );
  assert.match(sanitizeLogValue({ rawContent: '秘密の本文' }).rawContent, /^\[REDACTED_CONTENT:/u);

  const progress = buildProgressPayload({
    jobId: 1, completedItemCount: 1, failedItemCount: 0, skippedItemCount: 0,
    totalItemCount: 3, imageRestoredCount: 1, videoRestoredCount: 0,
    fileRestoredCount: 0, replyRestoredCount: 1
  });
  assert.equal(progress.components.length, 1);
  assert.equal(progress.allowedMentions.parse.length, 0);
  const completion = buildCompletionPayload({
    jobId: 1,
    guildId: IDS.guild,
    ownerUserId: IDS.historicalA,
    sourceThreadIdsJson: JSON.stringify([IDS.oldThreadA]),
    destinationThreadId: IDS.normalThread,
    startedAt: now,
    status: 'completed',
    completedAt: now,
    completedItemCount: 3,
    failedItemCount: 0,
    skippedItemCount: 0,
    imageRestoredCount: 1,
    videoRestoredCount: 0,
    fileRestoredCount: 0,
    replyRestoredCount: 1,
    qualityJson: '{}'
  }, Buffer.from('# log'));
  assert.equal(completion.files.length, 1);
  assert.ok(JSON.stringify(completion.components.map((component) => component.toJSON())).includes('attachment://timeline-restoration-'));
  assert.deepEqual(completion.allowedMentions.users, [IDS.historicalA]);
  const adminCompletion = buildCompletionPayload({
    jobId: 2,
    guildId: IDS.guild,
    ownerUserId: IDS.historicalA,
    sourceThreadIdsJson: JSON.stringify([IDS.oldThreadA]),
    destinationThreadId: IDS.testThread,
    startedAt: now,
    mode: 'admin_test',
    historicalOwnerUserId: IDS.historicalA,
    initiatorUserId: IDS.guildOwner,
    destinationTestThreadId: IDS.testThread,
    status: 'completed',
    completedAt: now,
    completedItemCount: 3,
    failedItemCount: 0,
    skippedItemCount: 0,
    imageRestoredCount: 1,
    videoRestoredCount: 0,
    fileRestoredCount: 0,
    replyRestoredCount: 1,
    qualityJson: '{}'
  }, Buffer.from('# log'));
  const adminCompletionJson = JSON.stringify(adminCompletion.components.map((component) => component.toJSON()));
  assert.ok(adminCompletionJson.includes('テスト復元が完了しました'));
  assert.ok(!adminCompletionJson.includes(`<@${IDS.historicalA}>`), 'admin test completion must not mention departed historical owner');
  assert.deepEqual(adminCompletion.allowedMentions.users, [IDS.guildOwner]);

  const timelineCommand = commands.registrationData.find((command) => command.name === 'timeline-restore');
  assert.ok(timelineCommand);
  const forceStart = timelineCommand.options.find((option) => option.name === 'force-start');
  assert.ok(forceStart);
  assert.ok(forceStart.options.some((option) => option.name === 'historical-user' && option.required));
  assert.ok(forceStart.options.some((option) => option.name === 'destination-thread' && option.required));
  assert.ok(forceStart.options.some((option) => option.name === 'source-thread' && !option.required));
  assert.ok(!forceStart.options.some((option) => option.name === 'test-mode'));

  const testThread = createProbeThread({ id: IDS.testThread, ownerId: IDS.guildOwner });
  const secondTestThread = createProbeThread({ id: IDS.secondTestThread, ownerId: IDS.guildOwner });
  const ownerSelfTestThread = createProbeThread({ id: IDS.ownerSelfTestThread, ownerId: IDS.guildOwner });
  const normalThread = createProbeThread({ id: IDS.normalThread, ownerId: IDS.historicalA });
  const legacyTestThread = createProbeThread({ id: IDS.legacyTestThread, ownerId: IDS.guildOwner });
  const legacyConflictThread = createProbeThread({ id: IDS.legacyConflictThread, ownerId: IDS.guildOwner });
  const channels = new Map([
    [testThread.id, testThread],
    [secondTestThread.id, secondTestThread],
    [ownerSelfTestThread.id, ownerSelfTestThread],
    [normalThread.id, normalThread],
    [legacyTestThread.id, legacyTestThread],
    [legacyConflictThread.id, legacyConflictThread]
  ]);
  const guild = {
    id: IDS.guild,
    ownerId: IDS.guildOwner,
    channels: { fetch: async (id) => channels.get(String(id)) || null }
  };
  const client = {
    appConfig: {
      watchedForums: { tweet: [IDS.forum] },
      timelineRestoration: {
        enabled: true,
        blockHumanMessagesDuringRestore: true,
        restorationNoticeCooldownMs: 1000,
        temporarySlowmodeSeconds: 0,
        restoringTagIds: {},
        restoreBotMessages: false,
        maxAttemptsPerItem: 5,
        delayBetweenBatchesMs: 5000
      },
      mediaRelay: { maxReuploadBytes: 25_000_000 }
    },
    db,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    timelineRestorationPermissionsReady: true,
    managedTimelineRestorationWebhookIds: new Set(),
    timelineRestorationJobLocks: new Set(),
    timelineRestorationNoticeCooldowns: new Map(),
    logDashboardUpdateTimers: new Map(),
    user: { id: '999999999999999999' },
    users: { fetch: async () => null }
  };
  client.db.relays = client.db.relays || { getThreadRelay: () => null };
  const rejectedNonOwner = createProbeInteraction({
    client,
    guild,
    userId: IDS.admin,
    destinationThread: testThread,
    historicalUserId: IDS.historicalA
  });
  await handleTimelineRestoreCommand(rejectedNonOwner);
  assert.match(String(rejectedNonOwner.lastReply || ''), /サーバー所有者/u);

  const malformed = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: testThread, historicalUserId: '<@invalid>'
  });
  await handleTimelineRestoreCommand(malformed);
  assert.match(String(malformed.lastReply || ''), /ユーザーID/u);

  const outsideThread = createProbeThread({
    id: '1503111111111111199', ownerId: IDS.guildOwner, parentId: IDS.outsideForum
  });
  const rejectedOutside = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: outsideThread, historicalUserId: IDS.historicalA
  });
  await handleTimelineRestoreCommand(rejectedOutside);
  assert.match(String(rejectedOutside.lastReply || ''), /設定済み/u);

  const memberOwnedThread = createProbeThread({ id: '1503111111111111198', ownerId: IDS.authorB });
  const rejectedMemberThread = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: memberOwnedThread, historicalUserId: IDS.historicalA
  });
  await handleTimelineRestoreCommand(rejectedMemberThread);
  assert.match(String(rejectedMemberThread.lastReply || ''), /サーバー所有者自身/u);

  const accepted = createProbeInteraction({
    client,
    guild,
    userId: IDS.guildOwner,
    destinationThread: testThread,
    historicalUserId: `<@!${IDS.historicalA}>`
  });
  await handleTimelineRestoreCommand(accepted);
  assert.match(String(accepted.lastReply?.content || ''), /テスト復元ジョブ/u);
  let adminJob = db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.testThread);
  assert.equal(adminJob.mode, 'admin_test');
  assert.equal(adminJob.ownerUserId, IDS.historicalA);
  assert.equal(adminJob.historicalOwnerUserId, IDS.historicalA);
  assert.equal(adminJob.initiatorUserId, IDS.guildOwner);
  assert.equal(adminJob.destinationTestThreadId, IDS.testThread);
  assert.equal(db.timelineRestoration.userThreads.get(IDS.guild, IDS.oldThreadA).replacementThreadId, null);

  const webhookPayloads = [];
  let webhookMessageCounter = 0;
  const webhook = {
    id: '888888888888888888',
    async send(payload) {
      webhookPayloads.push(payload);
      webhookMessageCounter += 1;
      return {
        id: `160000000000000000${webhookMessageCounter}`,
        async delete() {}
      };
    }
  };
  const initialItems = db.timelineRestoration.jobs.listItems(adminJob.jobId);
  await postRestorationItem(client, adminJob, initialItems[0], webhook, testThread);
  const postedFirst = db.timelineRestoration.jobs.getItem(adminJob.jobId, initialItems[0].snapshotId);
  assert.equal(postedFirst.status, 'posted');
  db.timelineRestoration.jobs.update(adminJob.jobId, {
    status: 'cancelled', cancelledAt: new Date().toISOString(), nextRunAt: null, updatedAt: new Date().toISOString()
  });
  const identityBase = {
    guildId: IDS.guild,
    destinationThreadId: IDS.testThread,
    mode: 'admin_test',
    historicalOwnerUserId: IDS.historicalA,
    ownerUserId: IDS.historicalA,
    initiatorUserId: IDS.guildOwner
  };
  assert.equal(
    db.timelineRestoration.jobs.resolveRequest({ ...identityBase, mode: 'normal' }).outcome,
    'conflict_different_mode'
  );
  assert.equal(
    db.timelineRestoration.jobs.resolveRequest({ ...identityBase, initiatorUserId: IDS.admin }).outcome,
    'conflict_different_initiator'
  );

  const conflict = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: testThread, historicalUserId: IDS.historicalB
  });
  await handleTimelineRestoreCommand(conflict);
  assert.match(String(conflict.lastReply || ''), /別の復元ジョブ/u);
  assert.equal(db.timelineRestoration.jobs.get(adminJob.jobId).status, 'cancelled');
  assert.equal(db.timelineRestoration.jobs.get(adminJob.jobId).historicalOwnerUserId, IDS.historicalA);

  const resumed = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: testThread, historicalUserId: IDS.historicalA
  });
  await handleTimelineRestoreCommand(resumed);
  assert.match(String(resumed.lastReply?.content || ''), /再開/u);
  adminJob = db.timelineRestoration.jobs.get(adminJob.jobId);
  assert.equal(adminJob.status, 'active');
  assert.equal(db.timelineRestoration.jobs.listPendingItems(adminJob.jobId, 10).some((item) => item.snapshotId === a.snapshotId), false);

  const remainingItems = db.timelineRestoration.jobs.listPendingItems(adminJob.jobId, 10);
  await Promise.all(remainingItems.map((item) => postRestorationItem(client, adminJob, item, webhook, testThread)));
  assert.equal(webhookPayloads.length, 3);
  const payloadA = webhookPayloads.find((payload) => payload.content === 'A本文');
  const payloadB = webhookPayloads.find((payload) => payload.content.endsWith('B本文'));
  const payloadC = webhookPayloads.find((payload) => payload.content.startsWith('C本文'));
  assert.equal(payloadA.username, 'A');
  assert.equal(payloadA.avatarURL, 'https://cdn.example/a.png');
  assert.equal(payloadB.username, 'B');
  assert.equal(payloadB.avatarURL, 'https://cdn.example/b.png');
  assert.equal(payloadC.username, 'C');
  assert.equal(payloadC.avatarURL, 'https://cdn.example/c.png');
  for (const payload of webhookPayloads) {
    assert.equal(payload.threadId, IDS.testThread);
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    assert.notEqual(payload.username, 'GuildOwner');
  }

  adminJob = persistJobCounts(client, adminJob.jobId);
  const sourceBeforeCompletion = db.timelineRestoration.userThreads.get(IDS.guild, IDS.oldThreadA);
  const snapshotBeforeCompletion = db.timelineRestoration.snapshots.get(IDS.guild, IDS.sourceA);
  const mediaBeforeCompletion = db.timelineRestoration.media.listBySnapshot(c.snapshotId);
  const completedAdminJob = await finalizeRestoration(client, adminJob, testThread);
  assert.equal(completedAdminJob.status, 'completed');
  const sourceAfterCompletion = db.timelineRestoration.userThreads.get(IDS.guild, IDS.oldThreadA);
  assert.equal(sourceAfterCompletion.replacementThreadId, sourceBeforeCompletion.replacementThreadId);
  assert.equal(sourceAfterCompletion.restorationJobId, sourceBeforeCompletion.restorationJobId);
  assert.deepEqual(db.timelineRestoration.snapshots.get(IDS.guild, IDS.sourceA), snapshotBeforeCompletion);
  assert.deepEqual(db.timelineRestoration.media.listBySnapshot(c.snapshotId), mediaBeforeCompletion);
  const completionMessage = testThread.messageStore.get(completedAdminJob.completionMessageId);
  assert.ok(completionMessage);
  assert.deepEqual(completionMessage.payload.allowedMentions.users, [IDS.guildOwner]);
  const completionJson = JSON.stringify(completionMessage.payload.components.map((component) => component.toJSON()));
  assert.ok(completionJson.includes('テスト復元が完了しました'));
  assert.ok(!completionJson.includes(`<@${IDS.historicalA}>`));
  const logText = completionMessage.payload.files[0].attachment.toString('utf8');
  assert.ok(logText.includes(`historical_owner_user_id: "${IDS.historicalA}"`));
  assert.ok(logText.includes(`initiator_user_id: "${IDS.guildOwner}"`));
  assert.ok(logText.includes(`destination_test_thread_id: "${IDS.testThread}"`));
  assert.ok(logText.includes('- Identity fallbacks: 0'));

  const completedRetry = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: testThread, historicalUserId: IDS.historicalA
  });
  await handleTimelineRestoreCommand(completedRetry);
  assert.match(String(completedRetry.lastReply || ''), /完了済み/u);
  assert.equal(db.timelineRestoration.jobs.get(adminJob.jobId).status, 'completed');

  let dismissReply = null;
  await handleTimelineRestorationInteraction({
    client,
    guild,
    user: { id: IDS.guildOwner },
    customId: `timeline_restore:dismiss:${completedAdminJob.jobId}`,
    message: completionMessage,
    isButton: () => true,
    async deferUpdate() {},
    async followUp(payload) { dismissReply = payload; },
    async reply(payload) { dismissReply = payload; }
  });
  assert.equal(dismissReply, null);
  assert.equal(completionMessage.deleted, true);

  const ownerSelfAccepted = createProbeInteraction({
    client, guild, userId: IDS.guildOwner, destinationThread: ownerSelfTestThread, historicalUserId: IDS.guildOwner
  });
  await handleTimelineRestoreCommand(ownerSelfAccepted);
  const ownerSelfJob = db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.ownerSelfTestThread);
  assert.equal(ownerSelfJob.mode, 'admin_test', 'force-start must remain admin_test even when owners match');
  assert.equal(db.timelineRestoration.userThreads.get(IDS.guild, IDS.oldThreadOwner).replacementThreadId, null);

  db.timelineRestoration.userThreads.upsert({
    guildId: IDS.guild,
    ownerUserId: IDS.authorB,
    forumChannelId: IDS.forum,
    threadId: IDS.legacyUnknownThread,
    threadName: 'legacy unknown owner',
    starterMessageId: null,
    status: 'legacy_missing',
    deletionReason: 'legacy_missing',
    createdAt: now,
    archivedAt: null,
    lockedAt: null,
    membershipEpisodeId: null,
    updatedAt: now
  });
  for (let index = 0; index < 125; index += 1) {
    const sourceMessageId = String(1517000000000000000n + BigInt(index));
    db.timelineRestoration.snapshots.upsert(snapshotRecord({
      sourceThreadId: IDS.legacyUnknownThread,
      sourceMessageId,
      threadOwnerUserId: IDS.authorB,
      authorUserId: IDS.historicalUnmapped,
      authorDisplayNameSnapshot: 'Unmapped',
      content: `legacy-${index}`,
      sourceCreatedAt: new Date(Date.parse(now) + index * 1000).toISOString()
    }));
  }
  db.timelineRestoration.userThreads.upsert({
    guildId: IDS.guild,
    ownerUserId: IDS.authorC,
    forumChannelId: IDS.forum,
    threadId: IDS.legacyUnrelatedThread,
    threadName: 'unrelated weak evidence',
    starterMessageId: null,
    status: 'legacy_missing',
    deletionReason: 'legacy_missing',
    createdAt: now,
    archivedAt: null,
    lockedAt: null,
    membershipEpisodeId: null,
    updatedAt: now
  });
  db.timelineRestoration.snapshots.upsert(snapshotRecord({
    sourceThreadId: IDS.legacyUnrelatedThread,
    sourceMessageId: '1518000000000000001',
    threadOwnerUserId: IDS.authorC,
    authorUserId: IDS.historicalUnmapped,
    content: 'one unrelated post'
  }));
  for (let index = 0; index < 9; index += 1) {
    db.timelineRestoration.snapshots.upsert(snapshotRecord({
      sourceThreadId: IDS.legacyUnrelatedThread,
      sourceMessageId: String(1518000000000000010n + BigInt(index)),
      threadOwnerUserId: IDS.authorC,
      authorUserId: IDS.authorC,
      content: `other-${index}`
    }));
  }

  const diagnosis = diagnoseTimelineOwner(db.sqlite, {
    guildId: IDS.guild,
    userId: IDS.historicalUnmapped
  });
  const unknownCandidate = diagnosis.candidates.find((candidate) => candidate.sourceThreadId === IDS.legacyUnknownThread);
  assert.equal(diagnosis.authoredSnapshotCount, 126);
  assert.equal(unknownCandidate.snapshotsAuthoredByTarget, 125);
  assert.equal(unknownCandidate.currentlyStoredOwnerId, IDS.authorB);
  assert.equal(unknownCandidate.confidence, 'participant_only');
  assert.notEqual(unknownCandidate.suggestedAction, 'auto_reassign');

  const unresolvedOwner = createProbeInteraction({
    client,
    guild,
    userId: IDS.guildOwner,
    destinationThread: legacyTestThread,
    historicalUserId: IDS.historicalUnmapped
  });
  await handleTimelineRestoreCommand(unresolvedOwner);
  assert.match(String(unresolvedOwner.lastReply || ''), /投稿履歴は126件保存/u);
  assert.match(String(unresolvedOwner.lastReply || ''), /所有者情報を確定できません/u);
  assert.equal(db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.legacyTestThread), null);

  const explicitLegacy = createProbeInteraction({
    client,
    guild,
    userId: IDS.guildOwner,
    destinationThread: legacyTestThread,
    historicalUserId: IDS.historicalUnmapped,
    sourceThreadId: IDS.legacyUnknownThread
  });
  await handleTimelineRestoreCommand(explicitLegacy);
  assert.match(String(explicitLegacy.lastReply?.content || ''), /テスト復元ジョブ/u);
  const legacyJob = db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.legacyTestThread);
  assert.equal(legacyJob.mode, 'admin_test');
  assert.equal(legacyJob.explicitSourceThreadId, IDS.legacyUnknownThread);
  assert.equal(legacyJob.sourceSelectionReason, 'meaningful_participant_evidence');
  assert.deepEqual(JSON.parse(legacyJob.sourceThreadIdsJson), [IDS.legacyUnknownThread]);
  assert.equal(db.timelineRestoration.userThreads.get(IDS.guild, IDS.legacyUnknownThread).ownerUserId, IDS.authorB);
  assert.equal(db.timelineRestoration.userThreads.get(IDS.guild, IDS.legacyUnknownThread).replacementThreadId, null);

  const weakUnrelated = createProbeInteraction({
    client,
    guild,
    userId: IDS.guildOwner,
    destinationThread: legacyConflictThread,
    historicalUserId: IDS.historicalUnmapped,
    sourceThreadId: IDS.legacyUnrelatedThread
  });
  await handleTimelineRestoreCommand(weakUnrelated);
  assert.match(String(weakUnrelated.lastReply || ''), /安全に確認できません/u);
  assert.equal(db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.legacyConflictThread), null);

  db.timelineRestoration.jobs.update(legacyJob.jobId, {
    status: 'cancelled', cancelledAt: new Date().toISOString(), nextRunAt: null, updatedAt: new Date().toISOString()
  });
  const conflictingSourceResume = createProbeInteraction({
    client,
    guild,
    userId: IDS.guildOwner,
    destinationThread: legacyTestThread,
    historicalUserId: IDS.historicalUnmapped,
    sourceThreadId: IDS.legacyUnrelatedThread
  });
  await handleTimelineRestoreCommand(conflictingSourceResume);
  assert.match(String(conflictingSourceResume.lastReply || ''), /別の復元ジョブ/u);
  assert.equal(db.timelineRestoration.jobs.get(legacyJob.jobId).explicitSourceThreadId, IDS.legacyUnknownThread);

  const oldProgressId = ownerSelfJob.progressMessageId;
  const oldProgressMessage = ownerSelfTestThread.messageStore.get(oldProgressId);
  const originalSend = ownerSelfTestThread.send.bind(ownerSelfTestThread);
  ownerSelfTestThread.send = async () => {
    throw Object.assign(new Error('probe send failed'), { code: 'probe_progress_send_failed' });
  };
  const itemStateBeforeProgressFailure = JSON.stringify(db.timelineRestoration.jobs.listItems(ownerSelfJob.jobId));
  await assert.rejects(
    moveProgressCardToBottom(client, ownerSelfTestThread, ownerSelfJob),
    /probe send failed/u
  );
  assert.equal(oldProgressMessage.deleted, false);
  assert.equal(db.timelineRestoration.jobs.get(ownerSelfJob.jobId).progressMessageId, oldProgressId);
  assert.equal(JSON.stringify(db.timelineRestoration.jobs.listItems(ownerSelfJob.jobId)), itemStateBeforeProgressFailure);
  ownerSelfTestThread.send = originalSend;

  const normalStart = createProbeInteraction({
    client,
    guild,
    userId: IDS.historicalA,
    destinationThread: normalThread,
    subcommand: 'start'
  });
  await handleTimelineRestoreCommand(normalStart);
  assert.match(String(normalStart.lastReply || ''), /復元を開始/u);
  const normalJob = db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.normalThread);
  assert.equal(normalJob.mode, 'normal');
  assert.equal(normalJob.ownerUserId, IDS.historicalA);
  assert.equal(db.timelineRestoration.userThreads.get(IDS.guild, IDS.oldThreadA).replacementThreadId, IDS.normalThread);

  db.sqlite.close();
  db = createDatabase(dbPath);
  assert.equal(db.timelineRestoration.membership.list(IDS.guild, IDS.historicalA).length, 2, 'migration rerun must preserve data');
  assert.equal(db.timelineRestoration.snapshots.listByThreads(IDS.guild, [IDS.oldThreadA]).length, 3);
  assert.equal(db.timelineRestoration.jobs.getByThread(IDS.guild, IDS.testThread).mode, 'admin_test');
  db.sqlite.close();
  fs.unlinkSync(dbPath);
  console.log(JSON.stringify({
    passed: true,
    probes: [
      'membership episode idempotency and rejoin',
      'A/B/C snapshot identity and ordering',
      'deleted snapshot retention',
      'exact-match resume and conflicting historical-owner rejection',
      'completed-item preservation across resume',
      'Components V2 avatar/media parsing',
      'stable media filenames and file signature detection',
      'log URL/content redaction',
      'Components V2 progress payload',
      'Components V2 completion log attachment and owner-only mention',
      'force-start admin_test-only schema and guild-owner validation',
      'strict snowflake and destination ownership validation',
      'admin_test persistence without source replacement consumption',
      'future genuine owner restoration after completed admin_test',
      'admin_test completion mentions initiator only',
      'A/B/C actual mocked webhook payload identity isolation',
      'progress replacement send failure retains old card and DB ID',
      'unmapped authored history diagnosis without owner reassignment',
      'explicit source-thread admin test with evidence gating',
      'conflicting explicit source-thread resume rejection',
      'idempotent migration reopen'
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
