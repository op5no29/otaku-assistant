const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const TEMP_DIR = path.resolve(__dirname, '../../../data/tmp/video-previews');
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 20_000;

let ffmpegAvailable;

function isFfmpegAvailable() {
  if (typeof ffmpegAvailable === 'boolean') {
    return ffmpegAvailable;
  }

  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ffmpegAvailable = result.status === 0;
  return ffmpegAvailable;
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

async function downloadVideoFile(url, outputPath) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    throw new Error(`Video download failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Video download exceeds limit: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Video download exceeds limit after fetch: ${buffer.length} bytes`);
  }

  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.writeFile(outputPath, buffer);
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

async function prepareVideoThumbnail(post, logger) {
  if (!post.firstVideoUrl) {
    return {
      post,
      cleanup: async () => {}
    };
  }

  logger.info('Video attachment detected for timeline relay', {
    messageId: post.messageId,
    threadId: post.threadId,
    videoName: post.firstVideoName || null,
    videoUrl: post.firstVideoUrl
  });

  if (!isFfmpegAvailable()) {
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
    await downloadVideoFile(post.firstVideoUrl, videoPath);
    await generateThumbnail(videoPath, thumbnailPath);

    logger.info('Video thumbnail generated', {
      messageId: post.messageId,
      threadId: post.threadId,
      thumbnailName
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
      error: error.message,
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
