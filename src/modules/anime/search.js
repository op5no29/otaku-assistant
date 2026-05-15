const { toKatakana } = require('./annictClient');

function normalizeSearchText(value) {
  return toKatakana(String(value || ''))
    .toLowerCase()
    .replace(/[!！?？"'`“”‘’\s・･\-–—_/／:：|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
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

function scoreResolvedWork(query, entry) {
  const normalizedQuery = normalizeSearchText(query);
  const aliases = extractSearchAliases(entry);
  let score = 0;

  for (const alias of aliases) {
    const normalizedAlias = normalizeSearchText(alias);
    if (!normalizedAlias || !normalizedQuery) {
      continue;
    }
    if (normalizedAlias === normalizedQuery) {
      score = Math.max(score, 120);
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
  return score;
}

function rankResolvedWorks(query, entries = []) {
  return entries
    .map((entry) => ({
      entry,
      score: scoreResolvedWork(query, entry)
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score);
}

module.exports = {
  normalizeSearchText,
  extractSearchAliases,
  scoreResolvedWork,
  rankResolvedWorks
};
