const { parseRelayHashtagPrefixes } = require('../../utils/text');
const {
  searchAnime,
  getAnimeById,
  postAnimeToChannel,
  linkAnimeHashtagSourceToEntry
} = require('./index');
const { buildAnimeLinks, getPreferredAnimeDisplayTitle } = require('./buildAnimeMessages');
const { registerDeletableMessage } = require('../deletableMessages');
const {
  analyzeResolvedWorkMatch,
  canonicalTitle,
  extractSeasonNumber,
  titleLooksLikeSeasonSpecific
} = require('./search');
const {
  prunePostSelectionStore,
  ensurePostSelectionStore,
  analyzePostSelectionPolicy,
  getSelectablePostCandidates,
  buildPostCandidateSelectResponse
} = require('./postSelection');
const { normalizeAnimeImageCandidate } = require('./imagePolicy');
const { normalizeAnimeSearchQuery } = require('./titleAliases');

const GENERIC_SHORT_COMMENTS = new Set([
  '見た',
  'これ好き',
  'test',
  'op好き',
  'ed好き',
  '神',
  '良い',
  'やばい',
  '最高',
  'すき',
  '好き',
  '良かった',
  'いい',
  'op最高'
]);

const INTEGRATION_STATE_TTL_MS = 1000 * 60 * 30;

function ensureReplyStore(client) {
  if (!client.animeHashtagRepliedMessages) {
    client.animeHashtagRepliedMessages = new Set();
  }
  return client.animeHashtagRepliedMessages;
}

function ensureIntegrationStateStore(client) {
  if (!client.animeHashtagIntegrationStates) {
    client.animeHashtagIntegrationStates = new Map();
  }
  return client.animeHashtagIntegrationStates;
}

function getIntegrationState(client, messageId) {
  const store = ensureIntegrationStateStore(client);
  const existing = store.get(messageId);
  if (!existing) {
    return null;
  }
  if (existing.expiresAt <= Date.now()) {
    store.delete(messageId);
    return null;
  }
  return existing;
}

function setIntegrationState(client, messageId, patch) {
  const store = ensureIntegrationStateStore(client);
  const previous = getIntegrationState(client, messageId) || {
    status: 'pending',
    attempts: 0,
    replied: false,
    lastReason: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + INTEGRATION_STATE_TTL_MS
  };
  const next = {
    ...previous,
    ...patch,
    expiresAt: Date.now() + INTEGRATION_STATE_TTL_MS
  };
  store.set(messageId, next);
  return next;
}

function hasAnimeRoute(message, options = {}) {
  const client = message.client;
  const animeChannelId = String(client.appConfig.anime?.channelId || '');
  const routeKeys = Array.isArray(options.matchedRouteKeys) ? options.matchedRouteKeys : [];
  if (!routeKeys.length) {
    return false;
  }

  return routeKeys.some((routeKey) => {
    const route = client.appConfig.globalHashtagRoutes?.[routeKey];
    return String(route?.channelId || '') === animeChannelId;
  });
}

function extractProviderIdFromText(text) {
  const source = String(text || '');
  const annictMatch = source.match(/https?:\/\/annict\.com\/works\/(\d+)(?:\/|$)/iu);
  if (annictMatch?.[1]) {
    return {
      provider: 'annict',
      providerMediaId: annictMatch[1]
    };
  }
  const anilistMatch = source.match(/https?:\/\/anilist\.co\/anime\/(\d+)(?:\/|$)/iu);
  if (anilistMatch?.[1]) {
    return {
      provider: 'anilist',
      providerMediaId: anilistMatch[1]
    };
  }
  return null;
}

