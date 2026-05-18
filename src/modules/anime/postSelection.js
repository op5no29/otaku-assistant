const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { getPreferredAnimeDisplayTitle } = require('./buildAnimeMessages');
const { extractSeasonNumber, normalizeSearchText } = require('./search');

function formatTitle(media) {
  return getPreferredAnimeDisplayTitle(media);
}

function formatSeason(media) {
  return [media?.season, media?.seasonYear].filter(Boolean).join(' ');
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

function ensurePostSelectionStore(client) {
  if (!client.animePostSelectionState) {
    client.animePostSelectionState = new Map();
  }
  return client.animePostSelectionState;
}

function prunePostSelectionStore(client) {
  const store = ensurePostSelectionStore(client);
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if ((value.expiresAt || 0) <= now) {
      store.delete(key);
    }
  }
}

function getSelectablePostCandidates(query, candidates = [], limit = 5) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return [];
  }

  const explicitSeasonNumber = extractSeasonNumber(query);
  if (!explicitSeasonNumber) {
    return candidates.slice(0, limit);
  }

  const sameSeason = candidates.filter((entry) => extractSeasonNumber(formatTitle(entry)) === explicitSeasonNumber);
  return (sameSeason.length ? sameSeason : candidates).slice(0, limit);
}

function buildPostCandidateSelectResponse(title, candidates, token, ownerUserId) {
  const selectable = getSelectablePostCandidates(title, candidates, 5);
  const providerLabel = (entry) => entry.provider === 'annict' ? 'Annict' : 'AniList';
  const options = selectable.map((entry) => ({
    label: formatTitle(entry).slice(0, 100),
    description: (
      formatSeason(entry)
        ? `${formatSeason(entry)} / ${providerLabel(entry)} ${entry.providerMediaId}`
        : `${providerLabel(entry)} ${entry.providerMediaId}`
    ).slice(0, 100),
    value: `${entry.provider}:${entry.providerMediaId}`
  }));

  const bulletLines = selectable.map((entry) => `• ${formatTitle(entry)}`).join('\n');

  return {
    content: [
      'アニメ作品の候補が複数あります。',
      '該当する作品を選んでください。',
      '',
      '候補:',
      bulletLines
    ].join('\n'),
    components: options.length
      ? [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`anime:post:select:${ownerUserId}:${token}`)
              .setPlaceholder('作品を選択してください')
              .addOptions(options)
          )
        ]
      : []
  };
}

function shouldRequirePostSelection(query, candidates = []) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return false;
  }

  const explicitSeasonNumber = extractSeasonNumber(query);
  if (explicitSeasonNumber) {
    const sameSeason = candidates.filter((entry) => extractSeasonNumber(formatTitle(entry)) === explicitSeasonNumber);
    if (sameSeason.length > 1) {
      return true;
    }
    if (sameSeason.length === 1) {
      return false;
    }
    return true;
  }

  const normalizedQuery = normalizeSearchText(query);
  const [first, second] = candidates;
  const firstTitle = normalizeSearchText(formatTitle(first));
  const secondTitle = normalizeSearchText(formatTitle(second));
  if (!normalizedQuery) {
    return true;
  }
  if (firstTitle === normalizedQuery) {
    return false;
  }
  if (normalizedQuery.length <= 8) {
    return true;
  }
  if (firstTitle.includes(normalizedQuery) && secondTitle.includes(normalizedQuery)) {
    return true;
  }
  return false;
}

module.exports = {
  buildCandidateLines,
  ensurePostSelectionStore,
  prunePostSelectionStore,
  getSelectablePostCandidates,
  buildPostCandidateSelectResponse,
  shouldRequirePostSelection
};
