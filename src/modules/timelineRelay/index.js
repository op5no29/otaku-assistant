const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');
const { buildTimelineMessage } = require('./buildTimelineMessage');
const { extractFirstPost, extractThreadMessagePost, extractPlainMessagePost } = require('./extractFirstPost');
const { prepareVideoThumbnail } = require('./videoThumbnail');
const { prepareAttachmentRelay } = require('./attachmentRelay');
const { resolveTwitterMedia } = require('./twitterMediaResolver');
const { enrichPostWithMusicLink } = require('./musicLinks');
const { applyQuestionStatusTag } = require('../questionResolver/threadTags');
const { getRecentArchivedMessages } = require('../messageArchive');
const { getMessageJumpUrl } = require('../../services/discordLinks');
const { getSilentRelayControl, parseRelayHashtagPrefixes } = require('../../utils/text');
const { resolveRouteAccentColor } = require('../../utils/accentColors');
const { handleAnimeHashtagPost } = require('../anime/hashtagIntegration');

const QUESTION_ROLE_SELECT_PREFIX = 'question-role-select:';
const QUESTION_ROLE_SKIP_PREFIX = 'question-role-skip:';

function buildQuestionGuideMessage(timelineMessageUrl = null) {
  return [
    '質問を受け付けました。',
    timelineMessageUrl ? `[タイムラインにも共有しました](${timelineMessageUrl})` : 'タイムラインにも共有しました。',
    '',
    '解決した場合は、この質問内で `/resolve` を使用してください。',
    '質問タイトルに `[解決済]` が付き、タイムライン上の質問カードも解決済みに更新されます。',
    '',
    '再び確認が必要になった場合は、同じ質問内で `/unresolve` を使用すると未解決に戻せます。'
  ].join('\n');
}

function getForumType(parentId, config) {
  const normalizedParentId = String(parentId || '');

  if (config.watchedForums.question.includes(normalizedParentId)) {
    return 'question';
  }

  if (config.watchedForums.tweet.includes(normalizedParentId)) {
    return 'tweet';
  }

  if (config.watchedForums.knowledge.includes(normalizedParentId)) {
    return 'knowledge';
  }

  return null;
}

function collectRouteOutputChannelIds(config) {
  const ids = new Set([
    String(config.timelineChannelId || ''),
    String(config.anime?.channelId || '')
  ].filter(Boolean));

  for (const route of Object.values(config.globalHashtagRoutes || {})) {
    if (route?.channelId) {
      ids.add(String(route.channelId));
    }
  }

  for (const route of Object.values(config.botHashtagRoutes || {})) {
    if (route?.channelId) {
      ids.add(String(route.channelId));
    }
  }

  return ids;
}

function getRouteScanSkipReason(message, config) {
  if (!message.inGuild?.()) {
    return 'not_guild_message';
  }
  if (message.author?.bot) {
    return 'bot_author';
  }
  if (!message.channel?.isTextBased?.()) {
    return 'not_text_based';
  }

  const outputChannelIds = collectRouteOutputChannelIds(config);
  const sourceChannelId = String(message.channelId || '');
  const parentId = String(message.channel?.parentId || '');
  if (outputChannelIds.has(sourceChannelId) || outputChannelIds.has(parentId)) {
    return 'route_output_channel';
  }

  if (message.channel?.archived) {
    return 'archived_thread';
  }

  return null;
}

function buildSilentRelayLogContext(message, state, extra = {}) {
  return {
    sourceMessageId: message?.id || null,
    sourceChannelId: message?.channelId || null,
    parentId: String(message?.channel?.parentId || ''),
    silentTokenDetected: state.token === true,
    silentFlagDetected: state.flag === true,
    messageFlagsBitfield: state.flagsBitfield,
    ...extra
  };
}

function logSilentRelaySkip(logger, logBaseName, message, extra = {}, options = {}) {
  const state = getSilentRelayControl(message);
  if (!state.silent) {
    return false;
  }

  const context = buildSilentRelayLogContext(message, state, extra);
  if (state.flag && options.logFlagDetected !== false) {
    logger.info('silent message flag detected', context);
  }

  const reason = state.flag ? 'flag' : 'token';
  logger.info(`${logBaseName} ${reason}`, context);
  return true;
}

function normalizeRoleIds(roleIds = []) {
  return [...new Set((Array.isArray(roleIds) ? roleIds : [])
    .map((roleId) => String(roleId || '').trim())
    .filter(Boolean))];
}

function getConfiguredQuestionRoleIds(config) {
  return new Set((config.questionRolePrompt?.roles || []).map((role) => String(role.id || '')).filter(Boolean));
}

function normalizeQuestionRoleSelection(config, roleIds = []) {
  const configuredRoleIds = getConfiguredQuestionRoleIds(config);
  return normalizeRoleIds(roleIds).filter((roleId) => configuredRoleIds.has(roleId));
}

function applyRoleMentionSection(post, {
  roleIds = [],
  label,
  allowMentions = false
} = {}) {
  const normalizedRoleIds = normalizeRoleIds(roleIds);
  if (!normalizedRoleIds.length) {
    return post;
  }

  return {
    ...post,
    roleMentionLabel: label,
    roleMentionIds: normalizedRoleIds,
    allowedMentionRoleIds: allowMentions ? normalizedRoleIds : []
  };
}

function shouldPromptQuestionRoles(config) {
  return Boolean(
    config.questionRolePrompt?.enabled === true &&
    Array.isArray(config.questionRolePrompt.roles) &&
    config.questionRolePrompt.roles.length > 0
  );
}

