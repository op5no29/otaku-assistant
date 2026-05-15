const { requestOllamaChat } = require('../llm/ollamaClient');
const { hasUserIntro } = require('../guildMembers');

const PROMPT_TYPES = {
  VC_NO_INTRO: 'vc_no_intro',
  JOIN_NO_INTRO: 'join_48h_no_intro'
};

const INTENT_RULES = {
  opt_out: [
    /DMしないで/u,
    /DMすんな/u,
    /送らないで/u,
    /もう送るな/u,
    /通知しないで/u,
    /やめて/u,
    /\bstop\b/i,
    /\bunsubscribe\b/i,
    /no\s*dm/i,
    /don'?t\s*dm/i
  ],
  ask_help: [
    /どんなことを書けばいい/u,
    /何を書けばいい/u,
    /何書けばいい/u,
    /例文/u,
    /書き方.*教えて/u,
    /内容.*教えて/u,
    /書いていい.*こと/u
  ],
  thanks: [
    /ありがとう/u,
    /助かる/u,
    /了解/u,
    /りょうかい/u,
    /わかった/u,
    /\bthanks\b/i,
    /\bthx\b/i
  ],
  wrote_intro: [
    /書いた/u,
    /投稿した/u,
    /自己紹介した/u,
    /書いてみた/u,
    /投稿してみた/u
  ]
};

function classifyIntroDmIntentByRules(content) {
  const text = String(content || '');
  for (const [intent, patterns] of Object.entries(INTENT_RULES)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return { intent, usedLlm: false, matchedPattern: pattern.toString() };
      }
    }
  }

  return { intent: 'unclear', usedLlm: false, matchedPattern: null };
}

async function classifyIntroDmIntentByLlm(content, client) {
  try {
    const response = await requestOllamaChat({
      baseUrl: process.env.OLLAMA_BASE_URL || client.appConfig.llm.baseUrl,
      model: process.env.OLLAMA_MODEL || client.appConfig.llm.model,
      timeoutMs: Math.min(Number(client.appConfig.llm.timeoutMs || 30000), 20000),
      logger: client.logger,
      sourceMessageId: 'intro-dm-intent',
      shortRequestMode: true,
      numPredict: 20,
      numCtx: 256,
      temperature: 0.1,
      topP: 0.9,
      keepAlive: '10m',
      messages: [
        {
          role: 'system',
          content: 'Classify the user\'s intent. Reply ONLY with JSON: {"intent":"opt_out"|"ask_help"|"thanks"|"wrote_intro"|"unclear"}'
        },
        {
          role: 'user',
          content: String(content || '').slice(0, 200)
        }
      ]
    });

    if (response) {
      const jsonMatch = String(response).match(/\{[^}]+\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const valid = ['opt_out', 'ask_help', 'thanks', 'wrote_intro', 'unclear'];
        if (valid.includes(parsed.intent)) {
          return parsed.intent;
        }
      }
    }
  } catch {
    // intentional: fallback to unclear
  }

  return 'unclear';
}

async function classifyIntroDmIntent(content, client) {
  const ruleResult = classifyIntroDmIntentByRules(content);
  if (ruleResult.intent !== 'unclear') {
    return { ...ruleResult };
  }

  const llmIntent = await classifyIntroDmIntentByLlm(content, client);
  return { intent: llmIntent, usedLlm: true, matchedPattern: null };
}

function buildVcReminderMessage(introChannelId) {
  return [
    'こんにちは、Otaku Assistantです。',
    '',
    '通話に参加してくれてありがとうございます！',
    'このサーバーでは、通話中に「誰が何をしている人なのか」が分かりやすいように、自己紹介チャンネルの投稿をもとにVCプロフィールを表示しています。',
    '',
    'まだ自己紹介が見つからなかったので、よければ時間があるときに自己紹介を書いてもらえると嬉しいです。',
    '',
    '短くて大丈夫です。',
    '・名前 / 呼び方',
    '・作っているもの、興味のある分野',
    '・SNS、YouTube、ポートフォリオなどのリンク',
    '・最近やっていること',
    '',
    '自己紹介チャンネルはこちらです：',
    `<#${introChannelId}>`,
    '',
    '無理に長く書かなくて大丈夫です。ひとまず一言だけでも助かります。'
  ].join('\n');
}

