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
  const options = selectable.map((entry) => ({
    label: formatTitle(entry).slice(0, 100),
    description: `${formatSeason(entry) || 'シーズン不明'} / ${entry.status || '状態不明'}`.slice(0, 100),
    value: `${entry.provider}:${entry.providerMediaId}`
  }));

  return {
    content: [
      '候補が複数あるため、自動登録を止めました。',
      `検索語: ${title}`,
      ...buildCandidateLines(selectable)
    ].join('\n\n'),
    components: options.length
      ? [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`anime:post:select:${ownerUserId}:${token}`)
              .setPlaceholder('登録する作品を選択')
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