function cleanupCandidate(value) {
  return String(value || '')
    .replace(/^[\s"'`“”‘’【『「]+/u, '')
    .replace(/[\s"'`“”‘’】』」]+$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function preserveQuotedCandidateText(value) {
  return String(value || '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function looksLikeGenericComment(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return GENERIC_SHORT_COMMENTS.has(normalized) || normalized.length <= 3;
}

function looksLikeWeakAnimeImpression(text) {
  const normalized = cleanupCandidate(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[!！?？。、,.\s]/gu, '')
    .trim();

  if (!normalized) {
    return true;
  }

  const weakFragments = [
    'いい',
    'すごい',
    '神',
    'やばい',
    '最高',
    '見て',
    'みて',
    'op',
    'ed',
    'オープニング',
    'エンディング',
    'オープニングムービー',
    'ノンクレジット'
  ];

  return weakFragments.some((fragment) => normalized === fragment || normalized.startsWith(fragment));
}

function looksLikeAnimeTitleCandidate(text) {
  const value = cleanupCandidate(text);
  if (!value || looksLikeGenericComment(value)) {
    return false;
  }
  if (looksLikeWeakAnimeImpression(value)) {
    return false;
  }
  if (/[ぁ-んァ-ヶ一-龠々ー]/u.test(value)) {
    return true;
  }
  const words = value.split(/\s+/u).filter(Boolean);
  if (words.length >= 2) {
    return true;
  }
  return /^[A-Z][A-Za-z0-9'!?:.-]+$/u.test(value);
}

function stripNoiseTokens(value) {
  return cleanupCandidate(
    String(value || '')
      .replace(/\bオープニングムービー完全版\b/giu, ' ')
      .replace(/\bオープニングムービー\b/giu, ' ')
      .replace(/\bOpening Movie\b/giu, ' ')
      .replace(/\bTVアニメ\b/giu, ' ')
      .replace(/\bアニメ\b/giu, ' ')
      .replace(/\banime\b/giu, ' ')
      .replace(/\b公式サイト\b/giu, ' ')
      .replace(/\bofficial site\b/giu, ' ')
      .replace(/\bofficial\b/giu, ' ')
      .replace(/\b公式\b/giu, ' ')
      .replace(/\bノンクレジット\b/giu, ' ')
      .replace(/\bノンテロップ\b/giu, ' ')
      .replace(/\bNCOP\b/giu, ' ')
      .replace(/\bNCED\b/giu, ' ')
      .replace(/\bOPテーマ\b/giu, ' ')
      .replace(/\bEDテーマ\b/giu, ' ')
      .replace(/\bOP\b/giu, ' ')
      .replace(/\bED\b/giu, ' ')
      .replace(/\bOpening\b/giu, ' ')
      .replace(/\bEnding\b/giu, ' ')
      .replace(/\bPV\b/giu, ' ')
      .replace(/\bMV\b/giu, ' ')
      .replace(/\bCM\b/giu, ' ')
      .replace(/\bTrailer\b/giu, ' ')
      .replace(/\bTeaser\b/giu, ' ')
      .replace(/\bティザー\b/giu, ' ')
      .replace(/\b予告\b/giu, ' ')
      .replace(/\b主題歌\b/giu, ' ')
      .replace(/\bオープニング\b/giu, ' ')
      .replace(/\bエンディング\b/giu, ' ')
      .replace(/第\s*\d+\s*期/giu, ' ')
      .replace(/\b\d+\s*期\b/giu, ' ')
      .replace(/\bSeason\s*\d+\b/giu, ' ')
      .replace(/\b\d+(?:st|nd|rd|th)\s+Season\b/giu, ' ')
      .replace(/\b\d+(?:st|nd|rd|th)\s*season\b/giu, ' ')
      .replace(/\b\d+\s*season\b/giu, ' ')
      .replace(/\bEpisode\b/giu, ' ')
      .replace(/\bEp\.\b/giu, ' ')
      .replace(/第\s*\d+\s*話/giu, ' ')
      .replace(/#\d+/gu, ' ')
      .replace(/\bfull\b/giu, ' ')
      .replace(/\bshort\b/giu, ' ')
      .replace(/\blyric video\b/giu, ' ')
      .replace(/\b歌詞\b/giu, ' ')
  );
}

function splitLikelyTitleSegments(value) {
  return String(value || '')
    .split(/\s*(?:\||｜| - | – | — |\/|／|:|：)\s*/u)
    .map(cleanupCandidate)
    .filter(Boolean);
}

function extractQuotedOfficialTitle(raw) {
  const text = String(raw || '');
  const patterns = [
    /[「『【]([^」』】]+)[」』】]\s*アニメ公式サイト/iu,
    /[「『【]([^」』】]+)[」』】]\s*公式サイト/iu,
    /アニメ[「『【]([^」』】]+)[」』】]\s*公式サイト/iu,
    /TVアニメ[「『【]([^」』】]+)(?:[」』】]|$)/iu,
    /アニメ[「『【]([^」』】]+)(?:[」』】]|$)/iu,
    /[「『【]([^」』】]{2,120})(?:[」』】]|$)/iu
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanupCandidate(match[1]);
    }
  }
  return null;
}

function extractUnclosedQuotedTitle(raw) {
  const text = String(raw || '');
  const match = text.match(/(?:TVアニメ|アニメ)?[「『【]([^|｜\n\r]+?)(?:公式サイト|公式|OP|ED|Opening|Ending|PV|MV|Trailer|Teaser|主題歌|ノンクレジット|ノンテロップ|$)/iu);
  return match?.[1] ? cleanupCandidate(match[1]) : null;
}

// Extract anime title from YouTube OP/ED video title format.
// Handles: 【optional_metadata】ANIME_TITLE OP/ED SONG_TITLE...
// Returns the ANIME_TITLE part, or null if the pattern doesn't match.
function extractYouTubeOpEdTitle(raw) {
  const text = String(raw || '');
  // Allow zero or more leading 【metadata】 brackets (e.g. 【高画質】, 【HD】, 【公式】)
  // then capture the anime title (stops at 「『【 to avoid grabbing song title brackets)
  // then require an OP/ED keyword
  const match = text.match(
    /^(?:【[^【】]{1,20}】\s*)*([^【「『\n\r]{2,60}?)\s+(?:OP|ED|Opening|Ending|オープニング|エンディング|ノンクレジット|主題歌|MV|PV)\b/iu
  );
  if (!match?.[1]) return null;
  const cleaned = cleanupCandidate(stripNoiseTokens(match[1]));
  return cleaned && cleaned.length >= 2 ? cleaned : null;
}

function normalizeAnimeCandidateTitle(rawTitle) {
  const rawSource = String(rawTitle || '').trim();
  const raw = cleanupCandidate(rawSource);
  if (!raw) {
    return {
      rawTitle: '',
      normalizedCandidate: '',
      candidates: [],
      reason: 'empty'
    };
  }

  const candidates = [];
  const addCandidate = (value, reason, weight = 0) => {
    const normalized = cleanupCandidate(stripNoiseTokens(value));
    if (!normalized) {
      return;
    }
    if (!candidates.some((entry) => entry.value === normalized)) {
      candidates.push({ value: normalized, reason, weight });
    }
  };

  // Highest priority: YouTube OP/ED title format (weight 90 > extractQuotedOfficialTitle's 70).
  // Handles 【高画質】アサシンズプライド OP 『song』 → アサシンズプライド
  const youtubeOpEdTitle = extractYouTubeOpEdTitle(rawSource);
  if (youtubeOpEdTitle) {
    addCandidate(youtubeOpEdTitle, 'youtube_op_ed_title', 90);
  }

  const quotedOfficialTitle = extractQuotedOfficialTitle(rawSource);
  if (quotedOfficialTitle) {
    addCandidate(quotedOfficialTitle, 'quoted_official_title', 70);
  }
  const unclosedQuotedTitle = extractUnclosedQuotedTitle(rawSource);
  if (unclosedQuotedTitle) {
    addCandidate(unclosedQuotedTitle, 'unclosed_quoted_title', 65);
  }

  const bracketPatterns = [
    /(?:TVアニメ|アニメ|anime)[「『【]([^」』】]+)[」』】]/iu,
    /(?:TVアニメ|アニメ|anime)[「『【]([^|｜\n\r]+)$/iu,
    /(?:TVアニメ|アニメ)[“"]([^”"]+)(?:[”"]|$)/iu,
    /(?:TVアニメ|アニメ)\s+(.+?)\s*(?:公式|OP|ED|Opening|Ending|PV|MV|CM|Trailer|Teaser|主題歌|オープニング|エンディング|ノンクレジット|ノンテロップ|$)/iu,
    /[【『「]([^】』」]+)[】』」]\s*(?:第\s*\d+\s*期|\d+\s*期|Season\s*\d+|\d+(?:st|nd|rd|th)\s+Season)?\s*(?:OP|ED|Opening|Ending|PV|MV|CM|Trailer|Teaser|主題歌|オープニング|エンディング)/iu,
    /[【『「]([^】』」|｜\n\r]+)(?:$|\s*(?:公式|OP|ED|Opening|Ending|PV|MV|CM|Trailer|Teaser|主題歌|オープニング|エンディング))/iu,
    /^(.*?)\s*(?:Opening|Ending|OP|ED)\b/iu
  ];

  for (const pattern of bracketPatterns) {
    const match = rawSource.match(pattern);
    if (match?.[1]) {
      addCandidate(match[1], 'pattern_extract', 40);
    }
  }

  const bracketMatches = Array.from(rawSource.matchAll(/[【『「]([^】』」]{2,120})[】』」]/gu));
  for (const match of bracketMatches) {
    addCandidate(match[1], 'bracket_extract', 25);
  }

  const segments = splitLikelyTitleSegments(raw);
  if (segments.length) {
    addCandidate(segments[0], 'leading_segment', 15);
  }

  addCandidate(raw, 'raw', 5);

  const normalizedCandidate = candidates.sort((left, right) => right.weight - left.weight)[0]?.value || '';
  return {
    rawTitle: raw,
    normalizedCandidate,
    candidates,
    reason: normalizedCandidate ? 'normalized' : 'empty'
  };
}

function extractExplicitTitleLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:作品名|title|anime|アニメ)\s*[:：]\s*(.+)\s*$/iu);
    if (match?.[1]) {
      return cleanupCandidate(match[1]);
    }
  }
  return null;
}

const GENERIC_CHANNEL_TERMS = [
  'アニメ主題歌', '主題歌', 'アニソン', '映像保存庫', '映像庫', '保存庫',
  'anime op', 'anime ed', 'anime song', 'anime music', 'anime ost',
  'opening archive', 'ending archive', 'op/ed', 'ost', '音楽保存庫'
];

function isGenericYouTubeChannelName(authorName) {
  const text = String(authorName || '').trim();
  if (!text) return false;
  // Official channels with a quoted anime title are not generic
  // e.g. 「Re:ゼロから始める異世界生活」チャンネル【公式】
  if (/[「『"].*?[」』"]/.test(text)) return false;
  const lower = text.toLowerCase();
  return GENERIC_CHANNEL_TERMS.some((term) => lower.includes(term));
}

function extractCandidateFromEmbeds(message) {
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  const candidates = [];
  for (const embed of embeds) {
    const sources = [
      ['embed_description', preserveQuotedCandidateText(embed?.description || '')],
      ['embed_author', preserveQuotedCandidateText(embed?.author?.name || '')],
      ['embed_title', preserveQuotedCandidateText(embed?.title || '')],
      ['embed_provider', cleanupCandidate(embed?.provider?.name || '')]
    ];

    for (const [index, [sourceType, rawTitle]] of sources.entries()) {
      if (!rawTitle) {
        continue;
      }
      candidates.push({
        sourceType,
        rawTitle,
        priority: 400 - (index * 10),
        embedUrl: embed?.url || null,
        embedProvider: cleanupCandidate(embed?.provider?.name || embed?.data?.provider?.name || ''),
        embedDescription: preserveQuotedCandidateText(embed?.description || ''),
        embedAuthor: preserveQuotedCandidateText(embed?.author?.name || '')
      });
    }
  }
  return candidates;
}

function extractAnimeCandidateFromHashtagPost(message, options = {}) {
  const parsed = parseRelayHashtagPrefixes(message.content || '', {
    globalRoutes: message.client.appConfig.globalHashtagRoutes,
    botRoutes: message.client.appConfig.botHashtagRoutes
  });
  const cleanedContent = cleanupCandidate(options.cleanedContent || parsed.content || '');
  const consideredSources = [];
  const hasUrl = /https?:\/\//iu.test(String(message.content || ''));
  const providerId = extractProviderIdFromText(message.content || '');
  if (providerId) {
    return {
      winner: {
        sourceType: `${providerId.provider}_url`,
        providerMediaId: providerId.providerMediaId,
        provider: providerId.provider,
        rawTitle: null,
        cleanedContent
      },
      consideredSources
    };
  }

  const explicitTitle = extractExplicitTitleLine(cleanedContent);
  if (explicitTitle) {
    const winner = {
      sourceType: 'explicit_title_line',
      rawTitle: explicitTitle,
      cleanedContent
    };
    consideredSources.push({
      sourceType: winner.sourceType,
      rawTitle: winner.rawTitle,
      normalizedCandidate: winner.rawTitle,
      priority: 500,
      rejectedReason: null
    });
    return { winner, consideredSources };
  }

  const embedCandidates = extractCandidateFromEmbeds(message);
  for (const embedCandidate of embedCandidates) {
    // Reject generic YouTube upload/archive channel names for embed_author.
    // These are never anime titles, and their presence before embed_title in the
    // priority order would otherwise block the actual title from being used.
    if (embedCandidate.sourceType === 'embed_author' && isGenericYouTubeChannelName(embedCandidate.rawTitle)) {
      consideredSources.push({
        sourceType: embedCandidate.sourceType,
        rawTitle: embedCandidate.rawTitle,
        normalizedCandidate: null,
        priority: embedCandidate.priority,
        rejectedReason: 'generic_youtube_author',
        embedUrl: embedCandidate.embedUrl || null,
        embedProvider: embedCandidate.embedProvider || null
      });
      continue;
    }
    const normalized = normalizeAnimeCandidateTitle(embedCandidate.rawTitle);
    const rejectedReason = normalized.normalizedCandidate
      ? null
      : 'normalized_candidate_missing';
    consideredSources.push({
      sourceType: embedCandidate.sourceType,
      rawTitle: embedCandidate.rawTitle,
      normalizedCandidate: normalized.normalizedCandidate || null,
      priority: embedCandidate.priority,
      rejectedReason,
      embedUrl: embedCandidate.embedUrl || null,
      embedProvider: embedCandidate.embedProvider || null
    });
    if (!rejectedReason) {
      return {
        winner: {
          ...embedCandidate,
          cleanedContent,
          normalizedCandidate: normalized.normalizedCandidate || null,
          candidateVariants: normalized.candidates || []
        },
        consideredSources
      };
    }
  }

  const lines = cleanedContent.split(/\r?\n/).map(cleanupCandidate).filter(Boolean);
  const firstMeaningfulLine = lines.find((line) => !/^https?:\/\//iu.test(line));
  if (firstMeaningfulLine) {
    const rejectedReason = hasUrl
      ? 'url_post_content_ignored'
      : (looksLikeAnimeTitleCandidate(firstMeaningfulLine) ? null : 'weak_or_generic_content');
    consideredSources.push({
      sourceType: 'content_title',
      rawTitle: firstMeaningfulLine,
      normalizedCandidate: rejectedReason ? null : normalizeAnimeCandidateTitle(firstMeaningfulLine).normalizedCandidate || null,
      priority: 100,
      rejectedReason
    });
    if (!rejectedReason) {
      const normalized = normalizeAnimeCandidateTitle(firstMeaningfulLine);
      return {
        winner: {
          sourceType: 'content_title',
          rawTitle: firstMeaningfulLine,
          cleanedContent,
          normalizedCandidate: normalized.normalizedCandidate || null,
          candidateVariants: normalized.candidates || []
        },
        consideredSources
      };
    }
  }

  return { winner: null, consideredSources };
}

function extractCandidateSeasonContext(candidate) {
  const rawText = String(candidate?.rawTitle || candidate?.normalizedCandidate || '');
  const normalizedText = String(candidate?.normalizedCandidate || '');
  return {
    explicitSeasonNumber: extractSeasonNumber(rawText),
    rawLooksSeasonSpecific: titleLooksLikeSeasonSpecific(rawText),
    normalizedLooksSeasonSpecific: titleLooksLikeSeasonSpecific(normalizedText),
    hasSpecialLikeTerms: /\bOVA\b|\bOAD\b|\bMovie\b|劇場版|Memory Snow|氷結の絆|\bSpecials?\b|\bSP\b/iu.test(rawText)
  };
}

function extractMediaSeasonInfo(media) {
  const title = String(
    media?.titleUserPreferred
    || media?.titleNative
    || media?.titleEnglish
    || media?.titleRomaji
    || ''
  );
  return {
    seasonNumber: extractSeasonNumber(title),
    isSpecialLike: /\bOVA\b|\bOAD\b|\bMovie\b|劇場版|Memory Snow|氷結の絆|\bSpecials?\b|\bSP\b/iu.test(title),
    isSeasonSpecific: titleLooksLikeSeasonSpecific(title)
  };
}

function scoreAniListCandidate(candidate, media) {
  if (candidate.sourceType === 'anilist_url' || candidate.sourceType === 'annict_url') {
    return {
      score: 999,
      reason: 'explicit_anilist_url',
      seasonPenaltyReason: null
    };
  }

  const candidateSeasonContext = extractCandidateSeasonContext(candidate);
  const mediaSeasonInfo = extractMediaSeasonInfo(media);
  const matchQuery = candidate.searchQueryInfo?.canonicalQuery || candidate.normalizedCandidate || candidate.rawTitle || '';
  const baseAnalysis = analyzeResolvedWorkMatch(matchQuery, media);
  const candidateTitle = canonicalTitle(matchQuery);
  const titles = [
    media.titleNative,
    media.titleUserPreferred,
    media.titleRomaji,
    media.titleEnglish,
    ...(Array.isArray(media.aliases) ? media.aliases : [])
  ].filter(Boolean);
  const canonicalTitles = titles.map((value) => canonicalTitle(value));
  let score = baseAnalysis.score;
  let reason = 'weak_match';
  let seasonPenaltyReason = null;

  if (baseAnalysis.exactTitleMatch || canonicalTitles.includes(candidateTitle)) {
    reason = 'exact_title';
  }
  if (canonicalTitle(media.titleNative) === candidateTitle) {
    score += 15;
    reason = 'exact_native_title';
  }
  if (!baseAnalysis.exactTitleMatch && canonicalTitles.some((value) => value.includes(candidateTitle) || candidateTitle.includes(value))) {
    score += 20;
  }

  if (candidate.sourceType === 'explicit_title_line') {
    score += 20;
  } else if (candidate.sourceType === 'embed_description' || candidate.sourceType === 'embed_author') {
    score += 16;
  } else if (candidate.sourceType === 'embed_title') {
    score += 8;
  } else if (candidate.sourceType === 'content_title') {
    score += 1;
  }

  if (String(media.format || '') === 'TV') {
    score += 8;
  } else if (['MOVIE', 'OVA', 'ONA', 'SPECIAL'].includes(String(media.format || ''))) {
    score -= 8;
  }

  if (candidateSeasonContext.explicitSeasonNumber) {
    if (mediaSeasonInfo.seasonNumber && mediaSeasonInfo.seasonNumber !== candidateSeasonContext.explicitSeasonNumber) {
      score -= 90;
      seasonPenaltyReason = 'season_number_mismatch';
    } else if (mediaSeasonInfo.seasonNumber === candidateSeasonContext.explicitSeasonNumber) {
      score += 35;
    } else if (mediaSeasonInfo.isSpecialLike) {
      score -= 70;
      seasonPenaltyReason = 'special_mismatch';
    }
  } else if (!candidateSeasonContext.rawLooksSeasonSpecific && !candidateSeasonContext.normalizedLooksSeasonSpecific) {
    if (mediaSeasonInfo.isSpecialLike) {
      score -= 70;
      seasonPenaltyReason = 'special_ambiguity';
    } else if (mediaSeasonInfo.isSeasonSpecific) {
      score -= 60;
      seasonPenaltyReason = 'season_ambiguity';
    }
  }

  if (!titleLooksLikeSeasonSpecific(candidate.rawTitle || candidate.normalizedCandidate || '') && titleLooksLikeSeasonSpecific(media.titleUserPreferred || media.titleRomaji || media.titleNative || media.titleEnglish || '')) {
    score -= 12;
    seasonPenaltyReason ||= 'season_specific_title_penalty';
  } else if (!titleLooksLikeSeasonSpecific(media.titleUserPreferred || media.titleRomaji || media.titleNative || media.titleEnglish || '')) {
    score += 5;
  }

  return {
    score,
    reason,
    seasonPenaltyReason,
    candidateSeasonContext,
    mediaSeasonNumber: mediaSeasonInfo.seasonNumber,
    mediaIsSpecialLike: mediaSeasonInfo.isSpecialLike,
    exactTitleMatch: baseAnalysis.exactTitleMatch,
    seasonMatchBonusApplied: baseAnalysis.seasonMatchBonusApplied || mediaSeasonInfo.seasonNumber === candidateSeasonContext.explicitSeasonNumber,
    crossoverOrSpecialPenaltyReasons: baseAnalysis.auxiliaryPenaltyReasons
  };
}

function shouldAutoRegisterAnime(scoreResult) {
  if (!scoreResult?.top) {
    return false;
  }
  if (scoreResult.candidate?.sourceType === 'anilist_url' || scoreResult.candidate?.sourceType === 'annict_url') {
    return true;
  }
  if (scoreResult.pickerPolicy?.requireSelection) {
    return false;
  }
  if ((scoreResult.sameSeasonCandidateCount || 0) > 1) {
    return false;
  }
  if (scoreResult.top?.seasonPenaltyReason) {
    return false;
  }
  if (scoreResult.candidate?.sourceType === 'explicit_title_line') {
    return scoreResult.top.score >= 80 && scoreResult.scoreGap >= 8;
  }
  if (scoreResult.candidate?.sourceType === 'embed_title' || scoreResult.candidate?.sourceType === 'embed_author' || scoreResult.candidate?.sourceType === 'embed_description') {
    return scoreResult.top.score >= 88 && scoreResult.scoreGap >= 12;
  }
  if (scoreResult.candidate?.sourceType === 'content_title') {
    return scoreResult.top.score >= 92 && scoreResult.scoreGap >= 15;
  }
  return false;
}

function getAutoRegisterSkipReason(scoreResult) {
  if (!scoreResult?.top) {
    return 'no_search_result';
  }
  if (scoreResult.pickerPolicy?.reason === 'franchise_alias') {
    return 'franchise_alias';
  }
  if (scoreResult.pickerPolicy?.reason === 'broad_franchise_results') {
    return 'broad_franchise_results';
  }
  if (scoreResult.sameSeasonCandidateCount > 1) {
    return 'same_season_ambiguity';
  }
  if (scoreResult.top?.seasonPenaltyReason === 'season_number_mismatch') {
    return 'season_mismatch';
  }
  if (scoreResult.top?.seasonPenaltyReason === 'season_ambiguity' || scoreResult.top?.seasonPenaltyReason === 'season_specific_title_penalty') {
    return 'season_ambiguity';
  }
  if (scoreResult.top?.seasonPenaltyReason === 'special_mismatch' || scoreResult.top?.seasonPenaltyReason === 'special_ambiguity') {
    return 'special_ambiguity';
  }
  return 'confidence_below_threshold';
}

async function maybeReplyAskForTitle(message, reason) {
  const state = getIntegrationState(message.client, message.id);
  const store = ensureReplyStore(message.client);
  if (store.has(message.id)) {
    return false;
  }
  if (state?.status === 'success') {
    message.client.logger.info('anime hashtag failure reply suppressed because success already happened', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      reason
    });
    return false;
  }
  store.add(message.id);
  setIntegrationState(message.client, message.id, { replied: true });
  await message.reply({
    content: [
      'アニメ作品を自動判定できませんでした。',
      '作品名が分かる場合は `作品名: ...` を付けて投稿するか、`/anime post title:` を使って登録してください。'
    ].join('\n'),
    allowedMentions: { parse: [] }
  }).catch(() => null);
  message.client.logger.info('anime hashtag source reply sent', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    reason
  });
  return true;
}

async function maybeReplyAskForSelection(message, reason) {
  const state = getIntegrationState(message.client, message.id);
  const store = ensureReplyStore(message.client);
  if (store.has(message.id)) {
    return false;
  }
  if (state?.status === 'success') {
    return false;
  }
  store.add(message.id);
  setIntegrationState(message.client, message.id, { replied: true });
  const replyPayload = {
    content: [
      'アニメ作品の候補が複数あります。',
      '作品名を指定して `/anime post title:` から選択してください。'
    ].join('\n'),
    allowedMentions: { parse: [] }
  };
  await message.reply(replyPayload).catch(() => null);
  message.client.logger.info('anime hashtag source reply sent', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    reason
  });
  return 'text';
}

async function maybeReplyAskForSelectionUi(message, detectedTitle, candidates, reason, options = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return maybeReplyAskForSelection(message, reason);
  }

  const state = getIntegrationState(message.client, message.id);
  const store = ensureReplyStore(message.client);
  if (store.has(message.id)) {
    return false;
  }
  if (state?.status === 'success') {
    return false;
  }

  const selectable = getSelectablePostCandidates(detectedTitle, candidates, options);
  if (!selectable.length) {
    return maybeReplyAskForSelection(message, reason);
  }

  prunePostSelectionStore(message.client);
  ensurePostSelectionStore(message.client).set(message.id, {
    userId: message.author.id,
    guildId: message.guildId,
    title: detectedTitle,
    candidates: selectable,
    expiresAt: Date.now() + (1000 * 60 * 10)
  });

  store.add(message.id);
  setIntegrationState(message.client, message.id, { replied: true });
  await message.reply({
    ...buildPostCandidateSelectResponse(detectedTitle, selectable, message.id, message.author.id, options),
    allowedMentions: { parse: [] }
  }).catch(() => null);
  message.client.logger.info('anime hashtag source reply sent', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    reason
  });
  return 'picker';
}

function resolveRelativeUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return raw;
  }
}

function collectMessageImageCandidates(message) {
  const candidates = [];
  for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
    const baseUrl = embed?.url || null;
    for (const [kind, candidate] of [['thumbnail', embed?.thumbnail?.url], ['image', embed?.image?.url]]) {
      const resolved = resolveRelativeUrl(candidate, baseUrl);
      const normalized = normalizeAnimeImageCandidate({
        url: resolved,
        kind,
        source: `message.embed.${kind}`
      });
      if (normalized && !candidates.some((entry) => entry.url === normalized.url)) {
        candidates.push(normalized);
      }
    }
  }
  return candidates;
}

async function resolveAnimeCandidate(client, candidate) {
  if (!candidate) {
    return {
      candidate,
      results: [],
      top: null,
      second: null,
      scoreGap: 0
    };
  }

  if ((candidate.sourceType === 'anilist_url' || candidate.sourceType === 'annict_url') && candidate.providerMediaId) {
    const media = await getAnimeById(client, candidate.providerMediaId, client.appConfig.anime.maxCastInCard, candidate.provider || null);
    return {
      candidate,
      results: media ? [{ media, score: 999, reason: 'explicit_anilist_url' }] : [],
      top: media ? { media, score: 999, reason: 'explicit_anilist_url' } : null,
      second: null,
      scoreGap: 999
    };
  }

  const queryInfo = candidate.searchQueryInfo || normalizeAnimeSearchQuery(candidate.normalizedCandidate || candidate.rawTitle);
  const results = await searchAnime(client, queryInfo.canonicalQuery || candidate.normalizedCandidate || candidate.rawTitle);
  const scored = results.map((media) => ({
    media,
    ...scoreAniListCandidate(candidate, media)
  })).sort((left, right) => right.score - left.score);
  const explicitSeasonNumber = extractCandidateSeasonContext(candidate).explicitSeasonNumber;
  const sameSeasonCandidates = explicitSeasonNumber
    ? scored.filter((result) => (
      result.mediaSeasonNumber === explicitSeasonNumber
      && !result.mediaIsSpecialLike
      && (!Array.isArray(result.crossoverOrSpecialPenaltyReasons) || result.crossoverOrSpecialPenaltyReasons.length === 0)
      && result.score >= Math.max((scored[0]?.score || 0) - 12, 80)
    ))
    : [];

  return {
    candidate,
    queryInfo,
    results: scored,
    top: scored[0] || null,
    second: scored[1] || null,
    scoreGap: (scored[0]?.score || 0) - (scored[1]?.score || 0),
    sameSeasonCandidates,
    sameSeasonCandidateCount: sameSeasonCandidates.length
  };
}

