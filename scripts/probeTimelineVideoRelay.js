const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ChannelType } = require('discord.js');
const { createDatabase } = require('../src/db/database');
const {
  buildTimelinePayload,
  handleQuestionRolePromptInteraction,
  isMergeableShortTweetPost,
  relayTweetMessage,
  sendRelayMessage,
  sendRelayMessageWithVideoFallback,
  startQuestionRolePromptTimeouts
} = require('../src/modules/timelineRelay');
const { prepareVideoThumbnail } = require('../src/modules/timelineRelay/videoThumbnail');
const { extractTimelineComponentData } = require('../src/modules/timelineRestoration/componentsParser');

const IDS = {
  guild: '1224747669122056232',
  questionForum: '1500000000000000001',
  tweetForum: '1500000000000000002',
  timeline: '1500000000000000003',
  owner: '609027783246741515',
  role: '1228130088755662868'
};
const AVATAR_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';

const mediaBytes = {
  mp4: Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('isom0000')]),
  mov: Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('qt  0000')]),
  webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-data')]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
  unknown: Buffer.from('not-a-supported-video')
};

function makeLogger() {
  const entries = [];
  return {
    entries,
    info(message, metadata = {}) { entries.push({ level: 'info', message, metadata }); },
    warn(message, metadata = {}) { entries.push({ level: 'warn', message, metadata }); },
    error(message, metadata = {}) { entries.push({ level: 'error', message, metadata }); },
    debug(message, metadata = {}) { entries.push({ level: 'debug', message, metadata }); }
  };
}

function makeConfig(tempDir, overrides = {}) {
  return {
    timelineChannelId: IDS.timeline,
    watchedForums: { question: [IDS.questionForum], tweet: [IDS.tweetForum], knowledge: [] },
    globalHashtagRoutes: {},
    botHashtagRoutes: {},
    vcListenOnlyChannelIds: [],
    timeline: {
      includeFirstImage: true,
      ignoreBotPosts: true,
      maxContentLength: 4_000,
      shortMergeEnabled: true,
      shortMergeMaxChars: 60,
      shortMergeWindowSeconds: 120,
      shortMergeMaxParts: 5
    },
    mediaRelay: {
      maxReuploadBytes: 1_000_000,
      fetchTimeoutMs: 1_000,
      tempDir
    },
    questionRolePrompt: {
      enabled: true,
      timeoutMinutes: 10,
      roles: [{ id: IDS.role, label: '映像制作', description: '映像制作' }]
    },
    questions: { resolvedPrefix: '[解決済]' },
    questionStatusTags: {},
    timelineRestoration: { enabled: false, restoreBotMessages: false },
    ...overrides
  };
}

function makeNormalizedAttachment({ id, kind, name, url, size, contentType, spoiler = false }) {
  const isVideo = ['mp4', 'mov', 'webm', 'unknown'].includes(kind);
  const isImage = kind === 'png';
  return {
    id,
    attachmentId: id,
    originalName: name,
    originalFileName: name,
    displayName: name,
    name,
    url,
    proxyUrl: url,
    size: size ?? mediaBytes[kind].length,
    contentType: contentType || (isVideo ? (kind === 'webm' ? 'video/webm' : 'video/mp4') : 'image/png'),
    isVideo,
    isImage,
    isGif: false,
    isAudio: false,
    isPdf: false,
    isSpoiler: spoiler,
    isPreviewableUpload: true
  };
}

function makePost({ id, attachments = [], content = '動画投稿', forumType = 'tweet', youtubePreviewPath = null }) {
  const firstVideo = attachments.find((attachment) => attachment.isVideo);
  const firstImage = attachments.find((attachment) => attachment.isImage);
  const socialPreview = youtubePreviewPath
    ? {
        sourceUrl: 'https://youtu.be/probe-video',
        title: 'YouTube preview',
        mediaItems: [{
          url: `attachment://${path.basename(youtubePreviewPath)}`,
          source: 'youtube_thumbnail',
          sourceType: 'youtube_thumbnail',
          requiresReupload: false
        }],
        imageUrl: `attachment://${path.basename(youtubePreviewPath)}`,
        imageUrls: [`attachment://${path.basename(youtubePreviewPath)}`],
        mediaUrls: [`attachment://${path.basename(youtubePreviewPath)}`]
      }
    : null;
  return {
    messageId: id,
    threadId: `${id}0`,
    parentChannelId: forumType === 'question' ? IDS.questionForum : IDS.tweetForum,
    displayName: '動画テスト',
    avatarUrl: AVATAR_URL,
    author: { id: IDS.owner, username: 'video-test', bot: false },
    title: forumType === 'question' ? '動画つき質問' : '',
    rawTitle: forumType === 'question' ? '動画つき質問' : '',
    content,
    createdAt: new Date('2026-07-22T12:00:00.000Z'),
    jumpUrl: `https://discord.com/channels/${IDS.guild}/${id}0/${id}`,
    forumName: forumType === 'question' ? '質問' : 'つぶやき',
    attachments,
    imageUrls: firstImage ? [firstImage.url] : [],
    firstImageUrl: firstImage?.url || null,
    firstVideoUrl: firstVideo?.url || null,
    firstVideoName: firstVideo?.name || null,
    socialPreview,
    componentFiles: youtubePreviewPath ? [{ attachment: youtubePreviewPath, name: path.basename(youtubePreviewPath) }] : []
  };
}

