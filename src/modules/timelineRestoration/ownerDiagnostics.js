const { extractTimelineComponentData } = require('./componentsParser');

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function tableExists(sqlite, tableName) {
  return Boolean(sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName));
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '')).filter(Boolean))];
}

function diagnoseTimelineOwner(sqlite, { guildId, userId, sourceThreadId = null }) {
  const params = { guildId: String(guildId), userId: String(userId) };
  const threadFilter = sourceThreadId ? 'AND s.source_thread_id = @sourceThreadId' : '';
  if (sourceThreadId) params.sourceThreadId = String(sourceThreadId);
  const candidates = sqlite.prepare(`
    SELECT
      s.source_thread_id AS sourceThreadId,
      MIN(s.source_forum_id) AS sourceForumId,
      COUNT(*) AS totalSnapshots,
      SUM(CASE WHEN s.author_user_id = @userId THEN 1 ELSE 0 END) AS authoredByTarget,
      MIN(s.source_message_id) AS earliestSourceMessageId,
      MIN(s.source_created_at) AS earliestCreatedAt,
      t.owner_user_id AS storedOwnerUserId,
      t.status,
      t.deletion_reason AS deletionReason,
      t.starter_message_id AS bindingStarterMessageId,
      rt.starter_message_id AS relayStarterMessageId,
      rt.author_id AS relayedThreadAuthorId,
      rt.timeline_message_id AS relayedThreadTimelineMessageId
    FROM timeline_restore_snapshots s
    LEFT JOIN timeline_user_threads t
      ON t.guild_id = s.guild_id AND t.thread_id = s.source_thread_id
    LEFT JOIN relayed_threads rt ON rt.thread_id = s.source_thread_id
    WHERE s.guild_id = @guildId
      AND EXISTS (
        SELECT 1 FROM timeline_restore_snapshots own
        WHERE own.guild_id = s.guild_id
          AND own.source_thread_id = s.source_thread_id
          AND own.author_user_id = @userId
      )
      ${threadFilter}
    GROUP BY s.source_thread_id
    ORDER BY authoredByTarget DESC, totalSnapshots DESC, s.source_thread_id ASC
  `).all(params);

  const hasIdentityHistory = tableExists(sqlite, 'guild_member_identity_history');
  const identityRows = hasIdentityHistory
    ? sqlite.prepare(`
        SELECT display_name AS displayName, username, global_name AS globalName,
          nickname, avatar_url AS avatarUrl, observed_at AS observedAt
        FROM guild_member_identity_history
        WHERE guild_id = ? AND user_id = ?
        ORDER BY datetime(observed_at) ASC
      `).all(params.guildId, params.userId)
    : [];
  const targetNames = new Set(identityRows.flatMap((row) => [row.displayName, row.username, row.globalName, row.nickname]).filter(Boolean));
  const targetAvatarUrls = new Set(identityRows.map((row) => row.avatarUrl).filter(Boolean));

  const results = candidates.map((candidate) => {
    const starterMessageId = candidate.bindingStarterMessageId || candidate.relayStarterMessageId || candidate.sourceThreadId;
    const firstSnapshot = sqlite.prepare(`
      SELECT source_message_id AS sourceMessageId, author_user_id AS authorUserId,
        source_created_at AS sourceCreatedAt
      FROM timeline_restore_snapshots
      WHERE guild_id = ? AND source_thread_id = ?
      ORDER BY datetime(source_created_at) ASC, sequence_snowflake ASC, snapshot_id ASC
      LIMIT 1
    `).get(params.guildId, candidate.sourceThreadId) || null;
    const starterSnapshot = starterMessageId
      ? sqlite.prepare(`
          SELECT source_message_id AS sourceMessageId, author_user_id AS authorUserId
          FROM timeline_restore_snapshots
          WHERE guild_id = ? AND source_thread_id = ? AND source_message_id = ?
          LIMIT 1
        `).get(params.guildId, candidate.sourceThreadId, starterMessageId) || null
      : null;
    const archivedStarter = tableExists(sqlite, 'archived_messages') && starterMessageId
      ? sqlite.prepare('SELECT author_id AS authorUserId FROM archived_messages WHERE message_id = ? LIMIT 1').get(starterMessageId) || null
      : null;
    const relayStarterTarget = tableExists(sqlite, 'relayed_message_targets') && starterMessageId
      ? sqlite.prepare(`
          SELECT author_id AS authorUserId, relayed_message_id AS timelineMessageId
          FROM relayed_message_targets
          WHERE source_message_id = ?
          ORDER BY datetime(created_at) ASC LIMIT 1
        `).get(starterMessageId) || null
      : null;
    const mappings = tableExists(sqlite, 'relayed_message_targets')
      ? sqlite.prepare(`
          SELECT source_message_id AS sourceMessageId, author_id AS authorUserId,
            relayed_message_id AS timelineMessageId
          FROM relayed_message_targets
          WHERE thread_id = ? ORDER BY source_message_id ASC
        `).all(candidate.sourceThreadId)
      : [];
    const cardEvidence = sqlite.prepare(`
      SELECT timeline_message_id AS timelineMessageId, timeline_card_payload_json AS payloadJson,
        timeline_card_author_avatar_url AS avatarUrl, author_user_id AS authorUserId
      FROM timeline_restore_snapshots
      WHERE guild_id = ? AND source_thread_id = ? AND timeline_message_id IS NOT NULL
      ORDER BY datetime(source_created_at) ASC
    `).all(params.guildId, candidate.sourceThreadId).map((row) => {
      const parsed = parseJson(row.payloadJson, {});
      const component = extractTimelineComponentData(parsed || {});
      return {
        timelineMessageId: row.timelineMessageId,
        snapshotAuthorUserId: row.authorUserId || null,
        parsedAuthorName: component.authorName || null,
        parsedAuthorMatchesTargetIdentity: component.authorName ? targetNames.has(component.authorName) : false,
        avatarPresent: Boolean(component.authorAvatarUrl || row.avatarUrl),
        avatarMatchesTargetIdentity: targetAvatarUrls.has(component.authorAvatarUrl || row.avatarUrl)
      };
    });
    const strongOwnerIds = unique([
      candidate.relayedThreadAuthorId,
      starterSnapshot?.authorUserId,
      archivedStarter?.authorUserId,
      relayStarterTarget?.authorUserId
    ]);
    const strongTargetEvidence = strongOwnerIds.includes(params.userId);
    const strongConflicts = strongOwnerIds.filter((id) => id !== params.userId);
    const authoredRatio = Number(candidate.totalSnapshots)
      ? Number(candidate.authoredByTarget) / Number(candidate.totalSnapshots)
      : 0;
    const confidence = strongTargetEvidence && !strongConflicts.length
      ? 'high'
      : strongConflicts.length
        ? 'conflicting'
        : Number(candidate.authoredByTarget) >= 3
          ? 'participant_only'
          : 'weak';
    const suggestedAction = confidence === 'high'
      ? 'owner evidence supports a manually reviewed repair; do not apply automatically'
      : confidence === 'participant_only'
        ? 'eligible for guild-owner admin_test after review; insufficient for owner reassignment'
        : confidence === 'conflicting'
          ? 'inspect starter and relayed-thread evidence before any test or repair'
          : 'insufficient evidence';
    return {
      sourceThreadId: candidate.sourceThreadId,
      sourceForumId: candidate.sourceForumId,
      currentlyStoredOwnerId: candidate.storedOwnerUserId || null,
      status: candidate.status || 'mapping_missing',
      deletionReason: candidate.deletionReason || null,
      totalSnapshots: Number(candidate.totalSnapshots || 0),
      snapshotsAuthoredByTarget: Number(candidate.authoredByTarget || 0),
      authoredRatio: Math.round(authoredRatio * 1000) / 1000,
      firstSnapshotAuthorId: firstSnapshot?.authorUserId || null,
      earliestSourceMessageId: firstSnapshot?.sourceMessageId || candidate.earliestSourceMessageId || null,
      starterMessageId: starterMessageId || null,
      starterAuthorEvidence: {
        snapshot: starterSnapshot?.authorUserId || null,
        archivedMessage: archivedStarter?.authorUserId || null,
        relayedMessageTarget: relayStarterTarget?.authorUserId || null
      },
      timelineCardMessageIds: unique(cardEvidence.map((row) => row.timelineMessageId)),
      parsedCardAuthorEvidence: cardEvidence.slice(0, 20),
      avatarEvidence: {
        targetHistoricalAvatarCount: targetAvatarUrls.size,
        matchingCardAvatarCount: cardEvidence.filter((row) => row.avatarMatchesTargetIdentity).length,
        cardAvatarPresentCount: cardEvidence.filter((row) => row.avatarPresent).length
      },
      relayedThreadsEvidence: {
        authorUserId: candidate.relayedThreadAuthorId || null,
        starterMessageId: candidate.relayStarterMessageId || null,
        timelineMessageId: candidate.relayedThreadTimelineMessageId || null
      },
      relayedMessagesEvidence: {
        rowCount: mappings.length,
        targetAuthoredRows: mappings.filter((row) => String(row.authorUserId || '') === params.userId).length,
        starterAuthorUserId: relayStarterTarget?.authorUserId || null
      },
      membershipIdentityEvidence: {
        historyRows: identityRows.length,
        knownNames: [...targetNames].slice(0, 20),
        avatarHistoryRows: targetAvatarUrls.size
      },
      evidenceConflicts: strongConflicts,
      strongOwnerEvidenceIds: strongOwnerIds,
      confidence,
      suggestedAction
    };
  });

  return {
    guildId: params.guildId,
    userId: params.userId,
    readOnly: true,
    candidateThreadCount: results.length,
    authoredSnapshotCount: results.reduce((sum, row) => sum + row.snapshotsAuthoredByTarget, 0),
    legacyMissingCandidateCount: results.filter((row) => row.status === 'legacy_missing').length,
    candidates: results
  };
}

