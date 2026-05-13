async function requestOllamaChat({ baseUrl, model, messages, timeoutMs, logger, sourceMessageId }) {
  const normalizedBaseUrl = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const targetUrl = `${normalizedBaseUrl}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs).unref();

  logger.info('Ollama request started', {
    sourceMessageId,
    baseUrl: normalizedBaseUrl,
    model,
    timeoutMs
  });

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(payload?.error || responseText || `HTTP ${response.status}`);
    }

    const content = String(payload?.message?.content || payload?.response || '').trim();
    if (!content) {
      throw new Error('Ollama returned an empty response');
    }

    logger.info('Ollama request finished', {
      sourceMessageId,
      model,
      responseChars: content.length
    });

    return content;
  } catch (error) {
    logger.error('Ollama request failed', {
      sourceMessageId,
      model,
      error: error.name === 'AbortError' ? 'timeout' : error.message
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  requestOllamaChat
};
