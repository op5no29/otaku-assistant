const { parseRelayHashtagPrefixes } = require('../../utils/text');
const {
  searchAnime,
  getAnimeById,
  postAnimeToChannel,
  linkAnimeHashtagSourceToEntry
} = require('./index');
const { buildAnimeLinks, getPreferredAnimeDisplayTitle } = require('./buildAnimeMessages');

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

function looksLikeGenericComment(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return GENERIC_SHORT_COMMENTS.has(normalized) || normalized.length <= 3;
}

function looksLikeAnimeTitleCandidate(text) {
  const value = cleanupCandidate(text);
  if (!value || looksLikeGenericComment(value)) {
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

function extractCandidateFromEmbeds(message) {
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const sources = [
      ['embed_title', cleanupCandidate(embed?.title || '')],
      ['embed_description', cleanupCandidate(embed?.description || '')],
      ['embed_author', cleanupCandidate(embed?.author?.name || '')],
      ['embed_provider', cleanupCandidate(embed?.provider?.name || '')]
    ];

    for (const [sourceType, rawTitle] of sources) {
      if (!rawTitle) {
        continue;
      }
      return {
        sourceType,
        rawTitle,
        embedUrl: embed?.url || null,
        embedProvider: cleanupCandidate(embed?.provider?.name || embed?.data?.provider?.name || ''),
        embedDescription: cleanupCandidate(embed?.description || ''),
        embedAuthor: cleanupCandidate(embed?.author?.name || '')
      };
    }
  }
  return null;
}

function extractAnimeCandidateFromHashtagPost(message, options = {}) {
  const parsed = parseRelayHashtagPrefixes(message.content || '', {
    globalRoutes: message.client.appConfig.globalHashtagRoutes,
    botRoutes: message.client.appConfig.botHashtagRoutes
  });
  const cleanedContent = cleanupCandidate(options.cleanedContent || parsed.content || '');
  const providerId = extractProviderIdFromText(message.content || '');
  if (providerId) {
    return {
      sourceType: `${providerId.provider}_url`,
      providerMediaId: providerId.providerMediaId,
      provider: providerId.provider,
      rawTitle: null,
      cleanedContent
    };
  }

  const explicitTitle = extractExplicitTitleLine(cleanedContent);
  if (explicitTitle) {
    return {
      sourceType: 'explicit_title_line',
      rawTitle: explicitTitle,
      cleanedContent
    };
  }

  const lines = cleanedContent.split(/\r?\n/).map(cleanupCandidate).filter(Boolean);
  const firstMeaningfulLine = lines.find((line) => !/^https?:\/\//iu.test(line));
  if (firstMeaningfulLine && looksLikeAnimeTitleCandidate(firstMeaningfulLine)) {
    return {
      sourceType: 'content_title',
      rawTitle: firstMeaningfulLine,
      cleanedContent
    };
  }

  const embedCandidate = extractCandidateFromEmbeds(message);
  if (embedCandidate) {
    return {
      ...embedCandidate,
      cleanedContent
    };
  }

  return null;
}

function canonicalTitle(value) {
  return stripNoiseTokens(String(value || ''))
    .toLowerCase()
    .replace(/[!！?？"'`“”‘’\s・･\-–—_/／:：|｜.。,、（）()［］\[\]【】『』「」]/gu, '');
}

function titleLooksLikeSeasonSpecific(value) {
  return /第\s*\d+\s*期|\b\d+\s*期\b|Season\s*\d+|\d+(?:st|nd|rd|th)\s+Season/iu.test(String(value || ''));
}

function scoreAniListCandidate(candidate, media) {
  if (candidate.sourceType === 'anilist_url' || candidate.sourceType === 'annict_url') {
    return {
      score: 999,
      reason: 'explicit_anilist_url'
    };
  }

  const candidateTitle = canonicalTitle(candidate.normalizedCandidate || candidate.rawTitle || '');
  const titles = [
    media.titleNative,
    media.titleUserPreferred,
    media.titleRomaji,
    media.titleEnglish,
    ...(Array.isArray(media.aliases) ? media.aliases : [])
  ].filter(Boolean);
  const canonicalTitles = titles.map((value) => canonicalTitle(value));
  let score = 0;
  let reason = 'weak_match';

  if (canonicalTitles.includes(candidateTitle)) {
    score += 70;
    reason = 'exact_title';
  }
  if (canonicalTitle(media.titleNative) === candidateTitle) {
    score += 15;
    reason = 'exact_native_title';
  }
  if (canonicalTitles.some((value) => value.includes(candidateTitle) || candidateTitle.includes(value))) {
    score += 20;
  }

  if (candidate.sourceType === 'explicit_title_line') {
    score += 20;
  } else if (candidate.sourceType === 'embed_title') {
    score += 12;
  } else if (candidate.sourceType === 'embed_description' || candidate.sourceType === 'embed_author') {
    score += 10;
  } else if (candidate.sourceType === 'content_title') {
    score += 5;
  }

  if (String(media.format || '') === 'TV') {
    score += 8;
  } else if (['MOVIE', 'OVA', 'ONA', 'SPECIAL'].includes(String(media.format || ''))) {
    score -= 8;
  }

  if (!titleLooksLikeSeasonSpecific(candidate.rawTitle || candidate.normalizedCandidate || '') && titleLooksLikeSeasonSpecific(media.titleUserPreferred || media.titleRomaji || media.titleNative || media.titleEnglish || '')) {
    score -= 12;
  } else if (!titleLooksLikeSeasonSpecific(media.titleUserPreferred || media.titleRomaji || media.titleNative || media.titleEnglish || '')) {
    score += 5;
  }

  return { score, reason };
}

function shouldAutoRegisterAnime(scoreResult) {
  if (!scoreResult?.top) {
    return false;
  }
  if (scoreResult.candidate?.sourceType === 'anilist_url' || scoreResult.candidate?.sourceType === 'annict_url') {
    return true;
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

  const results = await searchAnime(client, candidate.normalizedCandidate || candidate.rawTitle);
  const scored = results.map((media) => ({
    media,
    ...scoreAniListCandidate(candidate, media)
  })).sort((left, right) => right.score - left.score);

  return {
    candidate,
    results: scored,
    top: scored[0] || null,
    second: scored[1] || null,
    scoreGap: (scored[0]?.score || 0) - (scored[1]?.score || 0)
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

    const extracted = extractAnimeCandidateFromHashtagPost(integrationMessage, options);
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

    const normalized = extracted.rawTitle
      ? normalizeAnimeCandidateTitle(extracted.rawTitle)
      : { rawTitle: '', normalizedCandidate: '', candidates: [], reason: 'explicit_id' };

    const candidate = {
      ...extracted,
      rawTitle: extracted.rawTitle || null,
      normalizedCandidate: normalized.normalizedCandidate || null,
      candidateVariants: normalized.candidates || []
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
      normalizedCandidate: candidate.normalizedCandidate || null,
      providerMediaId: candidate.providerMediaId || null
    });

    const resolved = await resolveAnimeCandidate(client, candidate);
    logger.info('anime hashtag provider search result', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      resultCount: resolved.results.length,
      topScore: resolved.top?.score || 0,
      secondScore: resolved.second?.score || 0,
      providerMediaId: resolved.top?.media?.providerMediaId || null,
      titleNative: resolved.top?.media?.titleNative || null
    });

    const confidenceResult = {
      candidate,
      top: resolved.top,
      second: resolved.second,
      scoreGap: resolved.scoreGap
    };

    logger.info('anime hashtag confidence result', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      confidenceScore: confidenceResult.top?.score || 0,
      scoreGap: confidenceResult.scoreGap,
      sourceType: candidate.sourceType,
      providerMediaId: confidenceResult.top?.media?.providerMediaId || null,
      titleNative: confidenceResult.top?.media?.titleNative || null
    });

    if (!shouldAutoRegisterAnime(confidenceResult)) {
      setIntegrationState(client, message.id, {
        status: 'skipped_ambiguous',
        lastReason: confidenceResult.top ? 'confidence_below_threshold' : 'no_search_result'
      });
      logger.info('anime hashtag skipped ambiguous', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        sourceType: candidate.sourceType,
        normalizedCandidate: candidate.normalizedCandidate || null,
        confidenceScore: confidenceResult.top?.score || 0,
        scoreGap: confidenceResult.scoreGap,
        reason: confidenceResult.top ? 'confidence_below_threshold' : 'no_search_result'
      });
      if (['explicit_title_line', 'embed_title', 'embed_author', 'embed_description'].includes(candidate.sourceType)) {
        await maybeReplyAskForTitle(message, 'ambiguous_candidate');
        logger.info('anime hashtag final failure reply sent', {
          sourceMessageId: message.id,
          sourceChannelId: message.channelId,
          reason: 'ambiguous_candidate'
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
      return;
    }

    const postResult = await postAnimeToChannel(
      message.guild,
      confidenceResult.top.media,
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
