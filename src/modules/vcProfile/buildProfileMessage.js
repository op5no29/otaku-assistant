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
  const introSummary = member.introSummary?.trim()
    ? emphasizeSocialLinks(truncateText(member.introSummary.trim(), 260))
    : '自己紹介がまだありません';
  const avatarUrl = member.avatarUrl || null;

  if (compact) {
    return [
      new TextDisplayBuilder().setContent(`### ${displayName}\n${introSummary}`)
    ];
  }

  if (!avatarUrl) {
    return [
      new TextDisplayBuilder().setContent(`### ${displayName}`),
      new TextDisplayBuilder().setContent(introSummary)
    ];
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${displayName}`),
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
  contextName,
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
  const pageLabel = `${pageIndex + 1}/${totalPages}`;
  const statusLine = statusText?.trim()
    ? `**ステータス**\n${statusText.trim()}\n\n`
    : '';
  const voiceChannelLine = voiceChannelName?.trim()
    ? `**通話チャンネル**\n${voiceChannelName.trim()}\n\n`
    : '';

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${contextName} / VCにいる人のプロフィール ${pageLabel}`),
    new TextDisplayBuilder().setContent(`${voiceChannelLine}${statusLine}**現在いる人**\n${countLabel}`)
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
    allowedMentions: { parse: [] }
  };
}

module.exports = {
  buildProfileMessage
};