function getQuestionRolePromptTimeoutMs(config) {
  const minutes = Number(config.questionRolePrompt?.timeoutMinutes ?? 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60 * 1000;
}

function buildQuestionRolePromptPayload(threadId, authorUserId, roles) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${QUESTION_ROLE_SELECT_PREFIX}${threadId}`)
    .setPlaceholder('関連しているロールを選択')
    .setMinValues(1)
    .setMaxValues(Math.min(roles.length, 25))
    .addOptions(
      roles.slice(0, 25).map((role) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(role.label)
          .setValue(role.id)
          .setDescription(role.description || role.label)
      )
    );
  const skipButton = new ButtonBuilder()
    .setCustomId(`${QUESTION_ROLE_SKIP_PREFIX}${threadId}`)
    .setLabel('ロールを選択しないまま質問を作成')
    .setStyle(ButtonStyle.Secondary);

  return {
    content: [
      `<@${authorUserId}> この質問に関連しているソフトや分野のロールを選択してください。`,
      '選択したロールの人に通知される形で、タイムラインに質問カードを共有します。'
    ].join('\n'),
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(skipButton)
    ],
    allowedMentions: { users: [authorUserId], parse: [] }
  };
}

function getKnowWantRoleIdForThread(thread, config) {
  const roleId = String(config.questionRolePrompt?.knowWantRoleId || '').trim();
  if (!roleId) {
    return null;
  }

  const parentId = String(thread.parentId || '');
  const configuredChannelIds = config.questionRolePrompt?.knowWantChannelIds || [];
  const matched = configuredChannelIds.length
    ? configuredChannelIds.includes(parentId)
    : config.watchedForums.knowledge.includes(parentId);
  return matched ? roleId : null;
}

function clearQuestionRolePromptTimer(client, threadId) {
  const key = String(threadId || '');
  const timer = client.questionRolePromptTimers?.get(key);
  if (timer) {
    clearTimeout(timer);
    client.questionRolePromptTimers.delete(key);
  }
}

function scheduleQuestionRolePromptTimeout(client, threadId, expiresAt) {
  if (!client.questionRolePromptTimers) {
    client.questionRolePromptTimers = new Map();
  }

  clearQuestionRolePromptTimer(client, threadId);
  const expiresAtMs = new Date(expiresAt).getTime();
  const delayMs = Number.isFinite(expiresAtMs)
    ? Math.max(0, expiresAtMs - Date.now())
    : getQuestionRolePromptTimeoutMs(client.appConfig || {});
  const timer = setTimeout(() => {
    void handleQuestionRolePromptTimeout(client, threadId).catch((error) => {
      client.logger.error('question role prompt timeout failed', {
        threadId,
        error: error.message
      });
    });
  }, delayMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  client.questionRolePromptTimers.set(String(threadId), timer);
}

async function buildTimelinePayload(post, { config, forumType, logger }) {
  const twitterResolved = await resolveTwitterMedia(post, config, logger);
  const videoPrepared = await prepareVideoThumbnail(twitterResolved.post, logger);
  const attachmentPrepared = await prepareAttachmentRelay(videoPrepared.post, config, logger);
  const matchedGlobalRoutes = Array.isArray(attachmentPrepared.post?.matchedGlobalHashtagRoutes)
    ? attachmentPrepared.post.matchedGlobalHashtagRoutes
    : [];
  const matchedBotRoutes = Array.isArray(attachmentPrepared.post?.matchedBotHashtagRoutes)
    ? attachmentPrepared.post.matchedBotHashtagRoutes
    : [];
  if (forumType !== 'question' && (matchedGlobalRoutes.length || matchedBotRoutes.length)) {
    attachmentPrepared.post.accentColor = resolveRouteAccentColor({
      globalRouteKeys: matchedGlobalRoutes,
      botRouteKeys: matchedBotRoutes,
      config,
      logger,
      sourceMessageId: post.messageId
    });
  }
  if (forumType === 'question') {
    logger.info('Question card built', {
      sourceMessageId: post.messageId,
      questionCardStatusColor: post.isResolved ? 'green' : 'red',
      questionCardTitle: post.title?.trim() || '',
      questionCardBody: String(post.content || '').trim(),
      questionCardAuthorDisplayName: post.displayName || '',
      questionCardCategory: post.forumName || '',
      questionCardStatus: post.isResolved ? '解決済み' : '受付中',
      attachmentNamesCount: Array.isArray(post.attachments) ? post.attachments.length : 0,
      duplicateBlocksSkipped: true
    });
  }
  const allowedMentionRoleIds = normalizeRoleIds(attachmentPrepared.post.allowedMentionRoleIds);
  if (forumType === 'question' && allowedMentionRoleIds.length) {
    logger.info('question role allowed mentions applied', {
      sourceMessageId: post.messageId,
      threadId: post.threadId || null,
      roleIds: allowedMentionRoleIds
    });
  }
  if (forumType === 'knowledge' && allowedMentionRoleIds.length) {
    logger.info('know-want role allowed mention applied', {
      sourceMessageId: post.messageId,
      threadId: post.threadId || null,
      roleIds: allowedMentionRoleIds
    });
  }

  return {
    payload: buildTimelineMessage({
      post: attachmentPrepared.post,
      config,
      forumType,
      logger
    }),
    cleanup: async () => {
      await attachmentPrepared.cleanup();
      await videoPrepared.cleanup();
      await twitterResolved.cleanup();
    }
  };
}

function isMergeableShortTweetPost(post, config) {
  const text = String(post.content || '').trim();
  if (!config.timeline.shortMergeEnabled) {
    return false;
  }
  if (!text || text.length > Number(config.timeline.shortMergeMaxChars || 60)) {
    return false;
  }
  if (post.referencedSourceMessageId) {
    return false;
  }
  if (post.title || post.replyContext) {
    return false;
  }
  if (Array.isArray(post.attachments) && post.attachments.length) {
    return false;
  }
  if (Array.isArray(post.imageUrls) && post.imageUrls.length) {
    return false;
  }
  if (post.firstImageUrl || post.firstVideoUrl || post.generatedVideoThumbnailUrl) {
    return false;
  }
  if (post.socialPreview || post.musicLink) {
    return false;
  }
  if (Array.isArray(post.customEmojiMediaItems) && post.customEmojiMediaItems.length) {
    return false;
  }
  if (Array.isArray(post.matchedBotHashtagRoutes) && post.matchedBotHashtagRoutes.length) {
    return false;
  }
  if (/\bhttps?:\/\//i.test(text)) {
    return false;
  }
  return true;
}

function logShortMergeEvaluation(logger, payload) {
  logger.info('timeline short merge candidate evaluated', payload);
}

function getConsecutiveMergeChain(client, message, post, config, logger) {
  const text = String(post.content || '').trim();
  logShortMergeEvaluation(logger, {
    sourceMessageId: message.id,
    sourceChannelId: String(message.channel.parentId || ''),
    sourceThreadId: message.channelId,
    authorId: message.author?.id || null,
    bodyText: text,
    textLength: text.length,
    hasAttachments: Array.isArray(post.attachments) && post.attachments.length > 0,
    hasMedia: Boolean(
      (Array.isArray(post.imageUrls) && post.imageUrls.length) ||
      post.firstImageUrl ||
      post.firstVideoUrl ||
      post.generatedVideoThumbnailUrl ||
      (Array.isArray(post.customEmojiMediaItems) && post.customEmojiMediaItems.length)
    ),
    hasUrl: /\bhttps?:\/\//i.test(text),
    isReply: Boolean(post.referencedSourceMessageId || post.replyContext),
    hasBotHashtagRoute: Array.isArray(post.matchedBotHashtagRoutes) && post.matchedBotHashtagRoutes.length > 0,
    mergeable: isMergeableShortTweetPost(post, config)
  });

  if (!isMergeableShortTweetPost(post, config)) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      reason: 'current_not_mergeable'
    });
    return null;
  }

  const recentMessages = getRecentArchivedMessages(client, {
    channelId: message.channelId,
    limit: Number(config.timeline.shortMergeMaxParts || 5) + 3
  });
  const currentIndex = recentMessages.findIndex((entry) => String(entry.messageId) === String(message.id));
  if (currentIndex <= 0) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      reason: currentIndex === -1 ? 'current_message_not_archived' : 'no_previous_message'
    });
    return null;
  }

  const current = recentMessages[currentIndex];
  const currentTime = new Date(current.createdAt || message.createdAt || Date.now()).getTime();
  const previous = recentMessages[currentIndex - 1];
  const sameAuthor = String(previous.authorId || '') === String(current.authorId || '');
  logger.info('timeline short merge previous message checked', {
    sourceMessageId: message.id,
    previousSourceMessageId: previous.messageId,
    previousAuthorId: previous.authorId || null,
    previousIsMergeable: Boolean(
      String(previous.content || '').trim() &&
      String(previous.content || '').trim().length <= Number(config.timeline.shortMergeMaxChars || 60) &&
      !previous.referencedMessageId &&
      !(Array.isArray(previous.attachments) && previous.attachments.length) &&
      !(Array.isArray(previous.embeds) && previous.embeds.length) &&
      !/\bhttps?:\/\//i.test(String(previous.content || '').trim())
    ),
    sameAuthor
  });
  if (!sameAuthor) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      reason: 'intervening_author_detected'
    });
    return null;
  }

  const chain = [current];
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const entry = recentMessages[index];
    if (String(entry.authorId || '') !== String(current.authorId || '')) {
      break;
    }

    const text = String(entry.content || '').trim();
    const withinWindow = currentTime - new Date(entry.createdAt || 0).getTime() <= Number(config.timeline.shortMergeWindowSeconds || 180) * 1000;
    const mergeable =
      text &&
      text.length <= Number(config.timeline.shortMergeMaxChars || 60) &&
      !entry.referencedMessageId &&
      !(Array.isArray(entry.attachments) && entry.attachments.length) &&
      !(Array.isArray(entry.embeds) && entry.embeds.length) &&
      !/\bhttps?:\/\//i.test(text);
    if (!withinWindow || !mergeable) {
      logger.info('timeline short merge skipped', {
        sourceMessageId: message.id,
        reason: withinWindow ? 'previous_not_mergeable' : 'outside_merge_window'
      });
      break;
    }

    chain.unshift(entry);
    if (chain.length >= Number(config.timeline.shortMergeMaxParts || 5)) {
      break;
    }
  }

  if (chain.length < 2) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      reason: 'chain_too_short'
    });
    return null;
  }

  return chain;
}

async function tryMergeShortTweetMessage(message, post, target, { config, db, logger }) {
  if (String(target.destinationChannelId) !== String(config.timelineChannelId || '')) {
    return null;
  }

  const text = String(post.content || '').trim();
  const sourceChannelId = String(message.channelId || '');
  const sourceThreadId = String(message.channel?.id || '');
  const parentId = String(message.channel?.parentId || '');
  const recentMessages = getRecentArchivedMessages(message.client, {
    channelId: sourceChannelId,
    limit: Number(config.timeline.shortMergeMaxParts || 5) + 3
  });
  const currentIndex = recentMessages.findIndex((entry) => String(entry.messageId) === String(message.id));
  const previousEntry = currentIndex > 0 ? recentMessages[currentIndex - 1] : null;
  const previousText = String(previousEntry?.content || '').trim();
  const previousIsMergeable = Boolean(
    previousEntry &&
    previousText &&
    previousText.length <= Number(config.timeline.shortMergeMaxChars || 60) &&
    !previousEntry.referencedMessageId &&
    !(Array.isArray(previousEntry.attachments) && previousEntry.attachments.length) &&
    !(Array.isArray(previousEntry.embeds) && previousEntry.embeds.length) &&
    !/\bhttps?:\/\//i.test(previousText)
  );
  const mergeState = db.timelineMerge.get(
    message.guildId,
    sourceChannelId,
    message.author?.id || '',
    target.destinationChannelId
  );
  const latestDestinationState = db.timelineDestination.get(
    message.guildId,
    target.destinationChannelId
  );

  logShortMergeEvaluation(logger, {
    sourceMessageId: message.id,
    sourceChannelId,
    sourceThreadId,
    parentId,
    authorId: message.author?.id || null,
    bodyText: text,
    bodyTextLength: text.length,
    hasAttachments: Array.isArray(post.attachments) && post.attachments.length > 0,
    hasEmbeds: Boolean(post.socialPreview),
    hasUrls: /\bhttps?:\/\//i.test(text),
    hasMediaGallery: Boolean(
      (Array.isArray(post.imageUrls) && post.imageUrls.length) ||
      post.firstImageUrl ||
      post.firstVideoUrl ||
      post.generatedVideoThumbnailUrl ||
      (Array.isArray(post.mediaGalleryItems) && post.mediaGalleryItems.length)
    ),
    isReply: Boolean(post.referencedSourceMessageId || post.replyContext),
    isQuestion: false,
    isGlobalHashtag: false,
    isBotHashtag: Array.isArray(post.matchedBotHashtagRoutes) && post.matchedBotHashtagRoutes.length > 0,
    destinationChannelId: target.destinationChannelId,
    relayKind: target.relayKind,
    previousSourceMessageId: previousEntry?.messageId || null,
    previousSourceAuthorId: previousEntry?.authorId || null,
    previousRelayDbRecordFound: Boolean(mergeState?.relayedMessageId),
    previousRelayedTimelineMessageId: mergeState?.relayedMessageId || null,
    latestRelayedMessageId: latestDestinationState?.relayedMessageId || null
  });

  if (!isMergeableShortTweetPost(post, config)) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'current_not_mergeable'
    });
    return null;
  }

  if (!previousEntry) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'no_previous_message'
    });
    return null;
  }

  if (String(previousEntry.authorId || '') !== String(message.author?.id || '')) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'intervening_author_detected'
    });
    return null;
  }

  if (!previousIsMergeable) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'previous_not_mergeable'
    });
    return null;
  }

  if (!mergeState?.relayedMessageId || String(mergeState.lastSourceMessageId || '') !== String(previousEntry.messageId || '')) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: !mergeState?.relayedMessageId ? 'merge_state_missing' : 'merge_state_not_immediately_previous'
    });
    return null;
  }

  const destinationIntervened = Boolean(
    latestDestinationState?.relayedMessageId &&
    String(latestDestinationState.relayedMessageId) !== String(mergeState.relayedMessageId)
  );
  logger.info('destination latest relay checked', {
    sourceMessageId: message.id,
    destinationChannelId: target.destinationChannelId,
    latestRelayedMessageId: latestDestinationState?.relayedMessageId || null,
    candidateMergeRelayedMessageId: mergeState.relayedMessageId,
    destinationIntervened
  });
  if (destinationIntervened) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'destination_intervened'
    });
    return null;
  }

  const lastMessageAt = new Date(mergeState.lastMessageAt || 0).getTime();
  const currentMessageAt = new Date(message.createdAt || Date.now()).getTime();
  if (!lastMessageAt || currentMessageAt - lastMessageAt > Number(config.timeline.shortMergeWindowSeconds || 180) * 1000) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'outside_merge_window'
    });
    return null;
  }

  const mergedParts = (() => {
    try {
      const parsed = JSON.parse(mergeState.mergedTextJson || '[]');
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  const nextMergedParts = [...mergedParts, text].slice(-Number(config.timeline.shortMergeMaxParts || 5));

  if (nextMergedParts.length < 2) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'chain_too_short'
    });
    return null;
  }

  const destinationChannel = await getTextChannel(message.guild, target.destinationChannelId);
  if (!destinationChannel) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      reason: 'destination_missing'
    });
    return null;
  }

  const timelineMessage = await destinationChannel.messages.fetch(mergeState.relayedMessageId).catch(() => null);
  if (!timelineMessage) {
    logger.info('timeline short merge skipped', {
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      reason: 'timeline_message_missing'
    });
    return null;
  }

  const mergedPost = {
    ...post,
    content: nextMergedParts.join('\n'),
    attachments: [],
    imageUrls: [],
    firstImageUrl: null,
    firstVideoUrl: null,
    generatedVideoThumbnailUrl: null,
    socialPreview: null,
    musicLink: null,
    customEmojiMediaItems: [],
    matchedBotHashtagRoutes: [],
    displayBotHashtags: [],
    componentFiles: [],
    downloadableAttachments: []
  };

  try {
    logger.info('merge edit attempted', {
      sourceMessageId: message.id,
      relayedMessageId: timelineMessage.id,
      mergedCount: nextMergedParts.length
    });
    const mergePayload = buildTimelineMessage({
      post: mergedPost,
      config,
      forumType: 'tweet',
      logger
    });
    await timelineMessage.edit({
      ...mergePayload,
      attachments: []
    });
    db.relays.upsertMessageRelayTarget({
      sourceMessageId: message.id,
      destinationChannelId: target.destinationChannelId,
      threadId: message.channel.id,
      parentChannelId: String(message.channel.parentId || ''),
      forumType: 'tweet',
      relayKind: target.relayKind,
      relayedMessageId: timelineMessage.id,
      authorId: message.author?.id || null
    });
    db.timelineMerge.upsert({
      guildId: message.guildId,
      sourceChannelId,
      sourceThreadId,
      authorId: message.author?.id || null,
      destinationChannelId: target.destinationChannelId,
      lastSourceMessageId: message.id,
      relayedMessageId: timelineMessage.id,
      mergedTextJson: JSON.stringify(nextMergedParts),
      mergedCount: nextMergedParts.length,
      lastMessageAt: new Date(message.createdAt || Date.now()).toISOString()
    });
    updateTimelineDestinationState(db, {
      guildId: message.guildId,
      destinationChannelId: target.destinationChannelId,
      relayedMessageId: timelineMessage.id,
      sourceMessageId: message.id,
      sourceThreadId,
      authorId: message.author?.id || null
    });
    logger.info('timeline short merge edit success', {
      sourceMessageId: message.id,
      previousSourceMessageId: previousEntry.messageId,
      relayedMessageId: timelineMessage.id,
      mergedCount: nextMergedParts.length
    });
    return {
      merged: true,
      relayedMessageId: timelineMessage.id
    };
  } catch (error) {
    logger.warn('merge edit failed fallback send', {
      sourceMessageId: message.id,
      previousSourceMessageId: previousEntry.messageId,
      relayedMessageId: mergeState.relayedMessageId,
      error: error.message
    });
    return null;
  }
}

function buildReplyOptions({ message, destinationChannelId, db, logger }) {
  const referencedSourceMessageId = message.reference?.messageId || null;

  if (!referencedSourceMessageId) {
    return null;
  }

  let relayTarget = db.relays.getMessageRelayTarget(
    referencedSourceMessageId,
    String(destinationChannelId)
  );

  if (!relayTarget && String(destinationChannelId) === String(message.client.appConfig?.timelineChannelId || '')) {
    const legacyRelay = db.relays.getMessageRelay(referencedSourceMessageId);
    const normalizedLegacyTarget = normalizeLegacyRelayTarget(
      legacyRelay,
      message.client.appConfig?.timelineChannelId
    );

    if (normalizedLegacyTarget) {
      db.relays.upsertMessageRelayTarget(normalizedLegacyTarget);
      relayTarget = normalizedLegacyTarget;
    }
  }

  if (!relayTarget?.relayedMessageId) {
    logger.info('Reply relay fallback used because referenced timeline message was not found', {
      sourceMessageId: message.id,
      referencedSourceMessageId,
      destinationChannelId: String(destinationChannelId),
      fallbackReason: 'referenced_relay_missing'
    });
    return null;
  }

  logger.info('Reply relay target resolved', {
    sourceMessageId: message.id,
    referencedSourceMessageId,
    destinationChannelId: String(destinationChannelId),
    repliedToRelayedMessageId: relayTarget.relayedMessageId
  });

  return {
    messageReference: relayTarget.relayedMessageId,
    failIfNotExists: false
  };
}

function getTweetDestinationTargets(post, config) {
  const targets = [
    {
      destinationChannelId: String(config.timelineChannelId || ''),
      relayKind: 'timeline'
    }
  ];

  for (const routeKey of post.matchedBotHashtagRoutes || []) {
    const route = config.botHashtagRoutes?.[routeKey];
    if (!route?.channelId) {
      continue;
    }

    targets.push({
      destinationChannelId: String(route.channelId),
      relayKind: `hashtag:${routeKey}`
    });
  }

  const uniqueTargets = [];
  const seenChannelIds = new Set();
  for (const target of targets) {
    if (!target.destinationChannelId || seenChannelIds.has(target.destinationChannelId)) {
      continue;
    }

    seenChannelIds.add(target.destinationChannelId);
    uniqueTargets.push(target);
  }

  return uniqueTargets;
}

function getGlobalRouteDestinationTargets(post, config, sourceChannelId = '') {
  const targets = [];

  for (const routeKey of post.matchedGlobalHashtagRoutes || []) {
    const route = config.globalHashtagRoutes?.[routeKey];
    if (route?.channelId && route.relayUserPostToDestination !== false) {
      targets.push({
        destinationChannelId: String(route.channelId),
        relayKind: `global_hashtag:${routeKey}`
      });
    }

    if (route?.alsoTimeline && config.timelineChannelId) {
      targets.push({
        destinationChannelId: String(config.timelineChannelId),
        relayKind: 'timeline'
      });
    }
  }

  const uniqueTargets = [];
  const seenChannelIds = new Set();
  for (const target of targets) {
    if (!target.destinationChannelId || target.destinationChannelId === String(sourceChannelId || '') || seenChannelIds.has(target.destinationChannelId)) {
      continue;
    }

    seenChannelIds.add(target.destinationChannelId);
    uniqueTargets.push(target);
  }

  return uniqueTargets;
}

function buildRelaySendPurpose(message, target) {
  if (target.relayKind?.startsWith('hashtag:')) {
    return 'timeline:hashtag-card-send';
  }

  if (message.reference?.messageId) {
    return 'timeline:reply-card-send';
  }

  return 'timeline:primary-card-send';
}

function payloadHasMediaGallery(payload) {
  try {
    const components = Array.isArray(payload?.components)
      ? payload.components.map((component) => (
        typeof component?.toJSON === 'function' ? component.toJSON() : component
      ))
      : [];

    const walk = (value) => {
      if (!value) {
        return false;
      }

      if (Array.isArray(value)) {
        return value.some(walk);
      }

      if (typeof value === 'object') {
        if (
          value.type === 12 ||
          value.type === 'MEDIA_GALLERY' ||
          Object.prototype.hasOwnProperty.call(value, 'items')
        ) {
          return true;
        }

        return Object.values(value).some(walk);
      }

      return false;
    };

    return walk(components);
  } catch {
    return false;
  }
}

async function sendRelayMessage(destinationChannel, payload, logger, meta) {
  logger.info('Relay send starting', {
    ...meta,
    hasComponents: Array.isArray(payload?.components) && payload.components.length > 0,
    hasFiles: Array.isArray(payload?.files) && payload.files.length > 0,
    hasMediaGallery: payloadHasMediaGallery(payload),
    hasContent: Boolean(payload?.content)
  });

  const sentMessage = await destinationChannel.send(payload);

  logger.info('Relay send finished', {
    ...meta,
    returnedMessageId: sentMessage.id
  });

  return sentMessage;
}

function buildRelayInFlightKey(sourceMessageId, destinationChannelId, relayKind) {
  return `${sourceMessageId}:${destinationChannelId}:${relayKind}`;
}

function updateTimelineDestinationState(db, {
  guildId,
  destinationChannelId,
  relayedMessageId,
  sourceMessageId,
  sourceThreadId,
  authorId
}) {
  if (!guildId || !destinationChannelId || !relayedMessageId) {
    return;
  }

  db.timelineDestination.upsert({
    guildId,
    destinationChannelId,
    relayedMessageId,
    sourceMessageId,
    sourceThreadId,
    authorId
  });
}

async function getTextChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return null;
  }

  return channel;
}

function normalizeLegacyRelayTarget(legacyRelay, timelineChannelId) {
  if (!legacyRelay?.timelineMessageId || !timelineChannelId) {
    return null;
  }

  return {
    sourceMessageId: legacyRelay.messageId,
    destinationChannelId: String(timelineChannelId),
    threadId: legacyRelay.threadId,
    parentChannelId: legacyRelay.parentChannelId,
    forumType: legacyRelay.forumType,
    relayKind: 'legacy',
    relayedMessageId: legacyRelay.timelineMessageId,
    authorId: legacyRelay.authorId
  };
}

function normalizeStoredRelayTargets(targets, { db, timelineChannelId, sourceMessageId }) {
  const normalizedTargets = [];

  for (const target of targets) {
    if (!target.destinationChannelId && timelineChannelId) {
      const normalizedTarget = {
        ...target,
        destinationChannelId: String(timelineChannelId),
        relayKind: target.relayKind === 'legacy' ? 'timeline' : target.relayKind
      };
      db.relays.upsertMessageRelayTarget(normalizedTarget);
      db.relays.deleteMessageRelayTarget(sourceMessageId, '');
      normalizedTargets.push(normalizedTarget);
      continue;
    }

    normalizedTargets.push(target);
  }

  return normalizedTargets;
}

async function sendForumThreadTimelineCard(thread, post, {
  config,
  db,
  logger,
  forumType,
  questionRoleIds = [],
  allowQuestionRoleMentions = false
}) {
  let relayPost = post;
  const normalizedQuestionRoleIds = normalizeQuestionRoleSelection(config, questionRoleIds);
  if (forumType === 'question' && normalizedQuestionRoleIds.length) {
    relayPost = applyRoleMentionSection(relayPost, {
      roleIds: normalizedQuestionRoleIds,
      label: 'この質問に関係ありそうな人',
      allowMentions: allowQuestionRoleMentions
    });
  }

  const knowWantRoleId = forumType === 'knowledge'
    ? getKnowWantRoleIdForThread(thread, config)
    : null;
  if (knowWantRoleId) {
    relayPost = applyRoleMentionSection(relayPost, {
      roleIds: [knowWantRoleId],
      label: 'この投稿に興味がありそうな人',
      allowMentions: true
    });
    logger.info('know-want role mention applied', {
      threadId: thread.id,
      parentId: String(thread.parentId || ''),
      roleId: knowWantRoleId
    });
  }

  const timelineChannel = await thread.guild.channels.fetch(config.timelineChannelId);

  if (!timelineChannel || !timelineChannel.isTextBased()) {
    throw new Error('Timeline channel was not found or is not text-based');
  }

  const { payload, cleanup } = await buildTimelinePayload(relayPost, {
    config,
    forumType,
    logger
  });

  let sentMessage;
  try {
    sentMessage = await sendRelayMessage(timelineChannel, payload, logger, {
      sourceMessageId: relayPost.messageId,
      destinationChannelId: String(config.timelineChannelId || ''),
      relayKind: forumType,
      sendPurpose: 'timeline:thread-primary-card-send',
      callsiteLabel: 'timeline:thread-create'
    });
  } finally {
    await cleanup();
  }

  db.relays.insertThreadRelay({
    threadId: thread.id,
    parentChannelId: String(thread.parentId || ''),
    starterMessageId: relayPost.messageId,
    timelineMessageId: sentMessage.id,
    authorId: relayPost.author?.id || null
  });
  updateTimelineDestinationState(db, {
    guildId: thread.guildId,
    destinationChannelId: String(config.timelineChannelId || ''),
    relayedMessageId: sentMessage.id,
    sourceMessageId: relayPost.messageId,
    sourceThreadId: thread.id,
    authorId: relayPost.author?.id || null
  });

  if (forumType === 'question') {
    await applyQuestionStatusTag(thread, 'open', { config, logger });

    const questionRecord = db.questions.getQuestionThread(thread.id);
    if (!questionRecord?.guideMessageId) {
      const timelineMessageUrl = getMessageJumpUrl({
        guildId: thread.guildId,
        channelId: config.timelineChannelId,
        messageId: sentMessage.id
      });
      logger.info('Question timeline message returned', {
        threadId: thread.id,
        timelineMessageId: sentMessage.id,
        timelineMessageUrl
      });
      await thread.send(buildQuestionGuideMessage(timelineMessageUrl))
        .then((guideMessage) => {
          db.questions.setGuideMessage(thread.id, guideMessage.id);
          logger.info('Question acceptance guide posted', {
            threadId: thread.id,
            guideMessageId: guideMessage.id
          });
          logger.info('Question accepted response linked timeline', {
            threadId: thread.id,
            timelineMessageId: sentMessage.id
          });
        })
        .catch((error) => {
          logger.warn('Question acceptance message failed', {
            threadId: thread.id,
            error: error.message
          });
        });
    }
  }

  return sentMessage;
}

async function postQuestionRolePrompt(thread, post, { config, db, logger }) {
  if (!shouldPromptQuestionRoles(config)) {
    return false;
  }

  const existingRelay = db.relays.getThreadRelay(thread.id);
  if (existingRelay?.timelineMessageId) {
    return false;
  }

  const existingPrompt = db.questionRolePrompts.get(thread.id);
  if (existingPrompt) {
    if (existingPrompt.status === 'pending') {
      scheduleQuestionRolePromptTimeout(thread.client, thread.id, existingPrompt.expiresAt);
      logger.info('question timeline relay waiting for role selection', {
        threadId: thread.id,
        promptMessageId: existingPrompt.promptMessageId,
        expiresAt: existingPrompt.expiresAt,
        reason: 'existing_pending_prompt'
      });
      return true;
    }
    return false;
  }

  const roles = config.questionRolePrompt.roles || [];
  const authorUserId = post.author?.id || thread.ownerId || '';
  if (!authorUserId) {
    logger.warn('question role prompt skipped because author was unavailable', {
      threadId: thread.id
    });
    return false;
  }
  const expiresAt = new Date(Date.now() + getQuestionRolePromptTimeoutMs(config)).toISOString();
  const payload = buildQuestionRolePromptPayload(thread.id, authorUserId, roles);
  const promptMessage = await thread.send(payload).catch((error) => {
    logger.warn('question role prompt post failed', {
      threadId: thread.id,
      authorUserId,
      error: error.message
    });
    return null;
  });

  if (!promptMessage) {
    return false;
  }

  db.questionRolePrompts.upsert({
    threadId: thread.id,
    guildId: thread.guildId,
    authorUserId,
    promptMessageId: promptMessage.id,
    status: 'pending',
    expiresAt
  });
  scheduleQuestionRolePromptTimeout(thread.client, thread.id, expiresAt);

  logger.info('question role prompt posted', {
    threadId: thread.id,
    promptMessageId: promptMessage.id,
    authorUserId,
    roleOptionCount: roles.length,
    expiresAt
  });
  logger.info('question timeline relay waiting for role selection', {
    threadId: thread.id,
    promptMessageId: promptMessage.id,
    expiresAt
  });
  return true;
}

async function relayForumThread(thread, {
  config,
  db,
  logger,
  skipQuestionRolePrompt = false,
  questionRoleIds = [],
  allowQuestionRoleMentions = false
}) {
  if (thread.type !== ChannelType.PublicThread) {
    logger.info('Ignoring threadCreate because channel is not a public forum thread', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      threadType: thread.type
    });
    return;
  }

  const forumType = getForumType(thread.parentId, config);
  logger.info('Evaluated forum thread for relay', {
    threadId: thread.id,
    threadName: thread.name,
    parentId: String(thread.parentId || ''),
    forumType,
    watchedQuestionCount: config.watchedForums.question.length,
    watchedTweetCount: config.watchedForums.tweet.length
  });

  if (!forumType) {
    logger.info('Ignoring threadCreate because parent forum is not watched', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      reason: 'unwatched_forum'
    });
    return;
  }

  if (forumType === 'tweet') {
    logger.info('Ignoring threadCreate because tweet forum relay is handled by messageCreate', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      forumType,
      reason: 'tweet_forum_uses_message_create'
    });
    return;
  }

  if (db.relays.hasThreadRelay(thread.id)) {
    logger.info('Skipped relay because thread was already relayed', {
      threadId: thread.id,
      parentId: String(thread.parentId || ''),
      forumType,
      reason: 'already_relayed_thread_in_sqlite'
    });
    return;
  }

  if (thread.client.timelineRelayInFlight.has(thread.id)) {
    logger.info('Skipped relay because thread is already being processed', {
      threadId: thread.id,
      parentId: String(thread.parentId || ''),
      forumType,
      reason: 'relay_in_flight'
    });
    return;
  }

  thread.client.timelineRelayInFlight.add(thread.id);

  try {
    const post = await extractFirstPost(thread, config, logger);

    if (!post) {
      logger.warn('Starter message not found after retries', {
        threadId: thread.id,
        parentId: String(thread.parentId || ''),
        forumType
      });
      return;
    }

    if (config.timeline.ignoreBotPosts && post.author?.bot) {
      logger.info('Skipped relay because starter author is a bot', {
        threadId: thread.id,
        authorId: post.author?.id,
        forumType,
        reason: 'bot_author'
      });
      return;
    }

    if (forumType === 'question') {
      db.questions.upsertQuestionThread({
        threadId: thread.id,
        authorId: post.author?.id || null
      });
      logger.info('Question starter sources resolved', {
        threadId: thread.id,
        questionTitleSource: 'thread.name',
        questionBodySource: String(post.content || '').trim() ? 'starter_message' : 'missing',
        starterFetched: Boolean(post.messageId)
      });

      if (!skipQuestionRolePrompt) {
        const promptPosted = await postQuestionRolePrompt(thread, post, { config, db, logger });
        if (promptPosted) {
          return null;
        }
      }
    }

    const sentMessage = await sendForumThreadTimelineCard(thread, post, {
      config,
      db,
      logger,
      forumType,
      questionRoleIds,
      allowQuestionRoleMentions
    });

    logger.info('Forum thread relayed', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      starterMessageId: post.messageId,
      timelineMessageId: sentMessage.id,
      forumType
    });
    return sentMessage;
  } catch (error) {
    logger.error('Failed to relay forum thread', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      forumType: getForumType(thread.parentId, config),
      error: error.message
    });
    throw error;
  } finally {
    thread.client.timelineRelayInFlight.delete(thread.id);
  }
}

async function relayQuestionThreadAfterRolePrompt(client, threadId, {
  selectedRoleIds = [],
  status = 'selected',
  loggerContext = {}
} = {}) {
  const state = client.db.questionRolePrompts.get(threadId);
  if (!state) {
    return null;
  }

  if (state.status !== 'pending') {
    client.logger.info('question role prompt relay skipped because prompt was already handled', {
      threadId,
      status: state.status,
      relayedMessageId: state.relayedMessageId || null,
      ...loggerContext
    });
    return client.db.relays.getThreadRelay(threadId);
  }

  clearQuestionRolePromptTimer(client, threadId);
  const guild = await client.guilds.fetch(state.guildId).catch(() => null);
  const thread = guild ? await guild.channels.fetch(threadId).catch(() => null) : null;
  if (!thread?.isThread?.()) {
    client.logger.warn('question role prompt relay failed because thread was unavailable', {
      threadId,
      guildId: state.guildId,
      ...loggerContext
    });
    return null;
  }

  const normalizedRoleIds = normalizeQuestionRoleSelection(client.appConfig, selectedRoleIds);
  const sentMessage = await relayForumThread(thread, {
    config: client.appConfig,
    db: client.db,
    logger: client.logger,
    skipQuestionRolePrompt: true,
    questionRoleIds: normalizedRoleIds,
    allowQuestionRoleMentions: normalizedRoleIds.length > 0
  });
  const relay = client.db.relays.getThreadRelay(threadId);
  const relayedMessageId = sentMessage?.id || relay?.timelineMessageId || null;
  if (!relayedMessageId) {
    client.logger.warn('question role prompt relay did not produce timeline message', {
      threadId,
      status,
      selectedRoleIds: normalizedRoleIds,
      ...loggerContext
    });
    return null;
  }
  client.db.questionRolePrompts.markStatus(threadId, {
    selectedRoleIds: normalizedRoleIds,
    status,
    relayedMessageId
  });

  client.logger.info(normalizedRoleIds.length
    ? 'question timeline relay sent with role mentions'
    : 'question timeline relay sent without role mentions', {
    threadId,
    status,
    roleIds: normalizedRoleIds,
    timelineMessageId: relayedMessageId,
    ...loggerContext
  });

  if (status === 'timed_out' && state.promptMessageId) {
    const promptMessage = await thread.messages?.fetch?.(state.promptMessageId).catch(() => null);
    await promptMessage?.edit?.({
      content: 'ロール選択の受付時間が過ぎたため、ロールを選択せずにタイムラインへ質問カードを共有しました。',
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => null);
  }

  return client.db.questionRolePrompts.get(threadId);
}

async function handleQuestionRolePromptTimeout(client, threadId) {
  const state = client.db.questionRolePrompts.get(threadId);
  if (!state || state.status !== 'pending') {
    return;
  }

  await relayQuestionThreadAfterRolePrompt(client, threadId, {
    selectedRoleIds: [],
    status: 'timed_out',
    loggerContext: { reason: 'timeout' }
  });
}

function startQuestionRolePromptTimeouts(client) {
  if (!client.questionRolePromptTimers) {
    client.questionRolePromptTimers = new Map();
  }

  for (const timer of client.questionRolePromptTimers.values()) {
    clearTimeout(timer);
  }
  client.questionRolePromptTimers.clear();

  const pendingPrompts = client.db.questionRolePrompts.listPending();
  for (const prompt of pendingPrompts) {
    if (!prompt.expiresAt || new Date(prompt.expiresAt).getTime() <= Date.now()) {
      void handleQuestionRolePromptTimeout(client, prompt.threadId).catch((error) => {
        client.logger.error('question role prompt overdue relay failed', {
          threadId: prompt.threadId,
          error: error.message
        });
      });
      continue;
    }
    scheduleQuestionRolePromptTimeout(client, prompt.threadId, prompt.expiresAt);
  }

  client.logger.info('question role prompt pending timers restored', {
    pendingCount: pendingPrompts.length,
    scheduledCount: client.questionRolePromptTimers.size
  });
}

async function handleQuestionRolePromptInteraction(interaction) {
  if (!interaction.isStringSelectMenu?.() && !interaction.isButton?.()) {
    return false;
  }

  const customId = String(interaction.customId || '');
  const isSelect = customId.startsWith(QUESTION_ROLE_SELECT_PREFIX);
  const isSkip = customId.startsWith(QUESTION_ROLE_SKIP_PREFIX);
  if (!isSelect && !isSkip) {
    return false;
  }

  const threadId = customId.slice((isSelect ? QUESTION_ROLE_SELECT_PREFIX : QUESTION_ROLE_SKIP_PREFIX).length);
  const state = interaction.client.db.questionRolePrompts.get(threadId);
  if (!state) {
    await interaction.reply({
      content: 'この質問ロール選択は見つかりませんでした。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  if (String(state.authorUserId) !== String(interaction.user.id)) {
    interaction.client.logger.info('question role prompt wrong user', {
      threadId,
      promptMessageId: state.promptMessageId,
      authorUserId: state.authorUserId,
      actingUserId: interaction.user.id
    });
    await interaction.reply({
      content: 'この選択は質問を作成した本人だけが使えます。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  if (state.status !== 'pending') {
    await interaction.reply({
      content: 'この質問はすでにタイムラインへ共有されています。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  const selectedRoleIds = isSelect
    ? normalizeQuestionRoleSelection(interaction.client.appConfig, interaction.values || [])
    : [];

  interaction.client.logger.info(isSelect ? 'question role prompt selected' : 'question role prompt skipped', {
    threadId,
    promptMessageId: state.promptMessageId,
    authorUserId: state.authorUserId,
    selectedRoleIds
  });

  await interaction.deferUpdate().catch(() => null);
  const result = await relayQuestionThreadAfterRolePrompt(interaction.client, threadId, {
    selectedRoleIds,
    status: isSelect ? 'selected' : 'skipped',
    loggerContext: {
      interactionId: interaction.id,
      promptMessageId: state.promptMessageId
    }
  });

  if (!result) {
    await interaction.followUp({
      content: '質問カードの共有に失敗しました。少し待ってからもう一度試してください。',
      ephemeral: true
    }).catch(() => null);
    return true;
  }

  const content = selectedRoleIds.length
    ? [
        `<@${state.authorUserId}> 選択されたロールを含めて、タイムラインに質問カードを共有しました。`,
        selectedRoleIds.map((roleId) => `<@&${roleId}>`).join(' ')
      ].join('\n')
    : `<@${state.authorUserId}> ロールを選択せず、タイムラインに質問カードを共有しました。`;
  await interaction.message?.edit?.({
    content,
    components: [],
    allowedMentions: { users: [state.authorUserId], roles: [], parse: [] }
  }).catch(() => null);

  return Boolean(result);
}

async function relayTweetMessage(message, { config, db, logger }) {
  if (!message.inGuild() || !message.channel?.isThread?.()) {
    return;
  }

  if (message.channel.type !== ChannelType.PublicThread) {
    logger.info('Ignoring messageCreate because channel is not a public forum thread', {
      messageId: message.id,
      channelId: message.channelId,
      parentId: String(message.channel.parentId || ''),
      threadType: message.channel.type
    });
    return;
  }

  const forumType = getForumType(message.channel.parentId, config);
  logger.info('Evaluated thread message for relay', {
    messageId: message.id,
    channelId: message.channelId,
    parentId: String(message.channel.parentId || ''),
    forumType
  });

  if (forumType !== 'tweet') {
    logger.info('Ignoring messageCreate because parent forum is not watched tweet forum', {
      messageId: message.id,
      channelId: message.channelId,
      parentId: String(message.channel.parentId || ''),
      forumType,
      reason: 'not_watched_tweet_forum'
    });
    return;
  }

  if (message.author?.bot) {
    logger.info('Ignoring tweet relay because author is a bot', {
      messageId: message.id,
      channelId: message.channelId,
      parentId: String(message.channel.parentId || ''),
      reason: 'bot_author'
    });
    return;
  }

  if (logSilentRelaySkip(logger, 'timeline relay skipped silent', message, {
    parentId: String(message.channel.parentId || '')
  })) {
    return;
  }

  const extractedPost = await extractThreadMessagePost(message, config, logger);
  const post = await enrichPostWithMusicLink(extractedPost, { db, logger });
  const desiredTargets = getTweetDestinationTargets(post, config);
  logger.info('Computed relay destinations', {
    sourceMessageId: message.id,
    destinations: desiredTargets
  });
  let existingTargets = db.relays.listMessageRelayTargets(message.id);
  const legacyRelay = db.relays.getMessageRelay(message.id);
  const normalizedLegacyTarget = normalizeLegacyRelayTarget(legacyRelay, config.timelineChannelId);

  if (!existingTargets.length && normalizedLegacyTarget) {
    db.relays.upsertMessageRelayTarget(normalizedLegacyTarget);
    existingTargets.push(normalizedLegacyTarget);
  }

  existingTargets = normalizeStoredRelayTargets(existingTargets, {
    db,
    timelineChannelId: config.timelineChannelId,
    sourceMessageId: message.id
  });

  const existingTargetByChannelId = new Map(
    existingTargets.map((target) => [String(target.destinationChannelId), target])
  );

  const { payload, cleanup } = await buildTimelinePayload(post, {
    config,
    forumType: 'tweet',
    logger
  });

  try {
    for (const target of desiredTargets) {
      if (existingTargetByChannelId.has(target.destinationChannelId)) {
        logger.info('Skipped tweet relay because destination copy already exists', {
          messageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind
        });
        continue;
      }

      const relayInFlightKey = buildRelayInFlightKey(
        message.id,
        target.destinationChannelId,
        target.relayKind
      );
      if (message.client.timelineRelayMessageInFlight.has(relayInFlightKey)) {
        logger.warn('Skipped tweet relay because identical destination send is already in flight', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind
        });
        continue;
      }

      const destinationChannel = await getTextChannel(message.guild, target.destinationChannelId);
      if (!destinationChannel) {
        throw new Error(`Destination channel was not found or is not text-based: ${target.destinationChannelId}`);
      }

      message.client.timelineRelayMessageInFlight.add(relayInFlightKey);
      try {
        const existingTarget = db.relays.getMessageRelayTarget(message.id, target.destinationChannelId);
        if (existingTarget?.relayedMessageId) {
          logger.warn('Skipped tweet relay because destination copy already existed before send', {
            sourceMessageId: message.id,
            destinationChannelId: target.destinationChannelId,
            relayKind: target.relayKind,
            existingRelayedMessageId: existingTarget.relayedMessageId
          });
          continue;
        }

        const reply = buildReplyOptions({
          message,
          destinationChannelId: target.destinationChannelId,
          db,
          logger
        });
        const mergedResult = await tryMergeShortTweetMessage(message, post, target, {
          config,
          db,
          logger
        });
        if (mergedResult?.merged) {
          continue;
        }
        const sendPayload = {
          ...payload,
          ...(reply ? { reply } : {})
        };
        logger.info('relay hashtag transform applied', {
          sourceMessageId: message.id,
          rawContent: String(message.content || '').slice(0, 500),
          cleanedContent: String(post.content || '').slice(0, 500),
          displayHashtags: post.displayBotHashtags || [],
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(post.content || ''))
        });
        const sentMessage = await sendRelayMessage(destinationChannel, sendPayload, logger, {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          sendPurpose: buildRelaySendPurpose(message, target),
          callsiteLabel: 'timeline:message-create'
        });
        db.relays.upsertMessageRelayTarget({
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          threadId: message.channel.id,
          parentChannelId: String(message.channel.parentId || ''),
          forumType: 'tweet',
          relayKind: target.relayKind,
          relayedMessageId: sentMessage.id,
          authorId: message.author?.id || null
        });
        updateTimelineDestinationState(db, {
          guildId: message.guildId,
          destinationChannelId: target.destinationChannelId,
          relayedMessageId: sentMessage.id,
          sourceMessageId: message.id,
          sourceThreadId: String(message.channel.id || ''),
          authorId: message.author?.id || null
        });

        if (String(target.destinationChannelId) === String(config.timelineChannelId || '')) {
          if (isMergeableShortTweetPost(post, config)) {
            db.timelineMerge.upsert({
              guildId: message.guildId,
              sourceChannelId: String(message.channelId || ''),
              sourceThreadId: String(message.channel.id || ''),
              authorId: message.author?.id || null,
              destinationChannelId: target.destinationChannelId,
              lastSourceMessageId: message.id,
              relayedMessageId: sentMessage.id,
              mergedTextJson: JSON.stringify([String(post.content || '').trim()]),
              mergedCount: 1,
              lastMessageAt: new Date(message.createdAt || Date.now()).toISOString()
            });
          } else {
            db.timelineMerge.delete(
              message.guildId,
              String(message.channelId || ''),
              message.author?.id || '',
              target.destinationChannelId
            );
          }
        }

        logger.info('Tweet message relayed', {
          messageId: message.id,
          channelId: message.channelId,
          referencedSourceMessageId: message.reference?.messageId || null,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          relayedMessageId: sentMessage.id
        });
        if (String(target.destinationChannelId) === String(config.timelineChannelId || '')) {
          logger.info('new card sent after interruption', {
            sourceMessageId: message.id,
            destinationChannelId: target.destinationChannelId,
            relayedMessageId: sentMessage.id
          });
        }
      } finally {
        message.client.timelineRelayMessageInFlight.delete(relayInFlightKey);
      }
    }
  } finally {
    await cleanup();
  }
}

async function updateTweetTimelineCard(oldMessage, newMessage, { config, db, logger }) {
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;

  logger.info('messageUpdate received in thread', {
    messageId: newMessage.id,
    channelId: newMessage.channelId,
    parentId: String(newMessage.channel?.parentId || ''),
    partial: Boolean(newMessage.partial)
  });

  if (!message?.inGuild() || !message.channel?.isThread?.()) {
    logger.info('Ignoring messageUpdate because message is not in a guild thread', {
      messageId: newMessage.id,
      reason: 'not_guild_thread'
    });
    return;
  }

  const forumType = getForumType(message.channel.parentId, config);
  if (forumType !== 'tweet') {
    logger.info('Ignoring messageUpdate because parent forum is not watched tweet forum', {
      messageId: message.id,
      parentId: String(message.channel.parentId || ''),
      forumType,
      reason: 'not_watched_tweet_forum'
    });
    return;
  }

  if (message.author?.bot) {
    logger.info('Ignoring messageUpdate because author is a bot', {
      messageId: message.id,
      reason: 'bot_author'
    });
    return;
  }

  if (logSilentRelaySkip(logger, 'timeline relay skipped silent', message, {
    parentId: String(message.channel.parentId || ''),
    update: true
  })) {
    return;
  }

  let existingTargets = db.relays.listMessageRelayTargets(message.id);
  const legacyRelay = db.relays.getMessageRelay(message.id);
  const normalizedLegacyTarget = normalizeLegacyRelayTarget(legacyRelay, config.timelineChannelId);
  const relayTargets = existingTargets.length
    ? existingTargets
    : normalizedLegacyTarget
      ? [normalizedLegacyTarget]
      : [];
  const normalizedRelayTargets = normalizeStoredRelayTargets(relayTargets, {
    db,
    timelineChannelId: config.timelineChannelId,
    sourceMessageId: message.id
  });

  if (!normalizedRelayTargets.length) {
    logger.info('Ignoring messageUpdate because relay record was not found', {
      messageId: message.id,
      reason: 'relay_record_missing'
    });
    return;
  }

  const extractedPost = await extractThreadMessagePost(message, config, logger);
  const post = await enrichPostWithMusicLink(extractedPost, { db, logger });
  const desiredTargets = [
    ...getTweetDestinationTargets(post, config),
    ...getGlobalRouteDestinationTargets(post, config, message.channelId)
  ];
  const desiredTargetByChannelId = new Map();
  for (const target of desiredTargets) {
    if (!target?.destinationChannelId || desiredTargetByChannelId.has(String(target.destinationChannelId))) {
      continue;
    }
    desiredTargetByChannelId.set(String(target.destinationChannelId), target);
  }
  const { payload, cleanup } = await buildTimelinePayload(post, {
    config,
    forumType: 'tweet',
    logger
  });

  try {
    for (const relayTarget of normalizedRelayTargets) {
      const destinationChannel = await getTextChannel(message.guild, relayTarget.destinationChannelId || config.timelineChannelId);
      if (!destinationChannel) {
        logger.warn('Tweet timeline card update skipped because destination channel was missing', {
          messageId: message.id,
          destinationChannelId: relayTarget.destinationChannelId
        });
        continue;
      }

      const currentTarget = desiredTargetByChannelId.get(String(relayTarget.destinationChannelId));
      const timelineMessage = await destinationChannel.messages.fetch(relayTarget.relayedMessageId).catch(() => null);

      if (!currentTarget) {
        if (timelineMessage) {
          await timelineMessage.delete().catch(() => null);
        }
        db.relays.deleteMessageRelayTarget(message.id, String(relayTarget.destinationChannelId));
        logger.info('Tweet routed copy deleted because hashtag route was removed', {
          messageId: message.id,
          destinationChannelId: relayTarget.destinationChannelId
        });
        continue;
      }

      if (!timelineMessage) {
        logger.warn('Tweet timeline card update failed because destination message was missing', {
          messageId: message.id,
          destinationChannelId: relayTarget.destinationChannelId,
          relayedMessageId: relayTarget.relayedMessageId
        });
        continue;
      }

      logger.info('relay hashtag transform applied', {
        sourceMessageId: message.id,
        rawContent: String(message.content || '').slice(0, 500),
        cleanedContent: String(post.content || '').slice(0, 500),
        displayHashtags: post.displayBotHashtags || [],
        destinationChannelId: relayTarget.destinationChannelId,
        relayKind: currentTarget?.relayKind || relayTarget.relayKind || 'timeline_update',
        rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(post.content || ''))
      });

      await timelineMessage.edit({
        ...payload,
        attachments: []
      });

      db.relays.upsertMessageRelayTarget({
        sourceMessageId: message.id,
        destinationChannelId: String(relayTarget.destinationChannelId),
        threadId: message.channel.id,
        parentChannelId: String(message.channel.parentId || ''),
        forumType: 'tweet',
        relayKind: currentTarget.relayKind,
        relayedMessageId: timelineMessage.id,
        authorId: message.author?.id || null
      });
      desiredTargetByChannelId.delete(String(relayTarget.destinationChannelId));
    }

    const animeChannelId = String(config.anime?.channelId || '');
    for (const target of desiredTargetByChannelId.values()) {
      if (animeChannelId && String(target.destinationChannelId) === animeChannelId) {
        logger.warn('anime_channel_normal_relay_blocked', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          reason: 'anime_channel_is_parent_card_only'
        });
        continue;
      }
      const destinationChannel = await getTextChannel(message.guild, target.destinationChannelId);
      if (!destinationChannel) {
        logger.warn('Tweet routed copy creation skipped because destination channel was missing', {
          messageId: message.id,
          destinationChannelId: target.destinationChannelId
        });
        continue;
      }

      const reply = buildReplyOptions({
        message,
        destinationChannelId: target.destinationChannelId,
        db,
        logger
      });
      const relayInFlightKey = buildRelayInFlightKey(
        message.id,
        target.destinationChannelId,
        target.relayKind
      );
      if (message.client.timelineRelayMessageInFlight.has(relayInFlightKey)) {
        logger.warn('Skipped routed copy creation because identical destination send is already in flight', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind
        });
        continue;
      }

      message.client.timelineRelayMessageInFlight.add(relayInFlightKey);
      let sentMessage;
      try {
        const existingTarget = db.relays.getMessageRelayTarget(message.id, target.destinationChannelId);
        if (existingTarget?.relayedMessageId) {
          logger.warn('Skipped routed copy creation because destination copy already existed before send', {
            sourceMessageId: message.id,
            destinationChannelId: target.destinationChannelId,
            relayKind: target.relayKind,
            existingRelayedMessageId: existingTarget.relayedMessageId
          });
          continue;
        }

        const mergedResult = await tryMergeShortTweetMessage(message, post, target, {
          config,
          db,
          logger
        });
        if (mergedResult?.merged) {
          continue;
        }

        logger.info('relay hashtag transform applied', {
          sourceMessageId: message.id,
          rawContent: String(message.content || '').slice(0, 500),
          cleanedContent: String(post.content || '').slice(0, 500),
          displayHashtags: post.displayBotHashtags || [],
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(post.content || ''))
        });

        sentMessage = await sendRelayMessage(destinationChannel, {
          ...payload,
          ...(reply ? { reply } : {})
        }, logger, {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          sendPurpose: 'timeline:missing-route-create-send',
          callsiteLabel: 'timeline:message-update'
        });
      } finally {
        message.client.timelineRelayMessageInFlight.delete(relayInFlightKey);
      }
      db.relays.upsertMessageRelayTarget({
        sourceMessageId: message.id,
        destinationChannelId: target.destinationChannelId,
        threadId: message.channel.id,
        parentChannelId: String(message.channel.parentId || ''),
        forumType: 'tweet',
        relayKind: target.relayKind,
        relayedMessageId: sentMessage.id,
        authorId: message.author?.id || null
      });
    }
  } finally {
    await cleanup();
  }
  logger.info('Tweet timeline card copies updated', {
    messageId: message.id,
    destinationCount: desiredTargets.length
  });
}

async function updateQuestionTimelineCard(thread, { config, db, logger, questionStatusOverride = null, statusSource = null }) {
  const relay = db.relays.getThreadRelay(thread.id);

  if (!relay?.timelineMessageId) {
    logger.warn('Question timeline card update skipped because relay record was not found', {
      threadId: thread.id
    });
    return;
  }

  const post = await extractFirstPost(thread, config, logger, {
    questionStatusOverride
  });
  if (!post) {
    logger.warn('Question timeline card update skipped because starter message was unavailable', {
      threadId: thread.id
    });
    return;
  }
  const promptState = db.questionRolePrompts.get(thread.id);
  const selectedRoleIds = normalizeQuestionRoleSelection(config, promptState?.selectedRoleIds || []);
  const postWithRoles = selectedRoleIds.length
    ? applyRoleMentionSection(post, {
        roleIds: selectedRoleIds,
        label: 'この質問に関係ありそうな人',
        allowMentions: false
      })
    : post;

  const timelineChannel = await thread.guild.channels.fetch(config.timelineChannelId);
  if (!timelineChannel || !timelineChannel.isTextBased()) {
    throw new Error('Timeline channel was not found or is not text-based');
  }

  const timelineMessage = await timelineChannel.messages.fetch(relay.timelineMessageId).catch(() => null);
  if (!timelineMessage) {
    logger.warn('Question timeline card update skipped because timeline message was missing', {
      threadId: thread.id,
      timelineMessageId: relay.timelineMessageId
    });
    return;
  }

  const { payload, cleanup } = await buildTimelinePayload(postWithRoles, {
    config,
    forumType: 'question',
    logger
  });
  logger.info('timeline card update using explicit targetStatus', {
    threadId: thread.id,
    questionStatusOverride,
    cardBuilderStatusSource: questionStatusOverride ? (statusSource || 'command_target_status') : 'thread_state'
  });
  try {
    await timelineMessage.edit({
      ...payload,
      attachments: []
    });
  } finally {
    await cleanup();
  }

  logger.info('Question timeline card updated', {
    threadId: thread.id,
    timelineMessageId: relay.timelineMessageId,
    resolved: post.isResolved,
    questionCardStatusColor: post.isResolved ? 'green' : 'red',
    cardBuilderStatusSource: questionStatusOverride ? (statusSource || 'command_target_status') : 'thread_state'
  });
}

function detectGlobalHashtagMatches(content, globalHashtagRoutes) {
  const lines = String(content || '').split(/\r?\n/);
  const matched = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('##')) {
      continue;
    }

    for (const [routeKey, route] of Object.entries(globalHashtagRoutes)) {
      if (matched.has(routeKey)) {
        continue;
      }

      const tags = Array.isArray(route.tags) ? route.tags : [];
      for (const configTag of tags) {
        const normalizedPrefix = `##${String(configTag || '').trim()}`;
        const normalizedLine = trimmed.toLowerCase();
        const normalizedPrefixLower = normalizedPrefix.toLowerCase();
        if (
          normalizedLine === normalizedPrefixLower ||
          normalizedLine.startsWith(`${normalizedPrefixLower} `) ||
          normalizedLine.startsWith(`${normalizedPrefixLower}\t`)
        ) {
          matched.set(routeKey, route);
          break;
        }
      }
    }
  }

  return matched;
}

