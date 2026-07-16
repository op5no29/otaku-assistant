const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');
const { createDatabase } = require('../src/db/database');
const { extractThreadMessagePost } = require('../src/modules/timelineRelay/extractFirstPost');
const {
  buildTimelinePayload,
  sendRelayMessage,
  relayTweetMessage,
  runTimelineRelayRetryBatch
} = require('../src/modules/timelineRelay');
const { extractTimelineComponentData } = require('../src/modules/timelineRestoration/componentsParser');
const {
  captureTimelineMessageSnapshot,
  recordTimelineRelayDelivery
} = require('../src/modules/timelineRestoration/snapshots');

const bytes = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from([1, 2])]),
  gif: Buffer.from('GIF89a-test'),
  mp4: Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('isom-test')])
};

const contentTypes = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4'
};

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeConfig(tempDir) {
  return {
    timelineChannelId: '1500000000000000002',
    watchedForums: { tweet: ['1500000000000000001'], question: [], knowledge: [] },
    globalHashtagRoutes: {},
    botHashtagRoutes: {},
    mediaRelay: { tempDir, maxReuploadBytes: 5_000_000 },
    timeline: {
      includeFirstImage: true,
      maxContentLength: 4000,
      shortMergeEnabled: false,
      shortMergeMaxChars: 60,
      shortMergeWindowSeconds: 120,
      shortMergeMaxParts: 5
    },
    questions: { resolvedPrefix: '[解決済]' }
  };
}

function makeMessage({ id, baseUrl, content = '本文', files = [] }) {
  const attachments = new Map(files.map((file, index) => {
    const attachmentId = `${id}${index + 1}`;
    const name = file.spoiler ? `SPOILER_${file.name}` : file.name;
    return [attachmentId, {
      id: attachmentId,
      name,
      filename: name,
      url: `${baseUrl}/${file.path || file.kind}`,
      proxyURL: `${baseUrl}/${file.path || file.kind}`,
      contentType: file.contentType || contentTypes[file.kind],
      size: file.size ?? bytes[file.kind]?.length ?? 10,
      spoiler: file.spoiler === true,
      toJSON() { return { id: attachmentId, name, url: this.url, content_type: this.contentType, size: this.size }; }
    }];
  }));
  const guild = {
    id: '1224747669122056232',
    members: { fetch: async () => null },
    emojis: { cache: { find: () => null } },
    client: { users: { fetch: async () => null } }
  };
  const channel = {
    id: '1500000000000000100',
    guildId: guild.id,
    parentId: '1500000000000000001',
    name: '画像プローブ',
    ownerId: '609027783246741515',
    parent: { id: '1500000000000000001', name: 'つぶやき' },
    guild,
    isThread: () => true,
    messages: { fetch: async () => message }
  };
  const author = {
    id: '609027783246741515',
    username: '画像テスト',
    globalName: '画像テスト',
    bot: false,
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
  };
  const message = {
    id,
    guildId: guild.id,
    channelId: channel.id,
    guild,
    channel,
    author,
    member: null,
    content,
    cleanContent: content,
    attachments,
    embeds: [],
    reference: null,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    inGuild: () => true,
    toJSON: () => ({ attachments: [...attachments.values()].map((entry) => entry.toJSON()) })
  };
  return message;
}

function installAssetFetchMock() {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const kind = new URL(String(url)).pathname.slice(1).split('/').pop();
    if (kind === 'failure') return new Response('unavailable', { status: 503 });
    const body = bytes[kind] || bytes.png;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentTypes[kind] || 'image/png',
        'content-length': String(body.length)
      }
    });
  };
  return () => { global.fetch = originalFetch; };
}

function attachmentCollection(files) {
  return new Map(files.map((file, index) => [String(index + 1), {
    id: String(index + 1),
    name: file.name,
    filename: file.name,
    url: `https://cdn.destination.invalid/${encodeURIComponent(file.name)}`,
    proxyURL: null,
    contentType: file.contentType || null,
    size: file.size,
    spoiler: file.name.startsWith('SPOILER_')
  }]));
}

