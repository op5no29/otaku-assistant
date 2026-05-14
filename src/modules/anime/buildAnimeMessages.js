const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder
} = require('discord.js');
const { getChannelJumpUrl, getMessageJumpUrl } = require('../../services/discordLinks');

function createContainer(accentColor = 0x8b5cf6) {
  return new ContainerBuilder().setAccentColor(accentColor);
}

function getPreferredAnimeDisplayTitle(entry) {
  return entry.titleNative || entry.titleUserPreferred || entry.titleRomaji || entry.titleEnglish || 'タイトル不明';
}

function formatSeason(entry) {
  const bits = [];
  if (entry.season) {
    bits.push(entry.season);
  }
  if (entry.seasonYear) {
    bits.push(String(entry.seasonYear));
  }
  return bits.join(' ');
}

function formatNextAiring(entry) {
  if (!entry.nextAiringAt) {
    return null;
  }
  const date = new Date(entry.nextAiringAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('ja-JP');
}

function buildMetadataLines(entry, stats) {
  const lines = [];
  const seasonText = formatSeason(entry);
  if (seasonText) {
    lines.push(`**シーズン**: ${seasonText}`);
  }
  if (entry.status) {
    lines.push(`**状態**: ${entry.status}`);
  }
  if (entry.episodes) {
    lines.push(`**話数**: ${entry.episodes}`);
  }
  if (entry.duration) {
    lines.push(`**尺**: ${entry.duration}分`);
  }
  const nextAiring = formatNextAiring(entry);
  if (nextAiring) {
    lines.push(`**次回放送**: ${nextAiring}`);
  }
  if (stats) {
    lines.push(`👀 興味あり: ${stats.interestedCount} / ✅ 視聴済み: ${stats.watchedCount} / 💬 感想投稿済み: ${stats.reviewCount}`);
  }
  return lines;
}

function buildLinkRows({ threadUrl, siteUrl, parentUrl }) {
  const buttons = [];
  if (threadUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('作品スレッドへ飛ぶ')
        .setStyle(ButtonStyle.Link)
        .setURL(threadUrl)
    );
  }
  if (parentUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('作品カードへ飛ぶ')
        .setStyle(ButtonStyle.Link)
        .setURL(parentUrl)
    );
  }
  if (siteUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('AniListで開く')
        .setStyle(ButtonStyle.Link)
        .setURL(siteUrl)
    );
  }
  if (!buttons.length) {
    return [];
  }
  return [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))];
}

function addPoster(container, entry) {
  const imageUrl = entry.bannerImageUrl || entry.coverImageUrl;
  if (!imageUrl) {
    return;
  }
  const gallery = new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(imageUrl)
  );
  container.addMediaGalleryComponents(gallery);
}

function buildAnimeChannelCard(entry, stats) {
  const container = createContainer(stats?.hasSpoilerReviews ? 0xef4444 : 0x8b5cf6);
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${getPreferredAnimeDisplayTitle(entry)}`),
    new TextDisplayBuilder().setContent(buildMetadataLines(entry, stats).join('\n'))
  );

  if (entry.coverImageUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(entry.coverImageUrl)
        .setDescription(`${getPreferredAnimeDisplayTitle(entry)} のカバー`)
    );
  }

  container.addSectionComponents(section);
  if (stats?.hasSpoilerReviews) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⚠️ この作品のスレッドにはネタバレ感想が含まれています。')
    );
  }
  addPoster(container, entry);
  for (const row of buildLinkRows({
    threadUrl: stats?.threadUrl || null,
    siteUrl: entry.siteUrl || null
  })) {
    container.addActionRowComponents(row);
  }
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] }
  };
}

function buildReviewPreview(review, memberDisplayName) {
  if (!review) {
    return null;
  }
  const title = memberDisplayName ? `**${memberDisplayName}**` : `**${review.userId}**`;
  if (review.spoiler) {
    return `${title}\nネタバレ感想あり`;
  }
  const excerpt = String(review.reviewText || '').trim().slice(0, 180) || '（本文なし）';
  return `${title}\n${excerpt}`;
}

function buildAnimeThreadHeaderCard(entry, stats, cast, latestReviews) {
  const container = createContainer(stats?.hasSpoilerReviews ? 0xef4444 : 0x8b5cf6);
  const title = getPreferredAnimeDisplayTitle(entry);
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${title}`),
    new TextDisplayBuilder().setContent(buildMetadataLines(entry, stats).join('\n'))
  );

  if (entry.coverImageUrl) {
    section.setThumbnailAccessory(
      new ThumbnailBuilder()
        .setURL(entry.coverImageUrl)
        .setDescription(`${title} のカバー`)
    );
  }
  container.addSectionComponents(section);

  const castLines = Array.isArray(cast)
    ? cast
        .slice(0, Number(stats?.maxCastInCard || 5))
        .map((item) => `- ${item.characterName || 'キャラ不明'}: ${item.voiceActorName || '声優情報なし'}`)
    : [];
  if (castLines.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**メインキャスト**\n${castLines.join('\n')}`)
    );
  }

  if (Array.isArray(latestReviews) && latestReviews.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**最新感想**\n${latestReviews.join('\n\n')}`)
    );
  }

  if (stats?.hasSpoilerReviews) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⚠️ このスレッドにはネタバレ感想が含まれています。')
    );
  }

  addPoster(container, entry);
  for (const row of buildLinkRows({
    parentUrl: stats?.parentUrl || null,
    siteUrl: entry.siteUrl || null
  })) {
    container.addActionRowComponents(row);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] }
  };
}

function buildAnimeReviewPrompt(entry, user, reactionType) {
  const typeLabel = reactionType === 'watched' ? '視聴済み' : '興味あり';
  return {
    content: [
      `<@${user.id}> さんが「${typeLabel}」にしました。`,
      '感想があれば、このスレッドで `/anime review` を使って投稿できます。',
      '感想を投稿すると、視聴作品数カウントとロール付与の対象になります。'
    ].join('\n'),
    allowedMentions: { users: [user.id], roles: [], parse: [] }
  };
}

function buildAnimeLinks(entry) {
  const parentUrl = entry.animeChannelId && entry.animeChannelMessageId
    ? getMessageJumpUrl({
        guildId: entry.guildId,
        channelId: entry.animeChannelId,
        messageId: entry.animeChannelMessageId
      })
    : null;
  const threadUrl = entry.threadId
    ? getChannelJumpUrl({
        guildId: entry.guildId,
        channelId: entry.threadId
      })
    : null;

  return {
    parentUrl,
    threadUrl
  };
}

module.exports = {
  buildAnimeChannelCard,
  buildAnimeThreadHeaderCard,
  buildAnimeReviewPrompt,
  buildAnimeLinks,
  buildReviewPreview,
  getPreferredAnimeDisplayTitle
};
