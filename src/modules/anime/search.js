const { toKatakana } = require('./annictClient');
const {
  normalizeAnimeSearchQuery,
  buildAnimeSearchQueries
} = require('./titleAliases');

const AUXILIARY_TITLE_RULES = [
  { reason: 'crossover', patterns: [/コラボ/iu, /(?:^|\s|[「『【])x(?:\s|$)|×/iu], penalty: 140 },
  { reason: 'mini_drama', patterns: [/ミニドラマ/iu], penalty: 180 },
  { reason: 'pv', patterns: [/\bPV\b/iu, /\bTrailer\b/iu, /\bTeaser\b/iu], penalty: 170 },
  { reason: 'cm', patterns: [/\bCM\b/iu], penalty: 170 },
  { reason: 'special_program', patterns: [/特番/iu], penalty: 150 },
  { reason: 'short', patterns: [/ショート/iu, /\bShorts?\b/iu], penalty: 120 },
  { reason: 'bonus_video', patterns: [/映像特典/iu], penalty: 180 },
  { reason: 'specials', patterns: [/\bSpecials?\b/iu], penalty: 130 },
  { reason: 'ova', patterns: [/\bOVA\b/iu, /\bOAD\b/iu], penalty: 130 }
];

function normalizeSearchText(value) {
  return toKatakana(String(value || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/[!！?？"'`“”‘’\s・･\-–—_/／:：|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
}

function normalizeLooseSearchText(value) {
  return normalizeSearchText(value).replace(/ー/gu, '');
}

function canonicalTitle(value) {
  return normalizeSearchText(value);
}

function titleLooksLikeSeasonSpecific(value) {
  return /第\s*\d+\s*期|\b\d+\s*期\b|Season\s*\d+|\d+(?:st|nd|rd|th)\s+Season/iu.test(String(value || ''));
}

function extractSeasonNumber(value) {
  const text = String(value || '');
  const patterns = [
    /(?:^|[^\d])(\d+)(?:st|nd|rd|th)\s+season/iu,
    /season\s*(\d+)/iu,
    /第\s*(\d+)\s*期/iu,
    /(?:^|[^\d])(\d+)\s*期/iu
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function queryExplicitlyRequestsRule(query, rule) {
  return rule.patterns.some((pattern) => pattern.test(String(query || '')));
}

function analyzeAuxiliaryTitle(query, titles = []) {
  const joined = titles.filter(Boolean).join(' / ');
  const reasons = [];
  let totalPenalty = 0;

  for (const rule of AUXILIARY_TITLE_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(joined))) {
      continue;
    }
    if (queryExplicitlyRequestsRule(query, rule)) {
      continue;
    }
    reasons.push(rule.reason);
    totalPenalty += rule.penalty;
  }

  return {
    reasons,
    totalPenalty,
    hasPenalty: reasons.length > 0
  };
}

function extractSearchAliases(entry) {
  const aliases = new Set([
    entry.titleNative,
    entry.titleKana,
    entry.titleUserPreferred,
    entry.titleRomaji,
    entry.titleEnglish,
    ...(Array.isArray(entry.aliases) ? entry.aliases : [])
  ].filter(Boolean).map(String));
  return Array.from(aliases);
}

function scoreAliasAgainstQuery(queryVariant, alias) {
  const strictQuery = normalizeSearchText(queryVariant);
  const looseQuery = normalizeLooseSearchText(queryVariant);
  const strictAlias = normalizeSearchText(alias);
  const looseAlias = normalizeLooseSearchText(alias);

  if (!strictQuery || !strictAlias) {
    return {
      score: -1_000,
      exact: false,
      normalizedSubstring: false,
      kind: 'none'
    };
  }

  if (strictAlias === strictQuery) {
    return {
      score: 120,
      exact: true,
      normalizedSubstring: false,
      kind: 'strict_exact'
    };
  }
  if (looseAlias && looseQuery && looseAlias === looseQuery) {
    return {
      score: 112,
      exact: true,
      normalizedSubstring: false,
      kind: 'loose_exact'
    };
  }
  if (strictAlias.startsWith(strictQuery)) {
    return {
      score: 96,
      exact: false,
      normalizedSubstring: false,
      kind: 'strict_prefix'
    };
  }
  if (looseAlias && looseQuery && looseAlias.startsWith(looseQuery)) {
    return {
      score: 92,
      exact: false,
      normalizedSubstring: false,
      kind: 'loose_prefix'
    };
  }
  if (strictAlias.includes(strictQuery)) {
    return {
      score: 84,
      exact: false,
      normalizedSubstring: true,
      kind: 'strict_substring'
    };
  }
  if (looseAlias && looseQuery && looseAlias.includes(looseQuery)) {
    return {
      score: 88,
      exact: false,
      normalizedSubstring: true,
      kind: 'loose_substring'
    };
  }
  if (strictQuery.includes(strictAlias) && strictAlias.length >= 3) {
    return {
      score: 68,
      exact: false,
      normalizedSubstring: false,
      kind: 'query_contains_alias'
    };
  }
  if (looseQuery && looseAlias && looseQuery.includes(looseAlias) && looseAlias.length >= 3) {
    return {
      score: 72,
      exact: false,
      normalizedSubstring: false,
      kind: 'loose_query_contains_alias'
    };
  }

  return {
    score: -1_000,
    exact: false,
    normalizedSubstring: false,
    kind: 'none'
  };
}

function analyzeResolvedWorkMatch(query, entry, options = {}) {
  const queryInfo = options.queryInfo || normalizeAnimeSearchQuery(query);
  const queryVariants = buildAnimeSearchQueries(query, queryInfo);
  const normalizedOriginalQuery = normalizeSearchText(queryInfo.original || query);
  const aliases = extractSearchAliases(entry);
  const titles = [
    entry.titleNative,
    entry.titleKana,
    entry.titleUserPreferred,
    entry.titleRomaji,
    entry.titleEnglish,
    ...aliases
  ].filter(Boolean);
  const titleSeasonNumbers = Array.from(new Set(titles.map((value) => extractSeasonNumber(value)).filter(Number.isFinite)));
  const explicitSeasonNumber = extractSeasonNumber(queryInfo.original || query)
    || extractSeasonNumber(queryInfo.canonicalQuery || query);
  const auxiliary = analyzeAuxiliaryTitle(queryInfo.original || queryInfo.canonicalQuery || query, titles);
  let score = 0;
  let exactTitleMatch = false;
  let matchedAliasCanonical = false;
  let matchedNormalizedSubstring = false;

  for (const queryVariant of queryVariants) {
    const isCanonicalVariant = normalizeSearchText(queryVariant) === normalizeSearchText(queryInfo.canonicalQuery || queryVariant);
    for (const alias of aliases) {
      const aliasScore = scoreAliasAgainstQuery(queryVariant, alias);
      if (aliasScore.score < 0) {
        continue;
      }
      let candidateScore = aliasScore.score;
      if (isCanonicalVariant && queryInfo.aliasMatched) {
        candidateScore += aliasScore.exact ? 28 : 18;
        matchedAliasCanonical = true;
      }
      if (aliasScore.normalizedSubstring) {
        matchedNormalizedSubstring = true;
      }
      if (candidateScore > score) {
        score = candidateScore;
      }
      exactTitleMatch ||= aliasScore.exact;
    }
  }

  if (normalizedOriginalQuery.length <= 2 && score < 120) {
    score -= 30;
  }

  let seasonMatchBonusApplied = false;
  let seasonMismatchPenaltyApplied = false;
  let seasonUnknownPenaltyApplied = false;
  if (explicitSeasonNumber) {
    if (titleSeasonNumbers.includes(explicitSeasonNumber)) {
      score += 90;
      seasonMatchBonusApplied = true;
    } else if (titleSeasonNumbers.length) {
      score -= 150;
      seasonMismatchPenaltyApplied = true;
    } else {
      score -= 70;
      seasonUnknownPenaltyApplied = true;
    }
  }

  if (auxiliary.totalPenalty > 0) {
    score -= auxiliary.totalPenalty;
  }

  return {
    score,
    exactTitleMatch,
    explicitSeasonNumber,
    seasonMatchBonusApplied,
    seasonMismatchPenaltyApplied,
    seasonUnknownPenaltyApplied,
    titleSeasonNumbers,
    auxiliaryPenaltyReasons: auxiliary.reasons,
    queryInfo,
    queryVariants,
    matchedAliasCanonical,
    matchedNormalizedSubstring
  };
}

function scoreResolvedWork(query, entry, options = {}) {
  return analyzeResolvedWorkMatch(query, entry, options).score;
}

function rankResolvedWorks(query, entries = [], options = {}) {
  return entries
    .map((entry) => ({
      entry,
      ...analyzeResolvedWorkMatch(query, entry, options)
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);
}

module.exports = {
  normalizeSearchText,
  normalizeLooseSearchText,
  canonicalTitle,
  titleLooksLikeSeasonSpecific,
  extractSeasonNumber,
  extractSearchAliases,
  analyzeResolvedWorkMatch,
  scoreResolvedWork,
  rankResolvedWorks
};
