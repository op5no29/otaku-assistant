const { toKatakana } = require('./annictClient');

const BROAD_FRANCHISE_RULES = [
  {
    franchiseKey: 'sao',
    canonical: 'ソードアート・オンライン',
    englishTitle: 'Sword Art Online',
    queryForms: [
      'SAO',
      'sao',
      'ソードアートオンライン',
      'ソードアート・オンライン'
    ],
    expansionQueries: [
      'ソードアート・オンライン',
      'ソードアートオンライン',
      'Sword Art Online'
    ]
  },
  {
    franchiseKey: 'gineiden',
    canonical: '銀河英雄伝説',
    englishTitle: 'Legend of the Galactic Heroes',
    queryForms: [
      '銀河英雄伝説',
      '銀英伝',
      'ぎんえいでん'
    ],
    expansionQueries: [
      '銀河英雄伝説',
      'Legend of the Galactic Heroes'
    ]
  },
  {
    franchiseKey: 'overlord',
    canonical: 'オーバーロード',
    englishTitle: 'Overlord',
    queryForms: [
      'オバロ',
      'おばろ',
      'オーバーロード',
      'overlord'
    ],
    expansionQueries: [
      'オーバーロード',
      'Overlord'
    ]
  },
  {
    franchiseKey: 'mha',
    canonical: '僕のヒーローアカデミア',
    englishTitle: 'My Hero Academia',
    queryForms: [
      'ヒロアカ',
      'ひろあか',
      'ヒーロアカデミア',
      'ヒーローアカデミア',
      '僕のヒーローアカデミア',
      'mha',
      'my hero academia'
    ],
    expansionQueries: [
      '僕のヒーローアカデミア',
      'ヒーローアカデミア',
      'ヒーロアカデミア',
      'My Hero Academia'
    ]
  }
];

const NICKNAME_ALIASES = [
  ['ノゲノラ', 'ノーゲーム・ノーライフ'],
  ['noge nora', 'ノーゲーム・ノーライフ'],
  ['notenora', 'ノーゲーム・ノーライフ'],
  ['リゼロ', 'Re:ゼロから始める異世界生活'],
  ['rezero', 'Re:ゼロから始める異世界生活'],
  ['re zero', 'Re:ゼロから始める異世界生活'],
  ['このすば', 'この素晴らしい世界に祝福を！'],
  ['konosuba', 'この素晴らしい世界に祝福を！'],
  ['よりもい', '宇宙よりも遠い場所'],
  ['青ブタ', '青春ブタ野郎'],
  ['aobuta', '青春ブタ野郎'],
  ['俺ガイル', 'やはり俺の青春ラブコメはまちがっている。'],
  ['oregairu', 'やはり俺の青春ラブコメはまちがっている。'],
  ['ダンまち', 'ダンジョンに出会いを求めるのは間違っているだろうか'],
  ['danmachi', 'ダンジョンに出会いを求めるのは間違っているだろうか']
];

