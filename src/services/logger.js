function sanitizeLogValue(value, key = '', depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  const normalizedKey = String(key || '');
  if (/(?:access.?token|webhook.?token|client.?secret|encryption.?key|authorization.?code|oauth.?code)/iu.test(normalizedKey)) {
    return '[REDACTED_SECRET]';
  }
  if (typeof value === 'string') {
    if (/(?:rawContent|cleanContent|finalBodyText|extractedBodyText|messageContent|privateContent)/u.test(normalizedKey)) {
      return `[REDACTED_CONTENT:${value.length}]`;
    }
    if (/url/iu.test(normalizedKey) && /^https?:\/\//iu.test(value)) {
      try {
        const url = new URL(value);
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[REDACTED_URL]';
      }
    }
    if (/https?:\/\//iu.test(value)) {
      return value.replace(/https?:\/\/[^\s<>]+/giu, (rawUrl) => {
        try {
          const url = new URL(rawUrl);
          url.search = '';
          url.hash = '';
          return url.toString();
        } catch {
          return '[REDACTED_URL]';
        }
      });
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogValue(entry, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeLogValue(childValue, childKey, depth + 1)
    ]));
  }
  return value;
}

function createLogger(scope) {
  function write(level, message, meta = {}) {
    const line = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...sanitizeLogValue(meta)
    };

    const serialized = JSON.stringify(line);

    if (level === 'error') {
      console.error(serialized);
      return;
    }

    console.log(serialized);
  }

  return {
    info(message, meta) {
      write('info', message, meta);
    },
    warn(message, meta) {
      write('warn', message, meta);
    },
    error(message, meta) {
      write('error', message, meta);
    }
  };
}

module.exports = {
  createLogger,
  sanitizeLogValue
};