function buildJoinReminderMessage(introChannelId) {
  return [
    'こんにちは、Otaku Assistantです。',
    '',
    'サーバーに参加してから少し時間が経ったので、自己紹介のお願いで連絡しました。',
    '',
    'このサーバーは、映像・音楽・CG・ゲーム・デザインなど、創作や知識共有をゆるく楽しむためのコミュニティです。',
    'メンバー同士が話しかけやすくなるように、できれば自己紹介チャンネルに一度だけ投稿してもらえると助かります。',
    '',
    '内容は短くて大丈夫です。',
    '・呼ばれたい名前',
    '・興味のある分野',
    '・作っているもの / 勉強していること',
    '・SNSや作品リンク',
    '・最近ハマっていること',
    '',
    '自己紹介チャンネルはこちらです：',
    `<#${introChannelId}>`,
    '',
    'よろしくお願いします！'
  ].join('\n');
}

function getIntroDmConfig(client) {
  return client.appConfig.introDm || {
    enabled: false,
    devTestMode: true,
    devUserId: '323041740963446785',
    introChannelId: client.appConfig.introChannelId || '1503672008930623508',
    logChannelId: '1224747669604536385',
    vcReminderCooldownDays: 7,
    joinReminderHours: 48,
    joinReminderQueueEnabled: true,
    joinReminderBatchSize: 3,
    joinReminderMinDelayMinutes: 5,
    joinReminderMaxDelayMinutes: 30,
    queueAutoProcessEnabled: false,
    queueProcessIntervalMinutes: 5,
    maxLlmReplies: 3,
    llmRepliesEnabled: false
  };
}

function getIntroChannelId(client) {
  return String(getIntroDmConfig(client).introChannelId || client.appConfig.introChannelId || '');
}

function getIntroDmGuildId(client) {
  return process.env.GUILD_ID || '';
}

function getIntroDmReasonLabel(promptType) {
  if (promptType === PROMPT_TYPES.JOIN_NO_INTRO) {
    return '参加から一定時間経過しても自己紹介が見つからなかったため';
  }
  return '通話参加時に自己紹介が見つからなかったため';
}

function isPermanentIntroDmFailure(errorOrMessage) {
  const message = String(errorOrMessage?.message || errorOrMessage || '').toLowerCase();
  return [
    'cannot send messages to this user due to having no mutual guilds',
    'cannot send messages to this user',
    'missing access',
    'unknown user'
  ].some((needle) => message.includes(needle));
}

async function sendIntroDmReport(client, {
  userId,
  promptType,
  success,
  reason,
  errorMessage = null
}) {
  const config = getIntroDmConfig(client);
  const channelId = config.logChannelId;
  if (!channelId) {
    return null;
  }

  const content = success
    ? [
        '自己紹介DMを送信しました。',
        `対象: <@${userId}> (\`${userId}\`)`,
        `種類: \`${promptType}\``,
        `理由: ${reason}`,
        `devTestMode: ${config.devTestMode ? 'true' : 'false'}`,
        `時刻: ${new Date().toISOString()}`
      ].join('\n')
    : [
        '自己紹介DMの送信に失敗しました。',
        `対象: <@${userId}> (\`${userId}\`)`,
        `種類: \`${promptType}\``,
        `理由: ${reason}`,
        `devTestMode: ${config.devTestMode ? 'true' : 'false'}`,
        `エラー: ${errorMessage || 'unknown'}`,
        `時刻: ${new Date().toISOString()}`
      ].join('\n');

  try {
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      client.logger.warn('intro DM report failed', {
        channelId,
        reason: 'not_text_based'
      });
      return null;
    }

    const sent = await channel.send({
      content,
      allowedMentions: {
        parse: [],
        repliedUser: false
      }
    });
    client.logger.info('intro DM report sent', {
      channelId,
      userId,
      promptType,
      success,
      reportMessageId: sent.id
    });
    return sent;
  } catch (error) {
    client.logger.warn('intro DM report failed', {
      channelId,
      userId,
      promptType,
      success,
      error: error.message
    });
    return null;
  }
}

function isAllowedTargetUser(client, userId) {
  const config = getIntroDmConfig(client);
  if (!config.devTestMode) {
    return true;
  }

  return String(userId) === String(config.devUserId);
}

