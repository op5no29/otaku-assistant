const { toKatakana } = require('./annictClient');

const BROAD_FRANCHISE_RULES = [
  {
    franchiseKey: 'sao',
    canonical: 'ソードアート・オンライン',
    queryForms: [
      'SAO',
      'sao',
      'ソードアートオンライン',
      'ソードアート・オンライン'
    ]
  },
  {
    franchiseKey: 'gineiden',
    canonical: '銀河英雄伝説',
    queryForms: [
      '銀河英雄伝説',
      '銀英伝',
      'ぎんえいでん'
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
  return toKatakana(String(value || ''))
    .toLowerCase()
    .replace(/[!！?？"'`“”‘’\s・･\-–—_/／:：|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
}

const compiledFranchiseRules = BROAD_FRANCHISE_RULES.map((rule) => ({
  ...rule,
  canonicalKey: normalizeAliasLookupKey(rule.canonical),
  queryKeys: Array.from(new Set(rule.queryForms.map((value) => normalizeAliasLookupKey(value))))
}));

const compiledNicknameAliases = NICKNAME_ALIASES.map(([alias, canonical]) => ({
  alias,
  canonical,
  aliasKey: normalizeAliasLookupKey(alias),
  canonicalKey: normalizeAliasLookupKey(canonical)
}));

function isBroadFranchiseAliasKind(aliasKind) {
  return String(aliasKind || '') === 'franchise';
}

function getAnimeFranchiseRuleByKey(franchiseKey) {
  return compiledFranchiseRules.find((rule) => rule.franchiseKey === franchiseKey) || null;
}

function getAnimeFranchiseRuleByQuery(value) {
  const key = normalizeAliasLookupKey(value);
  return compiledFranchiseRules.find((rule) => rule.queryKeys.includes(key) || rule.canonicalKey === key) || null;
}

function getAnimeFranchiseKeyFromTitle(value) {
  const key = normalizeAliasLookupKey(value);
  if (!key) {
    return null;
  }
  const match = compiledFranchiseRules.find((rule) => key.includes(rule.canonicalKey));
  return match?.franchiseKey || null;
}

function normalizeAnimeSearchQuery(query) {
  const original = String(query || '').trim();
  const lookupKey = normalizeAliasLookupKey(original);

  const franchiseRule = getAnimeFranchiseRuleByQuery(original);
  if (franchiseRule) {
    const matchedAlias = franchiseRule.canonicalKey === lookupKey
      ? null
      : (franchiseRule.queryForms.find((value) => normalizeAliasLookupKey(value) === lookupKey) || original);
    return {
      original,
      canonicalQuery: franchiseRule.canonical,
      aliasMatched: matchedAlias,
      aliasKind: 'franchise',
      franchiseKey: franchiseRule.franchiseKey
    };
  }

  const nicknameAlias = compiledNicknameAliases.find((entry) => entry.aliasKey === lookupKey);
  if (nicknameAlias) {
    return {
      original,
      canonicalQuery: nicknameAlias.canonical,
      aliasMatched: nicknameAlias.alias,
      aliasKind: 'nickname',
      franchiseKey: getAnimeFranchiseKeyFromTitle(nicknameAlias.canonical)
    };
  }

  return {
    original,
    canonicalQuery: original,
    aliasMatched: null,
    aliasKind: 'exact',
    franchiseKey: getAnimeFranchiseKeyFromTitle(original)
  };
}

module.exports = {
  BROAD_FRANCHISE_RULES,
  NICKNAME_ALIASES,
  normalizeAliasLookupKey,
  normalizeAnimeSearchQuery,
  isBroadFranchiseAliasKind,
  getAnimeFranchiseRuleByKey,
  getAnimeFranchiseRuleByQuery,
  getAnimeFranchiseKeyFromTitle
};