function evaluateExplicitSourceThread(sqlite, { guildId, userId, sourceThreadId, allowedForumIds }) {
  const report = diagnoseTimelineOwner(sqlite, { guildId, userId, sourceThreadId });
  const candidate = report.candidates[0] || null;
  if (!candidate) return { accepted: false, code: 'source_thread_no_target_history', report };
  if (!['deleted', 'legacy_missing'].includes(String(candidate.status || ''))) {
    return { accepted: false, code: 'source_thread_not_missing', report };
  }
  if (!allowedForumIds.map(String).includes(String(candidate.sourceForumId || ''))) {
    return { accepted: false, code: 'source_thread_wrong_forum', report };
  }
  const strongTarget = candidate.strongOwnerEvidenceIds.includes(String(userId));
  const strongConflict = candidate.evidenceConflicts.length > 0 && !strongTarget;
  const meaningfulParticipation = candidate.snapshotsAuthoredByTarget >= 3
    || candidate.authoredRatio >= 0.25;
  if (strongConflict) return { accepted: false, code: 'source_thread_owner_evidence_conflict', report };
  if (!strongTarget && !meaningfulParticipation) {
    return { accepted: false, code: 'source_thread_target_evidence_weak', report };
  }
  return {
    accepted: true,
    code: strongTarget ? 'strong_owner_evidence' : 'meaningful_participant_evidence',
    evidence: {
      sourceThreadId: candidate.sourceThreadId,
      sourceForumId: candidate.sourceForumId,
      storedOwnerUserId: candidate.currentlyStoredOwnerId,
      snapshotsAuthoredByTarget: candidate.snapshotsAuthoredByTarget,
      totalSnapshots: candidate.totalSnapshots,
      authoredRatio: candidate.authoredRatio,
      strongOwnerEvidenceIds: candidate.strongOwnerEvidenceIds,
      confidence: candidate.confidence
    },
    report
  };
}

module.exports = { diagnoseTimelineOwner, evaluateExplicitSourceThread };