async function sendIntroDm(client, { guildId: providedGuildId, userId, promptType }) {
  const config = getIntroDmConfig(client);
  const logger = client.logger;
  const guildId = providedGuildId || getIntroDmGuildId(client);

  if (!config.enabled && !config.devTestMode) {
    logger.info('Intro DM skipped because disabled', {
      guildId,
      userId,
      promptType
    });
    return {
      ok: false,
      skippedReason: 'disabled'
    };
  }

  if (!isAllowedTargetUser(client, userId)) {
    logger.info('Intro DM skipped because not dev user', {
      guildId,
      userId,
      promptType
    });
    return {
      ok: false,
      skippedReason: 'not_dev_user'
    };
  }

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {
    client.db.introDm.upsertState({
      guildId,
      userId,
      promptType,
      lastError: 'user_fetch_failed'
    });
    return {
      ok: false,
      skippedReason: 'user_fetch_failed'
    };
  }

  const content = promptType === PROMPT_TYPES.JOIN_NO_INTRO
    ? buildJoinReminderMessage(getIntroChannelId(client))
    : buildVcReminderMessage(getIntroChannelId(client));

  logger.info('Intro DM test started', {
    guildId,
    userId,
    promptType
  });

  try {
    const dmMessage = await user.send({
      content,
      allowedMentions: {
        parse: []
      }
    });

    client.db.introDm.upsertState({
      guildId,
      userId,
      promptType,
      sentAt: new Date().toISOString(),
      repliedCount: 0,
      optOut: false,
      lastError: null
    });

    logger.info('Intro DM sent', {
      guildId,
      userId,
      promptType,
      dmMessageId: dmMessage.id
    });
    await sendIntroDmReport(client, {
      userId,
      promptType,
      success: true,
      reason: getIntroDmReasonLabel(promptType)
    });

    return {
      ok: true,
      dmMessage
    };
  } catch (error) {
    const permanentFailure = isPermanentIntroDmFailure(error);
    client.db.introDm.upsertState({
      guildId,
      userId,
      promptType,
      lastError: error.message
    });

    logger.warn('Intro DM failed', {
      guildId,
      userId,
      promptType,
      error: error.message
    });
    await sendIntroDmReport(client, {
      userId,
      promptType,
      success: false,
      reason: getIntroDmReasonLabel(promptType),
      errorMessage: error.message
    });

    return {
      ok: false,
      skippedReason: 'send_failed',
      error,
      permanentFailure
    };
  }
}

