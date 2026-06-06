const DELETE_EMOJI = '❌';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24;
const WRONG_USER_MESSAGE = 'このリアクションは、この操作をした本人だけが使えます。';
const POSTHOC_WRONG_USER_MESSAGE = 'このリアクションは、元の投稿者だけが使えます。';
const VC_SUMMARY_WRONG_USER_MESSAGE = 'このリアクションは、コマンドを実行した人だけが使えます。';
const POSTHOC_PURPOSE = 'posthoc_route_relay';
const VC_SUMMARY_PURPOSE = 'vc_summary_command';
const { cleanupRelayedBotMessageState } = require('../timelineRelay/relayDeletionCleanup');

function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isPosthocPurpose(purpose) {
  return String(purpose || '').startsWith('posthoc_');
}

function isVcSummaryPurpose(purpose) {
  return String(purpose || '') === VC_SUMMARY_PURPOSE;
}

async function registerDeletableMessage(message, ownerUserId, purpose, ttlMs = DEFAULT_TTL_MS, metadata = null) {
  const client = message.client;
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  client.db.deletableMessages.upsert({
    guildId: message.guildId || '',
    channelId: message.channelId,
    messageId: message.id,
    ownerUserId,
    purpose,
    metadataJson,
    expiresAt
  });
  await message.react(DELETE_EMOJI).catch(() => null);
}

async function registerVcSummaryDeletableMessage(message, {
  commandUserId,
  sessionId,
  mode,
  categoryId,
  lookbackHours
}) {
  await registerDeletableMessage(message, commandUserId, VC_SUMMARY_PURPOSE, null, {
    commandUserId,
    sessionId,
    mode,
    categoryId,
    lookbackHours,
    createdAt: new Date().toISOString()
  });
  message.client.logger.info('vc summary delete registered', {
    messageId: message.id,
    channelId: message.channelId,
    commandUserId,
    sessionId,
    mode,
    categoryId,
    lookbackHours
  });
}

async function registerPosthocDeletableCard(message, {
  ownerUserId,
  sourceMessageId,
  sourceChannelId,
  destinationChannelId,
  taggerUserId,
  relayKind,
  displayTags
}) {
  await registerDeletableMessage(message, ownerUserId, POSTHOC_PURPOSE, null, {
    sourceMessageId,
    sourceChannelId,
    destinationChannelId,
    taggerUserId,
    relayKind,
    displayTags: Array.isArray(displayTags) ? displayTags : []
  });
  message.client.logger.info('posthoc deletable card registered', {
    messageId: message.id,
    channelId: message.channelId,
    ownerUserId,
    sourceMessageId,
    destinationChannelId,
    taggerUserId,
    relayKind,
    displayTags: Array.isArray(displayTags) ? displayTags : []
  });
}

function recordPosthocRelayRejection(message, record, user) {
  const metadata = parseMetadataJson(record.metadataJson);
  const sourceMessageId = metadata?.sourceMessageId;

  if (!sourceMessageId) {
    message.client.logger.warn('posthoc relay rejection record skipped missing source', {
      messageId: message.id,
      channelId: message.channelId,
      ownerUserId: record.ownerUserId,
      reactingUserId: user.id,
      metadataJson: record.metadataJson || null
    });
    return null;
  }

  const result = message.client.db.posthocRelayRejections.record({
    guildId: record.guildId || message.guildId || '',
    sourceMessageId,
    sourceChannelId: metadata?.sourceChannelId || null,
    originalAuthorId: record.ownerUserId || null,
    rejectedByUserId: user.id,
    destinationChannelId: metadata?.destinationChannelId || record.channelId || null,
    relayKind: metadata?.relayKind || record.purpose || null,
    displayTagsJson: JSON.stringify(Array.isArray(metadata?.displayTags) ? metadata.displayTags : []),
    rejectedRelayedMessageId: record.messageId || message.id
  });

  message.client.logger.info('posthoc relay rejection recorded', {
    messageId: message.id,
    channelId: message.channelId,
    ownerUserId: record.ownerUserId,
    reactingUserId: user.id,
    sourceMessageId,
    destinationChannelId: metadata?.destinationChannelId || record.channelId || null,
    relayKind: metadata?.relayKind || null,
    displayTags: Array.isArray(metadata?.displayTags) ? metadata.displayTags : []
  });
  message.client.logger.info('posthoc relay rejection count updated', {
    guildId: result?.guildId || record.guildId || message.guildId || '',
    sourceMessageId,
    rejectionCount: Number(result?.rejectionCount || 0),
    lastRejectedAt: result?.lastRejectedAt || null
  });

  return result;
}

