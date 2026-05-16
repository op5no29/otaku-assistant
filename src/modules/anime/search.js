const { toKatakana } = require('./annictClient');

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
  return toKatakana(String(value || ''))
    .toLowerCase()
    .replace(/[!！?？"'`“”‘’\s・･\-–—_/／:：|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
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

function analyzeResolvedWorkMatch(query, entry) {
  const normalizedQuery = normalizeSearchText(query);
  const aliases = extractSearchAliases(entry);
  const canonicalQuery = canonicalTitle(query);
  const titles = [
    entry.titleNative,
    entry.titleUserPreferred,
    entry.titleRomaji,
    entry.titleEnglish,
    ...aliases
  ].filter(Boolean);
  const titleSeasonNumbers = Array.from(new Set(titles.map((value) => extractSeasonNumber(value)).filter(Number.isFinite)));
  const explicitSeasonNumber = extractSeasonNumber(query);
  const auxiliary = analyzeAuxiliaryTitle(query, titles);
  let score = 0;
  let exactTitleMatch = false;

  for (const alias of aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (!normalizedAlias || !normalizedQuery) {
      continue;
    }
    if (normalizedAlias === normalizedQuery) {
      score = Math.max(score, 120);
      exactTitleMatch = true;
    } else if (normalizedAlias.startsWith(normalizedQuery)) {
      score = Math.max(score, 95);
    } else if (normalizedAlias.includes(normalizedQuery)) {
      score = Math.max(score, 80);
    } else if (normalizedQuery.includes(normalizedAlias) && normalizedAlias.length >= 3) {
      score = Math.max(score, 65);
    }
  }

  if (normalizedQuery.length <= 2 && score < 120) {
    score -= 30;
  }

  const primaryTitle = String(entry.titleUserPreferred || entry.titleNative || entry.titleEnglish || entry.titleRomaji || '');
  const canonicalPrimaryTitle = canonicalTitle(primaryTitle);
  if (canonicalPrimaryTitle && canonicalPrimaryTitle === canonicalQuery) {
    score += 20;
    exactTitleMatch = true;
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
    auxiliaryPenaltyReasons: auxiliary.reasons
  };
}

function scoreResolvedWork(query, entry) {
  return analyzeResolvedWorkMatch(query, entry).score;
}

function rankResolvedWorks(query, entries = []) {
  return entries
    .map((entry) => ({
      entry,
      ...analyzeResolvedWorkMatch(query, entry)
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);
}

module.exports = {
  normalizeSearchText,
  canonicalTitle,
  titleLooksLikeSeasonSpecific,
  extractSeasonNumber,
  extractSearchAliases,
  analyzeResolvedWorkMatch,
  scoreResolvedWork,
  rankResolvedWorks
};
