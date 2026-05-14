const { SlashCommandBuilder } = require('discord.js');
const {
  searchAnime,
  resolveAnimeFromTitle,
  postAnimeToChannel,
  getAnimeStats,
  saveAnimeReview,
  getAnimeByThreadId,
  findRegisteredAnime,
  listAnimeIndex,
  getCurrentSeasonAnime,
  getNextSeasonAnime,
  getAnimeById
} = require('../modules/anime');
const { buildAnimeLinks, getPreferredAnimeDisplayTitle } = require('../modules/anime/buildAnimeMessages');

function formatTitle(media) {
  return getPreferredAnimeDisplayTitle(media);
}

function formatSeason(media) {
  return [media.season, media.seasonYear].filter(Boolean).join(' ');
}

function buildCandidateLines(list) {
  return list.map((item, index) => {
    const lines = [
      `${index + 1}. **${formatTitle(item)}**`,
      `- ${formatSeason(item) || 'シーズン不明'} / ${item.status || '状態不明'}`,
      item.siteUrl ? `- ${item.siteUrl}` : null
    ].filter(Boolean);
    return lines.join('\n');
  });
}

function getNextThreshold(config, reviewedCount) {
  const thresholds = Array.isArray(config.anime.reviewRoles)
    ? config.anime.reviewRoles.map((entry) => Number(entry.threshold)).filter((value) => value > 0).sort((a, b) => a - b)
    : [];
  return thresholds.find((threshold) => reviewedCount < threshold) || null;
}

