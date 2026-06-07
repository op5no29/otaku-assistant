const fs = require('node:fs');
const path = require('node:path');
const { parseAccentColor } = require('../utils/accentColors');

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

function ensureGlobalHashtagRoutes(value, label) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const normalizeRoute = (route, routeLabel) => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error(`${routeLabel} must be an object`);
    }

    return {
      tags: ensureArray(route.tags || [], `${routeLabel}.tags`),
      channelId: String(route.destinationChannelId || route.channelId || ''),
      displayTag: String(route.displayTag || route.display || route.tags?.[0] || ''),
      displayMode: String(route.displayMode || 'displayTag'),
      alsoTimeline: route.alsoTimeline === true,
      relayUserPostToDestination: route.relayUserPostToDestination !== false,
      accentColor: parseAccentColor(route.accentColor, null)
    };
  };

  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((route, index) => {
        const normalized = normalizeRoute(route, `${label}[${index}]`);
        const fallbackKey = normalized.tags[0] || `route_${index + 1}`;
        return [String(route.key || fallbackKey), normalized];
      })
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([routeKey, route]) => {
      return [String(routeKey), normalizeRoute(route, `${label}.${routeKey}`)];
    })
  );
}

function ensureTwitterMediaConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      videoMode: 'preview-only',
      maxVideoUploadBytes: 25_000_000,
      suppressDuplicateImages: true,
      resolveTimeoutMs: 15_000,
      ytDlpPath: 'yt-dlp'
    };
  }

  return {
    enabled: value.enabled !== false,
    videoMode: String(value.videoMode || 'preview-only'),
    maxVideoUploadBytes: Number(value.maxVideoUploadBytes ?? 25_000_000),
    suppressDuplicateImages: value.suppressDuplicateImages !== false,
    resolveTimeoutMs: Number(value.resolveTimeoutMs ?? 15_000),
    ytDlpPath: String(value.ytDlpPath || 'yt-dlp')
  };
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
          channelId: String(route.channelId || ''),
          accentColor: parseAccentColor(route.accentColor, null)
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

function ensureModeratorLogsConfig(value, opsConfig = {}) {
  const fallbackChannelId = String(opsConfig.logChannelId || '');
  const dashboardValue = value?.dashboard && typeof value.dashboard === 'object' && !Array.isArray(value.dashboard)
    ? value.dashboard
    : {};

  return {
    routineDiscordLogs: value?.routineDiscordLogs === true,
    introReminderSkipLogs: value?.introReminderSkipLogs === true,
    dashboard: {
      enabled: dashboardValue.enabled == null ? Boolean(fallbackChannelId) : dashboardValue.enabled !== false,
      channelId: String(dashboardValue.channelId || value?.channelId || fallbackChannelId),
      maxEvents: Math.max(1, Math.min(Number(dashboardValue.maxEvents ?? 3), 10)),
      recreateOnStartup: dashboardValue.recreateOnStartup === true,
      debounceMs: Math.max(1000, Number(dashboardValue.debounceMs ?? 5000))
    }
  };
}

function ensureIntroDmConfig(value, introChannelId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: false,
      devTestMode: false,
      devUserId: '',
      introChannelId: String(introChannelId || ''),
      logChannelId: '',
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

  return {
    enabled: value.enabled === true,
    devTestMode: value.devTestMode === true,
    devUserId: String(value.devUserId || ''),
    introChannelId: String(value.introChannelId || introChannelId || ''),
    logChannelId: String(value.logChannelId || value.botLogChannelId || ''),
    vcReminderCooldownDays: Number(value.vcReminderCooldownDays ?? 7),
    joinReminderHours: Number(value.joinReminderHours ?? 48),
    joinReminderQueueEnabled: value.joinReminderQueueEnabled !== false,
    joinReminderBatchSize: Number(value.joinReminderBatchSize ?? 3),
    joinReminderMinDelayMinutes: Number(value.joinReminderMinDelayMinutes ?? 5),
    joinReminderMaxDelayMinutes: Number(value.joinReminderMaxDelayMinutes ?? 30),
    queueAutoProcessEnabled: value.queueAutoProcessEnabled === true,
    queueProcessIntervalMinutes: Number(value.queueProcessIntervalMinutes ?? 5),
    maxLlmReplies: Number(value.maxLlmReplies ?? 3),
    llmRepliesEnabled: value.llmRepliesEnabled === true
  };
}

