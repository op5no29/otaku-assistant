const {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder
} = require('discord.js');

const INTRO_TEXT_MAX_LENGTH = 1200;
const COMPACT_INTRO_TEXT_MAX_LENGTH = 800;
const CUSTOM_EMOJI_PATTERN = /<a?:[A-Za-z0-9_~]+:\d+>/gu;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;

function collectProtectedRanges(text) {
  const ranges = [];
  for (const pattern of [CUSTOM_EMOJI_PATTERN, URL_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      ranges.push({
        start: match.index,
        end: match.index + match[0].length
      });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function avoidProtectedRangeCut(text, cutIndex) {
  const ranges = collectProtectedRanges(text);
  let safeIndex = cutIndex;
  for (const range of ranges) {
    if (range.start < safeIndex && safeIndex < range.end) {
      safeIndex = range.start;
    }
  }
  return safeIndex;
}

function segmentSafeSlice(text, maxLength) {
  const normalizedMax = Math.max(0, Number(maxLength || 0));
  if (!text || Array.from(text).length <= normalizedMax) {
    return text;
  }

  const budget = Math.max(0, normalizedMax - 1);
  if (budget <= 0) {
    return '…';
  }

  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    let endIndex = 0;
    let count = 0;
    for (const segment of segmenter.segment(text)) {
      if (count >= budget) {
        break;
      }
      endIndex = segment.index + segment.segment.length;
      count += 1;
    }
    return text.slice(0, avoidProtectedRangeCut(text, endIndex)).trimEnd();
  }

  const chars = Array.from(text);
  const approximateSlice = chars.slice(0, budget).join('');
  return text.slice(0, avoidProtectedRangeCut(text, approximateSlice.length)).trimEnd();
}

function truncateIntroText(text, maxLength) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return '';
  }
  if (Array.from(trimmed).length <= maxLength) {
    return trimmed;
  }

  const sliced = segmentSafeSlice(trimmed, maxLength);
  return `${sliced}…`;
}

function buildMemberSection(member, { compact = false } = {}) {
  const displayName = member.displayName || '不明なメンバー';
  const headingName = member.mention || (member.id ? `<@${member.id}>` : displayName);
  const introSummary = member.introSummary?.trim()
    ? truncateIntroText(member.introSummary, compact ? COMPACT_INTRO_TEXT_MAX_LENGTH : INTRO_TEXT_MAX_LENGTH)
    : '自己紹介がまだありません';
  const avatarUrl = member.avatarUrl || null;

  if (compact) {
    return [
      new TextDisplayBuilder().setContent(`### ${headingName}\n${introSummary}`)
    ];
  }

  if (!avatarUrl) {
    return [
      new TextDisplayBuilder().setContent(`### ${headingName}`),
      new TextDisplayBuilder().setContent(introSummary)
    ];
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${headingName}`),
    new TextDisplayBuilder().setContent(introSummary)
  );

  section.setThumbnailAccessory(
    new ThumbnailBuilder()
      .setURL(avatarUrl)
      .setDescription(`${displayName} のアイコン`)
  );

  return section;
}

function formatRecentLeaveSection(recentLeaves) {
  if (!Array.isArray(recentLeaves) || recentLeaves.length === 0) {
    return '';
  }

  const visibleItems = recentLeaves.slice(0, 3).map((leave) => {
    const mention = leave.mention || (leave.userId ? `<@${leave.userId}>` : null);
    const relativeLabel = leave.relativeLabel || leave.leftAgoLabel || '';
    return [mention, relativeLabel].filter(Boolean).join(' ');
  }).filter(Boolean);

  if (visibleItems.length === 0) {
    return '';
  }

  const extraCount = Math.max(0, Number(recentLeaves.extraCount || 0));
  if (extraCount > 0) {
    visibleItems.push(`ほか${extraCount}名`);
  }

  return `\n\n**直近の退出**\n${visibleItems.join(' / ')}`;
}

function buildProfileMessage({
  voiceChannelName,
  statusText = null,
  recentLeaves = [],
  members,
  accentColor = 0x3b82f6,
  totalMemberCount = members.length,
  pageIndex = 0,
  totalPages = 1,
  compact = false
}) {
  const container = new ContainerBuilder().setAccentColor(accentColor);
  const countLabel = `${totalMemberCount}名`;
  const title = totalPages > 1
    ? `${voiceChannelName || '通話チャンネル'} ${pageIndex + 1}/${totalPages}`
    : `${voiceChannelName || '通話チャンネル'}`;
  const statusLine = statusText?.trim()
    ? `**ステータス**\n${statusText.trim()}\n\n`
    : '';
  const recentLeaveSection = formatRecentLeaveSection(recentLeaves);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(`${statusLine}**現在の人数**\n${countLabel}${recentLeaveSection}`)
  );

  for (const member of members) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    const memberComponent = buildMemberSection(member, { compact });
    if (Array.isArray(memberComponent)) {
      container.addTextDisplayComponents(...memberComponent);
      continue;
    }

    container.addSectionComponents(memberComponent);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

module.exports = {
  buildProfileMessage
};
