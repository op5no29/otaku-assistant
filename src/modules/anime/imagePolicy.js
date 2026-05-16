const LOGO_LIKE_SUBSTRINGS = [
  'common/logo',
  'header/logo',
  'og-logo',
  'favicon'
];

const LOGO_LIKE_PATTERNS = [
  /(?:^|[\/_.-])logo(?:[\/_.-]|$)/iu,
  /(?:^|[\/_.-])icon(?:[\/_.-]|$)/iu,
  /profile_images/iu
];

const KIND_PRIORITY = {
  main_visual: 120,
  recommended: 120,
  ogp: 105,
  cover: 95,
  image: 85,
  poster: 80,
  banner: 70,
  thumbnail: 40,
  unknown: 20,
  logo: -100
};

function normalizeAnimeImageCandidate(candidate, defaults = {}) {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    return {
      url: candidate,
      kind: defaults.kind || 'unknown',
      source: defaults.source || 'unknown'
    };
  }

  const url = String(candidate.url || candidate.imageUrl || '').trim();
  if (!url) {
    return null;
  }

  return {
    url,
    kind: String(candidate.kind || defaults.kind || 'unknown'),
    source: String(candidate.source || defaults.source || 'unknown')
  };
}

function normalizeAnimeImageCandidates(candidates = [], defaults = {}) {
  return candidates
    .map((candidate) => normalizeAnimeImageCandidate(candidate, defaults))
    .filter(Boolean);
}

function normalizeHttpsUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  return /^http:\/\//iu.test(text)
    ? text.replace(/^http:\/\//iu, 'https://')
    : text;
}

function isLogoLikeImageUrl(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return false;
  }
  if (LOGO_LIKE_SUBSTRINGS.some((fragment) => text.includes(fragment))) {
    return true;
  }
  return LOGO_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

function getAnimeImageCandidateRejectionReason(candidate) {
  const normalized = normalizeAnimeImageCandidate(candidate);
  if (!normalized?.url) {
    return 'missing_url';
  }

  const url = normalizeHttpsUrl(normalized.url);
  if (!/^https:\/\//iu.test(String(url || ''))) {
    return 'non_https';
  }
  if (/\.svg(?:$|\?)/iu.test(url)) {
    return 'svg';
  }
  if (String(normalized.kind || '').toLowerCase() === 'logo') {
    return 'logo_like';
  }
  if (isLogoLikeImageUrl(url)) {
    return 'logo_like';
  }
  return null;
}

function isUsableAnimeMainImageUrl(value, kind = 'unknown') {
  return !getAnimeImageCandidateRejectionReason({
    url: value,
    kind
  });
}

function getAnimeImageCandidatePriority(candidate) {
  const normalized = normalizeAnimeImageCandidate(candidate);
  if (!normalized) {
    return -1_000;
  }
  return KIND_PRIORITY[String(normalized.kind || 'unknown').toLowerCase()] ?? KIND_PRIORITY.unknown;
}

function selectPreferredAnimeImageCandidates(candidates = [], limit = 2) {
  const deduped = [];
  const seen = new Set();

  for (const candidate of normalizeAnimeImageCandidates(candidates)) {
    const url = normalizeHttpsUrl(candidate.url);
    if (!url) {
      continue;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...candidate,
      url
    });
  }

  return deduped
    .filter((candidate) => !getAnimeImageCandidateRejectionReason(candidate))
    .sort((left, right) => getAnimeImageCandidatePriority(right) - getAnimeImageCandidatePriority(left))
    .slice(0, Math.max(0, limit));
}

module.exports = {
  normalizeAnimeImageCandidate,
  normalizeAnimeImageCandidates,
  normalizeHttpsUrl,
  isLogoLikeImageUrl,
  isUsableAnimeMainImageUrl,
  getAnimeImageCandidateRejectionReason,
  getAnimeImageCandidatePriority,
  selectPreferredAnimeImageCandidates
};
