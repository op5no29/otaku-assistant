const fs = require('node:fs');
const path = require('node:path');

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.filter(Boolean).map(String);
}

function ensureTagMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([forumId, tagConfig]) => {
      if (!tagConfig || typeof tagConfig !== 'object') {
        throw new Error(`${label}.${forumId} must be an object`);
      }

      return [
        String(forumId),
        {
          resolved: String(tagConfig.resolved || ''),
          open: String(tagConfig.open || '')
        }
      ];
    })
  );
}

function ensureBotHashtagRoutes(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([routeKey, route]) => {
      if (!route || typeof route !== 'object') {
        throw new Error(`${label}.${routeKey} must be an object`);
      }

      return [
        String(routeKey),
        {
          aliases: ensureArray(route.aliases || [], `${label}.${routeKey}.aliases`),
          display: String(route.display || `#${routeKey}`),
          channelId: String(route.channelId || '')
        }
      ];
    })
  );
}

function ensureStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return fallback.map(String);
  }

  return value.filter(Boolean).map(String);
}

function ensureOpsConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      logChannelId: '',
      developerPortalUrl: '',
      allowRestartCommand: false
    };
  }

  return {
    logChannelId: String(value.logChannelId || ''),
    developerPortalUrl: String(value.developerPortalUrl || ''),
    allowRestartCommand: value.allowRestartCommand === true
  };
}

function ensureIntroDmConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: false,
      devTestMode: true,
      devUserId: '323041740963446785',
      vcReminderCooldownDays: 7,
      joinReminderHours: 48,
      maxLlmReplies: 2,
      llmRepliesEnabled: false
    };
  }

  return {
    enabled: value.enabled === true,
    devTestMode: value.devTestMode !== false,
    devUserId: String(value.devUserId || '323041740963446785'),
    vcReminderCooldownDays: Number(value.vcReminderCooldownDays ?? 7),
    joinReminderHours: Number(value.joinReminderHours ?? 48),
    maxLlmReplies: Number(value.maxLlmReplies ?? 2),
    llmRepliesEnabled: value.llmRepliesEnabled === true
  };
}

function loadConfig(configPath) {
  if (!process.env.DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN is missing in .env');
  }

  if (!process.env.CLIENT_ID) {
    throw new Error('CLIENT_ID is missing in .env');
  }

  if (!process.env.GUILD_ID) {
    throw new Error('GUILD_ID is missing in .env');
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}. Copy ${path.basename(configPath, '.json')}.example.json first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    entranceChannelId: String(parsed.entranceChannelId || ''),
    timelineChannelId: String(parsed.timelineChannelId || ''),
    introChannelId: String(parsed.introChannelId || ''),
    welcomeChannelId: String(parsed.welcomeChannelId || ''),
    welcomeReactionsMax: Number(parsed.welcomeReactionsMax ?? 5),
    watchedForums: {
      question: ensureArray(parsed.watchedForums?.question || [], 'watchedForums.question'),
      tweet: ensureArray(parsed.watchedForums?.tweet || [], 'watchedForums.tweet'),
      knowledge: ensureArray(parsed.watchedForums?.knowledge || [], 'watchedForums.knowledge')
    },
    voiceProfileChannels: Array.isArray(parsed.voiceProfileChannels)
      ? parsed.voiceProfileChannels.map((entry) => ({
          name: String(entry.name || ''),
          profileChannelId: String(entry.profileChannelId || '')
        }))
      : [],
    timeline: {
      maxContentLength: Number(parsed.timeline?.maxContentLength ?? 800),
      includeFirstImage: parsed.timeline?.includeFirstImage !== false,
      ignoreBotPosts: parsed.timeline?.ignoreBotPosts !== false
    },
    voiceProfile: {
      ignoreBots: parsed.voiceProfile?.ignoreBots !== false
    },
    mediaRelay: {
      maxReuploadBytes: Number(parsed.mediaRelay?.maxReuploadBytes ?? 25_000_000),
      tempDir: String(parsed.mediaRelay?.tempDir || './tmp/relay-media')
    },
    llm: {
      enabled: parsed.llmEnabled !== false,
      contextMessageLimit: Number(parsed.llmContextMessageLimit ?? 50),
      shortRequestContextLimit: Number(parsed.llmShortRequestContextLimit ?? 2),
      mentionedUserMessageLimit: Number(parsed.llmMentionedUserMessageLimit ?? 30),
      introProfileCandidateLimit: Number(parsed.llmIntroProfileCandidateLimit ?? 3),
      includeIntroProfiles: parsed.llmIncludeIntroProfiles !== false,
      thinkingMessage: String(parsed.llmThinkingMessage || '少女祈祷中...'),
      thinkingMessages: ensureStringArray(parsed.llmThinkingMessages, [
        '少女祈祷中...',
        '応答作成中...',
        '会話を整理中...',
        '文脈を読み込み中...',
        'ローカルLLMが考えています...',
        '少しお待ちください...'
      ]),
      busyMessages: ensureStringArray(parsed.llmBusyMessages, [
        '回線が混雑しています。少し待ってからもう一度試してください。',
        '少女が困っています。少し待ってからもう一度試してください。',
        'ただいま応答処理が詰まっています。少し待ってからもう一度試してください。',
        'ローカルLLMが別の応答を処理中です。少し待ってからもう一度試してください。'
      ]),
      numPredict: Number(parsed.llmNumPredict ?? 160),
      numPredictShort: Number(parsed.llmNumPredictShort ?? 48),
      numCtx: Number(parsed.llmNumCtx ?? 1024),
      temperature: Number(parsed.llmTemperature ?? 0.3),
      topP: Number(parsed.llmTopP ?? 0.9),
      keepAlive: String(parsed.llmKeepAlive || '30m'),
      maxReplyChars: Number(parsed.llmMaxReplyChars ?? 1800),
      timeoutMs: Number(parsed.llmTimeoutMs ?? 120000),
      baseUrl: String(parsed.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'),
      model: String(parsed.ollamaModel || process.env.OLLAMA_MODEL || 'gemma3:4b')
    },
    questions: {
      resolvedPrefix: String(parsed.questions?.resolvedPrefix || '[解決済]'),
      allowResolveBy: ensureArray(
        parsed.questions?.allowResolveBy || ['threadOwner', 'administrator'],
        'questions.allowResolveBy'
      ),
      moderatorRoleIds: ensureArray(parsed.questions?.moderatorRoleIds || [], 'questions.moderatorRoleIds')
    },
    introDm: ensureIntroDmConfig(parsed.introDm),
    ops: ensureOpsConfig(parsed.ops),
    questionForumTags: ensureTagMap(parsed.questionForumTags, 'questionForumTags'),
    botHashtagRoutes: ensureBotHashtagRoutes(parsed.botHashtagRoutes, 'botHashtagRoutes')
  };
}

module.exports = {
  loadConfig
};
