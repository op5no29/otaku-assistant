const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileBuilder,
  MessageFlags,
  TextDisplayBuilder
} = require('discord.js');

function percent(numerator, denominator) {
  if (!denominator) return 100;
  return Math.round((Number(numerator || 0) / Number(denominator)) * 1000) / 10;
}

function buildProgressPayload(job, { stateLabel = '過去ログを復元しています' } = {}) {
  const completed = Number(job.completedItemCount || 0);
  const failed = Number(job.failedItemCount || 0);
  const skipped = Number(job.skippedItemCount || 0);
  const handled = completed + failed + skipped;
  const total = Number(job.totalItemCount || 0);
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${stateLabel}`),
      new TextDisplayBuilder().setContent([
        `進捗: ${handled} / ${total}（${percent(handled, total)}%）`,
        `復元済み: ${completed}件`,
        `失敗: ${failed}件`,
        `画像: ${Number(job.imageRestoredCount || 0)}件`,
        `動画: ${Number(job.videoRestoredCount || 0)}件`,
        `ファイル: ${Number(job.fileRestoredCount || 0)}件`,
        `返信関係: ${Number(job.replyRestoredCount || 0)}件`,
        '',
        '復元中は、このスレッドへの通常の投稿を一時的に停止しています。'
      ].join('\n'))
    );
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
  };
}

function parseQuality(job) {
  try {
    return JSON.parse(job.qualityJson || '{}');
  } catch {
    return {};
  }
}

function buildCompletionPayload(job, logBuffer) {
  const quality = parseQuality(job);
  const adminTest = job.mode === 'admin_test';
  const mentionUserId = adminTest
    ? String(job.initiatorUserId || job.ownerUserId)
    : String(job.ownerUserId);
  const total = Number(job.totalItemCount || 0);
  const completed = Number(job.completedItemCount || 0);
  const failed = Number(job.failedItemCount || 0);
  const messageRate = quality.messageRate ?? percent(completed, total);
  const textRate = quality.textRate ?? 100;
  const mediaRate = quality.mediaRate ?? 100;
  const replyRate = quality.replyRate ?? 100;
  const identityRate = quality.identityRate ?? 100;
  const overallRate = quality.overallRate ?? Math.round((messageRate * 0.35 + textRate * 0.2 + mediaRate * 0.2 + replyRate * 0.1 + identityRate * 0.15) * 10) / 10;
  const durationMs = job.startedAt && job.completedAt
    ? Math.max(0, new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
    : 0;
  const durationMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const logFileName = `timeline-restoration-${job.jobId}.md`;
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        adminTest
          ? `<@${mentionUserId}> テスト復元が完了しました。`
          : `<@${mentionUserId}> 過去ログの復元作業が完了しました。`,
        '',
        adminTest ? `テスト対象の履歴所有者ID: \`${job.historicalOwnerUserId || job.ownerUserId}\`` : null,
        adminTest ? `テスト開始者ID: \`${job.initiatorUserId}\`` : null,
        adminTest ? `テスト復元先: <#${job.destinationThreadId}>` : null,
        adminTest ? '' : null,
        `メッセージ復元率: ${messageRate}%`,
        `本文復元率: ${textRate}%`,
        `メディア復元率: ${mediaRate}%`,
        `返信復元率: ${replyRate}%`,
        `投稿者情報の復元率: ${identityRate}%`,
        `投稿者情報フォールバック: ${Number(quality.identityFallbackCount || 0)}件`,
        `総合復元率: ${overallRate}%`,
        `対象メッセージ: ${total}件`,
        `復元成功: ${completed}件`,
        `復元できなかったメッセージ: ${failed}件`,
        `重複スキップ: ${Number(job.skippedItemCount || 0)}件`,
        `画像: ${Number(job.imageRestoredCount || 0)}件`,
        `動画: ${Number(job.videoRestoredCount || 0)}件`,
        `ファイル: ${Number(job.fileRestoredCount || 0)}件`,
        `返信関係: ${Number(job.replyRestoredCount || 0)}件`,
        `処理時間: ${durationMinutes}分`,
        '',
        '完全に取得できなかった内容は、添付した復元ログで確認できます。'
      ].filter((line) => line !== null).join('\n'))
    );
  if (logBuffer) {
    container.addFileComponents(new FileBuilder().setURL(`attachment://${logFileName}`));
  }
  container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`timeline_restore:dismiss:${job.jobId}`)
          .setLabel('×')
          .setStyle(ButtonStyle.Secondary)
      )
    );
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files: logBuffer ? [{ attachment: logBuffer, name: logFileName }] : undefined,
    allowedMentions: {
      parse: [],
      users: [mentionUserId],
      roles: [],
      repliedUser: false
    }
  };
}