function normalizeAliasLookupKey(value) {
  return toKatakana(String(value || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/[!！?？"'`“”‘’\s・･\-–—_/／:：|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
}

function normalizeLooseAliasLookupKey(value) {
  return normalizeAliasLookupKey(value)
    .replace(/ー/gu, '');
}

const compiledFranchiseRules = BROAD_FRANCHISE_RULES.map((rule) => ({
  ...rule,
  canonicalKey: normalizeAliasLookupKey(rule.canonical),
  canonicalLooseKey: normalizeLooseAliasLookupKey(rule.canonical),
  queryKeys: Array.from(new Set(rule.queryForms.map((value) => normalizeAliasLookupKey(value)))),
  queryLooseKeys: Array.from(new Set(rule.queryForms.map((value) => normalizeLooseAliasLookupKey(value)))),
  expansionQueries: Array.from(new Set([
    rule.canonical,
    ...(Array.isArray(rule.expansionQueries) ? rule.expansionQueries : []),
    rule.englishTitle
  ].filter(Boolean).map(String)))
}));

const compiledNicknameAliases = NICKNAME_ALIASES.map(([alias, canonical]) => ({
  alias,
  canonical,
  aliasKey: normalizeAliasLookupKey(alias),
  aliasLooseKey: normalizeLooseAliasLookupKey(alias),
  canonicalKey: normalizeAliasLookupKey(canonical),
  canonicalLooseKey: normalizeLooseAliasLookupKey(canonical)
}));

function dedupeDisplayQueries(values = []) {
  const deduped = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) {
      continue;
    }
    const key = normalizeAliasLookupKey(text);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(text);
  }
  return deduped;
}

function buildBasicQueryVariants(value) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }

  const variants = new Set([text, text.normalize('NFKC')]);
  const noSpaces = text.replace(/\s+/gu, '');
  if (noSpaces) {
    variants.add(noSpaces);
  }
  const noMiddleDots = text.replace(/[・･]/gu, '');
  if (noMiddleDots) {
    variants.add(noMiddleDots);
  }
  const compactPunctuation = text.replace(/[!！?？"'`“”‘’:：\-–—_/／|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
  if (compactPunctuation) {
    variants.add(compactPunctuation);
  }

  return Array.from(variants).map((entry) => entry.trim()).filter(Boolean);
}

function getAnimeFranchiseRuleByKey(franchiseKey) {
  return compiledFranchiseRules.find((rule) => rule.franchiseKey === franchiseKey) || null;
}

function getAnimeFranchiseRuleByQuery(value) {
  const key = normalizeAliasLookupKey(value);
  const looseKey = normalizeLooseAliasLookupKey(value);
  return compiledFranchiseRules.find((rule) => (
    rule.queryKeys.includes(key)
    || rule.queryLooseKeys.includes(looseKey)
    || rule.canonicalKey === key
    || rule.canonicalLooseKey === looseKey
  )) || null;
}

function getAnimeFranchiseKeyFromTitle(value) {
  const key = normalizeAliasLookupKey(value);
  const looseKey = normalizeLooseAliasLookupKey(value);
  if (!key && !looseKey) {
    return null;
  }
  const match = compiledFranchiseRules.find((rule) => (
    (key && key.includes(rule.canonicalKey))
    || (looseKey && looseKey.includes(rule.canonicalLooseKey))
  ));
  return match?.franchiseKey || null;
}

function normalizeAnimeSearchQuery(query) {
  const original = String(query || '').trim();
  const lookupKey = normalizeAliasLookupKey(original);
  const looseLookupKey = normalizeLooseAliasLookupKey(original);

  const franchiseRule = getAnimeFranchiseRuleByQuery(original);
  if (franchiseRule) {
    const exactMatchedAlias = franchiseRule.queryForms.find((value) => normalizeAliasLookupKey(value) === lookupKey);
    const looseMatchedAlias = franchiseRule.queryForms.find((value) => normalizeLooseAliasLookupKey(value) === looseLookupKey);
    const matchedAlias = franchiseRule.canonicalKey === lookupKey || franchiseRule.canonicalLooseKey === looseLookupKey
      ? null
      : (exactMatchedAlias || looseMatchedAlias || original);
    return {
      original,
      canonicalQuery: franchiseRule.canonical,
      aliasMatched: matchedAlias,
      aliasKind: 'franchise',
      franchiseKey: franchiseRule.franchiseKey,
      englishTitle: franchiseRule.englishTitle || null,
      expansionQueries: dedupeDisplayQueries([
        original,
        franchiseRule.canonical,
        ...(franchiseRule.expansionQueries || [])
      ])
    };
  }

  const nicknameAlias = compiledNicknameAliases.find((entry) => (
    entry.aliasKey === lookupKey
    || entry.aliasLooseKey === looseLookupKey
  ));
  if (nicknameAlias) {
    return {
      original,
      canonicalQuery: nicknameAlias.canonical,
      aliasMatched: nicknameAlias.alias,
      aliasKind: 'nickname',
      franchiseKey: getAnimeFranchiseKeyFromTitle(nicknameAlias.canonical),
      englishTitle: null,
      expansionQueries: dedupeDisplayQueries([
        original,
        nicknameAlias.canonical
      ])
    };
  }

  const partialNicknameAlias = compiledNicknameAliases.find((entry) => (
    entry.aliasKey.length >= 3
    && (
      lookupKey.startsWith(entry.aliasKey)
      || looseLookupKey.startsWith(entry.aliasLooseKey)
    )
  ));
  if (partialNicknameAlias) {
    return {
      original,
      canonicalQuery: partialNicknameAlias.canonical,
      aliasMatched: partialNicknameAlias.alias,
      aliasKind: 'nickname',
      franchiseKey: getAnimeFranchiseKeyFromTitle(partialNicknameAlias.canonical),
      englishTitle: null,
      expansionQueries: dedupeDisplayQueries([
        original,
        partialNicknameAlias.canonical
      ])
    };
  }

  return {
    original,
    canonicalQuery: original,
    aliasMatched: null,
    aliasKind: 'exact',
    franchiseKey: getAnimeFranchiseKeyFromTitle(original),
    englishTitle: null,
    expansionQueries: dedupeDisplayQueries([original])
  };
}

function buildAnimeSearchQueries(input, queryInfo = normalizeAnimeSearchQuery(input)) {
  const rule = queryInfo.franchiseKey ? getAnimeFranchiseRuleByKey(queryInfo.franchiseKey) : null;
  return dedupeDisplayQueries([
    queryInfo.original,
    ...buildBasicQueryVariants(queryInfo.original),
    queryInfo.canonicalQuery,
    ...buildBasicQueryVariants(queryInfo.canonicalQuery),
    ...(Array.isArray(queryInfo.expansionQueries) ? queryInfo.expansionQueries : []),
    ...((rule?.expansionQueries) || []),
    queryInfo.englishTitle || null
  ]);
}

module.exports = {
  BROAD_FRANCHISE_RULES,
  NICKNAME_ALIASES,
  normalizeAliasLookupKey,
  normalizeLooseAliasLookupKey,
  dedupeDisplayQueries,
  buildBasicQueryVariants,
  normalizeAnimeSearchQuery,
  buildAnimeSearchQueries,
  getAnimeFranchiseRuleByKey,
  getAnimeFranchiseRuleByQuery,
  getAnimeFranchiseKeyFromTitle
};