function ensureIntroVcReminderConfig(value, introDmConfig = {}, fallbackLogChannelId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: introDmConfig.enabled === true,
      devTestMode: introDmConfig.devTestMode === true,
      devUserId: String(introDmConfig.devUserId || ''),
      introChannelId: String(introDmConfig.introChannelId || ''),
      logChannelId: String(introDmConfig.logChannelId || fallbackLogChannelId || ''),
      maxReminderCount: 3,
      cooldownHoursByCount: [0, 24, 168],
      failureCooldownHours: 24,
      sendOnVoiceJoin: true
    };
  }

  const rawCooldowns = Array.isArray(value.cooldownHoursByCount)
    ? value.cooldownHoursByCount
    : [0, 24, 168];

  return {
    enabled: value.enabled == null ? introDmConfig.enabled === true : value.enabled === true,
    devTestMode: value.devTestMode == null ? introDmConfig.devTestMode === true : value.devTestMode === true,
    devUserId: String(value.devUserId || introDmConfig.devUserId || ''),
    introChannelId: String(value.introChannelId || introDmConfig.introChannelId || ''),
    logChannelId: String(value.logChannelId || introDmConfig.logChannelId || fallbackLogChannelId || ''),
    maxReminderCount: Math.max(1, Number(value.maxReminderCount ?? 3)),
    cooldownHoursByCount: rawCooldowns.map((entry) => Math.max(0, Number(entry || 0))),
    failureCooldownHours: Math.max(1, Number(value.failureCooldownHours ?? 24)),
    sendOnVoiceJoin: value.sendOnVoiceJoin !== false
  };
}

function ensureVoiceSessionSummaryConfig(value) {
  const defaultEndCard = {
    enabled: true,
    deleteMode: 'on_next_session',
    ttlMinutes: null,
    restoreLatestOnReady: true,
    messages: {
      default: '通話チャンネルのご利用ありがとうございました。またお気軽にどうぞ。',
      work: '集中作業、お疲れ様でした。',
      workShort: '作業おつかれさまでした。',
      workMedium: '集中作業、お疲れ様でした。',
      workLong: '長時間の作業、お疲れ様でした。',
      workVeryLong: 'かなり長時間の作業、本当にお疲れ様でした。',
      workUltraLong: 'ものすごい長時間の作業、本当にお疲れ様でした。しっかり休んでください。',
      longWork: '長時間の作業、お疲れ様でした。',
      music: '音楽作業、お疲れ様でした。',
      longMusic: '長時間の音楽作業、本当にお疲れ様でした。',
      chat: '通話お疲れ様でした。また気軽に遊びに来てください。',
      longChat: '長時間の通話、お疲れ様でした。またゆっくり休んでください。'
    }
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      minHumansToStart: 2,
      soloGraceMinutes: 90,
      minSessionActiveMinutes: 5,
      summaryLookbackHours: 24,
      maxEventsToShow: 10,
      reconcileIntervalMinutes: 5,
      endCard: defaultEndCard
    };
  }

  const endCardValue = value.endCard && typeof value.endCard === 'object' && !Array.isArray(value.endCard)
    ? value.endCard
    : {};
  const endCardMessagesValue = endCardValue.messages && typeof endCardValue.messages === 'object' && !Array.isArray(endCardValue.messages)
    ? endCardValue.messages
    : {};

  return {
    enabled: value.enabled !== false,
    minHumansToStart: Math.max(2, Number(value.minHumansToStart ?? 2)),
    soloGraceMinutes: Math.max(1, Number(value.soloGraceMinutes ?? 90)),
    minSessionActiveMinutes: Math.max(0, Number(value.minSessionActiveMinutes ?? 5)),
    summaryLookbackHours: Math.max(1, Number(value.summaryLookbackHours ?? 24)),
    maxEventsToShow: Math.max(0, Number(value.maxEventsToShow ?? 10)),
    reconcileIntervalMinutes: Math.max(1, Number(value.reconcileIntervalMinutes ?? 5)),
    endCard: {
      enabled: endCardValue.enabled !== false,
      deleteMode: endCardValue.deleteMode === 'ttl' ? 'ttl' : 'on_next_session',
      ttlMinutes: endCardValue.deleteMode === 'ttl'
        ? Math.max(1, Number(endCardValue.ttlMinutes ?? 30))
        : null,
      restoreLatestOnReady: endCardValue.restoreLatestOnReady !== false,
      messages: {
        ...defaultEndCard.messages,
        ...Object.fromEntries(
          Object.entries(endCardMessagesValue)
            .map(([key, message]) => [String(key), String(message || '').trim()])
            .filter(([, message]) => message.length > 0)
        )
      }
    }
  };
}

function ensureIntroAddendumsConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      maxMessages: 500,
      lookbackDays: 90,
      addReaction: true
    };
  }

  return {
    enabled: value.enabled !== false,
    maxMessages: Math.max(1, Math.min(Number(value.maxMessages ?? 500), 2000)),
    lookbackDays: Math.max(1, Number(value.lookbackDays ?? 90)),
    addReaction: value.addReaction !== false
  };
}

