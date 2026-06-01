const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { getPreferredAnimeDisplayTitle } = require('./buildAnimeMessages');
const { extractSeasonNumber, normalizeSearchText } = require('./search');
const {
  normalizeAnimeSearchQuery,
  getAnimeFranchiseKeyFromTitle
} = require('./titleAliases');

const PICKER_CANDIDATE_LIMIT = 10;

function formatTitle(media) {
  return getPreferredAnimeDisplayTitle(media);
}

function getPickerTitle(media) {
  const preferredTitle = String(formatTitle(media) || '').trim();
  if (preferredTitle && preferredTitle !== 'タイトル不明') {
    return preferredTitle;
  }
  return `${media?.provider === 'annict' ? 'Annict' : 'AniList'} ${media?.providerMediaId || media?.id || 'unknown'}`;
}

function getProviderLabel(entry) {
  return String(entry?.provider || '') === 'annict' ? 'Annict' : 'AniList';
}

function buildOptionDescription(entry) {
  const parts = [];
  if (entry?.seasonYear) {
    parts.push(String(entry.seasonYear));
  } else if (entry?.season) {
    parts.push(String(entry.season));
  }
  if (entry?.format) {
    parts.push(String(entry.format));
  }
  parts.push(`${getProviderLabel(entry)} ${entry?.providerMediaId || entry?.id || 'unknown'}`);
  return parts.join(' / ').slice(0, 100);
}

