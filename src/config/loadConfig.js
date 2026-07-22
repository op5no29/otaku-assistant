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
  const defaultEarlyCounts = [3, 6];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: introDmConfig.enabled === true,
      devTestMode: introDmConfig.devTestMode === true,
      devUserId: String(introDmConfig.devUserId || ''),
      introChannelId: String(introDmConfig.introChannelId || ''),
      logChannelId: String(introDmConfig.logChannelId || fallbackLogChannelId || ''),
      maxReminderCount: null,
      cooldownHoursByCount: [0, 24, 168],
      failureCooldownHours: 24,
      sendOnVoiceJoin: true,
      rapidRejoinWindowMinutes: 30,
      firstReminderJoinCount: 1,
      earlyReminderJoinCounts: defaultEarlyCounts,
      repeatEveryQualifyingJoins: 5,
      minimumDaysBetweenReminders: 7,
      dmFailureCooldownDays: 14
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
    maxReminderCount: value.maxAutomaticReminders == null && value.maxReminderCount == null
      ? null
      : Math.max(1, Number(value.maxAutomaticReminders ?? value.maxReminderCount)),
    cooldownHoursByCount: rawCooldowns.map((entry) => Math.max(0, Number(entry || 0))),
    failureCooldownHours: Math.max(1, Number(value.failureCooldownHours ?? 24)),
    sendOnVoiceJoin: value.sendOnVoiceJoin !== false,
    rapidRejoinWindowMinutes: Math.max(1, Number(value.rapidRejoinWindowMinutes ?? 30)),
    firstReminderJoinCount: Math.max(1, Number(value.firstReminderJoinCount ?? 1)),
    earlyReminderJoinCounts: ensureArray(value.earlyReminderJoinCounts || defaultEarlyCounts, 'introVcReminder.earlyReminderJoinCounts')
      .map((entry) => Math.max(1, Number(entry || 0)))
      .filter((entry) => Number.isFinite(entry)),
    repeatEveryQualifyingJoins: Math.max(1, Number(value.repeatEveryQualifyingJoins ?? 5)),
    minimumDaysBetweenReminders: Math.max(1, Number(value.minimumDaysBetweenReminders ?? 7)),
    dmFailureCooldownDays: Math.max(1, Number(value.dmFailureCooldownDays ?? 14))
  };
}

function ensureVoiceSessionSummaryConfig(value) {
  const defaultEndCard = {
    enabled: true,
    deleteMode: 'on_next_session',
    ttlMinutes: null,
    restoreLatestOnReady: false,
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
      endCard: defaultEndCard,
      shortActivity: {
        enabled: true,
        maxDisplayedEpisodes: 5,
        maxStoredEpisodes: 50,
        retentionDays: 7,
        includeAfk: false,
        visibleDuringLiveProfile: true,
        trackSoloVisits: true
      }
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
      restoreLatestOnReady: endCardValue.restoreLatestOnReady === true,
      messages: {
        ...defaultEndCard.messages,
        ...Object.fromEntries(
          Object.entries(endCardMessagesValue)
            .map(([key, message]) => [String(key), String(message || '').trim()])
            .filter(([, message]) => message.length > 0)
        )
      }
    },
    shortActivity: {
      enabled: value.shortActivity?.enabled !== false,
      maxDisplayedEpisodes: Math.max(1, Math.min(Number(value.shortActivity?.maxDisplayedEpisodes ?? 5), 20)),
      maxStoredEpisodes: Math.max(1, Math.min(Number(value.shortActivity?.maxStoredEpisodes ?? 50), 500)),
      retentionDays: Math.max(1, Number(value.shortActivity?.retentionDays ?? 7)),
      includeAfk: value.shortActivity?.includeAfk === true,
      visibleDuringLiveProfile: value.shortActivity?.visibleDuringLiveProfile !== false,
      trackSoloVisits: value.shortActivity?.trackSoloVisits !== false
    }
  };
}