async function runCase({
  name,
  content,
  files,
  baseUrl,
  tempDir,
  expectFailure = false,
  hydrationMode = 'full'
}) {
  const message = makeMessage({
    id: String(1500000000000010000n + BigInt(runCase.counter++)),
    baseUrl,
    content,
    files
  });
  const config = makeConfig(tempDir);
  const extracted = await extractThreadMessagePost(message, config, logger);
  assert.equal(extracted.attachments.length, files.length, `${name}: extraction count`);
  const prepared = await buildTimelinePayload(extracted, { config, forumType: 'tweet', logger });
  const payload = prepared.payload;
  const componentData = extractTimelineComponentData(payload);
  const payloadFiles = payload.files || [];
  const sourceUrls = files.map((file) => `${baseUrl}/${file.path || file.kind}`);
  let sendCount = 0;
  let deleteCount = 0;
  let fetchCount = 0;
  let sendObservedExistingFiles = false;
  let hydratedAttachments = new Map();
  const destinationChannel = {
    id: config.timelineChannelId,
    async send(finalPayload) {
      sendCount += 1;
      for (const file of finalPayload.files || []) {
        const stat = await fs.stat(file.attachment);
        assert(stat.size > 0, `${name}: upload exists during send`);
      }
      sendObservedExistingFiles = true;
      hydratedAttachments = attachmentCollection(await Promise.all((finalPayload.files || []).map(async (file) => ({
        name: file.name,
        size: (await fs.stat(file.attachment)).size,
        contentType: files.find((entry) => file.name.endsWith(entry.kind === 'jpg' ? '.jpg' : `.${entry.kind}`))?.contentType || null
      }))));
      const hydrated = {
        id: '1600000000000000001',
        channelId: config.timelineChannelId,
        attachments: new Map(),
        async fetch() {
          fetchCount += 1;
          if (hydrationMode === 'full' || (hydrationMode === 'eventual' && fetchCount >= 2)) {
            this.attachments = hydratedAttachments;
          }
          return this;
        },
        async delete() {
          deleteCount += 1;
        }
      };
      return hydrated;
    }
  };

  try {
    const sent = await sendRelayMessage(destinationChannel, payload, logger, {
      sourceMessageId: message.id,
      destinationChannelId: config.timelineChannelId,
      relayKind: 'probe'
    });
    const client = {
      db: { timelineRestoration: { snapshots: { get: () => null } } },
      logger
    };
    const verification = await recordTimelineRelayDelivery(client, message, sent, payload);
    assert.equal(verification.valid, true, `${name}: hydrated attachment verification`);
    if (hydrationMode === 'empty' && componentData.attachmentReferences.length) {
      assert.equal(verification.mediaValid, false, `${name}: empty API metadata is not falsely verified`);
      assert.equal(verification.verificationUnavailable, true, `${name}: empty API metadata is unavailable`);
      assert.equal(verification.verificationStatus, 'verification_unavailable', `${name}: unavailable state retained`);
    } else {
      assert.equal(verification.mediaValid, true, `${name}: attachment metadata eventually verifies`);
    }
    assert.equal(sendCount, 1, `${name}: one destination card`);
    assert.equal(deleteCount, 0, `${name}: verification never deletes the sent card`);
    assert.equal(sendObservedExistingFiles, true, `${name}: files survive through send`);
    assert.equal((payload.flags & MessageFlags.IsComponentsV2) !== 0, true, `${name}: Components V2`);
    assert.equal(payload.content, undefined, `${name}: no forbidden content`);
    assert.equal(payload.embeds, undefined, `${name}: no forbidden embeds`);

    if (expectFailure) {
      assert.equal(payloadFiles.length, 0, `${name}: no failed source file upload`);
      assert.equal(componentData.attachmentReferences.length, 0, `${name}: no broken gallery slot`);
      assert.equal(prepared.relayState.attachmentRelayPending, true, `${name}: retry remains pending`);
      assert(JSON.stringify(componentData.rawComponents).includes('添付ファイルをコピーできませんでした'));
    } else {
      assert.equal(payloadFiles.length, files.length, `${name}: destination file count`);
      assert.equal(componentData.attachmentReferences.length, files.length, `${name}: gallery/file reference count`);
      assert.deepEqual(
        componentData.attachmentReferences.map((entry) => entry.filename).sort(),
        payloadFiles.map((entry) => entry.name).sort(),
        `${name}: attachment URL names exactly match files`
      );
      const serialized = JSON.stringify(componentData.rawComponents);
      for (const sourceUrl of sourceUrls) assert(!serialized.includes(sourceUrl), `${name}: source URL omitted from rendered media`);
    }
  } finally {
    const paths = payloadFiles.map((file) => file.attachment).filter((value) => typeof value === 'string');
    for (const filePath of paths) assert(await fs.stat(filePath).then(() => true, () => false), `${name}: temp exists before cleanup`);
    await prepared.cleanup();
    for (const filePath of paths) assert.equal(await fs.stat(filePath).then(() => true, () => false), false, `${name}: temp removed after send`);
  }
  return { payload, message, sendCount, deleteCount };
}
runCase.counter = 0;