async function handleDeletableMessageReaction(reaction, user) {
  if (user?.bot) {
    return false;
  }

  const fullReaction = reaction.partial ? await reaction.fetch().catch(() => reaction) : reaction;
  const message = fullReaction.message?.partial
    ? await fullReaction.message.fetch().catch(() => fullReaction.message)
    : fullReaction.message;
  if (!message?.id) {
    return false;
  }
  if (String(fullReaction.emoji?.name || '') !== DELETE_EMOJI) {
    return false;
  }

  const record = message.client.db.deletableMessages.get(message.id);
  if (!record) {
    return false;
  }

  const guild = message.guild || null;
  const member = guild ? (guild.members.cache.get(user.id) || await guild.members.fetch(user.id).catch(() => null)) : null;
  const isAdminLike = Boolean(member?.permissions?.has?.('Administrator') || member?.permissions?.has?.('ManageMessages'));
  const ownerMatched = String(record.ownerUserId) === String(user.id);
  const posthocPurpose = isPosthocPurpose(record.purpose);
  const vcSummaryPurpose = isVcSummaryPurpose(record.purpose);
  const ownerOnlyPurpose = String(record.purpose || '').startsWith('anime_') || posthocPurpose || vcSummaryPurpose;
  const allowedByAdmin = !ownerOnlyPurpose && isAdminLike;

  if (!ownerMatched && !allowedByAdmin) {
    const wrongUserLogName = vcSummaryPurpose
      ? 'vc summary delete rejected wrong user'
      : posthocPurpose
      ? 'posthoc delete reaction rejected wrong user'
      : 'deletable reaction rejected wrong user';
    message.client.logger.info(wrongUserLogName, {
      messageId: message.id,
      channelId: message.channelId,
      ownerUserId: record.ownerUserId,
      reactingUserId: user.id,
      purpose: record.purpose || null,
      ownerOnlyPurpose
    });

    const noticeMessage = vcSummaryPurpose
      ? VC_SUMMARY_WRONG_USER_MESSAGE
      : posthocPurpose
        ? POSTHOC_WRONG_USER_MESSAGE
        : WRONG_USER_MESSAGE;
    const notice = await message.channel?.send?.({
      content: `<@${user.id}> ${noticeMessage}`,
      allowedMentions: { users: vcSummaryPurpose ? [] : [user.id], parse: [] }
    }).catch(() => null);
    if (notice) {
      if (vcSummaryPurpose) {
        message.client.logger.info('vc summary delete warning sent', {
          messageId: message.id,
          channelId: message.channelId,
          ownerUserId: record.ownerUserId,
          reactingUserId: user.id,
          warningMessageId: notice.id
        });
      }
      setTimeout(() => {
        notice.delete().catch(() => null);
      }, vcSummaryPurpose ? 3_000 : 8_000).unref();
    }

    try {
      await fullReaction.users.remove(user.id);
      message.client.logger.info(vcSummaryPurpose
        ? 'vc summary delete wrong user reaction removed'
        : posthocPurpose
        ? 'posthoc delete reaction wrong user reaction removed'
        : 'deletable reaction wrong user reaction removed', {
        messageId: message.id,
        channelId: message.channelId,
        reactingUserId: user.id,
        purpose: record.purpose || null
      });
    } catch (error) {
      message.client.logger.warn(vcSummaryPurpose
        ? 'vc summary delete wrong user reaction remove failed'
        : posthocPurpose
        ? 'posthoc delete reaction wrong user reaction remove failed'
        : 'deletable reaction wrong user reaction remove failed', {
        messageId: message.id,
        channelId: message.channelId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        error: error.message
      });
    }
    if (posthocPurpose) {
      message.client.logger.info('posthoc relay rejection skipped non-owner deletion', {
        messageId: message.id,
        channelId: message.channelId,
        ownerUserId: record.ownerUserId,
        reactingUserId: user.id,
        purpose: record.purpose || null
      });
    }
    return true;
  }

  message.client.logger.info(vcSummaryPurpose
    ? 'vc summary delete accepted'
    : posthocPurpose
      ? 'posthoc delete reaction owner accepted'
      : 'deletable reaction owner accepted', {
    messageId: message.id,
    channelId: message.channelId,
    ownerUserId: record.ownerUserId,
    reactingUserId: user.id,
    purpose: record.purpose || null,
    acceptedBy: ownerMatched ? 'owner' : 'admin'
  });

  if (posthocPurpose) {
    message.client.posthocRelayReactionDeletes = message.client.posthocRelayReactionDeletes || new Set();
    message.client.posthocRelayReactionDeletes.add(message.id);
    try {
      await message.delete();
    } catch (error) {
      message.client.posthocRelayReactionDeletes.delete(message.id);
      message.client.logger.warn('posthoc delete reaction delete failed', {
        messageId: message.id,
        channelId: message.channelId,
        ownerUserId: record.ownerUserId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        error: error.message
      });
      return true;
    }

    try {
      recordPosthocRelayRejection(message, record, user);
      await cleanupRelayedBotMessageState(message.client, {
        messageId: message.id,
        guildId: message.guildId || record.guildId || null,
        channelId: message.channelId || record.channelId || null,
        reason: 'reaction_delete',
        logNoState: false
      });
    } catch (error) {
      message.client.logger.warn('posthoc delete reaction state cleanup failed', {
        messageId: message.id,
        channelId: message.channelId,
        ownerUserId: record.ownerUserId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        metadataJson: record.metadataJson || null,
        error: error.message
      });
    } finally {
      const timer = setTimeout(() => {
        message.client.posthocRelayReactionDeletes?.delete?.(message.id);
      }, 30_000);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    message.client.db.deletableMessages.delete(message.id);
    return true;
  }

  if (vcSummaryPurpose) {
    try {
      await message.delete();
      message.client.db.deletableMessages.delete(message.id);
    } catch (error) {
      message.client.logger.warn('vc summary delete cleanup failed', {
        messageId: message.id,
        channelId: message.channelId,
        ownerUserId: record.ownerUserId,
        reactingUserId: user.id,
        purpose: record.purpose || null,
        metadataJson: record.metadataJson || null,
        error: error.message
      });
    }
    return true;
  }

  try {
    await message.delete().catch(() => null);
  } finally {
    message.client.db.deletableMessages.delete(message.id);
  }
  return true;
}

module.exports = {
  DELETE_EMOJI,
  registerDeletableMessage,
  registerPosthocDeletableCard,
  registerVcSummaryDeletableMessage,
  handleDeletableMessageReaction
};
