const { parseRelayHashtagPrefixes } = require('../../utils/text');
const {
  searchAnime,
  getAnimeById,
  postAnimeToChannel
} = require('./index');
const { buildAnimeLinks, getPreferredAnimeDisplayTitle } = require('./buildAnimeMessages');

const GENERIC_SHORT_COMMENTS = new Set([
  '見た',
  'これ好き',
  'op好き',
  'ed好き',
  '神',
  '良い',
  'やばい',
  '最高',
  'すき',
  '好き',
  '良かった',
  'いい'
]);

function ensureReplyStore(client) {
  if (!client.animeHashtagRepliedMessages) {
    client.animeHashtagRepliedMessages = new Set();
  }
  return client.animeHashtagRepliedMessages;
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

function extractAniListIdFromText(text) {
  const match = String(text || '').match(/https?:\/\/anilist\.co\/anime\/(\d+)(?:\/|$)/iu);
  return match?.[1] || null;
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
  if (/[!！?？]/u.test(value)) {
    return true;
  }
  const words = value.split(/\s+/u).filter(Boolean);
  if (words.length >= 2) {
    return true;
  }
  if (/^[A-Z][A-Za-z0-9'!?:.-]+$/u.test(value)) {
    return true;
  }
  return false;
}

function cleanupCandidate(value) {
  return String(value || '')
    .replace(/^[\s"'`“”‘’【『「]+/u, '')
    .replace(/[\s"'`“”‘’】』」]+$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function stripNoiseTokens(value) {
  return cleanupCandidate(
    String(value || '')
      .replace(/\bTVアニメ\b/giu, ' ')
      .replace(/\bアニメ\b/giu, ' ')
      .replace(/\banime\b/giu, ' ')
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

function normalizeAnimeCandidateTitle(rawTitle) {
  const raw = cleanupCandidate(rawTitle);
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

  const bracketPatterns = [
    /(?:TVアニメ|アニメ|anime)[「『【]([^」』】]+)[」』】]/iu,
    /[【『「]([^】』」]+)[】』」]\s*(?:第\s*\d+\s*期|\d+\s*期|Season\s*\d+|\d+(?:st|nd|rd|th)\s+Season)?\s*(?:OP|ED|Opening|Ending|PV|MV|CM|Trailer|Teaser|主題歌|オープニング|エンディング)/iu,
    /^(.*?)\s*(?:Opening|Ending|OP|ED)\b/iu
  ];

  for (const pattern of bracketPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      addCandidate(match[1], 'pattern_extract', 40);
    }
  }

  const bracketMatches = Array.from(raw.matchAll(/[【『「]([^】』」]{2,80})[】』」]/gu));
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
    const embedTitle = cleanupCandidate(embed?.title || '');
    if (embedTitle) {
      return {
        sourceType: 'embed_title',
        rawTitle: embedTitle,
        embedUrl: embed?.url || null
      };
    }
    const authorTitle = cleanupCandidate(embed?.author?.name || '');
    if (authorTitle) {
      return {
        sourceType: 'embed_author',
        rawTitle: authorTitle,
        embedUrl: embed?.url || null
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
  const anilistId = extractAniListIdFromText(message.content || '');
  if (anilistId) {
    return {
      sourceType: 'anilist_url',
      providerMediaId: anilistId,
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
  if (candidate.sourceType === 'anilist_url') {
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
  } else if (candidate.sourceType === 'embed_title' || candidate.sourceType === 'embed_author') {
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

  return {
    score,
    reason
  };
}

function shouldAutoRegisterAnime(scoreResult) {
  if (!scoreResult?.top) {
    return false;
  }
  if (scoreResult.candidate?.sourceType === 'anilist_url') {
    return true;
  }
  if (scoreResult.candidate?.sourceType === 'explicit_title_line') {
    return scoreResult.top.score >= 80 && scoreResult.scoreGap >= 8;
  }
  if (scoreResult.candidate?.sourceType === 'embed_title' || scoreResult.candidate?.sourceType === 'embed_author') {
    return scoreResult.top.score >= 88 && scoreResult.scoreGap >= 12;
  }
  if (scoreResult.candidate?.sourceType === 'content_title') {
    return scoreResult.top.score >= 92 && scoreResult.scoreGap >= 15;
  }
  return false;
}

async function maybeReplyAskForTitle(message, reason) {
  const store = ensureReplyStore(message.client);
  if (store.has(message.id)) {
    return false;
  }
  store.add(message.id);
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

  if (candidate.sourceType === 'anilist_url' && candidate.providerMediaId) {
    const media = await getAnimeById(client, candidate.providerMediaId, client.appConfig.anime.maxCastInCard);
    return {
      candidate,
      results: media ? [{ media, score: 999, reason: 'explicit_anilist_url' }] : [],
      top: media ? { media, score: 999, reason: 'explicit_anilist_url' } : null,
      second: null,
      scoreGap: 999
    };
  }

  const results = await searchAnime(client, candidate.normalizedCandidate || candidate.rawTitle);
  const scored = results.map((media) => {
    const score = scoreAniListCandidate(candidate, media);
    return {
      media,
      ...score
    };
  }).sort((left, right) => right.score - left.score);

  return {
    candidate,
    results: scored,
    top: scored[0] || null,
    second: scored[1] || null,
    scoreGap: (scored[0]?.score || 0) - (scored[1]?.score || 0)
  };
}

async function maybeWaitForYoutubeEmbeds(message, logger) {
  const hasYoutubeUrl = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//iu.test(String(message.content || ''));
  if (!hasYoutubeUrl || (Array.isArray(message.embeds) && message.embeds.length > 0)) {
    return message;
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const refreshed = await message.channel.messages.fetch(message.id).catch(() => message);
  logger.info('anime hashtag embed retry finished', {
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
    embedCount: Array.isArray(refreshed?.embeds) ? refreshed.embeds.length : 0
  });
  return refreshed || message;
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
    const integrationMessage = await maybeWaitForYoutubeEmbeds(message, logger);
    const extracted = extractAnimeCandidateFromHashtagPost(integrationMessage, options);
    if (!extracted) {
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
      providerMediaId: candidate.providerMediaId || null
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
      if (candidate.sourceType === 'explicit_title_line' || candidate.sourceType === 'embed_title' || candidate.sourceType === 'embed_author') {
        await maybeReplyAskForTitle(message, 'normalized_candidate_missing');
      }
      return;
    }

    logger.info('anime hashtag AniList search started', {
      sourceMessageId: message.id,
      sourceChannelId: message.channelId,
      sourceType: candidate.sourceType,
      normalizedCandidate: candidate.normalizedCandidate || null,
      providerMediaId: candidate.providerMediaId || null
    });

    const resolved = await resolveAnimeCandidate(client, candidate);
    logger.info('anime hashtag AniList search result', {
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
      logger.info('anime hashtag skipped ambiguous', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        sourceType: candidate.sourceType,
        normalizedCandidate: candidate.normalizedCandidate || null,
        confidenceScore: confidenceResult.top?.score || 0,
        scoreGap: confidenceResult.scoreGap,
        reason: confidenceResult.top ? 'confidence_below_threshold' : 'no_search_result'
      });
      if (candidate.sourceType === 'explicit_title_line' || candidate.sourceType === 'embed_title' || candidate.sourceType === 'embed_author') {
        await maybeReplyAskForTitle(message, 'ambiguous_candidate');
      }
      return;
    }

    const existing = client.db.anime.getEntryByProviderMediaId(
      message.guildId,
      'anilist',
      confidenceResult.top.media.providerMediaId
    );
    if (existing) {
      logger.info('anime hashtag existing entry found', {
        sourceMessageId: message.id,
        sourceChannelId: message.channelId,
        providerMediaId: confidenceResult.top.media.providerMediaId,
        titleNative: confidenceResult.top.media.titleNative || null
      });
      return;
    }

    const postResult = await postAnimeToChannel(message.guild, confidenceResult.top.media, message.author.id);
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
