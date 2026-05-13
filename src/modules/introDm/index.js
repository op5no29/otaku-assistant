const { requestOllamaChat } = require('../llm/ollamaClient');

const PROMPT_TYPES = {
  VC_NO_INTRO: 'vc_no_intro',
  JOIN_NO_INTRO: 'join_48h_no_intro'
};

const OPT_OUT_PATTERN = /(やめて|DMしないで|通知しないで|stop|unsubscribe)/iu;

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
  const states = client.db.introDm.listStatesByUser(guildId, message.author.id);
  if (!states.length) {
    return false;
  }

  if (OPT_OUT_PATTERN.test(message.content || '')) {
    client.db.introDm.markOptOutByUser(guildId, message.author.id);
    client.logger.info('Intro DM opt-out detected', {
      guildId,
      userId: message.author.id
    });
    await message.reply({
      content: '了解しました。今後この案内DMは送りません。',
      allowedMentions: {
        repliedUser: false,
        parse: []
      }
    }).catch(() => null);
    return true;
  }

  client.db.introDm.incrementReplyCountByUser(guildId, message.author.id);

  const config = getIntroDmConfig(client);
  if (!config.llmRepliesEnabled) {
    return true;
  }

  const effectiveState = states[0];
  if (effectiveState.repliedCount >= config.maxLlmReplies) {
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
      allowedMentions: {
        repliedUser: false,
        parse: []
      }
    }).catch(() => null);
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
