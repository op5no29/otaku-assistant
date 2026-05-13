async function requestOllamaChat({
  baseUrl,
  model,
  messages,
  timeoutMs,
  logger,
  sourceMessageId,
  shortRequestMode = false,
  numPredict,
  numCtx,
  temperature,
  topP,
  keepAlive
}) {
  const normalizedBaseUrl = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const targetUrl = `${normalizedBaseUrl}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs).unref();
  const startedAt = Date.now();
  const promptCharCount = messages.reduce((total, entry) => total + String(entry?.content || '').length, 0);

  logger.info('Ollama request started', {
    sourceMessageId,
    baseUrl: normalizedBaseUrl,
    model,
    timeoutMs,
    shortRequestMode,
    numPredict,
    numCtx,
    promptCharCount
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
        keep_alive: keepAlive,
        messages,
        options: {
          num_predict: numPredict,
          num_ctx: numCtx,
          temperature,
          top_p: topP
        }
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
      responseChars: content.length,
      durationMs: Date.now() - startedAt,
      evalCount: payload?.eval_count ?? null,
      totalDuration: payload?.total_duration ?? null
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