function ensureVoiceWorkTimeConfig(value) {
  const defaultMilestoneHours = [1, 5, 10, 24, 48, 72, 100, 168, 200, 300, 336, 500, 720, 1000];
  const cardValue = value?.milestoneCard && typeof value.milestoneCard === 'object' && !Array.isArray(value.milestoneCard)
    ? value.milestoneCard
    : {};
  const configuredXProfileOverrides = cardValue.xProfileOverrides && typeof cardValue.xProfileOverrides === 'object' && !Array.isArray(cardValue.xProfileOverrides)
    ? Object.fromEntries(Object.entries(cardValue.xProfileOverrides).map(([key, val]) => [String(key), String(val || '').trim()]).filter(([, val]) => val))
    : {};
  const xProfileOverrides = {
    '1454160830487728391': 'https://x.com/_zahyou',
    ...configuredXProfileOverrides
  };
  const xHeaderImageOverrides = cardValue.xHeaderImageOverrides && typeof cardValue.xHeaderImageOverrides === 'object' && !Array.isArray(cardValue.xHeaderImageOverrides)
    ? Object.fromEntries(Object.entries(cardValue.xHeaderImageOverrides).map(([key, val]) => [String(key), String(val || '').trim()]).filter(([, val]) => val))
    : {};
  const generatedValue = value?.generatedMilestones && typeof value.generatedMilestones === 'object' && !Array.isArray(value.generatedMilestones)
    ? value.generatedMilestones
    : {};
  const channels = Array.isArray(value?.channels)
    ? value.channels.map((entry) => ({
        voiceChannelId: String(entry?.voiceChannelId || '').trim(),
        categoryId: String(entry?.categoryId || '').trim(),
        profileChannelId: String(entry?.profileChannelId || '').trim(),
        listenChatChannelId: String(entry?.listenChatChannelId || '').trim(),
        label: String(entry?.label || '').trim()
      })).filter((entry) => entry.voiceChannelId)
    : [];

  return {
    enabled: value?.enabled === true,
    timezone: String(value?.timezone || 'Asia/Tokyo'),
    tickIntervalSeconds: Math.max(30, Number(value?.tickIntervalSeconds ?? 60)),
    channels,
    milestoneHours: Array.isArray(value?.milestoneHours)
      ? value.milestoneHours.map((entry) => Math.max(1, Number(entry || 0))).filter(Number.isFinite)
      : defaultMilestoneHours,
    generatedMilestones: {
      startExclusiveHours: Math.max(1, Number(generatedValue.startExclusiveHours ?? 1000)),
      everyHours: Math.max(1, Number(generatedValue.everyHours ?? 500)),
      throughHours: Math.max(1, Number(generatedValue.throughHours ?? 10000))
    },
    milestoneCard: {
      enabled: cardValue.enabled !== false,
      width: Math.max(600, Number(cardValue.width ?? 1200)),
      height: Math.max(315, Number(cardValue.height ?? 630)),
      useDiscordBanner: cardValue.useDiscordBanner !== false,
      useTwitterHeaderFallback: cardValue.useTwitterHeaderFallback !== false,
      darkOverlayOpacity: Math.max(0, Math.min(Number(cardValue.darkOverlayOpacity ?? 0.42), 1)),
      blurBackground: cardValue.blurBackground !== false,
      footerBranding: String(cardValue.footerBranding || 'Otaku Assistant'),
      cacheTtlMinutes: Math.max(1, Number(cardValue.cacheTtlMinutes ?? 1440)),
      maxAssetBytes: Math.max(100_000, Number(cardValue.maxAssetBytes ?? 10_000_000)),
      fetchTimeoutMs: Math.max(1000, Number(cardValue.fetchTimeoutMs ?? 10_000)),
      xProfileOverrides,
      xHeaderImageOverrides
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

function ensureKnowledgeExportConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      forumChannelId: '1503762457779376179',
      maxMessages: 5000,
      maxTotalAttachmentBytes: 50_000_000,
      fetchTimeoutMs: 15_000,
      maxConcurrentExports: 2,
      timezone: 'Asia/Tokyo'
    };
  }

  return {
    enabled: value.enabled !== false,
    forumChannelId: String(value.forumChannelId || '1503762457779376179'),
    maxMessages: Math.max(1, Math.min(Number(value.maxMessages ?? 5000), 10_000)),
    maxTotalAttachmentBytes: Math.max(0, Number(value.maxTotalAttachmentBytes ?? 50_000_000)),
    fetchTimeoutMs: Math.max(1000, Number(value.fetchTimeoutMs ?? 15_000)),
    maxConcurrentExports: Math.max(1, Number(value.maxConcurrentExports ?? 2)),
    timezone: String(value.timezone || 'Asia/Tokyo')
  };
}

function ensureTimelineRestorationConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const restoringTagIds = source.restoringTagIds && typeof source.restoringTagIds === 'object'
    ? Object.fromEntries(Object.entries(source.restoringTagIds).map(([forumId, tagId]) => [String(forumId), String(tagId || '')]))
    : {};

  return {
    enabled: source.enabled !== false,
    // Thread deletion is deliberately not a product capability. Preservation never calls delete().
    deletePersonalThreadOnMemberLeave: false,
    leaveCleanupDelayMinutes: Math.max(0, Number(source.leaveCleanupDelayMinutes ?? 10)),
    automaticRestoreOnThreadCreate: false,
    userCommandRequired: true,
    maxConcurrentJobs: Math.max(1, Number(source.maxConcurrentJobs ?? 1)),
    messagesPerBatch: Math.max(1, Math.min(Number(source.messagesPerBatch ?? 20), 50)),
    delayBetweenMessagesMs: Math.max(250, Number(source.delayBetweenMessagesMs ?? 1500)),
    delayBetweenBatchesMs: Math.max(1000, Number(source.delayBetweenBatchesMs ?? 5000)),
    maxAttemptsPerItem: Math.max(1, Number(source.maxAttemptsPerItem ?? 5)),
    permanentMediaMirror: source.permanentMediaMirror !== false,
    preserveDeletedSnapshots: source.preserveDeletedSnapshots !== false,
    restoreOtherHumanParticipants: source.restoreOtherHumanParticipants !== false,
    restoreBotMessages: source.restoreBotMessages === true,
    blockHumanMessagesDuringRestore: source.blockHumanMessagesDuringRestore !== false,
    completionMentionOwner: source.completionMentionOwner !== false,
    successMediaCacheDays: null,
    maxMediaBytes: Math.max(1_000_000, Number(source.maxMediaBytes ?? 50_000_000)),
    mediaFetchTimeoutMs: Math.max(1000, Number(source.mediaFetchTimeoutMs ?? 20_000)),
    maxRedirects: Math.max(0, Math.min(Number(source.maxRedirects ?? 4), 10)),
    returnDmFailureCooldownDays: Math.max(1, Number(source.returnDmFailureCooldownDays ?? 14)),
    managedWebhookName: String(source.managedWebhookName || 'Otaku Assistant Timeline Restore').slice(0, 80),
    restorationNoticeCooldownMs: Math.max(10_000, Number(source.restorationNoticeCooldownMs ?? 60_000)),
    temporarySlowmodeSeconds: Math.max(0, Math.min(Number(source.temporarySlowmodeSeconds ?? 21600), 21600)),
    restoringTagIds
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
      cardReconcileDelayMs: 1000,
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
    cardReconcileDelayMs: Math.max(250, Number(value.cardReconcileDelayMs ?? 1000)),
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

function ensureAnnictUserIntegrationConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      enabled: true,
      oauthClientIdEnv: 'ANNICT_OAUTH_CLIENT_ID',
      oauthClientSecretEnv: 'ANNICT_OAUTH_CLIENT_SECRET',
      tokenEncryptionKeyEnv: 'ANNICT_TOKEN_ENCRYPTION_KEY',
      tokenEncryptionKeyId: 'default',
      redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
      syncIntervalMinutes: 10,
      maxWorksPerSync: 100,
      initialImportEnabled: false,
      watchedImport: {
        enabled: true,
        pageSize: 50,
        maxCardsPerBatch: 3,
        batchIntervalMinutes: 5,
        delayBetweenCardsMs: 5000,
        repairMissingMessages: true,
        maxAttemptsPerWork: 3
      },
      introDm: {
        enabled: true,
        excludedChannelIds: [],
        retryCooldownDays: 14,
        globalSendIntervalMs: 3000,
        minTitleLength: 4
      }
    };
  }

  const introDmValue = value.introDm && typeof value.introDm === 'object' && !Array.isArray(value.introDm)
    ? value.introDm
    : {};
  const watchedImportValue = value.watchedImport && typeof value.watchedImport === 'object' && !Array.isArray(value.watchedImport)
    ? value.watchedImport
    : {};

  return {
    enabled: value.enabled !== false,
    oauthClientIdEnv: String(value.oauthClientIdEnv || 'ANNICT_OAUTH_CLIENT_ID'),
    oauthClientSecretEnv: String(value.oauthClientSecretEnv || 'ANNICT_OAUTH_CLIENT_SECRET'),
    tokenEncryptionKeyEnv: String(value.tokenEncryptionKeyEnv || 'ANNICT_TOKEN_ENCRYPTION_KEY'),
    tokenEncryptionKeyId: String(value.tokenEncryptionKeyId || 'default'),
    redirectUri: String(value.redirectUri || 'urn:ietf:wg:oauth:2.0:oob'),
    syncIntervalMinutes: Math.max(1, Number(value.syncIntervalMinutes ?? 10)),
    maxWorksPerSync: Math.max(1, Math.min(Number(value.maxWorksPerSync ?? 100), 100)),
    initialImportEnabled: value.initialImportEnabled === true,
    watchedImport: {
      enabled: watchedImportValue.enabled !== false,
      pageSize: Math.max(1, Math.min(Number(watchedImportValue.pageSize ?? 50), 100)),
      maxCardsPerBatch: Math.max(1, Math.min(Number(watchedImportValue.maxCardsPerBatch ?? 3), 10)),
      batchIntervalMinutes: Math.max(1, Number(watchedImportValue.batchIntervalMinutes ?? 5)),
      delayBetweenCardsMs: Math.max(0, Number(watchedImportValue.delayBetweenCardsMs ?? 5000)),
      repairMissingMessages: watchedImportValue.repairMissingMessages !== false,
      maxAttemptsPerWork: Math.max(1, Number(watchedImportValue.maxAttemptsPerWork ?? 3))
    },
    introDm: {
      enabled: introDmValue.enabled !== false,
      excludedChannelIds: ensureArray(introDmValue.excludedChannelIds || [], 'annictUserIntegration.introDm.excludedChannelIds'),
      retryCooldownDays: Math.max(1, Number(introDmValue.retryCooldownDays ?? 14)),
      globalSendIntervalMs: Math.max(1000, Number(introDmValue.globalSendIntervalMs ?? 3000)),
      minTitleLength: Math.max(4, Number(introDmValue.minTitleLength ?? 4))
    }
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
    voiceWorkTime: ensureVoiceWorkTimeConfig(parsed.voiceWorkTime),
    mediaRelay: {
      maxReuploadBytes: Number(parsed.mediaRelay?.maxReuploadBytes ?? 25_000_000),
      fetchTimeoutMs: Number.isFinite(Number(parsed.mediaRelay?.fetchTimeoutMs))
        && Number(parsed.mediaRelay?.fetchTimeoutMs) > 0
        ? Number(parsed.mediaRelay.fetchTimeoutMs)
        : 30_000,
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
    knowledgeExport: ensureKnowledgeExportConfig(parsed.knowledgeExport),
    timelineRestoration: ensureTimelineRestorationConfig(parsed.timelineRestoration),
    introAddendums: ensureIntroAddendumsConfig(parsed.introAddendums),
    introDm: normalizedIntroDm,
    introVcReminder: ensureIntroVcReminderConfig(parsed.introVcReminder, normalizedIntroDm, normalizedOps.logChannelId || ''),
    welcomeDm: ensureWelcomeDmConfig(parsed.welcomeDm, normalizedOps.logChannelId || ''),
    anime: ensureAnimeConfig(parsed.anime),
    annict: ensureAnnictConfig(parsed.annict),
    annictUserIntegration: ensureAnnictUserIntegrationConfig(parsed.annictUserIntegration),
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