function buildCandidateLines(list) {
  return list.map((item) => `• ${getPickerTitle(item)}`);
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

function dedupeEntries(entries = []) {
  const deduped = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry?.provider}:${entry?.providerMediaId}`;
    if (!entry?.providerMediaId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function getDistinctTitles(entries = []) {
  return Array.from(new Set(
    entries
      .map((entry) => normalizeSearchText(getPickerTitle(entry)))
      .filter(Boolean)
  ));
}

function getPlausibleEntries(candidates = [], rankedRows = []) {
  if (!Array.isArray(rankedRows) || !rankedRows.length) {
    return dedupeEntries(candidates).slice(0, PICKER_CANDIDATE_LIMIT);
  }

  const topScore = Number(rankedRows[0]?.score || 0);
  const threshold = Math.max(topScore - 35, 60);
  const plausible = rankedRows
    .filter((row) => Number(row?.score || 0) >= threshold)
    .map((row) => row.entry || row.media)
    .filter(Boolean);

  return dedupeEntries(plausible.length ? plausible : candidates).slice(0, PICKER_CANDIDATE_LIMIT);
}

function getSelectablePostCandidates(query, candidates = [], options = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return [];
  }

  const queryInfo = options.queryInfo || normalizeAnimeSearchQuery(query);
  const plausibleEntries = getPlausibleEntries(candidates, options.rankedRows);
  const allEntries = dedupeEntries(candidates).slice(0, PICKER_CANDIDATE_LIMIT);
  const seasonSource = queryInfo.original || queryInfo.canonicalQuery || query;
  const explicitSeasonNumber = extractSeasonNumber(seasonSource);
  if (explicitSeasonNumber) {
    const sameSeason = plausibleEntries.filter((entry) => extractSeasonNumber(getPickerTitle(entry)) === explicitSeasonNumber);
    return (sameSeason.length ? sameSeason : plausibleEntries).slice(0, PICKER_CANDIDATE_LIMIT);
  }

  const franchiseKey = queryInfo.franchiseKey || getAnimeFranchiseKeyFromTitle(queryInfo.canonicalQuery || queryInfo.original || query);
  if (franchiseKey) {
    const franchiseEntries = allEntries.filter((entry) => getAnimeFranchiseKeyFromTitle(getPickerTitle(entry)) === franchiseKey);
    if (franchiseEntries.length > 1) {
      return franchiseEntries.slice(0, PICKER_CANDIDATE_LIMIT);
    }
  }

  return plausibleEntries.slice(0, PICKER_CANDIDATE_LIMIT);
}

function analyzePostSelectionPolicy(query, candidates = [], options = {}) {
  const queryInfo = options.queryInfo || normalizeAnimeSearchQuery(query);
  const selectableCandidates = getSelectablePostCandidates(query, candidates, {
    ...options,
    queryInfo
  });
  if (!Array.isArray(candidates) || candidates.length <= 1 || selectableCandidates.length <= 1) {
    return {
      requireSelection: false,
      reason: null,
      queryInfo,
      selectableCandidates
    };
  }

  const seasonSource = queryInfo.original || queryInfo.canonicalQuery || query;
  const explicitSeasonNumber = extractSeasonNumber(seasonSource);
  if (explicitSeasonNumber) {
    const sameSeason = selectableCandidates.filter((entry) => extractSeasonNumber(getPickerTitle(entry)) === explicitSeasonNumber);
    if (sameSeason.length > 1) {
      return {
        requireSelection: true,
        reason: 'season_specific_multiple',
        queryInfo,
        selectableCandidates: sameSeason
      };
    }
    if (sameSeason.length === 1) {
      return {
        requireSelection: false,
        reason: null,
        queryInfo,
        selectableCandidates: sameSeason
      };
    }
  }

  const franchiseKey = queryInfo.franchiseKey || getAnimeFranchiseKeyFromTitle(queryInfo.canonicalQuery || queryInfo.original || query);
  const franchiseEntries = franchiseKey
    ? selectableCandidates.filter((entry) => getAnimeFranchiseKeyFromTitle(getPickerTitle(entry)) === franchiseKey)
    : [];
  const distinctFranchiseTitles = getDistinctTitles(franchiseEntries);
  if (queryInfo.aliasKind === 'franchise' && queryInfo.aliasMatched && distinctFranchiseTitles.length > 1) {
    return {
      requireSelection: true,
      reason: 'franchise_alias',
      queryInfo,
      selectableCandidates: franchiseEntries
    };
  }
  if ((queryInfo.aliasKind === 'franchise' || franchiseKey) && distinctFranchiseTitles.length > 1) {
    return {
      requireSelection: true,
      reason: 'broad_franchise_results',
      queryInfo,
      selectableCandidates: franchiseEntries.length ? franchiseEntries : selectableCandidates
    };
  }

  const normalizedQuery = normalizeSearchText(queryInfo.original || queryInfo.canonicalQuery || query);
  const shortQuery = normalizedQuery.length > 0 && normalizedQuery.length <= 4;
  if (shortQuery) {
    return {
      requireSelection: true,
      reason: 'short_query',
      queryInfo,
      selectableCandidates
    };
  }

  const [first, second] = selectableCandidates;
  const firstTitle = normalizeSearchText(getPickerTitle(first));
  const secondTitle = normalizeSearchText(getPickerTitle(second));
  if (!normalizedQuery) {
    return {
      requireSelection: true,
      reason: 'empty_query',
      queryInfo,
      selectableCandidates
    };
  }
  if (firstTitle === normalizedQuery) {
    return {
      requireSelection: false,
      reason: null,
      queryInfo,
      selectableCandidates
    };
  }
  if (normalizedQuery.length <= 8) {
    return {
      requireSelection: true,
      reason: 'short_query',
      queryInfo,
      selectableCandidates
    };
  }
  if (firstTitle.includes(normalizedQuery) && secondTitle.includes(normalizedQuery)) {
    return {
      requireSelection: true,
      reason: 'multiple_query_matches',
      queryInfo,
      selectableCandidates
    };
  }

  return {
    requireSelection: false,
    reason: null,
    queryInfo,
    selectableCandidates
  };
}

function buildPostCandidateSelectResponse(title, candidates, token, ownerUserId, options = {}) {
  const selectable = getSelectablePostCandidates(title, candidates, options);
  const optionsList = selectable.map((entry) => ({
    label: getPickerTitle(entry).slice(0, 100),
    description: buildOptionDescription(entry),
    value: `${entry.provider}:${entry.providerMediaId}`
  }));

  return {
    content: [
      'アニメ作品の候補が複数あります。',
      '該当する作品を選んでください。',
      '',
      '候補:',
      ...buildCandidateLines(selectable)
    ].join('\n'),
    components: optionsList.length
      ? [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`anime:post:select:${ownerUserId}:${token}`)
              .setPlaceholder('作品を選択してください')
              .addOptions(optionsList)
          )
        ]
      : []
  };
}

function shouldRequirePostSelection(query, candidates = [], options = {}) {
  return analyzePostSelectionPolicy(query, candidates, options).requireSelection;
}

module.exports = {
  buildCandidateLines,
  ensurePostSelectionStore,
  prunePostSelectionStore,
  getSelectablePostCandidates,
  analyzePostSelectionPolicy,
  buildPostCandidateSelectResponse,
  shouldRequirePostSelection
};
