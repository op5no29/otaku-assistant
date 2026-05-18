const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
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
  getAnimeById,
  maybeLinkRecentAnimeHashtagSource,
  getProviderTokenMissingMessage
} = require('../modules/anime');
const { buildAnimeLinks, getPreferredAnimeDisplayTitle } = require('../modules/anime/buildAnimeMessages');
const { registerDeletableMessage } = require('../modules/deletableMessages');
const {
  buildCandidateLines,
  ensurePostSelectionStore,
  prunePostSelectionStore,
  buildPostCandidateSelectResponse,
  shouldRequirePostSelection
} = require('../modules/anime/postSelection');
const { normalizeAnimeSearchQuery } = require('../modules/anime/titleAliases');

function formatTitle(media) {
  return getPreferredAnimeDisplayTitle(media);
}

function getExternalLabel(entry) {
  return String(entry?.provider || '') === 'annict' ? 'Annict' : 'AniList';
}

function formatSeason(media) {
  return [media.season, media.seasonYear].filter(Boolean).join(' ');
}

function getNextThreshold(config, reviewedCount) {
  const thresholds = Array.isArray(config.anime.reviewRoles)
    ? config.anime.reviewRoles.map((entry) => Number(entry.threshold)).filter((value) => value > 0).sort((a, b) => a - b)
    : [];
  return thresholds.find((threshold) => reviewedCount < threshold) || null;
}

async function buildAnimeDetailLine(client, entry) {
  const stats = await getAnimeStats(client, entry);
  const links = buildAnimeLinks(entry);
  return [
    `**${formatTitle(entry)}**`,
    `👀 ${stats.interestedCount} / ✅ ${stats.watchedCount} / 💬 ${stats.reviewCount}`,
    links.parentUrl ? `作品カード: ${links.parentUrl}` : null,
    links.threadUrl ? `スレッド: ${links.threadUrl}` : null,
    entry.siteUrl ? `${getExternalLabel(entry)}: ${entry.siteUrl}` : null
  ].filter(Boolean).join('\n');
}