function makeFetchController(events) {
  let releaseSlow;
  let fetchCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async (value) => {
    const pathname = new URL(String(value)).pathname;
    fetchCount += 1;
    events.push(`fetch:${pathname}`);
    if (pathname.includes('timeout')) {
      throw Object.assign(new Error('mock timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
    }
    if (pathname.includes('slow')) {
      await new Promise((resolve) => { releaseSlow = resolve; });
    }
    if (pathname.includes('zero')) {
      return new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '0' } });
    }
    let kind = 'mp4';
    if (pathname.endsWith('.mov')) kind = 'mov';
    else if (pathname.endsWith('.webm')) kind = 'webm';
    else if (pathname.includes('actual.png') || pathname.endsWith('.png')) kind = 'png';
    else if (pathname.includes('unknown')) kind = 'unknown';
    const body = pathname.includes('no-length') ? Buffer.concat([mediaBytes.mp4, Buffer.alloc(32)]) : mediaBytes[kind];
    const declared = pathname.includes('actual.png') ? 'video/mp4' : kind === 'png' ? 'image/png' : kind === 'webm' ? 'video/webm' : 'video/mp4';
    const headers = { 'content-type': declared };
    if (!pathname.includes('no-length')) headers['content-length'] = String(body.length);
    return new Response(body, {
      status: 200,
      headers
    });
  };
  return {
    get fetchCount() { return fetchCount; },
    releaseSlow() { releaseSlow?.(); },
    hasSlowWaiter() { return typeof releaseSlow === 'function'; },
    restore() { global.fetch = originalFetch; }
  };
}

function payloadAttachmentNames(payload) {
  return (payload.files || []).map((file) => file.name);
}

async function assertPayloadFilesExist(payload, label) {
  for (const file of payload.files || []) {
    const stat = await fs.stat(file.attachment);
    assert(stat.size > 0, `${label}: physical file exists and is nonzero`);
  }
}

