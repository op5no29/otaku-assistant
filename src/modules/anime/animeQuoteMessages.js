const fs = require('node:fs');
const path = require('node:path');

const ANIME_QUOTES_PATH = path.join(__dirname, 'quoteData', 'anime_quotes.json');
const REQUIRED_THRESHOLDS = [10, 20, 50, 100, 300, 500];

const LEVEL_PRAISE = {
  10: '10本分の感想がちゃんと記録に残っています！！ここからが本番です。これからも自分のペースで気になった作品の感想を書いていってくださいね〜！',
  20: 'かなり習慣になってきていますね！！観たものを言葉にして残せる人は、強いです。',
  50: '50作品分の感想到達です。いよいよきましたね。',
  100: '100作品分の感想到達です。これはもう視聴履歴というより、あなた自身のアニメ年表です。',
  300: '300作品分の感想到達です。作品の違いを味わって、言葉にしてきた量がかなり異常です。もちろん褒めています。',
  500: '500作品分の感想到達です。観て、覚えて、語って、積み上げてきた記録が、アニメです。'
};

const FALLBACK_MESSAGES = {
  10: '🎉 アニメ感想10作品達成！\n「アニメ視聴者 Lv.1」ロールを付与しました。\nここからあなたのアニメ記録が育っていきます。感想投稿ありがとうございます！',
  20: '🎉 アニメ感想20作品達成！\n「アニメ視聴者 Lv.2」ロールを付与しました。\nもう立派な常連視聴者です。気になった作品の感想、これからもぜひ残していってください。',
  50: '🎊 アニメ感想50作品達成！\n「アニメ語り部」ロールを付与しました。\n作品を観るだけでなく、言葉として残してきた記録がかなりの量になっています。すごいです。',
  100: '🏮 アニメ感想100作品達成。\n「アニメ仙人」ロールを付与しました。\nここまで来ると、もうただの視聴履歴ではなく、あなた自身のアニメ年表です。敬意を込めて。',
  300: '🍷 アニメ感想300作品達成。\n「アニメソムリエ」ロールを付与しました。\n作品の空気、演出、物語、音楽。その違いを味わって言葉にしてきた人に贈られるロールです。かなり異常です。もちろん褒めています。',
  500: '👑 アニメ感想500作品達成。\n「オタク」ロールを付与しました。\nこれはもう称号です。観て、覚えて、語って、積み上げてきた記録がサーバー内のひとつの文化になっています。到達おめでとうございます。'
};

const lastQuoteIdByUserAndThreshold = new Map();

let quoteDatabaseCache = null;
let quoteDatabaseError = null;
let loadAttempted = false;
let loadLogged = false;
let loadFailedLogged = false;

function getConfiguredThresholds(reviewRoles = []) {
  return Array.from(new Set(
    reviewRoles
      .map((entry) => Number(entry?.threshold))
      .filter((threshold) => Number.isInteger(threshold) && threshold > 0)
  ));
}

function validateQuoteEntry(quote, threshold, index, errors) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    errors.push(`levels.${threshold}.quotes[${index}] must be an object`);
    return;
  }

  const requiredStringFields = ['id', 'quote', 'character', 'anime_title'];
  for (const field of requiredStringFields) {
    if (typeof quote[field] !== 'string' || !quote[field].trim()) {
      errors.push(`levels.${threshold}.quotes[${index}].${field} must be a non-empty string`);
    }
  }

  if (quote.official_url != null && (typeof quote.official_url !== 'string' || !quote.official_url.trim())) {
    errors.push(`levels.${threshold}.quotes[${index}].official_url must be a non-empty string when provided`);
  }
}