async function probePreSendValidation({ baseUrl, tempDir }) {
  const config = makeConfig(tempDir);

  const mismatchMessage = makeMessage({
    id: '1500000000000080001',
    baseUrl,
    content: 'mismatched filename',
    files: [{ kind: 'png', name: 'mismatch.png' }]
  });
  const mismatchExtracted = await extractThreadMessagePost(mismatchMessage, config, logger);
  const mismatchPrepared = await buildTimelinePayload(mismatchExtracted, { config, forumType: 'tweet', logger });
  let mismatchSendCount = 0;
  try {
    const expectedName = extractTimelineComponentData(mismatchPrepared.payload).attachmentReferences[0].filename;
    mismatchPrepared.payload.files[0].name = `wrong-${expectedName}`;
    await assert.rejects(
      sendRelayMessage({ send: async () => { mismatchSendCount += 1; } }, mismatchPrepared.payload, logger, {
        sourceMessageId: mismatchMessage.id,
        destinationChannelId: config.timelineChannelId,
        relayKind: 'probe'
      }),
      (error) => error?.code === 'invalid_relay_payload'
    );
    assert.equal(mismatchSendCount, 0, 'mismatched attachment name is rejected before Discord send');
  } finally {
    await mismatchPrepared.cleanup();
  }

  const missingFileMessage = makeMessage({
    id: '1500000000000080002',
    baseUrl,
    content: 'missing physical file',
    files: [{ kind: 'png', name: 'missing.png' }]
  });
  const missingFileExtracted = await extractThreadMessagePost(missingFileMessage, config, logger);
  const missingFilePrepared = await buildTimelinePayload(missingFileExtracted, { config, forumType: 'tweet', logger });
  let missingFileSendCount = 0;
  try {
    await fs.unlink(missingFilePrepared.payload.files[0].attachment);
    await assert.rejects(
      sendRelayMessage({ send: async () => { missingFileSendCount += 1; } }, missingFilePrepared.payload, logger, {
        sourceMessageId: missingFileMessage.id,
        destinationChannelId: config.timelineChannelId,
        relayKind: 'probe'
      }),
      (error) => error?.code === 'invalid_relay_payload'
    );
    assert.equal(missingFileSendCount, 0, 'missing physical file is rejected before Discord send');
  } finally {
    await missingFilePrepared.cleanup();
  }
}