async function probePreparedVideoCases({ config, tempDir, logger }) {
  const cases = [
    ['mp4', 'clip.mp4'],
    ['mov', 'clip.mov'],
    ['webm', 'clip.webm']
  ];
  for (const [kind, name] of cases) {
    const attachment = makeNormalizedAttachment({
      id: `a-${kind}`,
      kind,
      name,
      url: `https://video-probe.invalid/${name}`
    });
    const post = makePost({ id: `15000000000000001${cases.indexOf(cases.find((entry) => entry[0] === kind))}`, attachments: [attachment] });
    const prepared = await buildTimelinePayload(post, { config, forumType: 'tweet', logger });
    try {
      assert.equal(prepared.payload.files.length, 1, `${kind}: one durable upload`);
      const refs = extractTimelineComponentData(prepared.payload).attachmentReferences.map((entry) => entry.filename);
      assert.deepEqual(refs, payloadAttachmentNames(prepared.payload), `${kind}: attachment reference matches upload name`);
      assert(!JSON.stringify(prepared.payload.components).includes(attachment.url), `${kind}: source CDN URL is absent`);
      assert.equal(isMergeableShortTweetPost(prepared.preparedPost, config), false, `${kind}: video post is not short-merged`);
    } finally {
      await prepared.cleanup();
    }
  }

  const imageAndVideo = [
    makeNormalizedAttachment({ id: 'mix-image', kind: 'png', name: 'image.png', url: 'https://video-probe.invalid/image.png' }),
    makeNormalizedAttachment({ id: 'mix-video', kind: 'mp4', name: 'video.mp4', url: 'https://video-probe.invalid/video.mp4' })
  ];
  const mixed = await buildTimelinePayload(makePost({ id: '1500000000000000201', attachments: imageAndVideo }), { config, forumType: 'tweet', logger });
  try {
    assert.equal(mixed.payload.files.length, 2, 'video + image both remain durable uploads');
    assert.equal(new Set(payloadAttachmentNames(mixed.payload)).size, 2, 'video + image filenames are unique');
  } finally {
    await mixed.cleanup();
  }

  const twoVideos = await buildTimelinePayload(makePost({
    id: '1500000000000000202',
    attachments: [
      makeNormalizedAttachment({ id: 'video-1', kind: 'mp4', name: 'same.mp4', url: 'https://video-probe.invalid/one.mp4' }),
      makeNormalizedAttachment({ id: 'video-2', kind: 'mp4', name: 'same.mp4', url: 'https://video-probe.invalid/two.mp4' })
    ]
  }), { config, forumType: 'tweet', logger });
  try {
    assert.equal(twoVideos.payload.files.length, 2, 'two uploaded videos are retained');
    assert.equal(new Set(payloadAttachmentNames(twoVideos.payload)).size, 2, 'two video upload names do not collide');
  } finally {
    await twoVideos.cleanup();
  }

  const spoilerVideo = await buildTimelinePayload(makePost({
    id: '1500000000000000206',
    attachments: [makeNormalizedAttachment({
      id: 'spoiler-video',
      kind: 'mp4',
      name: '日本語 動画.mp4',
      url: 'https://video-probe.invalid/spoiler.mp4',
      spoiler: true
    })]
  }), { config, forumType: 'tweet', logger });
  try {
    assert.match(spoilerVideo.payload.files[0].name, /^SPOILER_[\x20-\x7e]+\.mp4$/u, 'spoiler video upload name is ASCII-safe');
    const rawComponents = spoilerVideo.payload.components.map((component) => component.toJSON());
    assert(JSON.stringify(rawComponents).includes('"spoiler":true'), 'spoiler state is preserved in MediaGallery');
  } finally {
    await spoilerVideo.cleanup();
  }

  const previewPath = path.join(tempDir, 'youtube-preview.jpg');
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(previewPath, mediaBytes.png);
  const videoWithPreview = await buildTimelinePayload(makePost({
    id: '1500000000000000203',
    content: 'https://youtu.be/probe-video\n動画とURL',
    attachments: [makeNormalizedAttachment({ id: 'video-youtube', kind: 'mp4', name: 'youtube.mp4', url: 'https://video-probe.invalid/youtube.mp4' })],
    youtubePreviewPath: previewPath
  }), { config, forumType: 'tweet', logger });
  try {
    assert.equal(videoWithPreview.payload.files.length, 2, 'uploaded video and YouTube preview coexist without a generated thumbnail');
    assert.equal(extractTimelineComponentData(videoWithPreview.payload).attachmentReferences.length, 2, 'video and YouTube preview have distinct references');
  } finally {
    await videoWithPreview.cleanup();
    await fs.unlink(previewPath).catch(() => null);
  }

  const mismatch = await buildTimelinePayload(makePost({
    id: '1500000000000000204',
    attachments: [makeNormalizedAttachment({
      id: 'mismatch', kind: 'mp4', name: 'claimed-video.mp4', url: 'https://video-probe.invalid/actual.png', contentType: 'video/mp4'
    })]
  }), { config, forumType: 'tweet', logger });
  try {
    assert(mismatch.payload.files[0].name.endsWith('.png'), 'detected image bytes override declared video MIME');
  } finally {
    await mismatch.cleanup();
  }

  const oversized = await buildTimelinePayload(makePost({
    id: '1500000000000000205',
    attachments: [makeNormalizedAttachment({
      id: 'oversized', kind: 'mp4', name: 'large.mp4', url: 'https://video-probe.invalid/large.mp4', size: config.mediaRelay.maxReuploadBytes + 1
    })]
  }), { config, forumType: 'tweet', logger });
  try {
    assert.equal((oversized.payload.files || []).length, 0, 'oversized video is not uploaded');
    assert.equal(oversized.relayState.attachmentRelayPending, false, 'oversized video is a terminal fallback, not an infinite retry');
    assert(JSON.stringify(oversized.payload.components).includes('動画をコピーできなかった'));
  } finally {
    await oversized.cleanup();
  }

  const streamedOversizedConfig = {
    ...config,
    mediaRelay: { ...config.mediaRelay, maxReuploadBytes: 16 }
  };
  const streamedOversized = await buildTimelinePayload(makePost({
    id: '1500000000000000207',
    attachments: [makeNormalizedAttachment({
      id: 'streamed-oversized',
      kind: 'mp4',
      name: 'no-length.mp4',
      url: 'https://video-probe.invalid/no-length.mp4',
      size: 0
    })]
  }), { config: streamedOversizedConfig, forumType: 'tweet', logger });
  try {
    assert.equal(streamedOversized.preparedPost.attachmentCopyFailures[0]?.reason, 'video_too_large');
    assert.equal(streamedOversized.relayState.attachmentRelayPending, false, 'stream limit overrun is terminal even without Content-Length');
  } finally {
    await streamedOversized.cleanup();
  }

  for (const [suffix, expectedReason] of [['timeout.mp4', 'ETIMEDOUT'], ['zero.mp4', 'zero_byte_attachment'], ['unknown.mp4', 'video_unsupported']]) {
    const failed = await buildTimelinePayload(makePost({
      id: `15000000000000003${suffix.length}`,
      attachments: [makeNormalizedAttachment({ id: suffix, kind: suffix.startsWith('unknown') ? 'unknown' : 'mp4', name: suffix, url: `https://video-probe.invalid/${suffix}` })]
    }), { config, forumType: 'tweet', logger });
    try {
      assert.equal((failed.payload.files || []).length, 0, `${suffix}: failed video is omitted from uploads`);
      const reason = failed.preparedPost.attachmentCopyFailures[0]?.reason;
      assert.equal(reason, expectedReason, `${suffix}: failure reason is explicit`);
      assert(JSON.stringify(failed.payload.components).includes('動画をコピーできなかった'), `${suffix}: text fallback remains visible`);
    } finally {
      await failed.cleanup();
    }
  }
}

