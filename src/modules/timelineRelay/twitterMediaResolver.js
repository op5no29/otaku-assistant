const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function getTwitterStatusUrl(post) {
  const url = String(post?.socialPreview?.sourceUrl || '');
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(url) ? url : null;
}

function chooseTwitterFormat(info, maxBytes) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const direct = formats
    .filter((format) =>
      typeof format?.url === 'string' &&
      /https?:\/\//i.test(format.url) &&
      /mp4|webm/i.test(String(format.ext || '')) &&
      Number(format.vcodec !== 'none')
    )
    .map((format) => ({
      url: format.url,
      ext: format.ext,
      formatId: format.format_id || null,
      filesize: Number(format.filesize || format.filesize_approx || 0),
      height: Number(format.height || 0)
    }))
    .filter((format) => !format.filesize || format.filesize <= maxBytes)
    .sort((left, right) => {
      if (left.filesize && right.filesize) {
        return left.filesize - right.filesize;
      }
      return (right.height || 0) - (left.height || 0);
    });

  return direct[0] || null;
}

async function resolveTwitterMedia(post, config, logger) {
  const twitterUrl = getTwitterStatusUrl(post);
  if (!twitterUrl) {
    return {
      post,
      cleanup: async () => {}
    };
  }

  const mediaConfig = config.twitterMedia || {};
  if (mediaConfig.videoMode !== 'yt-dlp') {
    logger?.info?.('twitter playable video unavailable fallback', {
      sourceMessageId: post.messageId,
      twitterStatusUrl: twitterUrl,
      reason: 'preview_only_mode'
    });
    return {
      post,
      cleanup: async () => {}
    };
  }

  const ytDlpPath = String(mediaConfig.ytDlpPath || 'yt-dlp');
  const timeoutMs = Number(mediaConfig.resolveTimeoutMs || 15000);
  logger?.info?.('twitter video resolve started', {
    sourceMessageId: post.messageId,
    twitterStatusUrl: twitterUrl,
    ytDlpPath,
    videoMode: mediaConfig.videoMode,
    resolveTimeoutMs: timeoutMs
  });

  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync(
      ytDlpPath,
      ['--dump-single-json', '--no-warnings', '--no-playlist', twitterUrl],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout || '{}');
    const selectedFormat = chooseTwitterFormat(info, Number(mediaConfig.maxVideoUploadBytes || 25_000_000));

    if (!selectedFormat?.url) {
      logger?.info?.('twitter playable video unavailable fallback', {
        sourceMessageId: post.messageId,
        twitterStatusUrl: twitterUrl,
        reason: 'no_suitable_format',
        resolveDurationMs: Date.now() - startedAt
      });
      return {
        post,
        cleanup: async () => {}
      };
    }

    logger?.info?.('twitter video resolve finished', {
      sourceMessageId: post.messageId,
      twitterStatusUrl: twitterUrl,
      resolveDurationMs: Date.now() - startedAt,
      selectedFormat: selectedFormat.formatId,
      selectedExt: selectedFormat.ext,
      fileSize: selectedFormat.filesize || 0,
      uploaded: false
    });

    return {
      post: {
        ...post,
        socialPreview: {
          ...post.socialPreview,
          mediaUrls: [selectedFormat.url],
          imageUrls: [],
          imageUrl: null
        }
      },
      cleanup: async () => {}
    };
  } catch (error) {
    logger?.warn?.('twitter video resolve failed', {
      sourceMessageId: post.messageId,
      twitterStatusUrl: twitterUrl,
      ytDlpPath,
      error: error.message,
      resolveDurationMs: Date.now() - startedAt,
      fallbackReason: 'yt_dlp_failed'
    });
    return {
      post,
      cleanup: async () => {}
    };
  }
}

module.exports = {
  resolveTwitterMedia
};