async function main() {
  const restoreFetch = installAssetFetchMock();
  const baseUrl = 'https://timeline-relay-probe.invalid';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-image-relay-probe-'));
  const tempDir = path.join(root, 'relay');
  try {
    await runCase({ name: 'text-only', content: 'text only', files: [], baseUrl, tempDir });
    await runCase({ name: 'image-only-png', content: '', files: [{ kind: 'png', name: 'image.png' }], baseUrl, tempDir });
    await runCase({ name: 'text-png', content: 'png', files: [{ kind: 'png', name: 'image.png' }], baseUrl, tempDir });
    await runCase({ name: 'text-jpeg', content: 'jpeg', files: [{ kind: 'jpg', name: 'photo.jpeg' }], baseUrl, tempDir });
    await runCase({ name: 'webp', content: 'webp', files: [{ kind: 'webp', name: 'photo.webp' }], baseUrl, tempDir });
    await runCase({ name: 'gif', content: 'gif', files: [{ kind: 'gif', name: 'anim.gif' }], baseUrl, tempDir });
    const spoiler = await runCase({ name: 'spoiler', content: 'spoiler', files: [{ kind: 'png', name: 'hidden.png', spoiler: true }], baseUrl, tempDir });
    assert(spoiler.payload.files[0].name.startsWith('SPOILER_'), 'spoiler upload name retained');
    await runCase({ name: 'two-images', content: 'two', files: [{ kind: 'png', name: 'same.png' }, { kind: 'png', name: 'same.png' }], baseUrl, tempDir });
    const unicode = await runCase({ name: 'unicode-name', content: 'unicode', files: [{ kind: 'png', name: '日本語 画像.png' }], baseUrl, tempDir });
    assert(/^[A-Za-z0-9_.-]+$/u.test(unicode.payload.files[0].name), 'upload filename is ASCII-safe');
    const noExtension = await runCase({ name: 'missing-extension', content: 'missing ext', files: [{ kind: 'png', name: 'attachment', contentType: 'image/png' }], baseUrl, tempDir });
    assert(noExtension.payload.files[0].name.endsWith('.png'), 'extension inferred from detected bytes');
    await runCase({ name: 'failed-download', content: 'fallback body', files: [{ kind: 'png', path: 'failure', name: 'failed.png' }], baseUrl, tempDir, expectFailure: true });
    await runCase({ name: 'video', content: 'video', files: [{ kind: 'mp4', name: 'clip.mp4' }], baseUrl, tempDir });
    await runCase({
      name: 'two-images-empty-components-v2-attachments',
      content: 'two images with unavailable metadata',
      files: [{ kind: 'png', name: 'first.png' }, { kind: 'jpg', name: 'second.jpg' }],
      baseUrl,
      tempDir,
      hydrationMode: 'empty'
    });
    await runCase({
      name: 'attachments-eventually-hydrate',
      content: 'eventual metadata',
      files: [{ kind: 'png', name: 'eventual.png' }],
      baseUrl,
      tempDir,
      hydrationMode: 'eventual'
    });
    await probePreSendValidation({ baseUrl, tempDir });

    const sendFailureMessage = makeMessage({ id: '1500000000000099999', baseUrl, content: 'send failure', files: [{ kind: 'png', name: 'send.png' }] });
    const config = makeConfig(tempDir);
    const extracted = await extractThreadMessagePost(sendFailureMessage, config, logger);
    const prepared = await buildTimelinePayload(extracted, { config, forumType: 'tweet', logger });
    let mappingCreated = false;
    try {
      await assert.rejects(
        sendRelayMessage({ send: async () => { throw Object.assign(new Error('mock Discord failure'), { code: 50013 }); } }, prepared.payload, logger, {
          sourceMessageId: sendFailureMessage.id,
          destinationChannelId: config.timelineChannelId,
          relayKind: 'probe'
        })
      );
      assert.equal(mappingCreated, false, 'mapping is not committed after send failure');
    } finally {
      await prepared.cleanup();
    }

    const dbPath = path.join(root, 'retry.sqlite');
    const db = createDatabase(dbPath);
    try {
      const retry = {
        guildId: sendFailureMessage.guildId,
        sourceMessageId: sendFailureMessage.id,
        sourceChannelId: sendFailureMessage.channelId,
        destinationChannelId: config.timelineChannelId,
        relayKind: 'timeline'
      };
      db.timelineRelayRetries.schedule(retry);
      db.timelineRelayRetries.schedule(retry);
      const rows = db.sqlite.prepare('SELECT COUNT(*) AS count FROM timeline_relay_retry_jobs').get();
      assert.equal(rows.count, 1, 'retry scheduling is idempotent per source and destination');

      const integratedMessage = makeMessage({
        id: '1500000000000099901',
        baseUrl,
        content: 'integrated image relay',
        files: [{ kind: 'png', name: 'integrated.png' }]
      });
      integratedMessage.channel.type = 11;
      const destinationMessages = new Map();
      const integratedLogs = [];
      const integratedLogger = {
        info(message, metadata = {}) { integratedLogs.push({ level: 'info', message, metadata }); },
        warn(message, metadata = {}) { integratedLogs.push({ level: 'warn', message, metadata }); },
        error(message, metadata = {}) { integratedLogs.push({ level: 'error', message, metadata }); },
        debug(message, metadata = {}) { integratedLogs.push({ level: 'debug', message, metadata }); }
      };
      let integratedSendCount = 0;
      let integratedDeleteCount = 0;
      let integratedEditCount = 0;
      let integratedFetchCount = 0;
      const destinationChannel = {
        id: config.timelineChannelId,
        isTextBased: () => true,
        messages: { fetch: async (id) => destinationMessages.get(String(id)) || null },
        async send(payload) {
          integratedSendCount += 1;
          const componentNames = extractTimelineComponentData(payload).attachmentReferences.map((entry) => entry.filename);
          const uploadNames = (payload.files || []).map((file) => file.name);
          assert.deepEqual(componentNames, uploadNames, 'live case attachment references match final upload names');
          for (const file of payload.files || []) {
            assert((await fs.stat(file.attachment)).size > 0, 'live case physical upload exists during send');
          }
          const sent = {
            id: '1600000000000099901',
            channelId: config.timelineChannelId,
            attachments: new Map(),
            components: payload.components,
            async fetch() {
              integratedFetchCount += 1;
              return this;
            },
            async edit(nextPayload) {
              integratedEditCount += 1;
              for (const file of nextPayload.files || []) {
                assert((await fs.stat(file.attachment)).size > 0, 'retry edit receives an existing physical upload');
              }
              this.components = nextPayload.components;
              this.attachments = new Map();
              return this;
            },
            async delete() {
              integratedDeleteCount += 1;
              destinationMessages.delete(this.id);
            }
          };
          destinationMessages.set(sent.id, sent);
          return sent;
        }
      };
      const integratedConfig = {
        ...config,
        timelineRestoration: {
          enabled: true,
          permanentMediaMirror: false,
          restoreBotMessages: false,
          maxMediaBytes: 5_000_000,
          mediaFetchTimeoutMs: 1_000,
          maxRedirects: 1
        }
      };
      const integratedClient = {
        appConfig: integratedConfig,
        db,
        logger: integratedLogger,
        timelineRelayMessageInFlight: new Set(),
        timelineRelayInFlight: new Set(),
        guilds: { cache: new Map() },
        users: { fetch: async () => null },
        user: { id: '999999999999999999' }
      };
      integratedMessage.client = integratedClient;
      integratedMessage.guild.client = integratedClient;
      integratedMessage.channel.guild = integratedMessage.guild;
      integratedMessage.guild.channels = {
        cache: new Map([[destinationChannel.id, destinationChannel], [integratedMessage.channel.id, integratedMessage.channel]]),
        fetch: async (id) => String(id) === destinationChannel.id ? destinationChannel : integratedMessage.channel
      };
      integratedClient.guilds.cache.set(integratedMessage.guildId, integratedMessage.guild);
      await captureTimelineMessageSnapshot(integratedClient, integratedMessage);
      await relayTweetMessage(integratedMessage, { config: integratedConfig, db, logger: integratedLogger });
      const integratedMapping = db.relays.getMessageRelayTarget(integratedMessage.id, destinationChannel.id);
      assert.equal(integratedSendCount, 1, 'real relay boundary sends image card once');
      assert.equal(integratedDeleteCount, 0, 'live Components V2 empty attachment metadata never deletes the card');
      assert(integratedFetchCount >= 1, 'live case successfully refetches the sent message');
      assert.equal(integratedMapping?.relayedMessageId, '1600000000000099901', 'relay mapping committed after send');
      assert.equal(db.timelineRelayRetries.get(integratedMessage.id, destinationChannel.id), null, 'unavailable verification does not schedule a destructive retry');
      const integratedSnapshot = db.timelineRestoration.snapshots.get(integratedMessage.guildId, integratedMessage.id);
      const integratedQuality = JSON.parse(integratedSnapshot.qualityJson);
      assert.equal(integratedSnapshot.timelineMessageId, '1600000000000099901', 'snapshot retains original destination message ID');
      assert.equal(integratedQuality.timelineMediaVerificationStatus, 'verification_unavailable', 'snapshot records unavailable verification');
      assert(integratedLogs.some((entry) => entry.message === 'timeline media verification unavailable for Components V2; preserving sent message'), 'unavailable verification is logged explicitly');
      assert(!integratedLogs.some((entry) => entry.message === 'broken timeline media detected'), 'empty Components V2 metadata is never logged as broken media');

      db.timelineRelayRetries.schedule({
        guildId: integratedMessage.guildId,
        sourceMessageId: integratedMessage.id,
        sourceChannelId: integratedMessage.channelId,
        destinationChannelId: destinationChannel.id,
        relayKind: 'timeline',
        fallbackMessageId: integratedMapping.relayedMessageId,
        errorCode: 'media_verification_deferred',
        nextAttemptAt: new Date(0).toISOString()
      });
      await runTimelineRelayRetryBatch(integratedClient);
      assert.equal(integratedSendCount, 1, 'legacy retry inspects or edits the existing card without a replacement send');
      assert.equal(integratedDeleteCount, 0, 'legacy retry never deletes the existing card');
      assert.equal(integratedEditCount, 1, 'legacy retry reuses the existing destination message');
      assert.equal(db.relays.getMessageRelayTarget(integratedMessage.id, destinationChannel.id)?.relayedMessageId, integratedMapping.relayedMessageId, 'legacy retry preserves the destination message ID');
      assert.equal(db.timelineRelayRetries.get(integratedMessage.id, destinationChannel.id)?.status, 'completed', 'legacy retry converges without replacement');

      const integratedFailure = makeMessage({
        id: '1500000000000099902',
        baseUrl,
        content: 'integrated send failure',
        files: [{ kind: 'png', name: 'integrated-failure.png' }]
      });
      integratedFailure.channel.type = 11;
      integratedFailure.client = integratedClient;
      integratedFailure.guild.client = integratedClient;
      integratedFailure.channel.guild = integratedFailure.guild;
      const failingDestination = {
        id: destinationChannel.id,
        isTextBased: () => true,
        send: async () => { throw Object.assign(new Error('mock destination failure'), { code: 50013 }); }
      };
      integratedFailure.guild.channels = {
        cache: new Map([[failingDestination.id, failingDestination], [integratedFailure.channel.id, integratedFailure.channel]]),
        fetch: async (id) => String(id) === failingDestination.id ? failingDestination : integratedFailure.channel
      };
      await assert.rejects(relayTweetMessage(integratedFailure, { config: integratedConfig, db, logger: integratedLogger }));
      assert.equal(db.relays.getMessageRelayTarget(integratedFailure.id, failingDestination.id), null, 'failed send has no relay mapping');
      assert.equal(db.timelineRelayRetries.get(integratedFailure.id, failingDestination.id)?.status, 'pending', 'failed send is durably retryable');
    } finally {
      db.sqlite.close();
    }

    console.log('probe-timeline-image-relay: passed (mocked Discord send boundary; no live Discord test)');
  } finally {
    restoreFetch();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