async function handleIntroDmMessage(message) {
  if (message.inGuild?.() || message.author?.bot) {
    return false;
  }

  const client = message.client;
  const guildId = getIntroDmGuildId(client);
  if (!isAllowedTargetUser(client, message.author.id)) {
    client.logger.info('Intro DM reply skipped non-dev', {
      guildId,
      userId: message.author.id
    });
    return false;
  }

  client.logger.info('Intro DM reply received', {
    guildId,
    userId: message.author.id,
    messageId: message.id
  });

  const states = client.db.introDm.listStatesByUser(guildId, message.author.id);
  if (!states.length) {
    client.logger.info('Intro DM reply ignored no state', {
      guildId,
      userId: message.author.id,
      messageId: message.id
    });
    return false;
  }

  if (states.some((state) => state.optOut)) {
    client.logger.info('Intro DM reply ignored due to opt-out', {
      guildId,
      userId: message.author.id,
      messageId: message.id
    });
    return true;
  }

  const { intent, usedLlm, matchedPattern } = await classifyIntroDmIntent(message.content || '', client);

  client.logger.info('Intro DM intent classified', {
    guildId,
    userId: message.author.id,
    messageId: message.id,
    intent,
    usedLlm,
    matchedPattern
  });

  if (intent === 'opt_out') {
    client.db.introDm.markOptOutByUser(guildId, message.author.id);
    client.logger.info('Intro DM opt-out detected and applied', {
      guildId,
      userId: message.author.id
    });
    await message.reply({
      content: '了解しました。今後この自己紹介案内のDMは送らないようにします。',
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => null);
    client.logger.info('Intro DM opt-out response sent', { guildId, userId: message.author.id });
    return true;
  }

  client.db.introDm.incrementReplyCountByUser(guildId, message.author.id);
  client.logger.info('Intro DM replied_count updated', { guildId, userId: message.author.id });

  if (intent === 'ask_help') {
    await message.reply({
      content: [
        '返信ありがとうございます！',
        '自己紹介は短くて大丈夫です。たとえば「呼び方 / 興味のある分野 / 最近やっていること」を一言ずつ書いてもらえれば十分です。',
        'よければ自己紹介チャンネルに投稿してみてください。',
        `<#${getIntroChannelId(client)}>`
      ].join('\n'),
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => null);
    client.logger.info('Intro DM ask_help response sent', { guildId, userId: message.author.id });
    return true;
  }

  if (intent === 'thanks') {
    await message.reply({
      content: 'ありがとうございます！自己紹介は短くて大丈夫なので、気が向いたときに投稿してもらえたら嬉しいです。',
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => null);
    client.logger.info('Intro DM thanks response sent', { guildId, userId: message.author.id });
    return true;
  }

  if (intent === 'wrote_intro') {
    await message.reply({
      content: '投稿ありがとうございます！確認できたらVCプロフィールなどにも反映されます。',
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => null);
    client.logger.info('Intro DM wrote_intro response sent', { guildId, userId: message.author.id });
    return true;
  }

  const config = getIntroDmConfig(client);
  const effectiveState = states[0];

  if (!config.llmRepliesEnabled || effectiveState.repliedCount >= config.maxLlmReplies) {
    await message.reply({
      content: 'ありがとうございます。自己紹介チャンネルへの投稿もぜひ気軽にどうぞ。',
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => null);
    client.logger.info('Intro DM unclear fallback response sent', { guildId, userId: message.author.id });
    return true;
  }

  const model = process.env.OLLAMA_MODEL || client.appConfig.llm.model;
  const response = await requestOllamaChat({
    baseUrl: process.env.OLLAMA_BASE_URL || client.appConfig.llm.baseUrl,
    model,
    timeoutMs: client.appConfig.llm.timeoutMs,
    logger: client.logger,
    sourceMessageId: message.id,
    shortRequestMode: true,
    numPredict: 64,
    numCtx: 512,
    temperature: 0.3,
    topP: 0.9,
    keepAlive: String(client.appConfig.llm.keepAlive || '30m'),
    messages: [
      {
        role: 'system',
        content: 'あなたは Otaku Assistant です。Discord サーバーの自己紹介をやさしく促す短い日本語返信だけを返してください。モデル名は名乗らないでください。'
      },
      {
        role: 'user',
        content: `ユーザーからDM返信がありました。\n\n${message.content || '(本文なし)'}\n\n短く丁寧に返信し、自己紹介チャンネルへの投稿を無理なく促してください。`
      }
    ]
  }).catch(() => null);

  if (response) {
    await message.reply({
      content: response,
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => null);
    client.logger.info('Intro DM LLM response sent', { guildId, userId: message.author.id });
  }

  return true;
}

function getIntroDmStatus(client) {
  const config = getIntroDmConfig(client);
  return {
    enabled: config.enabled,
    devTestMode: config.devTestMode,
    devUserId: config.devUserId,
    introChannelId: getIntroChannelId(client),
    stateCount: client.db.introDm.countStates()
  };
}

function shouldSkipByCooldown(client, guildId, userId, promptType, cooldownDays) {
  const state = client.db.introDm.getState(guildId, userId, promptType);
  if (!state) {
    return false;
  }
  if (state.optOut) {
    return 'opt_out';
  }
  if (!state.sentAt) {
    return false;
  }
  const cutoffMs = Date.now() - (Number(cooldownDays || 7) * 24 * 60 * 60 * 1000);
  return new Date(state.sentAt).getTime() >= cutoffMs ? 'cooldown' : false;
}

async function maybeSendVcNoIntroDm(client, member) {
  const config = getIntroDmConfig(client);
  const logger = client.logger;
  const guildId = member.guild.id;
  logger.info('VC intro check started', {
    guildId,
    userId: member.id,
    channelId: member.voice?.channelId || null
  });

  if (member.user?.bot) {
    logger.info('skipped bot', { guildId, userId: member.id });
    return { ok: false, skippedReason: 'bot' };
  }

  const introExists = hasUserIntro(client, guildId, member.id);
  if (introExists && !(config.devTestMode && String(member.id) === String(config.devUserId))) {
    logger.info('skipped has intro', { guildId, userId: member.id });
    return { ok: false, skippedReason: 'has_intro' };
  }

  if (config.devTestMode && String(member.id) !== String(config.devUserId)) {
    logger.info('skipped devTest non-dev', { guildId, userId: member.id });
    return { ok: false, skippedReason: 'not_dev_user' };
  }

  if (!config.enabled && !config.devTestMode) {
    logger.info('skipped because disabled', { guildId, userId: member.id });
    return { ok: false, skippedReason: 'disabled' };
  }

  const cooldownState = shouldSkipByCooldown(
    client,
    guildId,
    member.id,
    PROMPT_TYPES.VC_NO_INTRO,
    config.vcReminderCooldownDays
  );
  if (cooldownState) {
    logger.info(`skipped ${cooldownState}`, {
      guildId,
      userId: member.id,
      promptType: PROMPT_TYPES.VC_NO_INTRO
    });
    return { ok: false, skippedReason: cooldownState };
  }

  const result = await sendIntroDm(client, {
    guildId,
    userId: member.id,
    promptType: PROMPT_TYPES.VC_NO_INTRO
  });

  if (result.ok) {
    logger.info('intro DM sent vc_no_intro', {
      guildId,
      userId: member.id
    });
  } else {
    logger.warn('intro DM failed', {
      guildId,
      userId: member.id,
      promptType: PROMPT_TYPES.VC_NO_INTRO,
      skippedReason: result.skippedReason || result.error?.message || 'unknown'
    });
  }

  return result;
}

function randomIntInclusive(min, max) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

function enqueueJoinIntroDmCandidates(client, guildId, candidates) {
  const config = getIntroDmConfig(client);
  if (!config.joinReminderQueueEnabled) {
    return {
      queuedCount: 0,
      skippedExistingCount: 0,
      skippedReason: 'queue_disabled'
    };
  }
  const now = Date.now();
  let offsetMinutes = 0;
  let queuedCount = 0;
  let skippedExistingCount = 0;

  for (const candidate of candidates) {
    if (config.devTestMode && String(candidate.userId) !== String(config.devUserId)) {
      continue;
    }
    if (client.db.introDmQueue.getPendingForUserPrompt(guildId, candidate.userId, PROMPT_TYPES.JOIN_NO_INTRO)) {
      skippedExistingCount += 1;
      continue;
    }
    const delayMinutes = randomIntInclusive(
      Number(config.joinReminderMinDelayMinutes || 5),
      Number(config.joinReminderMaxDelayMinutes || 30)
    );
    offsetMinutes += delayMinutes;
    client.db.introDmQueue.enqueue({
      guildId,
      userId: candidate.userId,
      promptType: PROMPT_TYPES.JOIN_NO_INTRO,
      reason: getIntroDmReasonLabel(PROMPT_TYPES.JOIN_NO_INTRO),
      scheduledAt: new Date(now + (offsetMinutes * 60 * 1000)).toISOString()
    });
    queuedCount += 1;
  }

  return {
    queuedCount,
    skippedExistingCount
  };
}

async function processIntroDmQueue(client, guildId = null, limit = null, options = {}) {
  const config = getIntroDmConfig(client);
  const logger = client.logger;
  const processorLabel = options.processorLabel || 'manual';

  if (!config.joinReminderQueueEnabled) {
    logger.info('intro DM queue processing skipped because queue is disabled', {
      processorLabel,
      guildId
    });
    return {
      dueCount: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      remainingPendingCount: client.db.introDmQueue.countByStatus().find((entry) => entry.status === 'pending')?.count || 0,
      skippedReason: 'queue_disabled'
    };
  }

  if (options.requireEnabled === true && !config.enabled) {
    logger.info('auto queue skipped because disabled', {
      processorLabel,
      guildId
    });
    return {
      dueCount: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      remainingPendingCount: client.db.introDmQueue.countByStatus().find((entry) => entry.status === 'pending')?.count || 0,
      skippedReason: 'disabled'
    };
  }

  if (client.introDmQueueProcessing) {
    logger.info(options.isAutomatic ? 'auto queue skipped because already processing' : 'intro DM queue processor already running', {
      processorLabel,
      guildId
    });
    return {
      dueCount: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      remainingPendingCount: client.db.introDmQueue.countByStatus().find((entry) => entry.status === 'pending')?.count || 0,
      skippedReason: 'already_processing'
    };
  }

  client.introDmQueueProcessing = true;
  const batchSize = Number(limit || config.joinReminderBatchSize || 3);
  const nowIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - (30 * 60 * 1000)).toISOString();
  const recoveredCount = client.db.introDmQueue.resetStaleProcessing(staleBeforeIso);
  if (recoveredCount > 0) {
    logger.warn('intro DM queue stale processing rows reset', {
      processorLabel,
      recoveredCount
    });
  }

  try {
    const allDueCount = guildId
      ? client.db.introDmQueue.listDue(guildId, nowIso, 1000000).length
      : client.db.introDmQueue.countDue(nowIso);
    const dueItems = guildId
      ? client.db.introDmQueue.listDue(guildId, nowIso, batchSize)
      : client.db.introDmQueue.listDueAllGuilds(nowIso, batchSize);

    logger.info(options.isAutomatic ? 'intro DM auto queue tick started' : 'intro DM queue processing started', {
      processorLabel,
      guildId,
      dueCount: allDueCount,
      selectedCount: dueItems.length,
      batchSize
    });

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const item of dueItems) {
    client.db.introDmQueue.markStatus(item.id, 'processing');

    if (hasUserIntro(client, item.guildId || guildId, item.userId)) {
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'skipped',
        attempts: Number(item.attempts || 0) + 1,
        lastError: 'intro_found_before_send'
      });
      skippedCount += 1;
      logger.info('intro DM queue skipped because intro found before send', {
        processorLabel,
        guildId: item.guildId || guildId,
        userId: item.userId,
        promptType: item.promptType
      });
      continue;
    }

    if (config.devTestMode && String(item.userId) !== String(config.devUserId)) {
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'skipped',
        attempts: Number(item.attempts || 0) + 1,
        lastError: 'not_dev_user'
      });
      skippedCount += 1;
      continue;
    }

    const result = await sendIntroDm(client, {
      guildId: item.guildId || guildId,
      userId: item.userId,
      promptType: item.promptType
    });

    if (result.ok) {
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'sent',
        attempts: Number(item.attempts || 0) + 1,
        lastError: null
      });
      sentCount += 1;
    } else if (result.skippedReason === 'not_dev_user' || result.skippedReason === 'disabled' || result.skippedReason === 'cooldown' || result.skippedReason === 'opt_out') {
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'skipped',
        attempts: Number(item.attempts || 0) + 1,
        lastError: result.skippedReason
      });
      skippedCount += 1;
    } else {
      const failureReason = result.error?.message || result.skippedReason || 'send_failed';
      client.logger.warn('intro DM queue send failed', {
        processorLabel,
        guildId: item.guildId || guildId,
        userId: item.userId,
        promptType: item.promptType,
        permanentFailure: result.permanentFailure === true,
        error: failureReason
      });
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'failed',
        attempts: Number(item.attempts || 0) + 1,
        lastError: failureReason
      });
      failedCount += 1;
    }
  }

    const remainingPendingCount = client.db.introDmQueue.countByStatus().find((entry) => entry.status === 'pending')?.count || 0;

    logger.info(options.isAutomatic ? 'intro DM auto queue tick finished' : 'intro DM queue processing finished', {
      processorLabel,
      guildId,
      dueCount: allDueCount,
      selectedCount: dueItems.length,
      sentCount,
      failedCount,
      skippedCount,
      remainingPendingCount
    });

    return {
      dueCount: allDueCount,
      selectedCount: dueItems.length,
      sentCount,
      failedCount,
      skippedCount,
      remainingPendingCount
    };
  } finally {
    client.introDmQueueProcessing = false;
  }
}