async function maybeWaitForYoutubeEmbeds(message, logger) {
  const hasUrl = /https?:\/\//iu.test(String(message.content || ''));
  if (!hasUrl) {
    return message;
  }

  let workingMessage = message;
  const initialEmbedCount = Array.isArray(message.embeds) ? message.embeds.length : 0;
  if (initialEmbedCount > 0) {
    logger.info('anime hashtag delayed refetch embeds found', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      attempt: 0,
      embedCount: initialEmbedCount
    });
    return message;
  }

  const delays = [3000, 5000];
  for (let index = 0; index < delays.length; index += 1) {
    logger.info('anime hashtag delayed refetch scheduled', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      attempt: index + 1,
      delayMs: delays[index]
    });
    await new Promise((resolve) => setTimeout(resolve, delays[index]));
    logger.info('anime hashtag delayed refetch started', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      attempt: index + 1
    });
    workingMessage = await message.channel.messages.fetch(message.id).catch(() => workingMessage);
    const embedCount = Array.isArray(workingMessage?.embeds) ? workingMessage.embeds.length : 0;
    logger.info('anime hashtag delayed refetch embeds found', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      attempt: index + 1,
      embedCount
    });
    if (embedCount > 0) {
      return workingMessage || message;
    }
  }

  return workingMessage || message;
}