function rawAttachment({ id, name, kind = 'mp4', url, size }) {
  return {
    id,
    name,
    filename: name,
    url,
    proxyURL: url,
    contentType: kind === 'png' ? 'image/png' : kind === 'webm' ? 'video/webm' : 'video/mp4',
    size: size ?? mediaBytes[kind].length,
    spoiler: false,
    toJSON() { return { id, name, url, content_type: this.contentType, size: this.size }; }
  };
}

function makeQuestionEnvironment({
  db,
  config,
  logger,
  threadId,
  slow = false,
  skip = false,
  failSend = false,
  rejectVideoUpload = false,
  events = []
}) {
  let destinationSendCalls = 0;
  let successfulCards = 0;
  let guideCount = 0;
  let promptEditCount = 0;
  const attemptedFilePaths = [];
  const videoUrl = `https://video-probe.invalid/${slow ? 'slow' : 'question'}.mp4`;
  const attachment = rawAttachment({ id: `${threadId}1`, name: 'question.mp4', url: videoUrl });
  const attachments = new Map([[attachment.id, attachment]]);
  const author = {
    id: IDS.owner,
    username: 'question-owner',
    globalName: '質問者',
    bot: false,
    displayAvatarURL: () => AVATAR_URL
  };
  let starterMessage;
  const timelineChannel = {
    id: IDS.timeline,
    isTextBased: () => true,
    async send(payload) {
      destinationSendCalls += 1;
      events.push('timeline-send');
      await assertPayloadFilesExist(payload, 'question send');
      attemptedFilePaths.push(...(payload.files || []).map((file) => file.attachment));
      const hasVideo = payloadAttachmentNames(payload).some((name) => /\.(mp4|mov|webm)$/iu.test(name));
      if (hasVideo && rejectVideoUpload && !failSend) {
        throw Object.assign(new Error('request too large'), { code: 40005 });
      }
      if (failSend) throw Object.assign(new Error('destination unavailable'), { code: 50013 });
      successfulCards += 1;
      return { id: `${threadId}9`, channelId: IDS.timeline, attachments: new Map() };
    }
  };
  const guild = {
    id: IDS.guild,
    members: { fetch: async () => ({ displayName: '質問者', displayAvatarURL: () => AVATAR_URL }) },
    channels: null
  };
  const thread = {
    id: threadId,
    guildId: IDS.guild,
    parentId: IDS.questionForum,
    type: ChannelType.PublicThread,
    name: '動画つき質問',
    ownerId: IDS.owner,
    guild,
    parent: { id: IDS.questionForum, name: '質問', availableTags: [], parentId: null },
    appliedTags: [],
    isThread: () => true,
    fetchStarterMessage: async () => starterMessage,
    messages: {
      fetch: async (value) => {
        if (typeof value === 'object') return new Map([[starterMessage.id, starterMessage]]);
        return starterMessage;
      }
    },
    async send() {
      guideCount += 1;
      events.push('guide-send');
      return { id: `${threadId}8` };
    }
  };
  starterMessage = {
    id: threadId,
    guildId: IDS.guild,
    channelId: threadId,
    channel: thread,
    guild,
    author,
    member: null,
    content: '説明文',
    cleanContent: '説明文',
    attachments,
    embeds: [],
    createdAt: new Date('2026-07-22T12:00:00.000Z'),
    toJSON: () => ({ attachments: [...attachments.values()].map((entry) => entry.toJSON()) })
  };
  guild.channels = {
    fetch: async (id) => String(id) === IDS.timeline ? timelineChannel : thread,
    cache: new Map([[IDS.timeline, timelineChannel], [threadId, thread]])
  };
  const client = {
    appConfig: config,
    db,
    logger,
    questionRolePromptTimers: new Map(),
    timelineRelayInFlight: new Set(),
    timelineRelayMessageInFlight: new Set(),
    guilds: { fetch: async () => guild, cache: new Map([[IDS.guild, guild]]) }
  };
  thread.client = client;
  starterMessage.client = client;
  guild.client = client;
  db.questionRolePrompts.upsert({
    threadId,
    guildId: IDS.guild,
    authorUserId: IDS.owner,
    promptMessageId: `${threadId}7`,
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
  });
  const interaction = {
    id: `${threadId}6`,
    customId: `${skip ? 'question-role-skip:' : 'question-role-select:'}${threadId}`,
    values: skip ? [] : [IDS.role],
    user: { id: IDS.owner },
    client,
    isStringSelectMenu: () => !skip,
    isButton: () => skip,
    async deferUpdate() { events.push('defer'); },
    async editReply() { events.push('processing-ui'); },
    async reply() { events.push('interaction-reply'); },
    async followUp() { events.push('interaction-followup'); },
    message: {
      async edit() { promptEditCount += 1; events.push('prompt-edit'); }
    }
  };
  return {
    client,
    interaction,
    events,
    thread,
    get destinationSendCalls() { return destinationSendCalls; },
    get successfulCards() { return successfulCards; },
    get guideCount() { return guideCount; },
    get promptEditCount() { return promptEditCount; },
    attemptedFilePaths
  };
}