function startIntroDmQueueProcessor(client) {
  const config = getIntroDmConfig(client);
  const intervalMinutes = Number(config.queueProcessIntervalMinutes || 5);

  if (client.introDmQueueInterval) {
    clearInterval(client.introDmQueueInterval);
    client.introDmQueueInterval = null;
  }

  if (!config.queueAutoProcessEnabled) {
    client.logger.info('intro DM auto queue processor disabled', {
      intervalMinutes,
      batchSize: Number(config.joinReminderBatchSize || 3)
    });
    return;
  }

  client.logger.info('intro DM auto queue processor enabled', {
    intervalMinutes,
    batchSize: Number(config.joinReminderBatchSize || 3)
  });

  const runTick = async () => {
    try {
      await processIntroDmQueue(client, null, null, {
        processorLabel: 'auto_interval',
        isAutomatic: true,
        requireEnabled: true
      });
    } catch (error) {
      client.logger.error('intro DM auto queue tick failed', {
        processorLabel: 'auto_interval',
        error: error.message
      });
    }
  };

  client.introDmQueueInterval = setInterval(() => {
    void runTick();
  }, Math.max(1, intervalMinutes) * 60 * 1000);

  if (typeof client.introDmQueueInterval.unref === 'function') {
    client.introDmQueueInterval.unref();
  }
}

module.exports = {
  PROMPT_TYPES,
  sendIntroDm,
  handleIntroDmMessage,
  getIntroDmStatus,
  maybeSendVcNoIntroDm,
  enqueueJoinIntroDmCandidates,
  processIntroDmQueue,
  startIntroDmQueueProcessor,
  isPermanentIntroDmFailure
};