function diffAddedRoutes(previous = [], next = []) {
  const previousSet = new Set((Array.isArray(previous) ? previous : []).map(String));
  return (Array.isArray(next) ? next : []).filter((value) => !previousSet.has(String(value)));
}

async function relayGlobalHashtagMessage(message, { config, db, logger }) {
  const skipReason = getRouteScanSkipReason(message, config);
  if (skipReason) {
    const content = String(message.content || '');
    if (content.split(/\r?\n/).some((line) => line.trim().startsWith('##'))) {
      logger.info('route tag global scan skipped reason', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        parentId: String(message.channel?.parentId || ''),
        reason: skipReason
      });
      if (skipReason === 'route_output_channel') {
        logger.info('route tag loop prevention skipped', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          parentId: String(message.channel?.parentId || '')
        });
      }
    }
    return;
  }

  const sourceChannelId = String(message.channelId || '');
  const globalHashtagRoutes = config.globalHashtagRoutes || {};
  const vcListenOnlyChannelIds = config.vcListenOnlyChannelIds || [];
  const isVcListenOnly = vcListenOnlyChannelIds.includes(sourceChannelId);
  const content = String(message.content || '');
  const hasDoublePrefix = content.split(/\r?\n/).some((line) => line.trim().startsWith('##'));
  const isTweetThread = Boolean(message.channel?.isThread?.() && getForumType(message.channel.parentId, config) === 'tweet');

  if (logSilentRelaySkip(logger, 'route relay skipped silent', message, {
    sourceChannelId,
    parentId: String(message.channel?.parentId || '')
  })) {
    return;
  }

  logger.info('global hashtag messageCreate evaluated', {
    sourceMessageId: message.id,
    sourceChannelId,
    rawContent: content,
    hasDoublePrefix,
    globalRouteCount: Object.keys(globalHashtagRoutes).length,
    isVcListenOnly
  });

  const globalMatches = detectGlobalHashtagMatches(content, globalHashtagRoutes);
  const routing = parseRelayHashtagPrefixes(content, {
    globalRoutes: config.globalHashtagRoutes,
    botRoutes: config.botHashtagRoutes
  });
  const botMatches = isTweetThread && !isVcListenOnly ? [] : routing.botMatchedRoutes;
  const animeChannelId = String(config.anime?.channelId || '');
  const isAnimeRouteMatched = Array.from(globalMatches.values()).some((route) => String(route?.channelId || '') === animeChannelId);

  let hasAnyRoute = globalMatches.size > 0 || botMatches.length > 0;

  if (!hasAnyRoute && !isVcListenOnly) {
    if (hasDoublePrefix) {
      logger.info('global hashtag relay skipped reason', {
        sourceMessageId: message.id,
        sourceChannelId,
        matchedRoute: false,
        reason: 'no_matching_global_route'
      });
    }
    return;
  }

  if (isVcListenOnly) {
    if (!hasDoublePrefix) {
      return;
    }
  }

  logger.info('Global hashtag relay evaluation started', {
    sourceMessageId: message.id,
    sourceChannelId,
    rawContent: content,
    isVcListenOnly,
    globalMatchCount: globalMatches.size,
    globalMatchKeys: Array.from(globalMatches.keys()),
    botMatchCount: botMatches.length,
    botMatchKeys: botMatches
  });
  logger.info('route tag global scan accepted', {
    sourceMessageId: message.id,
    sourceChannelId,
    parentId: String(message.channel?.parentId || ''),
    globalMatchedRoutes: Array.from(globalMatches.keys()),
    botMatchedRoutes: botMatches,
    isVcListenOnly,
    isTweetThread
  });

  const extractedPost = await extractPlainMessagePost(message, config, logger);
  const post = await enrichPostWithMusicLink(extractedPost, { db, logger });
  const detectedTag = Array.from(globalMatches.values())
    .flatMap((route) => route.tags || [])
    .find((tag) => {
      const prefix = `##${String(tag || '').trim()}`;
      const loweredContent = content.toLowerCase();
      const loweredPrefix = prefix.toLowerCase();
      return (
        loweredContent.includes(`\n${loweredPrefix}`) ||
        loweredContent.startsWith(loweredPrefix)
      );
    }) || null;
  const cleanedBody = post.body || '';

  const destinationTargets = [];
  const seenDestinationIds = new Set();

  const addDestination = (destinationChannelId, relayKind) => {
    const destId = String(destinationChannelId || '');
    if (!destId || destId === sourceChannelId || seenDestinationIds.has(destId)) {
      return false;
    }

    seenDestinationIds.add(destId);
    destinationTargets.push({ destinationChannelId: destId, relayKind });
    return true;
  };

  for (const [routeKey, route] of globalMatches) {
    const isAnimeDestinationRoute = String(route.channelId || '') === animeChannelId;
    const shouldRelayUserPostToDestination = route.relayUserPostToDestination !== false && !isAnimeDestinationRoute;
    if (route.channelId && shouldRelayUserPostToDestination) {
      const added = addDestination(route.channelId, `global_hashtag:${routeKey}`);
      logger.info('Global hashtag route matched', {
        sourceMessageId: message.id,
        routeKey,
        detectedTag,
        matchedRoute: true,
        destinationChannelId: route.channelId,
        routeDestinationChannelId: route.channelId,
        relayUserPostToDestination: shouldRelayUserPostToDestination,
        alsoTimeline: route.alsoTimeline === true,
        willRelay: added
      });
    } else if (route.channelId) {
      logger.info('Global hashtag route destination skipped for normal relay', {
        sourceMessageId: message.id,
        routeKey,
        detectedTag,
        destinationChannelId: route.channelId,
        relayUserPostToDestination: route.relayUserPostToDestination !== false,
        forcedAnimeDestinationSkip: isAnimeDestinationRoute,
        reason: 'route_disabled_destination_relay'
      });
    }

    if (route.alsoTimeline && config.timelineChannelId) {
      addDestination(config.timelineChannelId, `global_hashtag:${routeKey}:timeline`);
    }
  }

  if (botMatches.length > 0 || isVcListenOnly) {
    for (const routeKey of botMatches.length > 0 ? botMatches : post.matchedBotHashtagRoutes || []) {
      const route = config.botHashtagRoutes?.[routeKey];
      if (route?.channelId) {
        const relayKind = isVcListenOnly ? `vc_hashtag:${routeKey}` : `hashtag:${routeKey}`;
        const added = addDestination(route.channelId, relayKind);
        logger.info(isVcListenOnly ? 'VC listen-only hashtag route matched' : 'Bot hashtag route matched globally', {
          sourceMessageId: message.id,
          routeKey,
          destinationChannelId: route.channelId,
          willRelay: added
        });
      }
    }

    if (config.timelineChannelId && (botMatches.length || post.matchedBotHashtagRoutes?.length || globalMatches.size)) {
      addDestination(config.timelineChannelId, isVcListenOnly ? 'vc_hashtag:timeline' : 'hashtag:timeline');
    }
  }

  if (!destinationTargets.length) {
    logger.info('Global hashtag relay skipped: no valid destinations', {
      sourceMessageId: message.id,
      sourceChannelId,
      destinationsBeforeDedupe: [],
      destinationsAfterDedupe: []
    });
    return;
  }

  logger.info('Global hashtag destinations computed', {
    sourceMessageId: message.id,
    detectedTag,
    matchedRoute: globalMatches.size > 0,
    routeDestinationChannelId: Array.from(globalMatches.values()).map((route) => route.channelId).filter(Boolean),
    alsoTimeline: Array.from(globalMatches.values()).some((route) => route.alsoTimeline === true),
    destinationsBeforeDedupe: destinationTargets.map((target) => target.destinationChannelId),
    destinationsAfterDedupe: destinationTargets.map((target) => target.destinationChannelId),
    cleanedBody
  });

  const { payload, cleanup } = await buildTimelinePayload(post, {
    config,
    forumType: 'tweet',
    logger
  });

  try {
    for (const target of destinationTargets) {
      const existingRelay = db.relays.getMessageRelayTarget(message.id, target.destinationChannelId);
      if (existingRelay?.relayedMessageId) {
        if (isAnimeRouteMatched && String(target.destinationChannelId) === String(config.timelineChannelId || '')) {
          db.anime.upsertHashtagSource({
            guildId: message.guildId,
            sourceMessageId: message.id,
            sourceChannelId: sourceChannelId,
            sourceAuthorId: message.author?.id || null,
            relayedTimelineMessageId: existingRelay.relayedMessageId,
            relayedRouteMessageIdsJson: JSON.stringify({ [target.destinationChannelId]: existingRelay.relayedMessageId }),
            cleanedContent: String(post.content || ''),
            displayTagsJson: JSON.stringify(Array.isArray(post.displayBotHashtags) ? post.displayBotHashtags : []),
            detectedCandidate: null,
            animeEntryId: null,
            status: 'pending'
          });
        }
        logger.info('Global hashtag relay skipped: destination already relayed', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          existingRelayedMessageId: existingRelay.relayedMessageId
        });
        continue;
      }

      const relayInFlightKey = buildRelayInFlightKey(message.id, target.destinationChannelId, target.relayKind);
      if (message.client.timelineRelayMessageInFlight.has(relayInFlightKey)) {
        logger.warn('Global hashtag relay skipped: in-flight duplicate', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind
        });
        continue;
      }

      const destinationChannel = await getTextChannel(message.guild, target.destinationChannelId);
      if (!destinationChannel) {
        logger.warn('Global hashtag relay skipped: destination channel unavailable', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId
        });
        continue;
      }

      message.client.timelineRelayMessageInFlight.add(relayInFlightKey);
      try {
        const doubleCheck = db.relays.getMessageRelayTarget(message.id, target.destinationChannelId);
        if (doubleCheck?.relayedMessageId) {
          continue;
        }

        logger.info('global hashtag relay send started', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          cleanedContent: String(post.content || '').slice(0, 500),
          displayHashtags: post.displayBotHashtags || [],
          rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(post.content || ''))
        });

        const sentMessage = await sendRelayMessage(destinationChannel, payload, logger, {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          sendPurpose: 'global_hashtag:relay-send',
          callsiteLabel: 'global-hashtag:message-create'
        });

        db.relays.upsertMessageRelayTarget({
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          threadId: sourceChannelId,
          parentChannelId: '',
          forumType: isVcListenOnly ? 'vc_hashtag' : 'global_hashtag',
          relayKind: target.relayKind,
          relayedMessageId: sentMessage.id,
          authorId: message.author?.id || null
        });
        updateTimelineDestinationState(db, {
          guildId: message.guildId,
          destinationChannelId: target.destinationChannelId,
          relayedMessageId: sentMessage.id,
          sourceMessageId: message.id,
          sourceThreadId: sourceChannelId,
          authorId: message.author?.id || null
        });

        logger.info('Global hashtag relay sent', {
          sourceMessageId: message.id,
          sourceChannelId,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          relayedMessageId: sentMessage.id
        });
        logger.info('global hashtag relay send finished', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          returnedMessageId: sentMessage.id,
          cleanedContent: String(post.content || '').slice(0, 500),
          displayHashtags: post.displayBotHashtags || [],
          rawPrefixStillPresent: /(^|\n)\s*##/u.test(String(post.content || ''))
        });

        if (isAnimeRouteMatched && String(target.destinationChannelId) === String(config.timelineChannelId || '')) {
          db.anime.upsertHashtagSource({
            guildId: message.guildId,
            sourceMessageId: message.id,
            sourceChannelId: sourceChannelId,
            sourceAuthorId: message.author?.id || null,
            relayedTimelineMessageId: sentMessage.id,
            relayedRouteMessageIdsJson: JSON.stringify({ [target.destinationChannelId]: sentMessage.id }),
            cleanedContent: String(post.content || ''),
            displayTagsJson: JSON.stringify(Array.isArray(post.displayBotHashtags) ? post.displayBotHashtags : []),
            detectedCandidate: null,
            animeEntryId: null,
            status: 'pending'
          });
        }
      } catch (error) {
        logger.error('target global hashtag relay send failed', {
          sourceMessageId: message.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          error: error.message
        });
        throw error;
      } finally {
        message.client.timelineRelayMessageInFlight.delete(relayInFlightKey);
      }
    }

    if (globalMatches.size > 0) {
      void handleAnimeHashtagPost(message, {
        matchedRouteKeys: Array.from(globalMatches.keys()),
        cleanedContent: post.content,
        displayHashtags: post.displayBotHashtags
      }).catch((error) => {
        logger.warn('anime hashtag integration failed', {
          sourceMessageId: message.id,
          sourceChannelId,
          error: error.message
        });
      });
    }
  } finally {
    await cleanup();
  }
}

