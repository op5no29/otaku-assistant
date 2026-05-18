const ANIME_ALIASES = new Map([
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
]);

function normalizeAnimeSearchQuery(query) {
  const original = String(query || '').trim();
  const key = original.toLowerCase();
  for (const [alias, canonical] of ANIME_ALIASES) {
    if (alias.toLowerCase() === key) {
      return { original, canonicalQuery: canonical, aliasMatched: alias };
    }
  }
  return { original, canonicalQuery: original, aliasMatched: null };
}

module.exports = { normalizeAnimeSearchQuery, ANIME_ALIASES };
