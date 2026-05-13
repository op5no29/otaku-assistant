const { ChannelType } = require('discord.js');
const { buildTimelineMessage } = require('./buildTimelineMessage');
const { extractFirstPost, extractThreadMessagePost, extractPlainMessagePost } = require('./extractFirstPost');
const { prepareVideoThumbnail } = require('./videoThumbnail');
const { prepareAttachmentRelay } = require('./attachmentRelay');
const { enrichPostWithMusicLink } = require('./musicLinks');
const { applyQuestionStatusTag } = require('../questionResolver/threadTags');

const QUESTION_GUIDE_MESSAGE = [
  '質問を受け付けました。',
  'タイムラインにも共有しました。',
  '',
  '解決した場合は、この質問内で `/resolve` を使用してください。',
  '質問タイトルに `[解決済]` が付き、タイムライン上の質問カードも解決済みに更新されます。',
  '',
  '再び確認が必要になった場合は、同じ質問内で `/unresolve` を使用すると未解決に戻せます。'
].join('\n');

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

async function buildTimelinePayload(post, { config, forumType, logger }) {
  const videoPrepared = await prepareVideoThumbnail(post, logger);
  const attachmentPrepared = await prepareAttachmentRelay(videoPrepared.post, config, logger);

  return {
    payload: buildTimelineMessage({
      post: attachmentPrepared.post,
      config,
      forumType
    }),
    cleanup: async () => {
      await attachmentPrepared.cleanup();
      await videoPrepared.cleanup();
    }
  };
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

async function relayForumThread(thread, { config, db, logger }) {
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
    }

    const timelineChannel = await thread.guild.channels.fetch(config.timelineChannelId);

    if (!timelineChannel || !timelineChannel.isTextBased()) {
      throw new Error('Timeline channel was not found or is not text-based');
    }

    const { payload, cleanup } = await buildTimelinePayload(post, {
      config,
      forumType,
      logger
    });

    let sentMessage;
    try {
      sentMessage = await sendRelayMessage(timelineChannel, payload, logger, {
        sourceMessageId: post.messageId,
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
      starterMessageId: post.messageId,
      timelineMessageId: sentMessage.id,
      authorId: post.author?.id || null
    });

    if (forumType === 'question') {
      await applyQuestionStatusTag(thread, 'open', { config, logger });

      const questionRecord = db.questions.getQuestionThread(thread.id);
      if (!questionRecord?.guideMessageId) {
        await thread.send(QUESTION_GUIDE_MESSAGE)
          .then((guideMessage) => {
            db.questions.setGuideMessage(thread.id, guideMessage.id);
            logger.info('Question acceptance guide posted', {
              threadId: thread.id,
              guideMessageId: guideMessage.id
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

    logger.info('Forum thread relayed', {
      threadId: thread.id,
      threadName: thread.name,
      parentId: String(thread.parentId || ''),
      starterMessageId: post.messageId,
      timelineMessageId: sentMessage.id,
      forumType
    });
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
        const sendPayload = {
          ...payload,
          ...(reply ? { reply } : {})
        };
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

        logger.info('Tweet message relayed', {
          messageId: message.id,
          channelId: message.channelId,
          referencedSourceMessageId: message.reference?.messageId || null,
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
  const desiredTargets = getTweetDestinationTargets(post, config);
  const desiredTargetByChannelId = new Map(
    desiredTargets.map((target) => [String(target.destinationChannelId), target])
  );
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

    for (const target of desiredTargetByChannelId.values()) {
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

async function updateQuestionTimelineCard(thread, { config, db, logger }) {
  const relay = db.relays.getThreadRelay(thread.id);

  if (!relay?.timelineMessageId) {
    logger.warn('Question timeline card update skipped because relay record was not found', {
      threadId: thread.id
    });
    return;
  }

  const post = await extractFirstPost(thread, config, logger);
  if (!post) {
    logger.warn('Question timeline card update skipped because starter message was unavailable', {
      threadId: thread.id
    });
    return;
  }

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

  const { payload, cleanup } = await buildTimelinePayload(post, {
    config,
    forumType: 'question',
    logger
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
    resolved: post.isResolved
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

async function relayGlobalHashtagMessage(message, { config, db, logger }) {
  if (!message.inGuild?.() || message.author?.bot) {
    return;
  }

  const sourceChannelId = String(message.channelId || '');
  const globalHashtagRoutes = config.globalHashtagRoutes || {};
  const vcListenOnlyChannelIds = config.vcListenOnlyChannelIds || [];
  const isVcListenOnly = vcListenOnlyChannelIds.includes(sourceChannelId);
  const content = String(message.content || '');

  const globalMatches = detectGlobalHashtagMatches(content, globalHashtagRoutes);

  let hasAnyRoute = globalMatches.size > 0;

  if (!hasAnyRoute && !isVcListenOnly) {
    return;
  }

  if (isVcListenOnly) {
    const lines = content.split(/\r?\n/);
    const hasAnyDoublePrefix = lines.some((line) => line.trim().startsWith('##'));
    if (!hasAnyDoublePrefix) {
      return;
    }
  }

  logger.info('Global hashtag relay evaluation started', {
    sourceMessageId: message.id,
    sourceChannelId,
    isVcListenOnly,
    globalMatchCount: globalMatches.size,
    globalMatchKeys: Array.from(globalMatches.keys())
  });

  const extractedPost = await extractPlainMessagePost(message, config, logger);
  const post = await enrichPostWithMusicLink(extractedPost, { db, logger });

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
    if (route.channelId) {
      const added = addDestination(route.channelId, `global_hashtag:${routeKey}`);
      logger.info('Global hashtag route matched', {
        sourceMessageId: message.id,
        routeKey,
        destinationChannelId: route.channelId,
        willRelay: added
      });
    }

    if (route.alsoTimeline && config.timelineChannelId) {
      addDestination(config.timelineChannelId, `global_hashtag:${routeKey}:timeline`);
    }
  }

  if (isVcListenOnly) {
    for (const routeKey of post.matchedBotHashtagRoutes || []) {
      const route = config.botHashtagRoutes?.[routeKey];
      if (route?.channelId) {
        const added = addDestination(route.channelId, `vc_hashtag:${routeKey}`);
        logger.info('VC listen-only hashtag route matched', {
          sourceMessageId: message.id,
          routeKey,
          destinationChannelId: route.channelId,
          willRelay: added
        });
      }
    }

    if (config.timelineChannelId && (post.matchedBotHashtagRoutes?.length || globalMatches.size)) {
      addDestination(config.timelineChannelId, 'vc_hashtag:timeline');
    }
  }

  if (!destinationTargets.length) {
    logger.info('Global hashtag relay skipped: no valid destinations', {
      sourceMessageId: message.id,
      sourceChannelId
    });
    return;
  }

  const { payload, cleanup } = await buildTimelinePayload(post, {
    config,
    forumType: 'tweet',
    logger
  });

  try {
    for (const target of destinationTargets) {
      const existingRelay = db.relays.getMessageRelayTarget(message.id, target.destinationChannelId);
      if (existingRelay?.relayedMessageId) {
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

        logger.info('Global hashtag relay sent', {
          sourceMessageId: message.id,
          sourceChannelId,
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
}

module.exports = {
  relayForumThread,
  relayTweetMessage,
  updateTweetTimelineCard,
  updateQuestionTimelineCard,
  relayGlobalHashtagMessage
};