async function handleReplyBasedGlobalHashtagRoute(message, { config, db, logger }) {
  if (!message.inGuild?.() || message.author?.bot || !message.reference?.messageId) {
    return false;
  }

  const replyRouting = parseRelayHashtagPrefixes(String(message.content || ''), {
    globalRoutes: config.globalHashtagRoutes,
    botRoutes: config.botHashtagRoutes
  });
  const hasRoutes =
    (Array.isArray(replyRouting.globalMatchedRoutes) && replyRouting.globalMatchedRoutes.length > 0) ||
    (Array.isArray(replyRouting.botMatchedRoutes) && replyRouting.botMatchedRoutes.length > 0);

  if (!hasRoutes) {
    return false;
  }

  if (logSilentRelaySkip(logger, 'posthoc relay skipped silent', message, {
    replyTargetMessageId: message.reference.messageId,
    tokenLocation: 'reply'
  })) {
    logSilentRelaySkip(logger, 'route relay skipped silent', message, {
      replyTargetMessageId: message.reference.messageId,
      posthoc: true
    }, { logFlagDetected: false });
    return true;
  }

  logger.info('posthoc hashtag reply detected', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    replyTargetMessageId: message.reference.messageId,
    displayTags: replyRouting.displayTags
  });
  logger.info('posthoc hashtag routes parsed', {
    sourceMessageId: message.id,
    replyTargetMessageId: message.reference.messageId,
    globalMatchedRoutes: replyRouting.globalMatchedRoutes,
    botMatchedRoutes: replyRouting.botMatchedRoutes,
    displayTags: replyRouting.displayTags
  });

  const targetMessage = await message.fetchReference().catch(() => null);
  if (!targetMessage?.inGuild?.()) {
    logger.warn('posthoc hashtag referenced message fetch failed', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      reason: 'reply_target_unavailable'
    });
    return true;
  }

  logger.info('posthoc hashtag referenced message fetched', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    replyTargetMessageId: targetMessage.id,
    replyTargetChannelId: targetMessage.channelId
  });

  if (logSilentRelaySkip(logger, 'posthoc relay skipped silent', targetMessage, {
    routedByMessageId: message.id,
    routedByChannelId: message.channelId,
    replyTargetMessageId: targetMessage.id,
    replyTargetChannelId: targetMessage.channelId,
    tokenLocation: 'referenced_message'
  })) {
    logSilentRelaySkip(logger, 'route relay skipped silent', targetMessage, {
      routedByMessageId: message.id,
      posthoc: true
    }, { logFlagDetected: false });
    return true;
  }

  const targetSkipReason = getRouteScanSkipReason(targetMessage, config);
  if (targetSkipReason) {
    logger.info('route tag loop prevention skipped', {
      sourceMessageId: message.id,
      replyTargetMessageId: targetMessage.id,
      replyTargetChannelId: targetMessage.channelId,
      reason: targetSkipReason
    });
    return true;
  }

  const post = await extractPlainMessagePost(targetMessage, config, logger);
  post.displayBotHashtags = replyRouting.displayTags;
  post.matchedGlobalHashtagRoutes = replyRouting.globalMatchedRoutes;
  post.matchedBotHashtagRoutes = replyRouting.botMatchedRoutes;
  post.detectedGlobalHashtags = replyRouting.globalDetectedTags;
  post.routedByUserId = message.author.id;

  const sourceChannelId = String(targetMessage.channelId || '');
  const destinationTargets = [];
  const seenDestinationIds = new Set();
  const addDestination = (destinationChannelId, relayKind) => {
    const destId = String(destinationChannelId || '');
    if (!destId || destId === sourceChannelId || seenDestinationIds.has(destId)) {
      return false;
    }
    seenDestinationIds.add(destId);
    destinationTargets.push({ destinationChannelId: destId, relayKind });
    return true;
  };

  for (const routeKey of replyRouting.globalMatchedRoutes) {
    const route = config.globalHashtagRoutes?.[routeKey];
    const isAnimeDestinationRoute = String(route?.channelId || '') === String(config.anime?.channelId || '');
    if (route?.channelId && route.relayUserPostToDestination !== false && !isAnimeDestinationRoute) {
      addDestination(route.channelId, `reply_global_hashtag:${routeKey}`);
    }
    if (route?.alsoTimeline && config.timelineChannelId) {
      addDestination(config.timelineChannelId, `reply_global_hashtag:${routeKey}:timeline`);
    }
  }

  for (const routeKey of replyRouting.botMatchedRoutes) {
    const route = config.botHashtagRoutes?.[routeKey];
    if (route?.channelId) {
      addDestination(route.channelId, `reply_hashtag:${routeKey}`);
    }
    if (config.timelineChannelId) {
      addDestination(config.timelineChannelId, `reply_hashtag:${routeKey}:timeline`);
    }
  }

  logger.info('posthoc hashtag relay started', {
    sourceMessageId: message.id,
    replyTargetMessageId: targetMessage.id,
    destinations: destinationTargets.map((target) => target.destinationChannelId),
    displayTags: post.displayBotHashtags,
    globalMatchedRoutes: replyRouting.globalMatchedRoutes,
    botMatchedRoutes: replyRouting.botMatchedRoutes
  });

  if (!destinationTargets.length) {
    logger.info('posthoc hashtag relay finished', {
      sourceMessageId: message.id,
      replyTargetMessageId: targetMessage.id,
      sentCount: 0,
      skippedCount: 0,
      reason: 'no_valid_destinations'
    });
    return true;
  }

  const { payload, cleanup } = await buildTimelinePayload(post, {
    config,
    forumType: 'tweet',
    logger
  });

  const relayedRouteMessageIds = {};
  let relayedTimelineMessageId = null;
  let sentCount = 0;
  let skippedCount = 0;

  try {
    for (const target of destinationTargets) {
      const existingRelay = db.relays.getMessageRelayTarget(targetMessage.id, target.destinationChannelId);
      if (existingRelay?.relayedMessageId) {
        relayedRouteMessageIds[target.destinationChannelId] = existingRelay.relayedMessageId;
        if (String(target.destinationChannelId) === String(config.timelineChannelId || '')) {
          relayedTimelineMessageId = existingRelay.relayedMessageId;
        }
        skippedCount += 1;
        logger.info('posthoc hashtag duplicate skipped', {
          replyTargetMessageId: targetMessage.id,
          destinationChannelId: target.destinationChannelId,
          existingRelayedMessageId: existingRelay.relayedMessageId
        });
        continue;
      }

      const relayInFlightKey = buildRelayInFlightKey(targetMessage.id, target.destinationChannelId, target.relayKind);
      if (message.client.timelineRelayMessageInFlight.has(relayInFlightKey)) {
        skippedCount += 1;
        logger.info('posthoc hashtag duplicate skipped', {
          replyTargetMessageId: targetMessage.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          reason: 'in_flight'
        });
        continue;
      }
      const destinationChannel = await getTextChannel(message.guild, target.destinationChannelId);
      if (!destinationChannel) {
        skippedCount += 1;
        continue;
      }

      message.client.timelineRelayMessageInFlight.add(relayInFlightKey);
      try {
        const sentMessage = await sendRelayMessage(destinationChannel, payload, logger, {
          sourceMessageId: targetMessage.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          sendPurpose: 'reply_global_hashtag:relay-send',
          callsiteLabel: 'reply-global-hashtag:message-create'
        });
        sentCount += 1;
        relayedRouteMessageIds[target.destinationChannelId] = sentMessage.id;
        if (String(target.destinationChannelId) === String(config.timelineChannelId || '')) {
          relayedTimelineMessageId = sentMessage.id;
        }
        db.relays.upsertMessageRelayTarget({
          sourceMessageId: targetMessage.id,
          destinationChannelId: target.destinationChannelId,
          threadId: sourceChannelId,
          parentChannelId: '',
          forumType: 'reply_global_hashtag',
          relayKind: target.relayKind,
          relayedMessageId: sentMessage.id,
          authorId: targetMessage.author?.id || null
        });
        updateTimelineDestinationState(db, {
          guildId: message.guildId,
          destinationChannelId: target.destinationChannelId,
          relayedMessageId: sentMessage.id,
          sourceMessageId: targetMessage.id,
          sourceThreadId: sourceChannelId,
          authorId: targetMessage.author?.id || null
        });
        logger.info('posthoc hashtag relay sent', {
          replyTargetMessageId: targetMessage.id,
          destinationChannelId: target.destinationChannelId,
          relayedMessageId: sentMessage.id
        });
        logger.info('posthoc hashtag missing destination sent', {
          replyTargetMessageId: targetMessage.id,
          destinationChannelId: target.destinationChannelId,
          relayKind: target.relayKind,
          relayedMessageId: sentMessage.id
        });
      } finally {
        message.client.timelineRelayMessageInFlight.delete(relayInFlightKey);
      }
    }
  } finally {
    await cleanup();
  }

  const animeChannelId = String(config.anime?.channelId || '');
  const isAnimeRouteMatched = replyRouting.globalMatchedRoutes.some((routeKey) => {
    const route = config.globalHashtagRoutes?.[routeKey];
    return String(route?.channelId || '') === animeChannelId;
  });

  if (isAnimeRouteMatched) {
    logger.info('posthoc hashtag anime integration started', {
      sourceMessageId: message.id,
      replyTargetMessageId: targetMessage.id,
      matchedRouteKeys: replyRouting.globalMatchedRoutes
    });
    db.anime.upsertHashtagSource({
      guildId: targetMessage.guildId,
      sourceMessageId: targetMessage.id,
      sourceChannelId,
      sourceAuthorId: targetMessage.author?.id || null,
      relayedTimelineMessageId,
      relayedRouteMessageIdsJson: JSON.stringify(relayedRouteMessageIds),
      cleanedContent: String(post.content || ''),
      displayTagsJson: JSON.stringify(Array.isArray(post.displayBotHashtags) ? post.displayBotHashtags : []),
      detectedCandidate: null,
      animeEntryId: null,
      status: 'pending'
    });
    void handleAnimeHashtagPost(targetMessage, {
      matchedRouteKeys: replyRouting.globalMatchedRoutes,
      cleanedContent: post.content,
      displayHashtags: post.displayBotHashtags
    }).then(() => {
      logger.info('posthoc hashtag anime integration finished', {
        sourceMessageId: message.id,
        replyTargetMessageId: targetMessage.id
      });
    }).catch((error) => {
      logger.warn('posthoc hashtag anime integration finished', {
        sourceMessageId: message.id,
        replyTargetMessageId: targetMessage.id,
        error: error.message
      });
    });
  }

  logger.info('posthoc hashtag relay finished', {
    sourceMessageId: message.id,
    replyTargetMessageId: targetMessage.id,
    sentCount,
    skippedCount,
    destinationCount: destinationTargets.length
  });

  return true;
}

