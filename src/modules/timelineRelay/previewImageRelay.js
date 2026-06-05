const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_TEMP_DIR = path.resolve(__dirname, '../../../tmp/relay-media');
const DEFAULT_MAX_PREVIEW_IMAGE_BYTES = 8_000_000;

const PREVIEW_IMAGE_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 compatible preview fetcher',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
};

function getTempDirectory(config) {
  const configured = config?.mediaRelay?.tempDir;
  if (!configured) {
    return DEFAULT_TEMP_DIR;
  }

  return path.resolve(process.cwd(), configured);
}

function sanitizeFilePart(value) {
  return String(value || 'preview').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function inferExtensionFromContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  return null;
}

function detectImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return null;
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  if (buffer.length >= 6 && /^GIF8[79]a/u.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  const textPrefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart().toLowerCase();
  if (textPrefix.startsWith('<svg') || textPrefix.startsWith('<?xml')) {
    return 'svg';
  }
  return null;
}

function collectPreviewUrls(socialPreview) {
  return new Set([
    socialPreview?.imageUrl,
    ...(Array.isArray(socialPreview?.imageUrls) ? socialPreview.imageUrls : []),
    ...(Array.isArray(socialPreview?.mediaUrls) ? socialPreview.mediaUrls : [])
  ].filter(Boolean));
}

function replacePreviewUrlList(values, replacements) {
  if (!Array.isArray(values)) {
    return values;
  }
  return values
    .map((url) => replacements.get(url) || url)
    .filter((url) => url && !replacements.get(`${url}:omit`));
}

function omitPreviewUrlList(values, omitted) {
  if (!Array.isArray(values)) {
    return values;
  }
  return values.filter((url) => !omitted.has(url));
}

async function removeFile(filePath, logger = null, context = {}) {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
    logger?.info?.('Temp preview image file cleaned up', {
      ...context,
      filePath
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.('Temp preview image file cleanup failed', {
        ...context,
        filePath,
        error: error.message
      });
    }
  }
}