async function buildLocalEntryLines(client, guildId, entries) {
  const lines = [];
  for (const entry of entries) {
    const stats = await getAnimeStats(client, entry);
    const links = buildAnimeLinks(entry);
    lines.push([
      `**${formatTitle(entry)}**`,
      `- 👀 ${stats.interestedCount} / ✅ ${stats.watchedCount} / 💬 ${stats.reviewCount}`,
      links.parentUrl ? `- 作品カード: ${links.parentUrl}` : null,
      links.threadUrl ? `- スレッド: ${links.threadUrl}` : null
    ].filter(Boolean).join('\n'));
  }
  return lines;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('anime')
    .setDescription('アニメ作品カード・スレッド・感想を管理します。')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('search')
        .setDescription('AniList でアニメ作品を検索します。')
        .addStringOption((option) =>
          option
            .setName('title')
            .setDescription('検索する作品名')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cast')
        .setDescription('作品の主要キャストを表示します。')
        .addStringOption((option) =>
          option
            .setName('title')
            .setDescription('検索する作品名')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('post')
        .setDescription('アニメチャンネルに作品カードとスレッドを作成します。')
        .addStringOption((option) =>
          option
            .setName('title')
            .setDescription('投稿する作品名')
            .setRequired(true)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('season')
        .setDescription('今期・来期のアニメを表示します。')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('current')
            .setDescription('今期アニメ一覧を表示します。')
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('next')
            .setDescription('来期アニメ一覧を表示します。')
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('review')
        .setDescription('このアニメスレッドに感想を保存します。')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('感想本文')
            .setRequired(true)
        )
        .addBooleanOption((option) =>
          option
            .setName('spoiler')
            .setDescription('ネタバレを含む場合は true')
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reviews')
        .setDescription('このアニメの保存済み感想を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('find')
        .setDescription('登録済みアニメをローカルDBから検索します。')
        .addStringOption((option) =>
          option
            .setName('query')
            .setDescription('検索語')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('index')
        .setDescription('登録済みアニメ一覧を表示します。')
        .addIntegerOption((option) =>
          option
            .setName('page')
            .setDescription('ページ番号')
            .setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('my')
        .setDescription('自分のアニメ記録を表示します。')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('profile')
        .setDescription('他のユーザーのアニメ記録を表示します。')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('対象ユーザー')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(true);
    const client = interaction.client;

    await interaction.deferReply({ ephemeral: true });
    client.logger.info('anime command started', {
      commandName: interaction.commandName,
      subcommandGroup: group || null,
      subcommand,
      guildId: interaction.guildId,
      userId: interaction.user.id
    });

    try {
      if (!client.appConfig.anime.enabled) {
        await interaction.editReply('アニメ機能は現在無効です。');
        return;
      }

      if (subcommand === 'search') {
        const title = interaction.options.getString('title', true);
        const results = await searchAnime(client, title);
        await interaction.editReply(
          results.length
            ? [`検索結果: ${title}`, ...buildCandidateLines(results.slice(0, 5))].join('\n\n')
            : '該当するアニメが見つかりませんでした。'
        );
        return;
      }

      if (subcommand === 'cast') {
        const title = interaction.options.getString('title', true);
        const resolved = await resolveAnimeFromTitle(client, title);
        if (!resolved.media) {
          await interaction.editReply('アニメ情報の取得に失敗しました。少し後で試してください。');
          return;
        }

        client.logger.info('anime cast query started', {
          title,
          mediaId: resolved.media.providerMediaId || null
        });

        const detailedMedia = await getAnimeById(client, resolved.media.providerMediaId, Math.max(client.appConfig.anime.maxCastInCard, 10));
        const castRows = Array.isArray(detailedMedia?.cast) ? detailedMedia.cast : [];
        client.logger.info('anime cast query finished', {
          title,
          mediaId: resolved.media.providerMediaId || null,
          castCount: castRows.length,
          hasCharacterFields: castRows.some((row) => row.characterName || row.characterNameNative),
          hasVoiceActorFields: castRows.some((row) => row.voiceActorName)
        });

        const castLines = castRows.slice(0, client.appConfig.anime.maxCastInCard).map(
          (row) => `- ${row.characterName || 'キャラ不明'}: ${row.voiceActorName || '声優情報なし'}`
        );
        const ambiguity = resolved.candidates.length > 1 ? `候補が複数ありましたが、先頭候補を採用しました。(${resolved.candidates.length}件)` : null;
        await interaction.editReply([
          `**${formatTitle(detailedMedia || resolved.media)}**`,
          formatSeason(detailedMedia || resolved.media) ? `- ${formatSeason(detailedMedia || resolved.media)} / ${(detailedMedia || resolved.media).status || '状態不明'}` : null,
          castLines.length ? castLines.join('\n') : 'キャスト情報を取得できませんでした。',
          ambiguity,
        ].filter(Boolean).join('\n'));
        return;
      }

      if (subcommand === 'post') {
        const title = interaction.options.getString('title', true);
        const resolved = await resolveAnimeFromTitle(client, title);
        if (!resolved.media) {
          await interaction.editReply('アニメ情報の取得に失敗しました。少し後で試してください。');
          return;
        }
        const result = await postAnimeToChannel(interaction.guild, resolved.media, interaction.user.id);
        const links = buildAnimeLinks(result.entry);
        await interaction.editReply([
          result.created ? '作品カードとスレッドを作成しました。' : '既に登録済みです。',
          links.parentUrl ? `作品カードへ飛ぶ: ${links.parentUrl}` : null,
          links.threadUrl ? `スレッドへ飛ぶ: ${links.threadUrl}` : null
        ].filter(Boolean).join('\n'));
        return;
      }

      if (group === 'season') {
        const seasonResult = subcommand === 'current'
          ? await getCurrentSeasonAnime(client, 15)
          : await getNextSeasonAnime(client, 15);
        const lines = [];
        for (const media of seasonResult.items.slice(0, 15)) {
          const existing = client.db.anime.getEntryByProviderMediaId(interaction.guildId, 'anilist', media.providerMediaId);
          lines.push(`- ${formatTitle(media)}${existing ? ' [登録済み]' : ''}`);
        }
        await interaction.editReply([
          `${seasonResult.season} ${seasonResult.seasonYear}`,
          ...lines
        ].join('\n'));
        return;
      }

      if (subcommand === 'review') {
        const animeEntry = getAnimeByThreadId(interaction.guildId, interaction.channelId, client);
        if (!animeEntry) {
          await interaction.editReply('このコマンドは各アニメのスレッド内で使用してください。');
          return;
        }

        const text = interaction.options.getString('text', true);
        const spoiler = interaction.options.getBoolean('spoiler') === true;
        const result = await saveAnimeReview(
          client,
          interaction.guildId,
          animeEntry.id,
          interaction.user.id,
          text,
          spoiler,
          interaction.id,
          interaction.channelId
        );
        await interaction.editReply([
          '感想を保存しました。',
          `感想投稿済み作品数: ${result.reviewedCount}`,
          result.grantedRoleIds.length ? `新規付与ロール数: ${result.grantedRoleIds.length}` : null
        ].filter(Boolean).join('\n'));
        return;
      }

      if (subcommand === 'reviews') {
        const animeEntry = getAnimeByThreadId(interaction.guildId, interaction.channelId, client);
        if (!animeEntry) {
          await interaction.editReply('このコマンドは各アニメのスレッド内で使用してください。');
          return;
        }
        const reviews = client.db.anime.listReviews(interaction.guildId, animeEntry.id, client.appConfig.anime.maxReviewsInCard);
        await interaction.editReply(
          reviews.length
            ? [
                `**${formatTitle(animeEntry)} の感想**`,
                ...reviews.map((review) => review.spoiler
                  ? `- ${review.userId}: ネタバレ感想あり`
                  : `- ${review.userId}: ${String(review.reviewText || '').trim().slice(0, 180)}`)
              ].join('\n')
            : 'まだ感想はありません。'
        );
        return;
      }

      if (subcommand === 'find') {
        const query = interaction.options.getString('query', true);
        const entries = await findRegisteredAnime(client, interaction.guildId, query, 10);
        if (!entries.length) {
          await interaction.editReply('登録済みアニメは見つかりませんでした。');
          return;
        }
        const lines = await buildLocalEntryLines(client, interaction.guildId, entries);
        await interaction.editReply(lines.join('\n\n'));
        return;
      }

      if (subcommand === 'index') {
        const page = interaction.options.getInteger('page') || 1;
        const result = await listAnimeIndex(client, interaction.guildId, page);
        const lines = await buildLocalEntryLines(client, interaction.guildId, result.entries);
        await interaction.editReply([
          `登録済みアニメ一覧 ${result.page}ページ目 / 全${result.total}件`,
          ...(lines.length ? lines : ['まだ登録済みアニメはありません。'])
        ].join('\n\n'));
        return;
      }

      if (subcommand === 'my' || subcommand === 'profile') {
        const targetUser = subcommand === 'profile'
          ? interaction.options.getUser('user', true)
          : interaction.user;
        const interestedCount = client.db.anime.countUserInterested(interaction.guildId, targetUser.id);
        const watchedCount = client.db.anime.countUserWatched(interaction.guildId, targetUser.id);
        const reviewedCount = client.db.anime.countReviewedByUser(interaction.guildId, targetUser.id);
        const nextThreshold = getNextThreshold(client.appConfig, reviewedCount);
        await interaction.editReply([
          `${targetUser.id === interaction.user.id ? 'あなた' : targetUser.username} のアニメ記録`,
          `👀 興味あり: ${interestedCount}`,
          `✅ 視聴済み: ${watchedCount}`,
          `💬 感想投稿済み作品数: ${reviewedCount}`,
          nextThreshold ? `次の感想ロール閾値: ${nextThreshold}` : '次の感想ロール閾値: なし'
        ].join('\n'));
        return;
      }

      await interaction.editReply('未対応の anime コマンドです。');
    } catch (error) {
      client.logger.error('anime command failed', {
        subcommandGroup: group || null,
        subcommand,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error: error.message
      });
      await interaction.editReply('アニメ情報の取得に失敗しました。少し後で試してください。');
    } finally {
      client.logger.info('anime command finished', {
        subcommandGroup: group || null,
        subcommand,
        guildId: interaction.guildId,
        userId: interaction.user.id
      });
    }
  }
};