async function buildAnimeIndexResponse(client, guildId, page = 1, selectedEntryId = null) {
  const result = await listAnimeIndex(client, guildId, page);
  const selectedEntry = selectedEntryId ? client.db.anime.getEntryById(Number(selectedEntryId)) : result.entries[0] || null;
  const validSelectedEntry = selectedEntry && String(selectedEntry.guildId) === String(guildId) ? selectedEntry : (result.entries[0] || null);
  const options = result.entries.slice(0, 10).map((entry) => ({
    label: formatTitle(entry).slice(0, 100),
    description: `${entry.status || '状態不明'} / ${formatSeason(entry) || 'シーズン不明'}`.slice(0, 100),
    value: String(entry.id)
  }));

  const content = [
    `登録済みアニメ一覧 ${result.page}ページ目 / 全${result.total}件`,
    validSelectedEntry ? await buildAnimeDetailLine(client, validSelectedEntry) : 'まだ登録済みアニメはありません。'
  ].join('\n\n');

  const components = [];
  if (options.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`anime:index:select:${result.page}`)
          .setPlaceholder('作品を選択')
          .addOptions(options)
      )
    );
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`anime:index:page:${Math.max(1, result.page - 1)}`)
        .setLabel('前へ')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(result.page <= 1),
      new ButtonBuilder()
        .setCustomId(`anime:index:page:${result.page + 1}`)
        .setLabel('次へ')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(result.page * result.pageSize >= result.total)
    )
  );

  if (validSelectedEntry) {
    const links = buildAnimeLinks(validSelectedEntry);
    const detailButtons = [];
    if (links.parentUrl) {
      detailButtons.push(new ButtonBuilder().setLabel('作品カードへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.parentUrl));
    }
    if (links.threadUrl) {
      detailButtons.push(new ButtonBuilder().setLabel('作品スレッドへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.threadUrl));
    }
    if (validSelectedEntry.siteUrl) {
      detailButtons.push(new ButtonBuilder().setLabel(`${getExternalLabel(validSelectedEntry)}で開く`).setStyle(ButtonStyle.Link).setURL(validSelectedEntry.siteUrl));
    }
    if (detailButtons.length) {
      components.push(new ActionRowBuilder().addComponents(...detailButtons.slice(0, 3)));
    }
  }

  return { content, components };
}

async function buildAnimeFindResponse(client, guildId, query, selectedEntryId = null) {
  const entries = await findRegisteredAnime(client, guildId, query, 10);
  const selectedEntry = selectedEntryId ? client.db.anime.getEntryById(Number(selectedEntryId)) : entries[0] || null;
  const validSelectedEntry = selectedEntry && String(selectedEntry.guildId) === String(guildId) ? selectedEntry : (entries[0] || null);
  const content = entries.length
    ? [`検索結果: ${query}`, validSelectedEntry ? await buildAnimeDetailLine(client, validSelectedEntry) : null].filter(Boolean).join('\n\n')
    : '登録済みアニメは見つかりませんでした。';
  const components = [];

  if (entries.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`anime:find:select`)
          .setPlaceholder('作品を選択')
          .addOptions(entries.map((entry) => ({
            label: formatTitle(entry).slice(0, 100),
            description: `${entry.status || '状態不明'} / ${formatSeason(entry) || 'シーズン不明'}`.slice(0, 100),
            value: String(entry.id)
          })))
      )
    );
    if (validSelectedEntry) {
      const links = buildAnimeLinks(validSelectedEntry);
      const buttons = [];
      if (links.parentUrl) {
        buttons.push(new ButtonBuilder().setLabel('作品カードへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.parentUrl));
      }
      if (links.threadUrl) {
        buttons.push(new ButtonBuilder().setLabel('作品スレッドへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.threadUrl));
      }
      if (validSelectedEntry.siteUrl) {
        buttons.push(new ButtonBuilder().setLabel(`${getExternalLabel(validSelectedEntry)}で開く`).setStyle(ButtonStyle.Link).setURL(validSelectedEntry.siteUrl));
      }
      if (buttons.length) {
        components.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 3)));
      }
    }
  }

  return { content, components };
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

async function sendPublicResult(interaction, payload, purpose) {
  const sentMessage = await interaction.channel.send(payload);
  await registerDeletableMessage(sentMessage, interaction.user.id, purpose);
  await interaction.editReply(`結果を投稿しました: ${sentMessage.url}`);
  return sentMessage;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('anime')
    .setDescription('アニメ作品カード・スレッド・感想を管理します。')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('search')
        .setDescription('Annict でアニメ作品を検索します。')
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

      const remoteLookupRequired = subcommand === 'search'
        || subcommand === 'cast'
        || subcommand === 'post'
        || group === 'season';
      const providerReadyError = remoteLookupRequired ? getProviderTokenMissingMessage(client) : null;
      if (providerReadyError) {
        await interaction.editReply(providerReadyError);
        return;
      }

      if (subcommand === 'search') {
        const title = interaction.options.getString('title', true);
        const results = await searchAnime(client, title);
        await sendPublicResult(interaction, {
          content: results.length
            ? [`検索結果: ${title}`, ...buildCandidateLines(results.slice(0, 5))].join('\n\n')
            : '該当するアニメが見つかりませんでした。',
          allowedMentions: { parse: [] }
        }, 'anime_search_result');
        return;
      }

      if (subcommand === 'cast') {
        const title = interaction.options.getString('title', true);
        const resolved = await resolveAnimeFromTitle(client, title, interaction.guildId);
        if (!resolved.media) {
          await interaction.editReply('アニメ情報の取得に失敗しました。少し後で試してください。');
          return;
        }

        client.logger.info('anime cast query started', {
          title,
          mediaId: resolved.media.providerMediaId || null
        });

        const detailedMedia = await getAnimeById(
          client,
          resolved.media.providerMediaId,
          Math.max(client.appConfig.anime.maxCastInCard, 10),
          resolved.media.provider
        );
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
        await sendPublicResult(interaction, {
          content: [
            `**${formatTitle(detailedMedia || resolved.media)}**`,
            formatSeason(detailedMedia || resolved.media) ? `- ${formatSeason(detailedMedia || resolved.media)} / ${(detailedMedia || resolved.media).status || '状態不明'}` : null,
            castLines.length ? castLines.join('\n') : 'キャスト情報が見つかりませんでした。',
            ambiguity,
          ].filter(Boolean).join('\n'),
          allowedMentions: { parse: [] }
        }, 'anime_cast_result');
        return;
      }

      if (subcommand === 'post') {
        const rawTitle = interaction.options.getString('title', true);
        const aliasResolved = normalizeAnimeSearchQuery(rawTitle);
        const searchTitle = aliasResolved.canonicalQuery;
        if (aliasResolved.aliasMatched) {
          client.logger.info('anime title alias matched', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            original: aliasResolved.original,
            alias: aliasResolved.aliasMatched,
            canonical: searchTitle
          });
        }
        const resolved = await resolveAnimeFromTitle(client, searchTitle, interaction.guildId);
        if (!resolved.media) {
          const hint = aliasResolved.aliasMatched
            ? `「${searchTitle}」で検索しましたが見つかりませんでした。`
            : `「${searchTitle}」は見つかりませんでした。`;
          await interaction.editReply(`${hint}\n別のタイトルや正式名称で試してみてください。`);
          return;
        }
        if (shouldRequirePostSelection(searchTitle, resolved.candidates)) {
          prunePostSelectionStore(client);
          const token = interaction.id;
          ensurePostSelectionStore(client).set(token, {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            title: searchTitle,
            candidates: resolved.candidates.slice(0, 5),
            expiresAt: Date.now() + (1000 * 60 * 10)
          });
          await interaction.editReply(buildPostCandidateSelectResponse(searchTitle, resolved.candidates, token, interaction.user.id));
          return;
        }
        let result;
        try {
          result = await postAnimeToChannel(interaction.guild, resolved.media, interaction.user.id, [searchTitle, rawTitle].filter((v, i, a) => a.indexOf(v) === i));
        } catch (postError) {
          client.logger.error('postAnimeToChannel failed', {
            subcommand,
            guildId: interaction.guildId,
            userId: interaction.user.id,
            providerMediaId: resolved.media?.providerMediaId || null,
            errorMessage: postError?.message || null
          });
          if (postError?.message === 'anime_channel_unavailable') {
            await interaction.editReply('アニメチャンネルが見つかりません。設定を確認してください。');
          } else {
            await interaction.editReply('作品カードの作成に失敗しました。時間をおいてもう一度試してください。');
          }
          return;
        }
        await maybeLinkRecentAnimeHashtagSource(client, interaction.guildId, interaction.user.id, result.entry.id).catch(() => null);
        const links = buildAnimeLinks(result.entry);
        const components = [];
        const buttons = [];
        if (links.parentUrl) {
          buttons.push(new ButtonBuilder().setLabel('作品カードへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.parentUrl));
        }
        if (links.threadUrl) {
          buttons.push(new ButtonBuilder().setLabel('作品スレッドへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.threadUrl));
        }
        if (result.entry.siteUrl) {
          buttons.push(new ButtonBuilder().setLabel(`${getExternalLabel(result.entry)}で開く`).setStyle(ButtonStyle.Link).setURL(result.entry.siteUrl));
        }
        if (buttons.length) {
          components.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 3)));
        }
        await interaction.editReply({
          content: [
            result.created ? '作品カードとスレッドを作成しました。' : '既に登録済みです。',
            `**${formatTitle(result.entry)}**`,
            aliasResolved.aliasMatched ? `（「${rawTitle}」→「${searchTitle}」で検索）` : null
          ].filter(Boolean).join('\n'),
          components,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (group === 'season') {
        const seasonResult = subcommand === 'current'
          ? await getCurrentSeasonAnime(client, 15)
          : await getNextSeasonAnime(client, 15);
        const lines = [];
        for (const media of seasonResult.items.slice(0, 15)) {
          const existing = client.db.anime.getEntryByProviderMediaId(interaction.guildId, media.provider, media.providerMediaId);
          const links = existing ? buildAnimeLinks(existing) : null;
          lines.push(`- ${formatTitle(media)}${existing ? ` [登録済み]${links?.threadUrl ? ` ${links.threadUrl}` : ''}` : ''}`);
        }
        await sendPublicResult(interaction, {
          content: [
            `${seasonResult.season} ${seasonResult.seasonYear}`,
            ...lines
          ].join('\n'),
          allowedMentions: { parse: [] }
        }, 'anime_season_result');
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
        await sendPublicResult(interaction, {
          content: reviews.length
            ? [
                `**${formatTitle(animeEntry)} の感想**`,
                ...reviews.map((review) => review.spoiler
                  ? `- ${review.userId}: ネタバレ感想あり`
                  : `- ${review.userId}: ${String(review.reviewText || '').trim().slice(0, 180)}`)
              ].join('\n')
            : 'まだ感想はありません。',
          allowedMentions: { parse: [] }
        }, 'anime_reviews_result');
        return;
      }

      if (subcommand === 'find') {
        const query = interaction.options.getString('query', true);
        const response = await buildAnimeFindResponse(client, interaction.guildId, query);
        await interaction.editReply(response);
        return;
      }

      if (subcommand === 'index') {
        const page = interaction.options.getInteger('page') || 1;
        const response = await buildAnimeIndexResponse(client, interaction.guildId, page);
        await interaction.editReply(response);
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
        errorName: error?.name || null,
        errorMessage: error?.message || null,
        errorStack: error?.stack || null,
        errorErrors: error?.errors || null,
        errorJson: JSON.stringify(error, Object.getOwnPropertyNames(error || {}))
      });
      if (error.code === 'ANNICT_TOKEN_MISSING') {
        await interaction.editReply('Annict APIトークンが設定されていません。');
      } else if (error?.message === 'anime_channel_unavailable') {
        await interaction.editReply('アニメチャンネルが見つかりません。設定を確認してください。');
      } else if (subcommand === 'post') {
        await interaction.editReply('作品カードの作成に失敗しました。時間をおいてもう一度試してください。');
      } else {
        await interaction.editReply('アニメ情報の取得に失敗しました。少し後で試してください。');
      }
    } finally {
      client.logger.info('anime command finished', {
        subcommandGroup: group || null,
        subcommand,
        guildId: interaction.guildId,
        userId: interaction.user.id
      });
    }
  }
  ,
  async handleComponentInteraction(interaction) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
      return false;
    }
    if (!String(interaction.customId || '').startsWith('anime:')) {
      return false;
    }

    const client = interaction.client;
    await interaction.deferUpdate().catch(() => null);

    if (interaction.isButton() && interaction.customId.startsWith('anime:index:page:')) {
      const page = Number(interaction.customId.split(':').pop() || '1');
      const response = await buildAnimeIndexResponse(client, interaction.guildId, page);
      await interaction.editReply(response).catch(() => null);
      return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('anime:index:select:')) {
      const page = Number(interaction.customId.split(':').pop() || '1');
      const selectedEntryId = interaction.values?.[0] || null;
      const response = await buildAnimeIndexResponse(client, interaction.guildId, page, selectedEntryId);
      await interaction.editReply(response).catch(() => null);
      return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'anime:find:select') {
      const selectedEntryId = interaction.values?.[0] || null;
      const currentQuery = interaction.message?.content?.match(/^検索結果: (.+)$/m)?.[1] || '';
      const response = await buildAnimeFindResponse(client, interaction.guildId, currentQuery, selectedEntryId);
      await interaction.editReply(response).catch(() => null);
      return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('anime:post:select:')) {
      prunePostSelectionStore(client);
      const parts = interaction.customId.split(':');
      const ownerUserId = parts.length >= 5 ? parts[3] : null;
      const token = parts.length >= 5 ? parts[4] : (parts[3] || null);
      client.logger.info('anime post select interaction received', {
        interactionId: interaction.id,
        customId: interaction.customId,
        token,
        ownerUserId,
        interactingUserId: interaction.user.id,
        selectedValue: interaction.values?.[0] || null
      });
      if (ownerUserId && String(ownerUserId) !== String(interaction.user.id)) {
        client.logger.warn('anime post select rejected owner mismatch', {
          interactionId: interaction.id,
          customId: interaction.customId,
          token,
          ownerUserId,
          interactingUserId: interaction.user.id
        });
        await interaction.editReply({ content: 'この候補選択は実行した本人のみ利用できます。', components: [] }).catch(() => null);
        return true;
      }
      const state = ensurePostSelectionStore(client).get(token);
      client.logger.info('anime post select token lookup', {
        interactionId: interaction.id,
        token,
        hit: Boolean(state),
        stateUserId: state?.userId || null,
        stateGuildId: state?.guildId || null
      });
      const selected = interaction.values?.[0] || '';
      const [provider, providerMediaId] = selected.split(':');
      let media = state?.candidates?.find((entry) => String(entry.provider) === String(provider) && String(entry.providerMediaId) === String(providerMediaId)) || null;
      if (!media && providerMediaId) {
        client.logger.info('anime post select state fallback fetch started', {
          interactionId: interaction.id,
          token,
          provider,
          providerMediaId
        });
        media = await getAnimeById(client, providerMediaId, client.appConfig.anime.maxCastInCard, provider).catch((error) => {
          client.logger.warn('anime post select state fallback fetch failed', {
            interactionId: interaction.id,
            token,
            provider,
            providerMediaId,
            error: error.message
          });
          return null;
        });
      }
      client.logger.info('anime post select work lookup result', {
        interactionId: interaction.id,
        token,
        provider,
        providerMediaId,
        mediaFound: Boolean(media),
        mediaTitle: media ? formatTitle(media) : null
      });
      if (!state && !media) {
        await interaction.editReply({
          content: '候補選択の有効期限が切れました。もう一度 `/anime post title:` を実行してください。',
          components: []
        }).catch(() => null);
        return true;
      }
      if (!media) {
        await interaction.editReply({ content: '選択された候補が見つかりませんでした。', components: [] }).catch(() => null);
        return true;
      }
      client.logger.info('anime ambiguity selected', {
        interactionId: interaction.id,
        token,
        provider,
        providerMediaId,
        title: formatTitle(media),
        interactingUserId: interaction.user.id
      });
      client.logger.info('postAnimeToChannel started from select interaction', {
        interactionId: interaction.id,
        token,
        provider,
        providerMediaId,
        title: formatTitle(media)
      });
      let result;
      try {
        result = await postAnimeToChannel(interaction.guild, media, interaction.user.id, state?.title ? [state.title] : []);
      } catch (error) {
        client.logger.error('postAnimeToChannel failed from select interaction', {
          interactionId: interaction.id,
          token,
          provider,
          providerMediaId,
          errorName: error?.name || null,
          errorMessage: error?.message || null,
          errorStack: error?.stack || null
        });
        await interaction.editReply({
          content: '作品カードの作成に失敗しました。少し時間をおいてもう一度試してください。',
          components: []
        }).catch(() => null);
        return true;
      }
      client.logger.info('postAnimeToChannel finished from select interaction', {
        interactionId: interaction.id,
        token,
        animeEntryId: result.entry.id,
        created: result.created
      });
      const linkResult = await maybeLinkRecentAnimeHashtagSource(client, interaction.guildId, interaction.user.id, result.entry.id).catch(() => null);
      if (linkResult) {
        client.logger.info('anime ambiguity selection linked to source', {
          interactionId: interaction.id,
          animeEntryId: result.entry.id,
          userId: interaction.user.id
        });
      }
      client.logger.info('anime ambiguity selection completed', {
        interactionId: interaction.id,
        animeEntryId: result.entry.id,
        created: result.created,
        title: formatTitle(result.entry)
      });
      ensurePostSelectionStore(client).delete(token);
      const links = buildAnimeLinks(result.entry);
      const buttons = [];
      if (links.parentUrl) {
        buttons.push(new ButtonBuilder().setLabel('作品カードへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.parentUrl));
      }
      if (links.threadUrl) {
        buttons.push(new ButtonBuilder().setLabel('作品スレッドへ飛ぶ').setStyle(ButtonStyle.Link).setURL(links.threadUrl));
      }
      if (result.entry.siteUrl) {
        buttons.push(new ButtonBuilder().setLabel(`${getExternalLabel(result.entry)}で開く`).setStyle(ButtonStyle.Link).setURL(result.entry.siteUrl));
      }
      const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons.slice(0, 3))] : [];
      await interaction.editReply({
        content: [
          result.created ? '作品カードとスレッドを作成しました。' : '既に登録済みです。',
          `**${formatTitle(result.entry)}**`
        ].join('\n'),
        components
      }).catch(() => null);
      return true;
    }

    return false;
  }
};
