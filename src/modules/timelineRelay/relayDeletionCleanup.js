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

async function cleanupRelayedBotMessageState(client, {
  messageId,
  guildId = null,
  channelId = null,
  reason = 'message_delete',
  logNoState = false
}) {
  if (!client?.db || !messageId) {
    return {
      cleaned: false,
      reason: 'missing_client_or_message_id'
    };
  }

  const logger = client.logger;
  const deletableRecord = client.db.deletableMessages.get(messageId);
  const relayTargets = client.db.relays.listMessageRelayTargetsByRelayedMessageId(messageId);
  const legacyRelays = client.db.relays.listMessageRelaysByTimelineMessageId(messageId);
  const destinationStates = client.db.timelineDestination.listByRelayedMessageId(messageId);
  const metadata = parseMetadataJson(deletableRecord?.metadataJson);
  const hasState = Boolean(
    deletableRecord ||
    relayTargets.length ||
    legacyRelays.length ||
    destinationStates.length
  );

  if (!hasState) {
    if (logNoState) {
      logger.info('relayed bot message DB cleanup skipped no state', {
        messageId,
        guildId,
        channelId,
        reason
      });
    }
    return {
      cleaned: false,
      reason: 'no_state'
    };
  }

  logger.info('relayed bot message deletion detected', {
    messageId,
    guildId,
    channelId,
    reason,
    hasDeletableRecord: Boolean(deletableRecord),
    relayTargetCount: relayTargets.length,
    relayedMessageCount: legacyRelays.length,
    timelineDestinationCount: destinationStates.length,
    purpose: deletableRecord?.purpose || null
  });
  logger.info('relayed bot message DB cleanup started', {
    messageId,
    guildId,
    channelId,
    reason
  });

  if (deletableRecord && isPosthocPurpose(deletableRecord.purpose) && reason === 'message_delete') {
    logger.info('posthoc relay rejection skipped manual admin deletion', {
      messageId,
      guildId: deletableRecord.guildId || guildId || null,
      channelId: deletableRecord.channelId || channelId || null,
      ownerUserId: deletableRecord.ownerUserId || null,
      purpose: deletableRecord.purpose || null
    });
  }

  let deletedSpecificRelayTargetCount = 0;
  if (metadata?.sourceMessageId && (metadata.destinationChannelId || deletableRecord?.channelId)) {
    deletedSpecificRelayTargetCount = client.db.relays.deleteMessageRelayTarget(
      metadata.sourceMessageId,
      metadata.destinationChannelId || deletableRecord.channelId
    );
  }

  const deletedRelayTargetCount = client.db.relays.deleteMessageRelayTargetsByRelayedMessageId(messageId);
  if (deletedSpecificRelayTargetCount || deletedRelayTargetCount) {
    logger.info('relayed_message_targets deleted for missing message', {
      messageId,
      deletedCount: deletedSpecificRelayTargetCount + deletedRelayTargetCount,
      deletedSpecificRelayTargetCount,
      deletedRelayTargetCount
    });
  }

  const deletedLegacyRelayCount = client.db.relays.deleteMessageRelaysByTimelineMessageId(messageId);
  if (deletedLegacyRelayCount) {
    logger.info('relayed_messages deleted for missing message', {
      messageId,
      deletedCount: deletedLegacyRelayCount
    });
  }

  const deletedTimelineDestinationCount = client.db.timelineDestination.deleteByRelayedMessageId(messageId);
  if (deletedTimelineDestinationCount) {
    logger.info('timeline_destination_state cleared for missing message', {
      messageId,
      deletedCount: deletedTimelineDestinationCount
    });
  }

  let deletedDeletableCount = 0;
  if (deletableRecord) {
    deletedDeletableCount = client.db.deletableMessages.delete(messageId);
    logger.info('bot_deletable_message deleted for missing message', {
      messageId,
      deletedCount: deletedDeletableCount,
      purpose: deletableRecord.purpose || null
    });
  }

  logger.info('relayed bot message DB cleanup completed', {
    messageId,
    guildId,
    channelId,
    reason,
    deletedSpecificRelayTargetCount,
    deletedRelayTargetCount,
    deletedLegacyRelayCount,
    deletedTimelineDestinationCount,
    deletedDeletableCount
  });

  return {
    cleaned: true,
    deletedSpecificRelayTargetCount,
    deletedRelayTargetCount,
    deletedLegacyRelayCount,
    deletedTimelineDestinationCount,
    deletedDeletableCount
  };
}

module.exports = {
  cleanupRelayedBotMessageState
};
