const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.resolve(__dirname, '../../../data/tmp/video-previews');
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 20_000;

let ffmpegAvailabilityPromise;

async function isFfmpegAvailable() {
  if (!ffmpegAvailabilityPromise) {
    ffmpegAvailabilityPromise = execFileAsync('ffmpeg', ['-version'], {
      timeout: 2_000,
      maxBuffer: 64 * 1024
    }).then(() => true, () => false);
  }
  return ffmpegAvailabilityPromise;
}

function sanitizeBaseName(value) {
  return String(value || 'video-preview').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function resolveVideoExtension(fileName) {
  const lowerName = fileName?.toLowerCase() || '';

  if (lowerName.endsWith('.mp4')) {
    return '.mp4';
  }

  if (lowerName.endsWith('.mov')) {
    return '.mov';
  }

  if (lowerName.endsWith('.webm')) {
    return '.webm';
  }

  if (lowerName.endsWith('.m4v')) {
    return '.m4v';
  }

  return '.video';
}

async function removeFile(filePath) {
  if (!filePath) {
    return;
  }

  await fs.unlink(filePath).catch(() => {});
}

async function downloadVideoFile(url, outputPath, {
  maxBytes = MAX_DOWNLOAD_BYTES,
  timeoutMs = 15_000
} = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Video download failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Video download exceeds limit: ${contentLength} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw Object.assign(new Error('Video response stream unavailable'), { code: 'stream_unavailable' });
  }
  await fs.mkdir(TEMP_DIR, { recursive: true });
  const file = await fs.open(outputPath, 'w');
  let total = 0;
  try {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          throw Object.assign(new Error('Video download exceeds configured limit'), { code: 'video_too_large' });
        }
        await file.write(chunk);
      }
      if (!total) {
        throw Object.assign(new Error('Video download returned zero bytes'), { code: 'zero_byte_video' });
      }
    } finally {
      await reader.cancel().catch(() => null);
      await file.close();
    }
  } catch (error) {
    await fs.unlink(outputPath).catch(() => null);
    throw error;
  }
  return { byteSize: total };
}

async function generateThumbnail(inputPath, outputPath) {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-vf',
      'thumbnail',
      '-frames:v',
      '1',
      outputPath
    ],
    {
      timeout: FFMPEG_TIMEOUT_MS
    }
  );
}

function hasDirectVideoAttachment(post) {
  return (Array.isArray(post.attachments) ? post.attachments : []).some((attachment) => (
    attachment?.isVideo === true
    && (!post.firstVideoUrl || String(attachment.url || '') === String(post.firstVideoUrl))
  ));
}

async function prepareVideoThumbnail(post, logger, options = {}) {
  if (!post.firstVideoUrl) {
    return {
      post,
      cleanup: async () => {}
    };
  }

  logger.info('Video attachment detected for timeline relay', {
    messageId: post.messageId,
    threadId: post.threadId,
    videoName: post.firstVideoName || null
  });

  if (hasDirectVideoAttachment(post)) {
    logger.info('video thumbnail skipped', {
      messageId: post.messageId,
      threadId: post.threadId,
      reason: 'direct_upload_is_playable',
      avoidsDuplicateDownload: true
    });
    return {
      post,
      cleanup: async () => {}
    };
  }

  const checkFfmpeg = options.isFfmpegAvailable || isFfmpegAvailable;
  if (!await checkFfmpeg()) {
    logger.warn('ffmpeg is not available; using video fallback without thumbnail', {
      messageId: post.messageId,
      threadId: post.threadId,
      fallback: 'download_button_only'
    });

    return {
      post,
      cleanup: async () => {}
    };
  }

  const baseName = sanitizeBaseName(`${post.messageId || post.threadId}-${Date.now()}`);
  const videoPath = path.join(TEMP_DIR, `${baseName}${resolveVideoExtension(post.firstVideoName)}`);
  const thumbnailName = `${baseName}.jpg`;
  const thumbnailPath = path.join(TEMP_DIR, thumbnailName);

  logger.info('Video thumbnail generation started', {
    messageId: post.messageId,
    threadId: post.threadId,
    output: thumbnailName
  });

  try {
    const download = options.downloadVideoFile || downloadVideoFile;
    const renderThumbnail = options.generateThumbnail || generateThumbnail;
    const startedAt = Date.now();
    const downloaded = await download(post.firstVideoUrl, videoPath, {
      maxBytes: Number(options.maxDownloadBytes || MAX_DOWNLOAD_BYTES),
      timeoutMs: Number(options.fetchTimeoutMs || 15_000)
    });
    await renderThumbnail(videoPath, thumbnailPath);

    logger.info('Video thumbnail generated', {
      messageId: post.messageId,
      threadId: post.threadId,
      thumbnailName,
      byteSize: downloaded?.byteSize || null,
      elapsedMs: Date.now() - startedAt
    });

    return {
      post: {
        ...post,
        generatedVideoThumbnailUrl: `attachment://${thumbnailName}`,
        componentFiles: [
          ...(post.componentFiles || []),
          {
            attachment: thumbnailPath,
            name: thumbnailName
          }
        ]
      },
      cleanup: async () => {
        await Promise.all([removeFile(videoPath), removeFile(thumbnailPath)]);
      }
    };
  } catch (error) {
    logger.warn('Video thumbnail generation failed; using fallback', {
      messageId: post.messageId,
      threadId: post.threadId,
      errorCode: error?.code || error?.name || 'thumbnail_failed',
      fallback: 'download_button_only'
    });

    await Promise.all([removeFile(videoPath), removeFile(thumbnailPath)]);

    return {
      post,
      cleanup: async () => {}
    };
  }
}

module.exports = {
  prepareVideoThumbnail
};