async function probeQuestionInteractions({ db, config, logger, fetchController, events }) {
  const selected = makeQuestionEnvironment({ db, config, logger, threadId: '1500000000000001001', slow: true, events });
  const selectedPromise = handleQuestionRolePromptInteraction(selected.interaction);
  for (let i = 0; i < 50 && !fetchController.hasSlowWaiter(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert(fetchController.hasSlowWaiter(), 'slow question reached video fetch');
  assert(selected.events.indexOf('defer') >= 0, 'question interaction was deferred');
  assert(selected.events.indexOf('defer') < selected.events.indexOf('fetch:/slow.mp4'), 'defer precedes slow media work');
  assert.equal(db.questionRolePrompts.get(selected.thread.id).status, 'processing', 'slow question is durably claimed while media is prepared');

  const duplicateInteraction = {
    ...selected.interaction,
    id: `${selected.interaction.id}-duplicate`,
    async reply() { selected.events.push('duplicate-rejected'); }
  };
  assert.equal(await handleQuestionRolePromptInteraction(duplicateInteraction), true, 'repeated in-flight interaction is handled');
  assert.equal(selected.destinationSendCalls, 0, 'repeated interaction cannot start a second destination send');

  let normalTextSendCount = 0;
  const normalTextDestination = {
    id: IDS.timeline,
    isTextBased: () => true,
    async send(payload) {
      normalTextSendCount += 1;
      return {
        id: '1600000000000001002',
        channelId: IDS.timeline,
        attachments: new Map(),
        components: payload.components,
        async fetch() { return this; },
        async delete() { throw new Error('text relay must not be deleted'); }
      };
    }
  };
  const normalTextMessage = makeTweetMessage({
    id: '1500000000000001002',
    config,
    db,
    logger,
    destinationChannel: normalTextDestination,
    kind: null
  });
  await relayTweetMessage(normalTextMessage, { config, db, logger });
  assert.equal(normalTextSendCount, 1, 'slow video preparation does not block a separate text relay');
  fetchController.releaseSlow();
  assert.equal(await selectedPromise, true, 'selected role interaction completes');
  assert.equal(selected.successfulCards, 1, 'question creates exactly one successful timeline card');
  assert.equal(selected.destinationSendCalls, 1, 'small question video sends exactly once');
  assert.equal(selected.guideCount, 1, 'question acceptance guide is sent exactly once');
  assert.equal(db.questionRolePrompts.get(selected.thread.id).status, 'selected', 'prompt transitions processing to selected');
  assert.equal(db.relays.getThreadRelay(selected.thread.id)?.timelineMessageId, `${selected.thread.id}9`, 'question mapping stores the sent message');
  for (const filePath of selected.attemptedFilePaths) {
    await assert.rejects(fs.stat(filePath), (error) => error?.code === 'ENOENT', 'question temp file is removed after send settles');
  }

  await handleQuestionRolePromptInteraction(selected.interaction);
  assert.equal(selected.successfulCards, 1, 'repeated question interaction does not duplicate card');
  assert.equal(selected.guideCount, 1, 'repeated question interaction does not duplicate guide');

  const skipped = makeQuestionEnvironment({ db, config, logger, threadId: '1500000000000001003', skip: true });
  assert.equal(await handleQuestionRolePromptInteraction(skipped.interaction), true, 'skip interaction completes');
  assert.equal(skipped.successfulCards, 1, 'skip with video creates one timeline card');
  assert.equal(skipped.guideCount, 1, 'skip with video creates one guide');
  assert.equal(db.questionRolePrompts.get(skipped.thread.id).status, 'skipped', 'skip prompt completes');

  const oversizedAtDiscord = makeQuestionEnvironment({
    db,
    config,
    logger,
    threadId: '1500000000000001005',
    rejectVideoUpload: true
  });
  assert.equal(await handleQuestionRolePromptInteraction(oversizedAtDiscord.interaction), true, 'Discord 40005 question fallback completes');
  assert.equal(oversizedAtDiscord.destinationSendCalls, 2, '40005 makes one failed request and one fallback request');
  assert.equal(oversizedAtDiscord.successfulCards, 1, '40005 leaves exactly one visible question card');
  assert.equal(oversizedAtDiscord.guideCount, 1, '40005 fallback still posts one acceptance guide');
  assert.equal(db.questionRolePrompts.get(oversizedAtDiscord.thread.id).status, 'selected', '40005 fallback completes the role prompt');

  const failed = makeQuestionEnvironment({ db, config, logger, threadId: '1500000000000001004', failSend: true });
  assert.equal(await handleQuestionRolePromptInteraction(failed.interaction), true, 'failed interaction is handled privately');
  assert.equal(db.questionRolePrompts.get(failed.thread.id).status, 'pending', 'failed prompt returns to pending');
  assert(failed.promptEditCount >= 1, 'failed prompt controls are restored');
  assert.equal(failed.guideCount, 0, 'failed destination send does not create a guide');

  db.questionRolePrompts.claimProcessing(failed.thread.id, []);
  startQuestionRolePromptTimeouts(failed.client);
  assert.equal(db.questionRolePrompts.get(failed.thread.id).status, 'pending', 'startup reconciliation recovers processing prompt');
  for (const timer of failed.client.questionRolePromptTimers.values()) clearTimeout(timer);
}

function makeTweetMessage({ id, config, db, logger, destinationChannel, kind = 'mp4' }) {
  const attachments = new Map();
  if (kind) {
    const url = `https://video-probe.invalid/tweet.${kind}`;
    const attachment = rawAttachment({ id: `${id}1`, name: `tweet.${kind}`, kind, url });
    attachments.set(attachment.id, attachment);
  }
  const guild = {
    id: IDS.guild,
    members: { fetch: async () => null },
    emojis: { cache: { find: () => null } },
    channels: null,
    client: null
  };
  let message;
  const channel = {
    id: `${id}0`,
    guildId: IDS.guild,
    parentId: IDS.tweetForum,
    type: ChannelType.PublicThread,
    name: '動画投稿',
    ownerId: IDS.owner,
    guild,
    parent: { id: IDS.tweetForum, name: 'つぶやき' },
    isThread: () => true,
    messages: { fetch: async () => message }
  };
  message = {
    id,
    guildId: IDS.guild,
    channelId: channel.id,
    guild,
    channel,
    author: { id: IDS.owner, username: 'tweet-owner', globalName: '投稿者', bot: false, displayAvatarURL: () => AVATAR_URL },
    member: null,
    content: '動画投稿',
    cleanContent: '動画投稿',
    attachments,
    embeds: [],
    reference: null,
    createdAt: new Date('2026-07-22T12:00:00.000Z'),
    inGuild: () => true,
    toJSON: () => ({ attachments: [...attachments.values()].map((entry) => entry.toJSON()) })
  };
  const client = {
    appConfig: config,
    db,
    logger,
    timelineRelayMessageInFlight: new Set(),
    timelineRelayInFlight: new Set(),
    guilds: { cache: new Map() },
    users: { fetch: async () => null },
    user: { id: '999999999999999999' }
  };
  message.client = client;
  guild.client = client;
  guild.channels = {
    cache: new Map([[IDS.timeline, destinationChannel], [channel.id, channel]]),
    fetch: async (channelId) => String(channelId) === IDS.timeline ? destinationChannel : channel
  };
  client.guilds.cache.set(IDS.guild, guild);
  return message;
}

async function probeTweetBoundary({ db, config, logger }) {
  let sendCount = 0;
  let deleteCount = 0;
  let observedFiles = 0;
  let finalPayload = null;
  let uploadedFilePaths = [];
  const destinationChannel = {
    id: IDS.timeline,
    isTextBased: () => true,
    async send(payload) {
      sendCount += 1;
      finalPayload = payload;
      observedFiles = payload.files?.length || 0;
      await assertPayloadFilesExist(payload, 'tweet destination send');
      uploadedFilePaths = (payload.files || []).map((file) => file.attachment);
      const sent = {
        id: '1600000000000002001',
        channelId: IDS.timeline,
        attachments: new Map(),
        components: payload.components,
        async fetch() { return this; },
        async delete() { deleteCount += 1; }
      };
      return sent;
    }
  };
  const message = makeTweetMessage({ id: '1500000000000002001', config, db, logger, destinationChannel });
  await relayTweetMessage(message, { config, db, logger });
  assert.equal(sendCount, 1, 'tweet video sends exactly once');
  assert.equal(deleteCount, 0, 'Components V2 empty attachment metadata does not delete video card');
  assert.equal(observedFiles, 1, 'tweet video is reuploaded as one destination attachment');
  assert.deepEqual(
    extractTimelineComponentData(finalPayload).attachmentReferences.map((entry) => entry.filename),
    payloadAttachmentNames(finalPayload),
    'tweet attachment reference exactly matches the uploaded file name'
  );
  assert.equal(db.relays.getMessageRelayTarget(message.id, IDS.timeline)?.relayedMessageId, '1600000000000002001', 'tweet mapping retains original destination ID');
  assert(!JSON.stringify(finalPayload.components).includes('video-probe.invalid'), 'tweet final media excludes source CDN URL');
  assert.equal(db.timelineRelayRetries.get(message.id, IDS.timeline), null, 'unavailable verification does not create a retry');
  for (const filePath of uploadedFilePaths) {
    await assert.rejects(fs.stat(filePath), (error) => error?.code === 'ENOENT', 'tweet temp file is removed after send settles');
  }

  let fallbackSendCount = 0;
  let fallbackVisibleCount = 0;
  const fallbackDestination = {
    id: IDS.timeline,
    isTextBased: () => true,
    async send(payload) {
      fallbackSendCount += 1;
      await assertPayloadFilesExist(payload, 'tweet fallback destination send');
      if (payloadAttachmentNames(payload).some((name) => name.endsWith('.mp4'))) {
        throw Object.assign(new Error('request too large'), { code: 40005 });
      }
      fallbackVisibleCount += 1;
      return {
        id: '1600000000000002003',
        channelId: IDS.timeline,
        attachments: new Map(),
        components: payload.components,
        async fetch() { return this; },
        async delete() { throw new Error('fallback card must not be deleted'); }
      };
    }
  };
  const fallbackMessage = makeTweetMessage({ id: '1500000000000002003', config, db, logger, destinationChannel: fallbackDestination });
  await relayTweetMessage(fallbackMessage, { config, db, logger });
  assert.equal(fallbackSendCount, 2, 'tweet 40005 performs one upload request and one text fallback request');
  assert.equal(fallbackVisibleCount, 1, 'tweet 40005 leaves exactly one visible card');
  assert.equal(
    db.relays.getMessageRelayTarget(fallbackMessage.id, IDS.timeline)?.relayedMessageId,
    '1600000000000002003',
    'successful tweet fallback writes its destination mapping'
  );

  const failingDestination = {
    id: IDS.timeline,
    isTextBased: () => true,
    async send() { throw Object.assign(new Error('mock send failure'), { code: 50013 }); }
  };
  const failedMessage = makeTweetMessage({ id: '1500000000000002002', config, db, logger, destinationChannel: failingDestination });
  await assert.rejects(relayTweetMessage(failedMessage, { config, db, logger }));
  assert.equal(db.relays.getMessageRelayTarget(failedMessage.id, IDS.timeline), null, 'send failure does not write mapping');
}

async function probeValidationAndFallback({ config, logger }) {
  const attachment = makeNormalizedAttachment({ id: 'fallback-video', kind: 'mp4', name: 'fallback.mp4', url: 'https://video-probe.invalid/fallback.mp4' });
  const prepared = await buildTimelinePayload(makePost({ id: '1500000000000003001', attachments: [attachment] }), {
    config,
    forumType: 'tweet',
    logger
  });
  let calls = 0;
  let successfulCards = 0;
  let deleteCount = 0;
  try {
    const destination = {
      async send(payload) {
        calls += 1;
        await assertPayloadFilesExist(payload, 'fallback send');
        if ((payload.files || []).some((file) => file.name.endsWith('.mp4'))) {
          throw Object.assign(new Error('too large'), { code: 40005 });
        }
        successfulCards += 1;
        return { id: '1600000000000003001', attachments: new Map(), async delete() { deleteCount += 1; } };
      }
    };
    const delivery = await sendRelayMessageWithVideoFallback(destination, prepared.payload, logger, {
      sourceMessageId: '1500000000000003001',
      destinationChannelId: IDS.timeline,
      relayKind: 'probe'
    }, {
      preparedPost: prepared.preparedPost,
      config,
      forumType: 'tweet'
    });
    assert.equal(calls, 2, '40005 performs one failed upload attempt and one fallback request');
    assert.equal(successfulCards, 1, '40005 creates exactly one visible fallback card');
    assert.equal(deleteCount, 0, '40005 fallback never deletes a message');
    assert.equal(delivery.sentMessage.id, '1600000000000003001');
    assert.equal(delivery.videoFallbackUsed, true);
    assert.equal((delivery.effectivePayload.files || []).length, 0, 'video file is absent from fallback payload');
    assert(JSON.stringify(delivery.effectivePayload.components).includes('動画をコピーできなかった'));
    assert(!JSON.stringify(delivery.effectivePayload.components).includes(attachment.url));

    const mismatched = {
      ...prepared.payload,
      files: prepared.payload.files.map((file) => ({ ...file, name: `wrong-${file.name}` }))
    };
    let mismatchSendCount = 0;
    await assert.rejects(sendRelayMessage({ send: async () => { mismatchSendCount += 1; } }, mismatched, logger, {
      sourceMessageId: 'mismatch', destinationChannelId: IDS.timeline, relayKind: 'probe'
    }), (error) => error?.code === 'invalid_relay_payload');
    assert.equal(mismatchSendCount, 0, 'mismatched filename is rejected before send');

    const duplicate = { ...prepared.payload, files: [prepared.payload.files[0], { ...prepared.payload.files[0] }] };
    let duplicateSendCount = 0;
    await assert.rejects(sendRelayMessage({ send: async () => { duplicateSendCount += 1; } }, duplicate, logger, {
      sourceMessageId: 'duplicate', destinationChannelId: IDS.timeline, relayKind: 'probe'
    }), (error) => error?.code === 'invalid_relay_payload');
    assert.equal(duplicateSendCount, 0, 'duplicate upload filename is rejected before send');

    await fs.unlink(prepared.payload.files[0].attachment);
    let missingSendCount = 0;
    await assert.rejects(sendRelayMessage({ send: async () => { missingSendCount += 1; } }, prepared.payload, logger, {
      sourceMessageId: 'missing', destinationChannelId: IDS.timeline, relayKind: 'probe'
    }), (error) => error?.code === 'invalid_relay_payload');
    assert.equal(missingSendCount, 0, 'missing physical video file is rejected before send');
  } finally {
    await prepared.cleanup();
  }
}

async function probeThumbnailFailurePolicy({ logger, root }) {
  const directPost = makePost({
    id: '1500000000000004001',
    attachments: [makeNormalizedAttachment({ id: 'direct', kind: 'mp4', name: 'direct.mp4', url: 'https://video-probe.invalid/direct.mp4' })]
  });
  let ffmpegCheckCount = 0;
  const direct = await prepareVideoThumbnail(directPost, logger, {
    isFfmpegAvailable: async () => { ffmpegCheckCount += 1; return true; }
  });
  assert.equal(direct.post.generatedVideoThumbnailUrl, undefined, 'direct playable video has no redundant thumbnail');
  assert.equal(ffmpegCheckCount, 0, 'direct video skips ffmpeg availability check');

  const externalPost = { ...directPost, attachments: [] };
  const unavailable = await prepareVideoThumbnail(externalPost, logger, { isFfmpegAvailable: async () => false });
  assert.equal(unavailable.post.generatedVideoThumbnailUrl, undefined, 'ffmpeg unavailable falls back safely');

  const inputPath = path.join(root, 'thumbnail-input.mp4');
  const failed = await prepareVideoThumbnail(externalPost, logger, {
    isFfmpegAvailable: async () => true,
    downloadVideoFile: async (_url, outputPath) => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, mediaBytes.mp4);
      return { byteSize: mediaBytes.mp4.length };
    },
    generateThumbnail: async () => { throw Object.assign(new Error('ffmpeg timeout'), { code: 'ETIMEDOUT' }); }
  });
  assert.equal(failed.post.generatedVideoThumbnailUrl, undefined, 'ffmpeg timeout/decode failure does not block relay');
  await fs.unlink(inputPath).catch(() => null);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timeline-video-relay-probe-'));
  const tempDir = path.join(root, 'relay');
  const logger = makeLogger();
  const events = [];
  const fetchController = makeFetchController(events);
  const config = makeConfig(tempDir);
  const db = createDatabase(path.join(root, 'probe.sqlite'));
  try {
    await probePreparedVideoCases({ config, tempDir, logger });
    await probeQuestionInteractions({ db, config, logger, fetchController, events });
    await probeTweetBoundary({ db, config, logger });
    await probeValidationAndFallback({ config, logger });
    await probeThumbnailFailurePolicy({ logger, root });

    assert(logger.entries.some((entry) => entry.message === 'video thumbnail skipped'), 'single-download thumbnail skip is logged');
    assert(logger.entries.some((entry) => entry.message === 'question role interaction deferred'), 'interaction defer stage is logged');
    assert(logger.entries.some((entry) => entry.message === 'video fallback card created'), 'video fallback creation is logged');
    assert(!logger.entries.some((entry) => JSON.stringify(entry.metadata).includes('?ex=')), 'logs contain no signed CDN query data');

    console.log('probe-timeline-video-relay: passed (mocked Discord boundaries; no live Discord test)');
  } finally {
    db.sqlite.close();
    fetchController.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
