const { requestOllamaChat } = require('../llm/ollamaClient');

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
    vcReminderCooldownDays: 7,
    joinReminderHours: 48,
    maxLlmReplies: 2,
    llmRepliesEnabled: false
  };
}

function getIntroDmGuildId(client) {
  return process.env.GUILD_ID || '';
}

function isAllowedTargetUser(client, userId) {
  const config = getIntroDmConfig(client);
  if (!config.devTestMode) {
    return true;
  }

  return String(userId) === String(config.devUserId);
}

async function sendIntroDm(client, { userId, promptType }) {
  const config = getIntroDmConfig(client);
  const logger = client.logger;
  const guildId = getIntroDmGuildId(client);

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
    ? buildJoinReminderMessage(client.appConfig.introChannelId)
    : buildVcReminderMessage(client.appConfig.introChannelId);

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

    return {
      ok: true,
      dmMessage
    };
  } catch (error) {
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

    return {
      ok: false,
      skippedReason: 'send_failed',
      error
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
        `<#${client.appConfig.introChannelId}>`
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
    stateCount: client.db.introDm.countStates()
  };
}

module.exports = {
  PROMPT_TYPES,
  sendIntroDm,
  handleIntroDmMessage,
  getIntroDmStatus
};
