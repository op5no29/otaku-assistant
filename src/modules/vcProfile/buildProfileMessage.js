const {
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder
} = require('discord.js');
const { truncateText } = require('../../utils/text');

function emphasizeSocialLinks(content) {
  return content
    .split('\n')
    .map((line) => (/x\.com|twitter\.com/i.test(line) ? `**${line}**` : line))
    .join('\n');
}

function buildMemberSection(member, { compact = false } = {}) {
  const displayName = member.displayName || '不明なメンバー';
  const headingName = member.mention || (member.id ? `<@${member.id}>` : displayName);
  const introSummary = member.introSummary?.trim()
    ? emphasizeSocialLinks(truncateText(member.introSummary.trim(), 260))
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

function buildProfileMessage({
  voiceChannelName,
  statusText = null,
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
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}`),
    new TextDisplayBuilder().setContent(`${statusLine}**現在の人数**\n${countLabel}`)
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
