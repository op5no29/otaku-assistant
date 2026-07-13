const { requestOllamaChat } = require('../llm/ollamaClient');
const { hasUserIntro } = require('../guildMembers');
const { appendOperationLog } = require('../logDashboard');

const PROMPT_TYPES = {
  VC_NO_INTRO: 'vc_no_intro',
  JOIN_NO_INTRO: 'join_48h_no_intro',
  WELCOME_JOIN: 'welcome_join'
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

function buildVcIntroReminderMessage(introChannelId, alreadySentCount = 0) {
  const introChannelLine = introChannelId ? [`<#${introChannelId}>`] : [];
  const variants = [
    'VCへのご参加ありがとうございます。このサーバーでは、自己紹介を書いておくと通話中のプロフィールカードに活動内容などを表示できます。',
    '以前もご案内しましたが、まだ自己紹介が確認できなかったため、改めてお知らせします。お時間のある時にご記入いただけると嬉しいです。',
    '自己紹介を投稿すると、VC参加中にあなたの活動やSNSをほかの参加者が確認しやすくなります。',
    '通話で初めて会う方にも活動内容が伝わるよう、よろしければ自己紹介をご登録ください。',
    '再度のご案内です。自己紹介はいつでも投稿できます。',
    '何度かVCをご利用いただいているため、改めて自己紹介機能をご案内します。投稿後はこのリマインドは届かなくなります。'
  ];
  const lead = variants[Math.max(0, Number(alreadySentCount || 0)) % variants.length];
  return [
    lead,
    '',
    '投稿先:',
    ...introChannelLine,
    '',
    'プロフィールカードには、自己紹介文、活動内容、SNSやポートフォリオのリンクなどが表示されます。',
    '自己紹介が確認できた後、このVC参加時リマインドは届かなくなります。'
  ].join('\n').trim();
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

function buildWelcomeJoinMessage() {
  return [
    'パソコン映像クラブへようこそ！',
    '',
    'このサーバーは、映像・音楽・CG・ゲーム・デザインなど、創作や知識共有をゆるく楽しむためのコミュニティです。',
    '',
    'まずは[案内チャンネル](https://discord.com/channels/1224747669122056232/1224770636266868847/1503975427348365322)を読んでもらえると助かります。',
    'https://discord.com/channels/1224747669122056232/1224770636266868847/1503975427348365322',
    '',
    'このサーバーでは、つぶやき用の個人スレッドを作って、作業ログ・作品・気になった情報・日常のメモなどを自由に投稿できます。',
    'まだ個人スレッドがない場合は、[こちらのチャンネル](https://discord.com/channels/1224747669122056232/1503668971520393367)から作ってみてください。',
    'https://discord.com/channels/1224747669122056232/1503668971520393367',
    '',
    'サーバーには独自の便利な機能がいくつかあります！ぜひ活用してください。',
    '',
    '・投稿に `##いい映像` `##いい音楽` `##技術``##Tips`  を付けると、該当のチャンネルやタイムラインに共有できます。',
    '・`##飯` / `##food` でごはん系の投稿を共有できます',
    '・`##アニメ` / `##anime` でアニメ作品カードや感想スレッドを作れます！！！（嬉）',
    '・[質問チャンネル](https://discord.com/channels/1224747669122056232/1224771331623485440)で質問をするとタイムラインから全体に共有されるので、回答を得やすいです。解決したら `/resolve` で解決済みにできます。',
    '',
    'ゆるく使ってもらえれば大丈夫です。よろしくお願いします！'
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

function getIntroVcReminderConfig(client) {
  const introDmConfig = getIntroDmConfig(client);
  return client.appConfig.introVcReminder || {
    enabled: introDmConfig.enabled === true,
    devTestMode: introDmConfig.devTestMode === true,
    devUserId: String(introDmConfig.devUserId || ''),
    introChannelId: getIntroChannelId(client),
    logChannelId: introDmConfig.logChannelId || client.appConfig.ops?.logChannelId || '',
    maxReminderCount: 3,
    cooldownHoursByCount: [0, 24, 168],
    failureCooldownHours: 24,
    sendOnVoiceJoin: true
  };
}

function getWelcomeDmConfig(client) {
  return client.appConfig.welcomeDm || {
    enabled: false,
    devTestMode: false,
    devUserId: '323041740963446785',
    delaySeconds: 30,
    logChannelId: client.appConfig.ops?.logChannelId || '1224747669604536385'
  };
}

function getPromptConfig(client, promptType) {
  if (promptType === PROMPT_TYPES.WELCOME_JOIN) {
    return getWelcomeDmConfig(client);
  }
  return getIntroDmConfig(client);
}

function getIntroChannelId(client) {
  return String(getIntroDmConfig(client).introChannelId || client.appConfig.introChannelId || '');
}

function getIntroVcReminderIntroChannelId(client) {
  return String(getIntroVcReminderConfig(client).introChannelId || getIntroChannelId(client) || '');
}

function getIntroDmGuildId(client) {
  return process.env.GUILD_ID || '';
}

function getIntroDmReasonLabel(promptType) {
  if (promptType === PROMPT_TYPES.WELCOME_JOIN) {
    return 'サーバー参加時の挨拶DM';
  }
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
  const config = getPromptConfig(client, promptType);
  const label = promptType === PROMPT_TYPES.WELCOME_JOIN ? '挨拶DM' : '自己紹介DM';
  const content = success
    ? [
        `${label}を送信しました。`,
        `対象: <@${userId}> (\`${userId}\`)`,
        `種類: \`${promptType}\``,
        `理由: ${reason}`,
        `devTestMode: ${config.devTestMode ? 'true' : 'false'}`,
        `時刻: ${new Date().toISOString()}`
      ].join('\n')
    : [
        `${label}の送信に失敗しました。`,
        `対象: <@${userId}> (\`${userId}\`)`,
        `種類: \`${promptType}\``,
        `理由: ${reason}`,
        `devTestMode: ${config.devTestMode ? 'true' : 'false'}`,
        `エラー: ${errorMessage || 'unknown'}`,
        `時刻: ${new Date().toISOString()}`
      ].join('\n');

  appendOperationLog(client, {
    severity: success ? 'info' : 'error',
    eventType: success ? 'intro_dm_sent' : 'intro_dm_failed',
    title: success ? `${label}を送信しました` : `${label}の送信に失敗しました`,
    body: content,
    metadata: {
      userId,
      promptType,
      success,
      logChannelId: config.logChannelId || null
    }
  });
  return null;
}

function isAllowedTargetUser(client, userId, promptType = null) {
  const config = getPromptConfig(client, promptType);
  if (!config.devTestMode) {
    return true;
  }

  return String(userId) === String(config.devUserId);
}

async function sendIntroDm(client, { guildId: providedGuildId, userId, promptType }) {
  const config = getPromptConfig(client, promptType);
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

  if (!isAllowedTargetUser(client, userId, promptType)) {
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

  const content = promptType === PROMPT_TYPES.WELCOME_JOIN
    ? buildWelcomeJoinMessage()
    : promptType === PROMPT_TYPES.JOIN_NO_INTRO
      ? buildJoinReminderMessage(getIntroChannelId(client))
      : buildVcReminderMessage(getIntroChannelId(client));

  logger.info(promptType === PROMPT_TYPES.WELCOME_JOIN ? 'welcome DM send started' : 'Intro DM test started', {
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
      status: 'sent',
      sentAt: new Date().toISOString(),
      repliedCount: 0,
      optOut: false,
      lastError: null
    });

    logger.info(promptType === PROMPT_TYPES.WELCOME_JOIN ? 'welcome DM sent' : 'Intro DM sent', {
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
      status: 'failed',
      lastError: error.message
    });

    logger.warn(promptType === PROMPT_TYPES.WELCOME_JOIN ? 'welcome DM failed' : 'Intro DM failed', {
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

function getIntroVcReminderCooldownHours(config, reminderCount) {
  const cooldowns = Array.isArray(config.cooldownHoursByCount) ? config.cooldownHoursByCount : [0, 24, 168];
  const fallback = cooldowns.length ? cooldowns[cooldowns.length - 1] : 168;
  return Math.max(0, Number(cooldowns[reminderCount] ?? fallback ?? 0));
}

function addHours(dateOrIso, hours) {
  const base = dateOrIso ? new Date(dateOrIso).getTime() : Date.now();
  if (!Number.isFinite(base)) {
    return null;
  }
  return new Date(base + (Number(hours || 0) * 60 * 60 * 1000));
}

function hasElapsedSince(dateOrIso, hours) {
  if (!dateOrIso) {
    return true;
  }
  const next = addHours(dateOrIso, hours);
  if (!next) {
    return true;
  }
  return Date.now() >= next.getTime();
}

function shouldSendIntroVcReminderForJoin(config, qualifyingJoinCount) {
  const count = Number(qualifyingJoinCount || 0);
  if (count <= 0) {
    return false;
  }
  if (count === Number(config.firstReminderJoinCount || 1)) {
    return true;
  }
  const earlyCounts = (config.earlyReminderJoinCounts || [3, 6])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (new Set(earlyCounts).has(count)) {
    return true;
  }
  const anchor = Math.max(Number(config.firstReminderJoinCount || 1), ...earlyCounts);
  const every = Math.max(1, Number(config.repeatEveryQualifyingJoins || 5));
  return count > anchor && (count - anchor) % every === 0;
}

function getVoiceChannelLabel(voiceChannel, channelId) {
  if (voiceChannel?.name) {
    return `${voiceChannel.name} (\`${voiceChannel.id || channelId}\`)`;
  }
  if (channelId) {
    return `\`${channelId}\``;
  }
  return '(不明)';
}

async function sendIntroVcReminderReport(client, {
  userId,
  voiceChannel = null,
  channelId = null,
  reminderCount = 0,
  success = false,
  skippedReason = null,
  errorMessage = null,
  nextEligibleAt = null
}) {
  const config = getIntroVcReminderConfig(client);

  const status = success
    ? 'intro reminder DM sent'
    : errorMessage
      ? 'intro reminder DM failed'
      : `intro reminder DM skipped ${skippedReason || 'unknown'}`;
  const lines = [
    status,
    `対象: <@${userId}> (\`${userId}\`)`,
    `VC: ${getVoiceChannelLabel(voiceChannel, channelId)}`,
    `reminder_count: ${reminderCount}`,
    `理由: ${success ? 'sent' : skippedReason || 'unknown'}`
  ];

  if (nextEligibleAt) {
    lines.push(`次回送信可能: ${nextEligibleAt.toISOString()}`);
  }
  if (errorMessage) {
    lines.push(`エラー: ${errorMessage}`);
  }
  lines.push(`時刻: ${new Date().toISOString()}`);

  const importantSkipReasons = new Set([
    'missing_config',
    'reminder_limit_reached'
  ]);
  const shouldShowRoutineSkip = client.appConfig.moderatorLogs?.introReminderSkipLogs === true;
  const shouldRecordVisible =
    success ||
    Boolean(errorMessage) ||
    importantSkipReasons.has(String(skippedReason || '')) ||
    shouldShowRoutineSkip;

  if (!shouldRecordVisible) {
    client.logger.info('intro reminder visible report suppressed routine skip', {
      userId,
      skippedReason: skippedReason || null,
      reminderCount
    });
    return null;
  }

  appendOperationLog(client, {
    severity: success ? 'info' : errorMessage ? 'error' : 'warn',
    eventType: success
      ? 'intro_reminder_dm_sent'
      : errorMessage
        ? 'intro_reminder_dm_failed'
        : `intro_reminder_${skippedReason || 'skipped'}`,
    title: status,
    body: lines.join('\n'),
    metadata: {
      userId,
      channelId,
      voiceChannelId: voiceChannel?.id || channelId || null,
      reminderCount,
      skippedReason,
      logChannelId: config.logChannelId || null
    }
  });
  return null;
}

async function withIntroVcReminderLock(client, guildId, userId, callback) {
  if (!client.introVcReminderLocks) {
    client.introVcReminderLocks = new Map();
  }

  const key = `${guildId}:${userId}`;
  const previous = client.introVcReminderLocks.get(key) || Promise.resolve();
  let release;
  const current = previous.catch(() => null).then(() => new Promise((resolve) => {
    release = resolve;
  }));
  client.introVcReminderLocks.set(key, current);

  await previous.catch(() => null);

  try {
    return await callback();
  } finally {
    if (typeof release === 'function') {
      release();
    }
    if (client.introVcReminderLocks.get(key) === current) {
      client.introVcReminderLocks.delete(key);
    }
  }
}

async function maybeSendVcNoIntroDmLocked(client, member, options = {}) {
  const config = getIntroVcReminderConfig(client);
  const logger = client.logger;
  const guildId = member.guild.id;
  const userId = member.id;
  const channelId = String(options.channelId || member.voice?.channelId || '');
  const voiceChannel = options.voiceChannel || member.voice?.channel || null;
  const voiceJoinAt = new Date().toISOString();

  logger.info('VC intro check started', {
    guildId,
    userId,
    channelId: channelId || null
  });

  if (member.user?.bot) {
    logger.info('intro reminder DM skipped bot', { guildId, userId });
    return { ok: false, skippedReason: 'bot_user' };
  }

  if (!config.sendOnVoiceJoin) {
    logger.info('intro reminder DM skipped disabled', { guildId, userId, skippedReason: 'send_on_voice_join_disabled' });
    return { ok: false, skippedReason: 'send_on_voice_join_disabled' };
  }

  if (config.devTestMode && String(userId) !== String(config.devUserId)) {
    logger.info('intro reminder DM skipped not dev user', { guildId, userId });
    return { ok: false, skippedReason: 'not_dev_user' };
  }

  if (!config.enabled && !config.devTestMode) {
    logger.info('intro reminder DM skipped disabled', { guildId, userId });
    return { ok: false, skippedReason: 'disabled' };
  }

  const introChannelId = getIntroVcReminderIntroChannelId(client);
  if (!introChannelId) {
    logger.warn('intro reminder DM skipped missing config', {
      guildId,
      userId,
      missing: 'introChannelId'
    });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      skippedReason: 'missing_config'
    });
    return { ok: false, skippedReason: 'missing_config' };
  }

  const introExists = hasUserIntro(client, guildId, userId);
  if (introExists && !(config.devTestMode && String(userId) === String(config.devUserId))) {
    const completedAt = new Date().toISOString();
    client.db.introVcReminder?.markCompleted?.(guildId, userId, completedAt);
    logger.info('intro reminder DM skipped already introduced', { guildId, userId });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      skippedReason: 'already_has_intro',
      reminderCount: client.db.introVcReminder?.get?.(guildId, userId)?.reminderCount || 0
    });
    return { ok: false, skippedReason: 'already_has_intro' };
  }

  const previousState = client.db.introVcReminder?.get?.(guildId, userId) || null;
  if (
    previousState?.lastDisconnectedAt &&
    !hasElapsedSince(previousState.lastDisconnectedAt, Number(config.rapidRejoinWindowMinutes || 30) / 60)
  ) {
    logger.info('intro rapid rejoin ignored', {
      guildId,
      userId,
      channelId,
      lastDisconnectedAt: previousState.lastDisconnectedAt
    });
    return { ok: false, skippedReason: 'rapid_rejoin' };
  }
  client.db.introVcReminder?.recordJoin?.({ guildId, userId, channelId, joinedAt: voiceJoinAt });
  const state = client.db.introVcReminder?.get?.(guildId, userId) || previousState || null;
  const reminderCount = Math.max(0, Number(state?.reminderCount || 0));
  const qualifyingJoinCount = Math.max(0, Number(state?.qualifyingJoinCount || 0));
  logger.info('intro qualifying join counted', {
    guildId,
    userId,
    channelId,
    qualifyingJoinCount
  });

  if (config.maxReminderCount != null && reminderCount >= Number(config.maxReminderCount)) {
    logger.info('intro reminder legacy limit reached', {
      guildId,
      userId,
      reminderCount
    });
    return { ok: false, skippedReason: 'reminder_limit_reached' };
  }

  if (!shouldSendIntroVcReminderForJoin(config, qualifyingJoinCount)) {
    logger.info('intro reminder DM skipped join cadence', {
      guildId,
      userId,
      qualifyingJoinCount,
      reminderCount
    });
    return { ok: false, skippedReason: 'join_cadence' };
  }

  const failureCooldownHours = Math.max(1, Number(config.dmFailureCooldownDays || 14) * 24);
  if (
    previousState?.lastError &&
    !hasElapsedSince(previousState.lastFailureAt || previousState.updatedAt, failureCooldownHours)
  ) {
    const nextEligibleAt = addHours(previousState.lastFailureAt || previousState.updatedAt, failureCooldownHours);
    logger.info('intro reminder DM skipped cooldown', {
      guildId,
      userId,
      reminderCount,
      skippedReason: 'recent_dm_failure',
      nextEligibleAt: nextEligibleAt?.toISOString() || null
    });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      reminderCount,
      skippedReason: 'dm_failed',
      nextEligibleAt
    });
    return { ok: false, skippedReason: 'dm_failed' };
  }

  const cooldownHours = Math.max(1, Number(config.minimumDaysBetweenReminders || 7) * 24);
  if (
    state?.lastSentAt &&
    !hasElapsedSince(state.lastSentAt, cooldownHours)
  ) {
    const nextEligibleAt = addHours(state.lastSentAt, cooldownHours);
    logger.info('intro reminder DM skipped cooldown', {
      guildId,
      userId,
      reminderCount,
      cooldownHours,
      lastSentAt: state.lastSentAt,
      nextEligibleAt: nextEligibleAt?.toISOString() || null
    });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      reminderCount,
      skippedReason: 'cooldown_not_elapsed',
      nextEligibleAt
    });
    return { ok: false, skippedReason: 'cooldown_not_elapsed' };
  }

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {
    client.db.introVcReminder?.markError?.({
      guildId,
      userId,
      channelId,
      error: 'user_fetch_failed',
      voiceJoinAt
    });
    client.db.introDm.upsertState({
      guildId,
      userId,
      promptType: PROMPT_TYPES.VC_NO_INTRO,
      status: 'failed',
      lastError: 'user_fetch_failed'
    });
    logger.warn('intro reminder DM failed', {
      guildId,
      userId,
      error: 'user_fetch_failed'
    });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      reminderCount,
      success: false,
      skippedReason: 'dm_failed',
      errorMessage: 'user_fetch_failed'
    });
    return { ok: false, skippedReason: 'user_fetch_failed' };
  }

  try {
    const dmMessage = await user.send({
      content: buildVcIntroReminderMessage(introChannelId, reminderCount),
      allowedMentions: {
        parse: []
      }
    });
    const sentAt = new Date().toISOString();
    client.db.introVcReminder?.markSent?.({
      guildId,
      userId,
      channelId,
      dmMessageId: dmMessage.id,
      sentAt,
      voiceJoinAt
    });
    client.db.introDm.upsertState({
      guildId,
      userId,
      promptType: PROMPT_TYPES.VC_NO_INTRO,
      status: 'sent',
      sentAt,
      repliedCount: 0,
      optOut: false,
      lastError: null
    });
    logger.info('intro reminder DM sent', {
      guildId,
      userId,
      reminderNumber: reminderCount + 1,
      dmMessageId: dmMessage.id
    });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      reminderCount: reminderCount + 1,
      success: true
    });
    return { ok: true, dmMessage, reminderCount: reminderCount + 1 };
  } catch (error) {
    client.db.introVcReminder?.markError?.({
      guildId,
      userId,
      channelId,
      error: error.message,
      voiceJoinAt
    });
    client.db.introDm.upsertState({
      guildId,
      userId,
      promptType: PROMPT_TYPES.VC_NO_INTRO,
      status: 'failed',
      lastError: error.message
    });
    logger.warn('intro reminder DM failed', {
      guildId,
      userId,
      reminderNumber: reminderCount + 1,
      error: error.message
    });
    await sendIntroVcReminderReport(client, {
      userId,
      voiceChannel,
      channelId,
      reminderCount,
      success: false,
      skippedReason: 'dm_failed',
      errorMessage: error.message
    });
    return {
      ok: false,
      skippedReason: 'dm_failed',
      error,
      permanentFailure: isPermanentIntroDmFailure(error)
    };
  }
}