function ensureWelcomeDmConfig(value, fallbackLogChannelId = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: false,
      devTestMode: false,
      devUserId: '',
      delaySeconds: 30,
      delayMinutes: null,
      logChannelId: String(fallbackLogChannelId || '')
    };
  }

  return {
    enabled: value.enabled === true,
    devTestMode: value.devTestMode === true,
    devUserId: String(value.devUserId || ''),
    delaySeconds: Number(value.delaySeconds ?? (
      value.delayMinutes != null ? Number(value.delayMinutes) * 60 : 30
    )),
    delayMinutes: value.delayMinutes == null ? null : Number(value.delayMinutes),
    logChannelId: String(value.logChannelId || value.botLogChannelId || fallbackLogChannelId || '')
  };
}

function ensureAccentColorMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, color]) => [
      String(key),
      parseAccentColor(color, null)
    ]).filter(([, color]) => color != null)
  );
}

function ensureStringMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, labelValue]) => [
      String(key),
      String(labelValue || '').trim()
    ]).filter(([, labelValue]) => labelValue.length > 0)
  );
}

function ensureQuestionRolePromptConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: false,
      timeoutMinutes: 10,
      roles: [],
      knowWantRoleId: '',
      knowWantChannelIds: []
    };
  }

  const rawRoles = Array.isArray(value.roles) ? value.roles : [];
  return {
    enabled: value.enabled === true,
    timeoutMinutes: Number(value.timeoutMinutes ?? 10),
    roles: rawRoles
      .map((entry) => ({
        id: String(entry?.id || '').trim(),
        label: String(entry?.label || entry?.name || '').trim(),
        description: String(entry?.description || '').trim()
      }))
      .filter((entry) => entry.id && entry.label)
      .slice(0, 25),
    knowWantRoleId: String(value.knowWantRoleId || '').trim(),
    knowWantChannelIds: ensureArray(value.knowWantChannelIds || [], 'questionRolePrompt.knowWantChannelIds')
  };
}

function ensurePosthocRelayConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      rejectionBlockThreshold: 2,
      adminOverrideUserIds: []
    };
  }

  return {
    rejectionBlockThreshold: Number(value.rejectionBlockThreshold ?? 2),
    adminOverrideUserIds: ensureArray(value.adminOverrideUserIds || [], 'posthocRelay.adminOverrideUserIds')
  };
}

function ensureAnimeConfig(value) {
  const defaultReviewRoles = [
    { threshold: 10, roleId: null, name: 'アニメ視聴者 Lv.1' },
    { threshold: 20, roleId: null, name: 'アニメ視聴者 Lv.2' },
    { threshold: 50, roleId: null, name: 'アニメ語り部' },
    { threshold: 100, roleId: null, name: 'アニメ仙人' },
    { threshold: 300, roleId: null, name: 'アニメソムリエ' },
    { threshold: 500, roleId: null, name: 'オタク' }
  ];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      provider: 'annict',
      channelId: '',
      autoPostOnCastLookup: false,
      interestEmoji: '👀',
      watchedEmoji: '✅',
      maxCastInCard: 5,
      maxReviewsInCard: 5,
      indexPageSize: 25,
      apiTimeoutMs: 15_000,
      apiCacheTtlHours: 24,
      reviewRoles: defaultReviewRoles
    };
  }

  return {
    enabled: value.enabled !== false,
    provider: String(value.provider || 'annict'),
    channelId: String(value.channelId || ''),
    autoPostOnCastLookup: value.autoPostOnCastLookup === true,
    interestEmoji: String(value.interestEmoji || '👀'),
    watchedEmoji: String(value.watchedEmoji || '✅'),
    maxCastInCard: Number(value.maxCastInCard ?? 5),
    maxReviewsInCard: Number(value.maxReviewsInCard ?? 5),
    indexPageSize: Number(value.indexPageSize ?? 25),
    apiTimeoutMs: Number(value.apiTimeoutMs ?? 15_000),
    apiCacheTtlHours: Number(value.apiCacheTtlHours ?? 24),
    reviewRoles: Array.isArray(value.reviewRoles) && value.reviewRoles.length
      ? value.reviewRoles.map((entry) => ({
          threshold: Number(entry?.threshold ?? 0),
          roleId: entry?.roleId ? String(entry.roleId) : null,
          name: entry?.name ? String(entry.name) : null
        }))
      : defaultReviewRoles
  };
}

function ensureAnnictConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      baseUrl: 'https://api.annict.com/v1',
      accessTokenEnv: 'ANNICT_ACCESS_TOKEN',
      timeoutMs: 15_000,
      cacheTtlHours: 24
    };
  }

  return {
    enabled: value.enabled !== false,
    baseUrl: String(value.baseUrl || 'https://api.annict.com/v1'),
    accessTokenEnv: String(value.accessTokenEnv || 'ANNICT_ACCESS_TOKEN'),
    timeoutMs: Number(value.timeoutMs ?? 15_000),
    cacheTtlHours: Number(value.cacheTtlHours ?? 24)
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
  const normalizedOps = ensureOpsConfig(parsed.ops);
  const normalizedIntroDm = ensureIntroDmConfig(parsed.introDm, parsed.introChannelId);

  return {
    entranceChannelId: String(parsed.entranceChannelId || ''),
    timelineChannelId: String(parsed.timelineChannelId || ''),
    introChannelId: String(parsed.introChannelId || ''),
    welcomeChannelId: String(parsed.welcomeChannelId || ''),
    welcomeReactionsMax: Number(parsed.welcomeReactionsMax ?? 5),
    introReactionsMax: Number(parsed.introReactionsMax ?? parsed.introReactions?.max ?? 5),
    watchedForums: {
      question: ensureArray(parsed.watchedForums?.question || [], 'watchedForums.question'),
      tweet: ensureArray(parsed.watchedForums?.tweet || [], 'watchedForums.tweet'),
      knowledge: ensureArray(parsed.watchedForums?.knowledge || [], 'watchedForums.knowledge')
    },
    voiceProfileChannels: Array.isArray(parsed.voiceProfileChannels)
      ? parsed.voiceProfileChannels.map((entry) => ({
          name: String(entry.name || ''),
          profileChannelId: String(entry.profileChannelId || ''),
          accentColor: parseAccentColor(entry.accentColor, null),
          voiceStatusLabel: String(entry.voiceStatusLabel || entry.statusText || '').trim()
        }))
      : [],
    timeline: {
      maxContentLength: Number(parsed.timeline?.maxContentLength ?? 800),
      includeFirstImage: parsed.timeline?.includeFirstImage !== false,
      ignoreBotPosts: parsed.timeline?.ignoreBotPosts !== false,
      shortMergeEnabled: parsed.timelineShortMergeEnabled !== false,
      shortMergeMaxChars: Number(parsed.timelineShortMergeMaxChars ?? 60),
      shortMergeWindowSeconds: Number(parsed.timelineShortMergeWindowSeconds ?? 180),
      shortMergeMaxParts: Number(parsed.timelineShortMergeMaxParts ?? 5)
    },
    voiceProfile: {
      ignoreBots: parsed.voiceProfile?.ignoreBots !== false,
      reconcileIntervalMinutes: Number(parsed.voiceProfile?.reconcileIntervalMinutes ?? 3),
      channelAccentColors: ensureAccentColorMap(parsed.voiceProfile?.channelAccentColors, 'voiceProfile.channelAccentColors'),
      channelStatusLabels: ensureStringMap(parsed.voiceProfile?.channelStatusLabels || parsed.voiceProfile?.statusText, 'voiceProfile.channelStatusLabels')
    },
    voiceSessionSummary: ensureVoiceSessionSummaryConfig(parsed.voiceSessionSummary),
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
    questionRolePrompt: ensureQuestionRolePromptConfig(parsed.questionRolePrompt),
    posthocRelay: ensurePosthocRelayConfig(parsed.posthocRelay),
    introAddendums: ensureIntroAddendumsConfig(parsed.introAddendums),
    introDm: normalizedIntroDm,
    introVcReminder: ensureIntroVcReminderConfig(parsed.introVcReminder, normalizedIntroDm, normalizedOps.logChannelId || ''),
    welcomeDm: ensureWelcomeDmConfig(parsed.welcomeDm, normalizedOps.logChannelId || ''),
    anime: ensureAnimeConfig(parsed.anime),
    annict: ensureAnnictConfig(parsed.annict),
    ops: normalizedOps,
    moderatorLogs: ensureModeratorLogsConfig(parsed.moderatorLogs, normalizedOps),
    questionForumTags: ensureTagMap(parsed.questionForumTags, 'questionForumTags'),
    botHashtagRoutes: ensureBotHashtagRoutes(parsed.botHashtagRoutes, 'botHashtagRoutes'),
    vcListenOnlyChannelIds: ensureArray(parsed.vcListenOnlyChannelIds || [], 'vcListenOnlyChannelIds'),
    globalHashtagRoutes: ensureGlobalHashtagRoutes(parsed.globalHashtagRoutes, 'globalHashtagRoutes'),
    twitterMedia: ensureTwitterMediaConfig(parsed.twitterMedia)
  };
}

module.exports = {
  loadConfig
};