function buildRestorationLog(job, items, snapshotsById) {
  const quality = parseQuality(job);
  const identitySourceCounts = quality.identitySourceCounts || {};
  const lines = [
    '---',
    `job_id: ${job.jobId}`,
    `guild_id: "${job.guildId}"`,
    `mode: "${job.mode || 'normal'}"`,
    `owner_user_id: "${job.ownerUserId}"`,
    `historical_owner_user_id: "${job.historicalOwnerUserId || job.ownerUserId}"`,
    `initiator_user_id: "${job.initiatorUserId || ''}"`,
    `destination_thread_id: "${job.destinationThreadId}"`,
    `destination_test_thread_id: "${job.destinationTestThreadId || ''}"`,
    `explicit_source_thread_id: "${job.explicitSourceThreadId || ''}"`,
    `source_selection_reason: "${job.sourceSelectionReason || ''}"`,
    `status: "${job.status}"`,
    `started_at: "${job.startedAt || ''}"`,
    `completed_at: "${job.completedAt || ''}"`,
    '---',
    '',
    `# Timeline restoration ${job.jobId}`,
    '',
    `Source threads: ${JSON.parse(job.sourceThreadIdsJson || '[]').map((id) => `\`${id}\``).join(', ') || 'none'}`,
    `Source selection evidence: ${job.sourceSelectionEvidenceJson || 'none'}`,
    '',
    '## Result counts',
    '',
    `- Total messages: ${Number(job.totalItemCount || items.length)}`,
    `- Restored messages: ${Number(job.completedItemCount || 0)}`,
    `- Failed messages: ${Number(job.failedItemCount || 0)}`,
    `- Skipped duplicates: ${Number(job.skippedItemCount || 0)}`,
    `- Images: ${Number(job.imageRestoredCount || 0)}`,
    `- Videos: ${Number(job.videoRestoredCount || 0)}`,
    `- Files: ${Number(job.fileRestoredCount || 0)}`,
    `- Replies: ${Number(job.replyRestoredCount || 0)}`,
    `- Unavailable media: ${Number(job.unavailableMediaCount || 0)}`,
    `- Identity fallbacks: ${Number(quality.identityFallbackCount || 0)}`,
    `- Identity sources: ${Object.entries(identitySourceCounts).map(([source, count]) => `${source}=${count}`).join(', ') || 'none'}`,
    '',
    '## Quality',
    '',
    `- Message restoration: ${quality.messageRate ?? 'n/a'}%`,
    `- Text restoration: ${quality.textRate ?? 'n/a'}%`,
    `- Media restoration: ${quality.mediaRate ?? 'n/a'}%`,
    `- Reply restoration: ${quality.replyRate ?? 'n/a'}%`,
    `- Identity restoration: ${quality.identityRate ?? 'n/a'}%`,
    `- Overall: ${quality.overallRate ?? 'n/a'}%`,
    '',
    '## Items',
    ''
  ];
  for (const item of items) {
    const snapshot = snapshotsById.get(Number(item.snapshotId));
    lines.push(
      `### ${item.sequenceIndex}. ${item.sourceMessageId}`,
      '',
      `- Source thread: \`${item.sourceThreadId}\``,
      `- Destination message: ${item.destinationMessageId ? `\`${item.destinationMessageId}\`` : 'none'}`,
      `- Historical author: ${item.authorNameUsed || snapshot?.authorDisplayNameSnapshot || 'unknown'} (${item.authorUserId || snapshot?.authorUserId || 'unknown'})`,
      `- Identity source: ${snapshot?.authorAvatarSource || 'unknown'}`,
      `- Status: ${item.status}`,
      `- Attempts: ${item.attempts}`,
      `- Text: ${item.textStatus || 'unknown'}`,
      `- Media: ${item.mediaStatus || 'unknown'}`,
      `- Reply: ${item.replyStatus || 'not_a_reply'}`,
      `- Failure: ${item.lastErrorCode || 'none'}`,
      ''
    );
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

module.exports = {
  percent,
  buildProgressPayload,
  buildCompletionPayload,
  buildRestorationLog
};