async function handleRouteAddedOnMessageUpdate(oldMessage, newMessage, { config, db, logger }) {
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message?.inGuild() || message.author?.bot) {
    return;
  }

  const oldContent = String(oldMessage?.content || '');
  const newContent = String(message.content || '');
  if (logSilentRelaySkip(logger, 'message edit route skipped silent', message, {
    update: true
  })) {
    logSilentRelaySkip(logger, 'route relay skipped silent', message, {
      update: true
    }, { logFlagDetected: false });
    return;
  }

  const skipReason = getRouteScanSkipReason(message, config);
  if (skipReason) {
    logger.info('route tag global scan skipped reason', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      parentId: String(message.channel?.parentId || ''),
      reason: skipReason,
      update: true
    });
    return;
  }

  const oldRouting = parseRelayHashtagPrefixes(oldContent, {
    globalRoutes: config.globalHashtagRoutes,
    botRoutes: config.botHashtagRoutes
  });
  const newRouting = parseRelayHashtagPrefixes(newContent, {
    globalRoutes: config.globalHashtagRoutes,
    botRoutes: config.botHashtagRoutes
  });
  const addedGlobalRoutes = diffAddedRoutes(oldRouting.globalMatchedRoutes, newRouting.globalMatchedRoutes);
  const addedBotRoutes = diffAddedRoutes(oldRouting.botMatchedRoutes, newRouting.botMatchedRoutes);
  const routeAdded = addedGlobalRoutes.length > 0 || addedBotRoutes.length > 0;
  const existingTimelineRelay = Boolean(
    db.relays.getMessageRelayTarget(message.id, String(config.timelineChannelId || ''))?.relayedMessageId ||
    db.relays.getMessageRelay(message.id)?.timelineMessageId
  );

  logger.info('message update route evaluated', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    oldHashtags: oldRouting.displayTags,
    newHashtags: newRouting.displayTags,
    oldGlobalRoutes: oldRouting.globalMatchedRoutes,
    newGlobalRoutes: newRouting.globalMatchedRoutes,
    oldBotRoutes: oldRouting.botMatchedRoutes,
    newBotRoutes: newRouting.botMatchedRoutes,
    routeAdded,
    existingTimelineRelayFound: existingTimelineRelay
  });

  if (!routeAdded) {
    return;
  }

  const sourceChannelId = String(message.channelId || '');
  const editDestinations = [];
  const seenEditDestinations = new Set();
  const addEditDestination = (destinationChannelId, relayKind, routeKey) => {
    const destId = String(destinationChannelId || '');
    if (!destId || destId === sourceChannelId || seenEditDestinations.has(destId)) {
      return;
    }
    seenEditDestinations.add(destId);
    editDestinations.push({ destinationChannelId: destId, relayKind, routeKey });
  };
  const animeChannelId = String(config.anime?.channelId || '');
  for (const routeKey of addedGlobalRoutes) {
    const route = config.globalHashtagRoutes?.[routeKey];
    const isAnimeDestinationRoute = animeChannelId && String(route?.channelId || '') === animeChannelId;
    if (route?.channelId && route.relayUserPostToDestination !== false && !isAnimeDestinationRoute) {
      addEditDestination(route.channelId, `global_hashtag:${routeKey}`, routeKey);
    }
    if (route?.alsoTimeline && config.timelineChannelId) {
      addEditDestination(config.timelineChannelId, `global_hashtag:${routeKey}:timeline`, routeKey);
    }
  }
  for (const routeKey of addedBotRoutes) {
    const route = config.botHashtagRoutes?.[routeKey];
    if (route?.channelId) {
      addEditDestination(route.channelId, `hashtag:${routeKey}`, routeKey);
    }
    if (config.timelineChannelId) {
      addEditDestination(config.timelineChannelId, `hashtag:${routeKey}:timeline`, routeKey);
    }
  }
  const missingEditDestinations = [];
  for (const destination of editDestinations) {
    const existingRelay = db.relays.getMessageRelayTarget(message.id, destination.destinationChannelId);
    if (existingRelay?.relayedMessageId) {
      logger.info('message edit route already existed skipped', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        destinationChannelId: destination.destinationChannelId,
        relayKind: destination.relayKind,
        existingRelayedMessageId: existingRelay.relayedMessageId
      });
      continue;
    }
    missingEditDestinations.push(destination);
  }

  logger.info('message edit route tags added', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    addedGlobalRoutes,
    addedBotRoutes,
    displayTags: newRouting.displayTags
  });
  logger.info('message edit new route destinations', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    destinations: missingEditDestinations
  });

  if (addedGlobalRoutes.some((routeKey) => String(config.globalHashtagRoutes?.[routeKey]?.channelId || '') === animeChannelId)) {
    logger.info('message edit anime integration triggered', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      addedGlobalRoutes
    });
  }

  const isTweetThread = Boolean(message.channel?.isThread?.() && getForumType(message.channel.parentId, config) === 'tweet');
  const isVcListenOnly = (config.vcListenOnlyChannelIds || []).includes(String(message.channelId || ''));
  const shouldRelayTweetRoutes = isTweetThread && addedBotRoutes.length > 0;
  const shouldRelayGlobalRoutes = addedGlobalRoutes.length > 0 || (!isTweetThread && addedBotRoutes.length > 0) || (isVcListenOnly && addedBotRoutes.length > 0);

  logger.info('message update route destination computed', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    routeAdded,
    shouldRelayTweetRoutes,
    shouldRelayGlobalRoutes,
    existingTimelineRelayFound: existingTimelineRelay,
    existingTimelineCardUpdated: isTweetThread && existingTimelineRelay && newRouting.displayTags.length > 0
  });

  if (shouldRelayTweetRoutes) {
    await relayTweetMessage(message, { config, db, logger });
  }

  if (shouldRelayGlobalRoutes) {
    await relayGlobalHashtagMessage(message, { config, db, logger });
  }

  logger.info('route relay sent', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    addedGlobalRoutes,
    addedBotRoutes
  });
}

module.exports = {
  buildTimelinePayload,
  relayForumThread,
  relayTweetMessage,
  updateTweetTimelineCard,
  updateQuestionTimelineCard,
  relayGlobalHashtagMessage,
  handleReplyBasedGlobalHashtagRoute,
  handleRouteAddedOnMessageUpdate,
  handleQuestionRolePromptInteraction,
  startQuestionRolePromptTimeouts
};