function validateAnimeQuoteDatabaseData(database, reviewRoles = []) {
  const errors = [];

  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    return {
      ok: false,
      errors: ['anime quote database must be a JSON object']
    };
  }

  if (!database.levels || typeof database.levels !== 'object' || Array.isArray(database.levels)) {
    return {
      ok: false,
      errors: ['anime quote database must contain a levels object']
    };
  }

  const thresholds = Array.from(new Set([...REQUIRED_THRESHOLDS, ...getConfiguredThresholds(reviewRoles)]));

  for (const threshold of thresholds) {
    const level = database.levels[String(threshold)];
    if (!level || typeof level !== 'object' || Array.isArray(level)) {
      errors.push(`levels.${threshold} is missing`);
      continue;
    }

    if (typeof level.role_name !== 'string' || !level.role_name.trim()) {
      errors.push(`levels.${threshold}.role_name must be a non-empty string`);
    }
    if (typeof level.emoji !== 'string' || !level.emoji.trim()) {
      errors.push(`levels.${threshold}.emoji must be a non-empty string`);
    }
    if (!Array.isArray(level.quotes) || level.quotes.length === 0) {
      errors.push(`levels.${threshold}.quotes must be a non-empty array`);
      continue;
    }

    for (const [index, quote] of level.quotes.entries()) {
      validateQuoteEntry(quote, threshold, index, errors);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function logLoadSuccess(logger, database) {
  if (!logger || loadLogged) {
    return;
  }

  const totalQuotes = Object.values(database.levels || {}).reduce((sum, level) => {
    const count = Array.isArray(level?.quotes) ? level.quotes.length : 0;
    return sum + count;
  }, 0);

  logger.info('anime quote database loaded', {
    path: ANIME_QUOTES_PATH,
    thresholds: REQUIRED_THRESHOLDS,
    totalQuotes
  });
  loadLogged = true;
}

function logLoadFailure(logger, error) {
  if (!logger || loadFailedLogged) {
    return;
  }

  logger.warn('anime quote database load failed', {
    path: ANIME_QUOTES_PATH,
    error: error.message
  });
  loadFailedLogged = true;
}

function loadAnimeQuoteDatabase({ logger } = {}) {
  if (quoteDatabaseCache) {
    logLoadSuccess(logger, quoteDatabaseCache);
    return quoteDatabaseCache;
  }

  if (loadAttempted) {
    logLoadFailure(logger, quoteDatabaseError || new Error('anime_quote_database_unavailable'));
    return null;
  }

  loadAttempted = true;

  try {
    const raw = fs.readFileSync(ANIME_QUOTES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const validation = validateAnimeQuoteDatabaseData(parsed);
    if (!validation.ok) {
      throw new Error(validation.errors.join('; '));
    }
    quoteDatabaseCache = parsed;
    quoteDatabaseError = null;
    logLoadSuccess(logger, quoteDatabaseCache);
    return quoteDatabaseCache;
  } catch (error) {
    quoteDatabaseCache = null;
    quoteDatabaseError = error;
    logLoadFailure(logger, error);
    return null;
  }
}

function validateAnimeQuoteDatabase(options = {}) {
  const database = loadAnimeQuoteDatabase();
  if (!database) {
    return {
      ok: false,
      errors: [quoteDatabaseError?.message || 'anime quote database failed to load']
    };
  }

  return validateAnimeQuoteDatabaseData(database, options.reviewRoles);
}

function pickRandomQuote(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return null;
  }
  return quotes[Math.floor(Math.random() * quotes.length)] || null;
}

function getAnimeMilestoneQuote(threshold, options = {}) {
  const database = loadAnimeQuoteDatabase({ logger: options.logger });
  if (!database) {
    return null;
  }

  const normalizedThreshold = Number(threshold);
  const level = database.levels[String(normalizedThreshold)];
  if (!level || !Array.isArray(level.quotes) || level.quotes.length === 0) {
    return null;
  }

  const cacheKey = options.userId ? `${options.userId}:${normalizedThreshold}` : null;
  const previousQuoteId = cacheKey ? lastQuoteIdByUserAndThreshold.get(cacheKey) : null;
  const selectableQuotes = previousQuoteId && level.quotes.length > 1
    ? level.quotes.filter((quote) => quote.id !== previousQuoteId)
    : level.quotes;
  const selectedQuote = pickRandomQuote(selectableQuotes.length ? selectableQuotes : level.quotes);

  if (!selectedQuote) {
    return null;
  }

  if (cacheKey) {
    lastQuoteIdByUserAndThreshold.set(cacheKey, selectedQuote.id);
  }

  return {
    threshold: normalizedThreshold,
    levelEmoji: String(level.emoji || '🎉'),
    levelRoleName: String(level.role_name || ''),
    theme: typeof level.theme === 'string' ? level.theme : '',
    id: selectedQuote.id,
    quote: selectedQuote.quote,
    character: selectedQuote.character,
    animeTitle: selectedQuote.anime_title,
    officialUrl: selectedQuote.official_url || null
  };
}

function buildFallbackAnimeRoleAwardDm({ threshold, roleName }) {
  return FALLBACK_MESSAGES[threshold]
    || `🎉 アニメ感想${threshold}作品達成！\n「${roleName || `Lv.${threshold}`}」ロールを付与しました。`;
}

function buildQuoteBlock(text) {
  return String(text || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function buildPraiseComment(threshold, reviewedCount) {
  return LEVEL_PRAISE[threshold]
    || `${reviewedCount || threshold}作品分の感想がしっかり積み上がっています。これからも自分のペースでアニメの記録を残していってください。`;
}

function buildAnimeRoleAwardDm({
  threshold,
  roleName,
  reviewedCount,
  userDisplayName,
  userId,
  logger
}) {
  void userDisplayName;

  const quote = getAnimeMilestoneQuote(threshold, {
    logger,
    userId
  });

  if (!quote) {
    return {
      content: buildFallbackAnimeRoleAwardDm({ threshold, roleName }),
      quote: null,
      usedFallback: true
    };
  }

  const resolvedRoleName = roleName || quote.levelRoleName || `Lv.${threshold}`;
  const achievementLine = `${quote.levelEmoji} アニメ感想${threshold}作品達成！「${resolvedRoleName}」ロールを付与しました。`;
  const sourceLine = `―― ${quote.character}『${quote.animeTitle}』`;
  const praiseComment = buildPraiseComment(Number(threshold), Number(reviewedCount));

  return {
    content: [
      achievementLine,
      '',
      buildQuoteBlock(quote.quote),
      buildQuoteBlock(sourceLine),
      '',
      praiseComment
    ].join('\n'),
    quote,
    usedFallback: false
  };
}

module.exports = {
  ANIME_QUOTES_PATH,
  REQUIRED_THRESHOLDS,
  getAnimeMilestoneQuote,
  buildAnimeRoleAwardDm,
  validateAnimeQuoteDatabase
};