async function handleAnimeHashtagPost(message, options = {}) {
  const client = message.client;
  const logger = client.logger;

  if (!message.inGuild?.()) {
    return;
  }

  logger.info('anime hashtag integration started', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    matchedRouteKeys: options.matchedRouteKeys || []
  });

  if (!hasAnimeRoute(message, options)) {
    logger.info('anime hashtag integration skipped not anime route', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId
    });
    return;
  }

  try {
    const existingState = getIntegrationState(client, message.id);
    if (existingState?.status === 'pending' || existingState?.status === 'success' || existingState?.status === 'skipped_no_candidate' || existingState?.status === 'skipped_ambiguous') {
      logger.info('anime hashtag duplicate invocation skipped', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        status: existingState.status,
        attempts: existingState.attempts
      });
      return;
    }

    setIntegrationState(client, message.id, {
      status: 'pending',
      attempts: 0,
      lastReason: 'started'
    });
    logger.info('anime hashtag integration state created', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId
    });

    const integrationMessage = await maybeWaitForYoutubeEmbeds(message, logger);
    setIntegrationState(client, message.id, {
      attempts: 1,
      lastReason: 'candidate_extraction'
    });
    logger.info('anime hashtag source embeds snapshot', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      embedCount: Array.isArray(integrationMessage.embeds) ? integrationMessage.embeds.length : 0,
      embeds: (Array.isArray(integrationMessage.embeds) ? integrationMessage.embeds : []).slice(0, 3).map((embed) => ({
        title: embed?.title || null,
        description: embed?.description || null,
        author: embed?.author?.name || null,
        provider: embed?.provider?.name || null,
        url: embed?.url || null
      }))
    });

    const extraction = extractAnimeCandidateFromHashtagPost(integrationMessage, options);
    for (const considered of extraction.consideredSources || []) {
      logger.info('anime candidate source considered', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        sourceType: considered.sourceType,
        rawTitle: considered.rawTitle || null,
        normalizedCandidate: considered.normalizedCandidate || null,
        priority: considered.priority ?? null,
        rejectedReason: considered.rejectedReason || null,
        embedUrl: considered.embedUrl || null,
        embedProvider: considered.embedProvider || null
      });
    }
    const extracted = extraction.winner;
    if (!extracted) {
      setIntegrationState(client, message.id, {
        status: 'skipped_no_candidate',
        lastReason: 'no_candidate'
      });
      logger.info('anime hashtag skipped no candidate', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId
      });
      return;
    }

    const candidate = {
      ...extracted,
      rawTitle: extracted.rawTitle || null,
      normalizedCandidate: extracted.normalizedCandidate || null,
      candidateVariants: extracted.candidateVariants || []
    };

    logger.info('anime hashtag candidate extracted', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      sourceType: candidate.sourceType,
      rawTitle: candidate.rawTitle,
      normalizedCandidate: candidate.normalizedCandidate || null,
      providerMediaId: candidate.providerMediaId || null,
      embedProvider: candidate.embedProvider || null,
      embedUrl: candidate.embedUrl || null
    });

    if (candidate.rawTitle) {
    logger.info('anime hashtag candidate normalized', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        rawTitle: candidate.rawTitle,
        normalizedCandidate: candidate.normalizedCandidate,
        variants: candidate.candidateVariants.map((entry) => entry.value)
      });
    }
    logger.info('anime candidate season context', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      sourceType: candidate.sourceType,
      rawTitle: candidate.rawTitle || null,
      normalizedCandidate: candidate.normalizedCandidate || null,
      seasonContext: extractCandidateSeasonContext(candidate)
    });
    logger.info('anime candidate winner selected', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      sourceType: candidate.sourceType,
      normalizedCandidate: candidate.normalizedCandidate || null,
      whyItWon: candidate.sourceType === 'content_title' ? 'fallback_after_embed_sources' : 'higher_priority_source'
    });
    const searchQueryInfo = normalizeAnimeSearchQuery(candidate.normalizedCandidate || candidate.rawTitle || '');
    logger.info('anime search alias kind detected', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      original: searchQueryInfo.original,
      canonicalQuery: searchQueryInfo.canonicalQuery,
      aliasMatched: searchQueryInfo.aliasMatched || null,
      aliasKind: searchQueryInfo.aliasKind,
      franchiseKey: searchQueryInfo.franchiseKey || null
    });

    if (!candidate.providerMediaId && !candidate.normalizedCandidate) {
      setIntegrationState(client, message.id, {
        status: 'skipped_no_candidate',
        lastReason: 'normalized_candidate_missing'
      });
      if (['explicit_title_line', 'embed_title', 'embed_author', 'embed_description'].includes(candidate.sourceType)) {
        await maybeReplyAskForTitle(message, 'normalized_candidate_missing');
        logger.info('anime hashtag final failure reply sent', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          reason: 'normalized_candidate_missing'
        });
      }
      return;
    }

    logger.info('anime hashtag provider search started', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      sourceType: candidate.sourceType,
      query: searchQueryInfo.canonicalQuery || candidate.normalizedCandidate || candidate.rawTitle || null,
      normalizedCandidate: candidate.normalizedCandidate || null,
      canonicalQuery: searchQueryInfo.canonicalQuery || null,
      aliasKind: searchQueryInfo.aliasKind,
      providerMediaId: candidate.providerMediaId || null
    });

    const resolved = await resolveAnimeCandidate(client, {
      ...candidate,
      searchQueryInfo
    });
    logger.info('anime hashtag provider search result', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      resultCount: resolved.results.length,
      topScore: resolved.top?.score || 0,
      secondScore: resolved.second?.score || 0,
      sameSeasonCandidateCount: resolved.sameSeasonCandidateCount || 0,
      providerMediaId: resolved.top?.media?.providerMediaId || null,
      titleNative: resolved.top?.media?.titleNative || null,
      topResults: resolved.results.slice(0, 3).map((result) => ({
        title: result.media?.titleNative || result.media?.titleUserPreferred || result.media?.titleEnglish || null,
        providerMediaId: result.media?.providerMediaId || null,
        score: result.score,
        reason: result.reason,
        seasonPenaltyReason: result.seasonPenaltyReason || null,
        mediaSeasonNumber: result.mediaSeasonNumber || null,
        mediaIsSpecialLike: result.mediaIsSpecialLike || false,
        exactTitleMatch: result.exactTitleMatch || false,
        seasonMatchBonusApplied: result.seasonMatchBonusApplied || false,
        crossoverOrSpecialPenaltyReasons: result.crossoverOrSpecialPenaltyReasons || []
      }))
    });
    for (const result of resolved.results.slice(0, 5)) {
      if (result.exactTitleMatch) {
        logger.info('anime result exact title bonus', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          providerMediaId: result.media?.providerMediaId || null,
          titleNative: result.media?.titleNative || result.media?.titleUserPreferred || null
        });
      }
      if (result.seasonMatchBonusApplied) {
        logger.info('anime result season match bonus', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          providerMediaId: result.media?.providerMediaId || null,
          titleNative: result.media?.titleNative || result.media?.titleUserPreferred || null,
          mediaSeasonNumber: result.mediaSeasonNumber || null
        });
      }
      if (Array.isArray(result.crossoverOrSpecialPenaltyReasons) && result.crossoverOrSpecialPenaltyReasons.length) {
        logger.info('anime result rejected crossover_or_special', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          providerMediaId: result.media?.providerMediaId || null,
          titleNative: result.media?.titleNative || result.media?.titleUserPreferred || null,
          reasons: result.crossoverOrSpecialPenaltyReasons
        });
      }
      if (result.seasonPenaltyReason) {
        logger.info('anime result season penalty', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          providerMediaId: result.media?.providerMediaId || null,
          titleNative: result.media?.titleNative || result.media?.titleUserPreferred || null,
          seasonPenaltyReason: result.seasonPenaltyReason,
          mediaSeasonNumber: result.mediaSeasonNumber || null
        });
      }
    }

    const confidenceResult = {
      candidate,
      queryInfo: searchQueryInfo,
      top: resolved.top,
      second: resolved.second,
      scoreGap: resolved.scoreGap,
      sameSeasonCandidates: resolved.sameSeasonCandidates,
      sameSeasonCandidateCount: resolved.sameSeasonCandidateCount
    };
    const pickerPolicy = analyzePostSelectionPolicy(searchQueryInfo.canonicalQuery || candidate.rawTitle || '', resolved.results.map((result) => result.media), {
      queryInfo: searchQueryInfo,
      rankedRows: resolved.results
    });
    confidenceResult.pickerPolicy = pickerPolicy;

    logger.info('anime hashtag confidence result', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      confidenceScore: confidenceResult.top?.score || 0,
      scoreGap: confidenceResult.scoreGap,
      sourceType: candidate.sourceType,
      aliasKind: searchQueryInfo.aliasKind,
      pickerReason: pickerPolicy.reason || null,
      providerMediaId: confidenceResult.top?.media?.providerMediaId || null,
      titleNative: confidenceResult.top?.media?.titleNative || null
    });

    if (!shouldAutoRegisterAnime(confidenceResult)) {
      const skipReason = getAutoRegisterSkipReason(confidenceResult);
      setIntegrationState(client, message.id, {
        status: 'skipped_ambiguous',
        lastReason: skipReason
      });
      logger.info('anime hashtag skipped ambiguous', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        sourceType: candidate.sourceType,
        normalizedCandidate: candidate.normalizedCandidate || null,
        confidenceScore: confidenceResult.top?.score || 0,
        scoreGap: confidenceResult.scoreGap,
        sameSeasonCandidateCount: confidenceResult.sameSeasonCandidateCount || 0,
        reason: skipReason
      });
      if (skipReason === 'season_mismatch') {
        logger.info('anime auto registration skipped due to season mismatch', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          normalizedCandidate: candidate.normalizedCandidate || null,
          providerMediaId: confidenceResult.top?.media?.providerMediaId || null
        });
      } else if (skipReason === 'season_ambiguity' || skipReason === 'special_ambiguity') {
        logger.info('anime auto registration skipped due to sequel/season ambiguity', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          normalizedCandidate: candidate.normalizedCandidate || null,
          providerMediaId: confidenceResult.top?.media?.providerMediaId || null
        });
      } else if (skipReason === 'same_season_ambiguity') {
        logger.info('anime auto skipped multiple same-season candidates', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          normalizedCandidate: candidate.normalizedCandidate || candidate.rawTitle || null,
          sameSeasonCandidateCount: confidenceResult.sameSeasonCandidateCount || 0
        });
      } else if (skipReason === 'franchise_alias') {
        logger.info('anime auto-register skipped due to franchise alias', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          normalizedCandidate: candidate.normalizedCandidate || candidate.rawTitle || null,
          canonicalQuery: searchQueryInfo.canonicalQuery || null,
          aliasMatched: searchQueryInfo.aliasMatched || null
        });
      } else if (skipReason === 'broad_franchise_results') {
        logger.info('anime auto-register skipped due to broad franchise results', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          normalizedCandidate: candidate.normalizedCandidate || candidate.rawTitle || null,
          canonicalQuery: searchQueryInfo.canonicalQuery || null,
          franchiseKey: searchQueryInfo.franchiseKey || null
        });
      }
      const franchiseOrBroadPicker = skipReason === 'franchise_alias' || skipReason === 'broad_franchise_results';
      if (franchiseOrBroadPicker) {
        logger.info('anime candidate picker shown for franchise search', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          normalizedCandidate: candidate.normalizedCandidate || candidate.rawTitle || null,
          canonicalQuery: searchQueryInfo.canonicalQuery || null,
          reason: skipReason
        });
      }
      // Strict filter: same-season candidates or high-confidence results without special penalties
      const strictCandidates = (
        confidenceResult.sameSeasonCandidateCount > 1
          ? confidenceResult.sameSeasonCandidates.map((result) => result.media)
          : (pickerPolicy.selectableCandidates.length
              ? pickerPolicy.selectableCandidates
              : resolved.results
                  .filter((result) => result.score >= Math.max((confidenceResult.top?.score || 0) - 12, 75))
                  .filter((result) => !Array.isArray(result.crossoverOrSpecialPenaltyReasons) || result.crossoverOrSpecialPenaltyReasons.length === 0)
                  .map((result) => result.media))
      ).slice(0, 10);
      // When strict filter is empty, fall back to top N results so the picker is always shown
      // when Annict returned usable candidates (avoids falling back to plain text)
      const ambiguityCandidates = strictCandidates.length > 0
        ? strictCandidates
        : resolved.results
            .map((result) => result.media)
            .filter((m) => m.titleNative || m.titleUserPreferred || m.titleRomaji || m.titleEnglish)
            .slice(0, 10);

      // When there are no search results at all, bypass the picker (which would
      // misleadingly say "候補が複数あります") and show an accurate failure message.
      if (ambiguityCandidates.length === 0) {
        logger.info('anime hashtag no search result', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          skipReason,
          normalizedCandidate: candidate.normalizedCandidate || null
        });
        await maybeReplyAskForTitle(message, skipReason);
        return;
      }

      logger.info('anime ambiguity picker shown', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        skipReason,
        candidateCount: ambiguityCandidates.length,
        usedFallbackFilter: strictCandidates.length === 0,
        candidates: ambiguityCandidates.map((m) => ({
          providerMediaId: m?.providerMediaId || null,
          title: m?.titleNative || m?.titleUserPreferred || null
        }))
      });
      const pickerResult = await maybeReplyAskForSelectionUi(
        message,
        searchQueryInfo.canonicalQuery || candidate.normalizedCandidate || candidate.rawTitle || '不明な作品',
        ambiguityCandidates,
        skipReason,
        {
          queryInfo: searchQueryInfo,
          rankedRows: resolved.results
        }
      );
      if (pickerResult === 'picker') {
        logger.info('anime hashtag ambiguity picker flow completed', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          skipReason,
          candidateCount: ambiguityCandidates.length
        });
      } else {
        logger.info('anime hashtag final failure reply sent', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          reason: skipReason
        });
      }
      return;
    }

    const existing = client.db.anime.getEntryByProviderMediaId(
      message.guildId,
      confidenceResult.top.media.provider,
      confidenceResult.top.media.providerMediaId
    );
    const sourceRecord = client.db.anime.getHashtagSourceByMessageId(message.guildId, message.id);
    if (existing) {
      setIntegrationState(client, message.id, {
        status: 'success',
        lastReason: 'existing_entry'
      });
      if (sourceRecord) {
        await linkAnimeHashtagSourceToEntry(client, sourceRecord, existing.id, candidate.normalizedCandidate || candidate.rawTitle || null).catch(() => null);
      }
      logger.info('anime hashtag existing entry found', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        providerMediaId: confidenceResult.top.media.providerMediaId,
        titleNative: confidenceResult.top.media.titleNative || null
      });
      const store = ensureReplyStore(client);
      if (!store.has(message.id)) {
        store.add(message.id);
        const links = buildAnimeLinks(existing);
        const replyMessage = await message.reply({
          content: [
            `このアニメにはすでにスレッドがあります: **${getPreferredAnimeDisplayTitle(existing)}**`,
            links.parentUrl ? `作品カード: ${links.parentUrl}` : null,
            links.threadUrl ? `スレッド: ${links.threadUrl}` : null
          ].filter(Boolean).join('\n'),
          allowedMentions: { parse: [] }
        }).catch(() => null);
        if (replyMessage) {
          await registerDeletableMessage(replyMessage, message.author.id, 'anime_existing_entry_notice').catch(() => null);
        }
      }
      return;
    }

    const postResult = await postAnimeToChannel(
      message.guild,
      {
        ...confidenceResult.top.media,
        imageCandidates: collectMessageImageCandidates(integrationMessage)
      },
      message.author.id,
      [candidate.normalizedCandidate, candidate.rawTitle].filter(Boolean)
    );
    setIntegrationState(client, message.id, {
      status: 'success',
      lastReason: 'created_entry'
    });
    if (sourceRecord) {
      await linkAnimeHashtagSourceToEntry(client, sourceRecord, postResult.entry.id, candidate.normalizedCandidate || candidate.rawTitle || null).catch(() => null);
    }
    logger.info('anime hashtag created anime entry', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      providerMediaId: confidenceResult.top.media.providerMediaId,
      titleNative: confidenceResult.top.media.titleNative || null,
      created: postResult.created
    });

    const store = ensureReplyStore(client);
    if (!store.has(message.id)) {
      store.add(message.id);
      const links = buildAnimeLinks(postResult.entry);
      await message.reply({
        content: [
          `アニメ作品カードを作成しました: **${getPreferredAnimeDisplayTitle(postResult.entry)}**`,
          links.parentUrl ? `作品カード: ${links.parentUrl}` : null,
          links.threadUrl ? `スレッド: ${links.threadUrl}` : null
        ].filter(Boolean).join('\n'),
        allowedMentions: { parse: [] }
      }).then(async (replyMessage) => {
        if (replyMessage) {
          await registerDeletableMessage(replyMessage, message.author.id, 'anime_created_entry_notice').catch(() => null);
        }
      }).catch(() => null);
      logger.info('anime hashtag source reply sent', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        reason: 'created_anime_entry'
      });
    }
  } catch (error) {
    setIntegrationState(client, message.id, {
      status: 'failed',
      lastReason: error.message
    });
    logger.warn('anime hashtag integration failed', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      error: error.message
    });
  }
}

module.exports = {
  handleAnimeHashtagPost,
  extractAnimeCandidateFromHashtagPost,
  extractCandidateFromEmbeds,
  normalizeAnimeCandidateTitle,
  resolveAnimeCandidate,
  scoreAniListCandidate,
  shouldAutoRegisterAnime,
  maybeReplyAskForTitle
};