async function downloadPreviewImage(url, outputPath, maxBytes) {
  const response = await fetch(url, {
    headers: PREVIEW_IMAGE_FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    throw new Error(`Preview image download failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Preview image exceeds max bytes: ${contentLength}`);
  }

  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Preview image exceeds max bytes: ${buffer.length}`);
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buffer);
    return {
      bytes: buffer.length,
      contentType: response.headers.get('content-type') || null,
      extension: detectImageExtension(buffer) || inferExtensionFromContentType(response.headers.get('content-type'))
    };
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const buffer = Buffer.from(value);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`Preview image exceeds max bytes: ${total}`);
      }
      chunks.push(buffer);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const finalBuffer = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, finalBuffer);
  return {
    bytes: finalBuffer.length,
    contentType: response.headers.get('content-type') || null,
    extension: detectImageExtension(finalBuffer) || inferExtensionFromContentType(response.headers.get('content-type'))
  };
}

async function preparePreviewImageRelay(post, config, logger = null) {
  const socialPreview = post?.socialPreview;
  const mediaItems = Array.isArray(socialPreview?.mediaItems) ? socialPreview.mediaItems : [];
  if (!mediaItems.length) {
    return {
      post,
      cleanup: async () => {}
    };
  }

  const cleanupPaths = [];
  const replacements = new Map();
  const omitted = new Set();
  const componentFiles = [...(post.componentFiles || [])];
  const tempDir = getTempDirectory(config);
  const maxPreviewImageBytes = Number(config?.mediaRelay?.maxPreviewImageBytes ?? DEFAULT_MAX_PREVIEW_IMAGE_BYTES);
  const referencedUrls = collectPreviewUrls(socialPreview);

  const nextMediaItems = [];
  for (const [index, item] of mediaItems.entries()) {
    if (!referencedUrls.has(item.url)) {
      nextMediaItems.push(item);
      continue;
    }

    if (item.requiresReupload !== true) {
      nextMediaItems.push(item);
      continue;
    }

    const sourceMessageId = post.messageId || null;
    const sourceUrl = socialPreview.sourceUrl || null;
    const downloadUrl = item.finalUrl || item.url;
    const preferredExtension = item.extension || inferExtensionFromContentType(item.contentType) || 'png';
    const uploadName = sanitizeFilePart(`preview-${sourceMessageId || 'message'}-${index + 1}.${preferredExtension}`);
    const outputPath = path.join(tempDir, `${Date.now()}-${uploadName}`);
    logger?.info?.('preview image attachment relay started', {
      sourceMessageId,
      sourceUrl,
      rawUrl: item.rawUrl || item.url,
      normalizedUrl: item.normalizedUrl || item.url,
      finalUrl: downloadUrl,
      sourceType: item.sourceType || item.source || 'link_preview_image',
      contentType: item.contentType || null,
      contentLength: item.contentLength || null,
      maxBytes: maxPreviewImageBytes
    });

    try {
      const download = await downloadPreviewImage(downloadUrl, outputPath, maxPreviewImageBytes);
      const actualExtension = download.extension || preferredExtension;
      const finalUploadName = actualExtension === preferredExtension
        ? uploadName
        : sanitizeFilePart(`preview-${sourceMessageId || 'message'}-${index + 1}.${actualExtension}`);
      const finalOutputPath = finalUploadName === uploadName
        ? outputPath
        : path.join(tempDir, `${Date.now()}-${finalUploadName}`);
      if (finalOutputPath !== outputPath) {
        await fs.rename(outputPath, finalOutputPath);
      }
      cleanupPaths.push(finalOutputPath);
      const attachmentUrl = `attachment://${finalUploadName}`;
      componentFiles.push({
        attachment: finalOutputPath,
        name: finalUploadName
      });
      replacements.set(item.url, attachmentUrl);
      nextMediaItems.push({
        ...item,
        originalUrl: item.url,
        url: attachmentUrl,
        source: item.source || 'link_preview_image',
        sourceType: item.sourceType || item.source || 'link_preview_image',
        reuploaded: true
      });
      logger?.info?.('preview image reuploaded for media gallery', {
        sourceMessageId,
        sourceUrl,
        rawUrl: item.rawUrl || item.url,
        normalizedUrl: item.normalizedUrl || item.url,
        finalUrl: downloadUrl,
        mediaGalleryUrl: attachmentUrl,
        sourceType: item.sourceType || item.source || 'link_preview_image',
        bytes: download.bytes,
        contentType: download.contentType || item.contentType || null
      });
    } catch (error) {
      omitted.add(item.url);
      logger?.warn?.('media gallery item skipped broken_preview_image', {
        sourceMessageId,
        sourceUrl,
        rawUrl: item.rawUrl || item.url,
        normalizedUrl: item.normalizedUrl || item.url,
        finalUrl: downloadUrl,
        sourceType: item.sourceType || item.source || 'link_preview_image',
        failureReason: 'preview_reupload_failed',
        error: error.message
      });
    }
  }

  const nextSocialPreview = {
    ...socialPreview,
    mediaItems: nextMediaItems.filter((item) => !omitted.has(item.url) && !omitted.has(item.originalUrl)),
    mediaUrls: omitPreviewUrlList(replacePreviewUrlList(socialPreview.mediaUrls, replacements), omitted),
    imageUrls: omitPreviewUrlList(replacePreviewUrlList(socialPreview.imageUrls, replacements), omitted),
    imageUrl: omitted.has(socialPreview.imageUrl)
      ? null
      : replacements.get(socialPreview.imageUrl) || socialPreview.imageUrl || null
  };

  return {
    post: {
      ...post,
      socialPreview: nextSocialPreview,
      componentFiles
    },
    cleanup: async () => {
      await Promise.all(cleanupPaths.map((filePath) =>
        removeFile(filePath, logger, {
          sourceMessageId: post.messageId || null
        })
      ));
    }
  };
}

module.exports = {
  preparePreviewImageRelay
};