async function maybeSendVcNoIntroDm(client, member, options = {}) {
  const guildId = member.guild.id;
  const userId = member.id;
  return withIntroVcReminderLock(client, guildId, userId, () => (
    maybeSendVcNoIntroDmLocked(client, member, options)
  ));
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

function getWelcomeDmDelayMs(config) {
  if (config.delayMinutes != null && Number.isFinite(Number(config.delayMinutes))) {
    return Math.max(0, Number(config.delayMinutes) * 60 * 1000);
  }
  return Math.max(0, Number(config.delaySeconds ?? 30) * 1000);
}

async function enqueueWelcomeJoinDm(client, member) {
  const config = getWelcomeDmConfig(client);
  const guildId = member.guild?.id || getIntroDmGuildId(client);
  const userId = member.id;

  if (member.user?.bot) {
    client.logger.info('welcome DM skipped bot', {
      guildId,
      userId
    });
    return { queued: false, skippedReason: 'bot' };
  }

  if (!config.enabled && !config.devTestMode) {
    client.logger.info('welcome DM skipped existing', {
      guildId,
      userId,
      skippedReason: 'disabled'
    });
    return { queued: false, skippedReason: 'disabled' };
  }

  if (config.devTestMode && String(userId) !== String(config.devUserId)) {
    client.logger.info('welcome DM skipped existing', {
      guildId,
      userId,
      skippedReason: 'not_dev_user'
    });
    return { queued: false, skippedReason: 'not_dev_user' };
  }

  const existingState = client.db.introDm.getState(guildId, userId, PROMPT_TYPES.WELCOME_JOIN);
  if (
    existingState?.sentAt ||
    ['sent', 'failed', 'skipped'].includes(String(existingState?.status || ''))
  ) {
    client.logger.info('welcome DM skipped existing', {
      guildId,
      userId,
      status: existingState.status || null,
      sentAt: existingState.sentAt || null,
      lastError: existingState.lastError || null
    });
    return { queued: false, skippedReason: 'existing_state' };
  }

  const existingQueue = client.db.introDmQueue.getPendingForUserPrompt(guildId, userId, PROMPT_TYPES.WELCOME_JOIN);
  if (existingQueue) {
    client.logger.info('welcome DM skipped existing', {
      guildId,
      userId,
      queueId: existingQueue.id,
      scheduledAt: existingQueue.scheduledAt,
      skippedReason: 'pending_queue'
    });
    return { queued: false, skippedReason: 'pending_queue' };
  }

  const scheduledAt = new Date(Date.now() + getWelcomeDmDelayMs(config)).toISOString();
  client.db.introDmQueue.enqueue({
    guildId,
    userId,
    promptType: PROMPT_TYPES.WELCOME_JOIN,
    reason: getIntroDmReasonLabel(PROMPT_TYPES.WELCOME_JOIN),
    scheduledAt
  });
  client.db.introDm.upsertState({
    guildId,
    userId,
    promptType: PROMPT_TYPES.WELCOME_JOIN,
    status: 'pending',
    lastError: null
  });

  client.logger.info('welcome DM queued', {
    guildId,
    userId,
    scheduledAt,
    delaySeconds: Math.round(getWelcomeDmDelayMs(config) / 1000)
  });

  return { queued: true, scheduledAt };
}

async function processIntroDmQueue(client, guildId = null, limit = null, options = {}) {
  const config = getIntroDmConfig(client);
  const welcomeConfig = getWelcomeDmConfig(client);
  const logger = client.logger;
  const processorLabel = options.processorLabel || 'manual';
  const welcomeQueueEnabled = welcomeConfig.enabled === true || welcomeConfig.devTestMode === true;

  if (!config.joinReminderQueueEnabled && !welcomeQueueEnabled) {
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

  if (
    options.requireEnabled === true &&
    !config.enabled &&
    !config.devTestMode &&
    !welcomeQueueEnabled
  ) {
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
  const promptTypeFilter = Array.isArray(options.promptTypes) && options.promptTypes.length
    ? new Set(options.promptTypes.map(String))
    : null;
  const recoveredCount = client.db.introDmQueue.resetStaleProcessing(staleBeforeIso);
  if (recoveredCount > 0) {
    logger.warn('intro DM queue stale processing rows reset', {
      processorLabel,
      recoveredCount
    });
  }

  try {
    const duePoolLimit = promptTypeFilter ? 1000000 : batchSize;
    const duePool = guildId
      ? client.db.introDmQueue.listDue(guildId, nowIso, duePoolLimit)
      : client.db.introDmQueue.listDueAllGuilds(nowIso, duePoolLimit);
    const filteredDuePool = promptTypeFilter
      ? duePool.filter((item) => promptTypeFilter.has(String(item.promptType)))
      : duePool;
    const allDueCount = promptTypeFilter
      ? filteredDuePool.length
      : guildId
        ? client.db.introDmQueue.listDue(guildId, nowIso, 1000000).length
        : client.db.introDmQueue.countDue(nowIso);
    const dueItems = filteredDuePool.slice(0, batchSize);

    logger.info(options.isAutomatic ? 'intro DM auto queue tick started' : 'intro DM queue processing started', {
      processorLabel,
      guildId,
      dueCount: allDueCount,
      selectedCount: dueItems.length,
      batchSize,
      promptTypes: promptTypeFilter ? [...promptTypeFilter] : null
    });

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const item of dueItems) {
    client.db.introDmQueue.markStatus(item.id, 'processing');
    const itemConfig = getPromptConfig(client, item.promptType);

    if (item.promptType !== PROMPT_TYPES.WELCOME_JOIN && hasUserIntro(client, item.guildId || guildId, item.userId)) {
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'skipped',
        attempts: Number(item.attempts || 0) + 1,
        lastError: 'intro_found_before_send'
      });
      client.db.introDm.upsertState({
        guildId: item.guildId || guildId,
        userId: item.userId,
        promptType: item.promptType,
        status: 'skipped',
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

    if (itemConfig.devTestMode && String(item.userId) !== String(itemConfig.devUserId)) {
      client.db.introDmQueue.updateStatus(item.id, {
        status: 'skipped',
        attempts: Number(item.attempts || 0) + 1,
        lastError: 'not_dev_user'
      });
      client.db.introDm.upsertState({
        guildId: item.guildId || guildId,
        userId: item.userId,
        promptType: item.promptType,
        status: 'skipped',
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
      client.db.introDm.upsertState({
        guildId: item.guildId || guildId,
        userId: item.userId,
        promptType: item.promptType,
        status: 'skipped',
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
  const welcomeConfig = getWelcomeDmConfig(client);
  const intervalMinutes = Number(config.queueProcessIntervalMinutes || 5);
  const shouldAutoProcess = config.queueAutoProcessEnabled || welcomeConfig.enabled === true || welcomeConfig.devTestMode === true;

  if (client.introDmQueueInterval) {
    clearInterval(client.introDmQueueInterval);
    client.introDmQueueInterval = null;
  }

  if (!shouldAutoProcess) {
    client.logger.info('intro DM auto queue processor disabled', {
      intervalMinutes,
      batchSize: Number(config.joinReminderBatchSize || 3)
    });
    return;
  }

  client.logger.info('intro DM auto queue processor enabled', {
    intervalMinutes,
    batchSize: Number(config.joinReminderBatchSize || 3),
    welcomeDmEnabled: welcomeConfig.enabled === true,
    welcomeDmDevTestMode: welcomeConfig.devTestMode === true
  });

  const runTick = async () => {
    try {
      await processIntroDmQueue(client, null, null, {
        processorLabel: 'auto_interval',
        isAutomatic: true,
        requireEnabled: true,
        promptTypes: config.queueAutoProcessEnabled ? null : [PROMPT_TYPES.WELCOME_JOIN]
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
  enqueueWelcomeJoinDm,
  processIntroDmQueue,
  startIntroDmQueueProcessor,
  isPermanentIntroDmFailure
};
