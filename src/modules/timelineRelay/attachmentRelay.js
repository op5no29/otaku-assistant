const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createUniqueDisplayFileName,
  ensureSpoilerFileName,
  stripSpoilerPrefix
} = require('../../utils/text');
const { stableUploadName, detectType } = require('../timelineRestoration/mediaMirror');

const DEFAULT_TEMP_DIR = path.resolve(__dirname, '../../../tmp/relay-media');
const MAX_DOWNLOAD_BUTTONS = 4;
const MAX_REUPLOAD_ATTACHMENTS = 10;

function sanitizeTempName(value) {
  return String(value || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getTempDirectory(config) {
  const configured = config?.mediaRelay?.tempDir;
  if (!configured) {
    return DEFAULT_TEMP_DIR;
  }

  return path.resolve(process.cwd(), configured);
}

function detectFileKind(attachment) {
  if (attachment.isVideo) {
    return 'video';
  }

  if (attachment.isAudio) {
    return 'audio';
  }

  if (attachment.isPdf) {
    return 'pdf';
  }

  return 'file';
}

async function removeFile(filePath, logger = null, context = {}) {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
    logger?.info?.('Temp relay file cleaned up', {
      ...context,
      filePath
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.('Temp relay file cleanup failed', {
        ...context,
        filePath,
        error: error.message
      });
    }
  }
}

async function downloadAttachment(url, outputPath, maxBytes, declaredContentType = '') {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    throw new Error(`Attachment download failed with status ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw Object.assign(new Error('Attachment exceeds configured byte limit'), { code: 'attachment_too_large' });
  }
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader?.();
  if (!reader) throw Object.assign(new Error('Attachment response stream unavailable'), { code: 'stream_unavailable' });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        throw Object.assign(new Error('Attachment exceeds configured byte limit'), { code: 'attachment_too_large' });
      }
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => null);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw Object.assign(new Error('Attachment download returned zero bytes'), { code: 'zero_byte_attachment' });
  const detected = detectType(buffer.subarray(0, 512), response.headers.get('content-type') || declaredContentType);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  return {
    byteSize: buffer.length,
    detectedContentType: detected.contentType,
    detectedExtension: detected.extension,
    detectedKind: detected.kind
  };
}

function withDetectedExtension(fileName, detectedExtension) {
  const normalizedExtension = String(detectedExtension || '').toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 10);
  if (!normalizedExtension) return String(fileName || 'attachment');
  const currentExtension = path.extname(String(fileName || ''));
  const baseName = currentExtension
    ? String(fileName).slice(0, -currentExtension.length)
    : String(fileName || 'attachment');
  return `${baseName || 'attachment'}.${normalizedExtension}`;
}

function buildAttachmentDisplayLine(attachment) {
  if (attachment.reuploadSkippedReason === 'file_too_large') {
    return `${attachment.displayName}（容量が大きいため再アップロードできませんでした。元メッセージから確認してください）`;
  }

  if (attachment.reuploadSkippedReason === 'upload_failed') {
    return `${attachment.displayName}（再アップロードに失敗しました。元メッセージから確認してください）`;
  }

  return attachment.displayName;
}

function buildVideoUploadName(index, attachment) {
  const baseName = attachment.uploadFileName || attachment.displayName || attachment.name || `video-${index + 1}.mp4`;
  return attachment.isSpoiler ? ensureSpoilerFileName(baseName) : baseName;
}

function addVideoMediaGalleryItem({
  mediaGalleryItems,
  attachment,
  url,
  logger,
  context,
  mode
}) {
  if (!url) {
    return false;
  }

  mediaGalleryItems.push({
    url,
    spoiler: attachment.isSpoiler === true
  });
  attachment.playableMediaSucceeded = true;
  logger.info('relay video playable media selected', {
    ...context,
    mode,
    mediaUrl: url,
    spoilerPreserved: attachment.isSpoiler === true
  });
  logger.info('relay video media gallery item added', {
    ...context,
    mode,
    mediaUrl: url,
    spoilerPreserved: attachment.isSpoiler === true
  });
  if (attachment.isSpoiler) {
    logger.info('relay video spoiler preserved', {
      ...context,
      mode,
      mediaUrl: url
    });
  }
  return true;
}

async function prepareAttachmentRelay(post, config, logger) {
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  const cleanupPaths = [];
  const componentFiles = [...(post.componentFiles || [])];
  const fileComponentUrls = [];
  const mediaGalleryItems = [...(post.mediaGalleryItems || [])];
  const downloadableAttachments = [];
  const attachmentCopyFailures = [];
  const usedDisplayNames = new Set(
    componentFiles.map((file) => file?.name).filter(Boolean)
  );
  const maxReuploadBytes = Number(config?.mediaRelay?.maxReuploadBytes ?? 25_000_000);
  const tempDir = getTempDirectory(config);
  const normalizedAttachments = attachments.map((attachment, index) => {
    const originalFileName = attachment.originalName || attachment.name || 'attachment';
    const displayName = createUniqueDisplayFileName(originalFileName, usedDisplayNames);
    const normalizedDisplayName = attachment.isSpoiler ? stripSpoilerPrefix(displayName) : displayName;
    const uploadFileName = stableUploadName(post.messageId, index, displayName, attachment.isSpoiler);

    logger?.info?.('attachment spoiler detected', {
      sourceMessageId: post.messageId,
      attachmentId: attachment.id,
      originalFileName,
      displayName: normalizedDisplayName,
      uploadFileName,
      spoilerDetected: attachment.isSpoiler === true
    });
    if (attachment.isSpoiler === true) {
      logger?.info?.('spoiler attachment detected', {
        sourceMessageId: post.messageId,
        attachmentId: attachment.id,
        originalFileName,
        uploadFileName
      });
    }
    return {
      ...attachment,
      originalFileName,
      displayName: normalizedDisplayName,
      uploadFileName,
      displayLine: normalizedDisplayName,
      reuploadSucceeded: false,
      reuploadSkippedReason: null
    };
  });
  const relayAttachments = normalizedAttachments;

  if (!relayAttachments.length) {
    return {
      post: {
        ...post,
        attachments: normalizedAttachments
      },
      cleanup: async () => {}
    };
  }

  let reuploadedCount = componentFiles.length;
  let hasReuploadedVideo = false;
  const unavailableSourceMediaUrls = new Set();

  for (const [index, attachment] of relayAttachments.entries()) {
    const fileKind = detectFileKind(attachment);
    const context = {
      sourceMessageId: post.messageId,
      attachmentId: attachment.id,
      originalFileName: attachment.originalFileName,
      safeTempFileName: null,
      displayFileName: attachment.displayName,
      uploadFileName: attachment.uploadFileName,
      attachmentSize: attachment.size,
      contentType: attachment.contentType,
      fileKind,
      maxBytes: maxReuploadBytes
    };

    logger.info('Attachment detected for relay', {
      ...context,
      previewableUpload: attachment.isPreviewableUpload
    });
    if (attachment.isVideo) {
      logger.info('relay video attachment detected', {
        ...context,
        sourceUrlPresent: Boolean(attachment.url),
        isSpoiler: attachment.isSpoiler === true
      });
    }

    if (attachment.size > maxReuploadBytes) {
      attachment.reuploadSkippedReason = 'file_too_large';
      attachment.displayLine = buildAttachmentDisplayLine(attachment);
      if (attachment.isVideo) {
        logger.warn('relay video skipped too large', {
          ...context,
          maxBytes: maxReuploadBytes,
          fallbackStrategy: 'download_button_or_placeholder'
        });
      }
      unavailableSourceMediaUrls.add(attachment.url);
      logger.warn('Attachment re-upload skipped; file exceeds size limit', {
        ...context,
        maxBytes: maxReuploadBytes,
        fallbackReason: 'file_too_large'
      });
      if (attachment.isSpoiler) {
        logger.warn('spoiler attachment relay fallback', {
          ...context,
          fallbackReason: 'file_too_large',
          spoilerPreservedByRawPreviewSuppression: true
        });
      }
      attachmentCopyFailures.push({
        attachmentId: attachment.id || null,
        displayName: attachment.displayName,
        reason: 'file_too_large'
      });
      continue;
    }

    if (reuploadedCount >= MAX_REUPLOAD_ATTACHMENTS) {
      attachment.reuploadSkippedReason = 'preview_upload_limit_reached';
      unavailableSourceMediaUrls.add(attachment.url);
      logger.info('Attachment re-upload skipped; max preview upload count reached', {
        ...context,
        maxCount: MAX_REUPLOAD_ATTACHMENTS,
        fallbackReason: 'preview_upload_limit_reached'
      });
      if (attachment.isSpoiler) {
        logger.warn('spoiler attachment relay fallback', {
          ...context,
          fallbackReason: 'preview_upload_limit_reached',
          spoilerPreservedByRawPreviewSuppression: true
        });
      }
      attachmentCopyFailures.push({
        attachmentId: attachment.id || null,
        displayName: attachment.displayName,
        reason: 'preview_upload_limit_reached'
      });
      continue;
    }

    const tempName = `${sanitizeTempName(post.messageId)}-${sanitizeTempName(attachment.id || `${index}`)}-${crypto.randomUUID()}.partial`;
    let filePath = path.join(tempDir, tempName);
    context.safeTempFileName = tempName;
    const initialComponentFileCount = componentFiles.length;
    const initialGalleryItemCount = mediaGalleryItems.length;
    const initialFileComponentCount = fileComponentUrls.length;

    try {
      if (attachment.isVideo) {
        logger.info('relay video attachment reupload started', context);
      }
      logger.info('Attachment download started', context);
      const download = await downloadAttachment(attachment.url, filePath, maxReuploadBytes, attachment.contentType);
      const uploadSourceName = withDetectedExtension(attachment.displayName, download.detectedExtension);
      attachment.uploadFileName = stableUploadName(post.messageId, index, uploadSourceName, attachment.isSpoiler);
      attachment.detectedContentType = download.detectedContentType;
      attachment.detectedExtension = download.detectedExtension;
      attachment.actualByteSize = download.byteSize;
      attachment.isImage = download.detectedKind === 'image';
      attachment.isVideo = download.detectedKind === 'video';
      attachment.isGif = download.detectedContentType === 'image/gif';
      context.uploadFileName = attachment.uploadFileName;
      context.detectedContentType = download.detectedContentType;
      context.detectedExtension = download.detectedExtension;
      context.actualByteSize = download.byteSize;
      const finalizedPath = path.join(tempDir, `${crypto.randomUUID()}-${sanitizeTempName(attachment.uploadFileName)}`);
      await fs.rename(filePath, finalizedPath);
      filePath = finalizedPath;
      context.safeTempFileName = path.basename(finalizedPath);
      logger.info('Attachment download finished', context);
      logger.info('relay attachment MIME detected', context);
      logger.info('relay attachment upload filename generated', context);
      cleanupPaths.push(finalizedPath);

      logger.info('Attachment re-upload attempted', {
        ...context,
        displayFileName: attachment.displayName,
        uploadFileName: attachment.uploadFileName
      });
      attachment.displayLine = attachment.displayName;

      if (attachment.isVideo) {
        hasReuploadedVideo = true;
        const uploadName = buildVideoUploadName(index, attachment);
        const attachmentUrl = `attachment://${uploadName}`;
        componentFiles.push({
          attachment: filePath,
          name: uploadName
        });
        addVideoMediaGalleryItem({
          mediaGalleryItems,
          attachment,
          url: attachmentUrl,
          logger,
          context: {
            ...context,
            uploadFileName: uploadName
          },
          mode: 'attachment-upload'
        });
        logger.info('media gallery spoiler item', {
          ...context,
          uploadFileName: uploadName,
          spoilerPreserved: attachment.isSpoiler === true,
          mode: 'video'
        });
        logger.info('Video reupload mode selected', {
          ...context,
          mode: 'media-gallery',
          displayFileName: attachment.displayName,
          uploadFileName: uploadName,
          attachmentUrl
        });
        logger.info('relay video attachment reuploaded', {
          ...context,
          uploadFileName: uploadName,
          attachmentUrl
        });
        if (post.relayOrigin === 'posthoc_hashtag') {
          logger.info('posthoc source video attachment relayed', {
            ...context,
            uploadFileName: uploadName,
            attachmentUrl,
            spoilerPreserved: attachment.isSpoiler === true
          });
        }
        logger.info('FileBuilder skipped for video attachment', {
          ...context,
          displayFileName: attachment.displayName
        });
      } else if (attachment.isGif || attachment.isImage) {
        const attachmentUrl = `attachment://${attachment.uploadFileName}`;
        componentFiles.push({
          attachment: filePath,
          name: attachment.uploadFileName
        });
        mediaGalleryItems.push({
          url: attachmentUrl,
          spoiler: attachment.isSpoiler === true
        });
        logger.info('media gallery spoiler item', {
          ...context,
          uploadFileName: attachment.uploadFileName,
          spoilerPreserved: attachment.isSpoiler === true,
          mode: 'gif'
        });
        logger.info('GIF reupload mode selected', {
          ...context,
          mode: attachment.isGif ? 'media-gallery' : 'spoiler-image-media-gallery',
          displayFileName: attachment.displayName,
          uploadFileName: attachment.uploadFileName,
          attachmentUrl
        });
        if (post.relayOrigin === 'posthoc_hashtag') {
          logger.info('posthoc source media attachment relayed', {
            ...context,
            uploadFileName: attachment.uploadFileName,
            attachmentUrl,
            mediaKind: attachment.isGif ? 'gif' : 'image',
            spoilerPreserved: attachment.isSpoiler === true
          });
        }
      } else {
        componentFiles.push({
          attachment: filePath,
          name: attachment.uploadFileName
        });
        fileComponentUrls.push({
          url: `attachment://${attachment.uploadFileName}`,
          spoiler: attachment.isSpoiler === true,
          name: attachment.displayName
        });
        logger.info('upload filename spoiler adjusted', {
          ...context,
          uploadFileName: attachment.uploadFileName,
          spoilerPreserved: attachment.isSpoiler === true
        });
      }

      attachment.reuploadSucceeded = true;
      reuploadedCount += 1;

      logger.info('Attachment re-upload succeeded', {
        ...context,
        displayFileName: attachment.displayName,
        uploadFileName: attachment.uploadFileName
      });
      if (attachment.isSpoiler) {
        logger.info('spoiler attachment relay preserved', {
          ...context,
          uploadFileName: attachment.uploadFileName,
          spoilerPrefixPreserved: /^SPOILER_/iu.test(String(attachment.uploadFileName || ''))
        });
        if (post.relayOrigin === 'posthoc_hashtag') {
          logger.info('posthoc source spoiler attachment preserved', {
            ...context,
            uploadFileName: attachment.uploadFileName,
            relayStage: 'reupload_succeeded'
          });
        }
      }
    } catch (error) {
      componentFiles.splice(initialComponentFileCount);
      mediaGalleryItems.splice(initialGalleryItemCount);
      fileComponentUrls.splice(initialFileComponentCount);
      logger.warn('Attachment re-upload failed; using fallback', {
        ...context,
        error: error.message,
        fallbackReason: 'download_or_upload_failed'
      });
      if (attachment.isVideo) {
        logger.warn('relay video relay failed', {
          ...context,
          error: error.message,
          fallbackStrategy: 'download_button_or_placeholder'
        });
      }
      unavailableSourceMediaUrls.add(attachment.url);
      if (attachment.isSpoiler) {
        logger.warn('spoiler attachment relay failed', {
          ...context,
          error: error.message
        });
        logger.warn('spoiler attachment relay fallback', {
          ...context,
          error: error.message,
          fallbackReason: 'download_or_upload_failed',
          spoilerPreservedByRawPreviewSuppression: true
        });
      }
      if (post.relayOrigin === 'posthoc_hashtag') {
        logger.warn('posthoc source attachment relay failed', {
          ...context,
          error: error.message,
          fallbackReason: 'download_or_upload_failed'
        });
      }
      attachment.reuploadSkippedReason = 'upload_failed';
      attachment.displayLine = buildAttachmentDisplayLine(attachment);
      await removeFile(filePath, logger, context);
      if (!attachmentCopyFailures.some((failure) => failure.attachmentId === (attachment.id || null))) {
        attachmentCopyFailures.push({
          attachmentId: attachment.id || null,
          displayName: attachment.displayName,
          reason: error.code || 'download_or_upload_failed'
        });
      }
    }
  }

  for (const [index, attachment] of relayAttachments.entries()) {
    if ((attachment.reuploadSucceeded || attachment.playableMediaSucceeded) && attachment.isVideo) {
      continue;
    }

    if (attachment.reuploadSucceeded) {
      continue;
    }

    if (!attachmentCopyFailures.some((failure) => failure.attachmentId === (attachment.id || null))) {
      attachmentCopyFailures.push({
        attachmentId: attachment.id || null,
        displayName: attachment.displayName,
        reason: attachment.reuploadSkippedReason || 'copy_unavailable'
      });
    }
  }

  const spoilerPreviewUrls = new Set(
    normalizedAttachments
      .filter((attachment) => attachment.isSpoiler && (attachment.isGif || attachment.isImage))
      .map((attachment) => attachment.url)
      .filter(Boolean)
  );
  const hasPlayableVideo = normalizedAttachments.some(
    (attachment) => attachment.isVideo && attachment.playableMediaSucceeded
  );
  const shouldSuppressGeneratedVideoThumbnail = Boolean((hasReuploadedVideo || hasPlayableVideo) && post.generatedVideoThumbnailUrl);
  if (shouldSuppressGeneratedVideoThumbnail) {
    logger.info('uploaded video static thumbnail suppressed', {
      sourceMessageId: post.messageId || null,
      thumbnailUrl: post.generatedVideoThumbnailUrl,
      source_type: 'uploaded_video_thumbnail_static'
    });
  }

  return {
    post: {
      ...post,
      attachments: normalizedAttachments,
      imageUrls: (Array.isArray(post.imageUrls) ? post.imageUrls : []).filter(
        (url) => !unavailableSourceMediaUrls.has(url) && !spoilerPreviewUrls.has(url) && !normalizedAttachments.some(
          (attachment) => attachment.reuploadSucceeded && (attachment.isGif || attachment.isImage) && attachment.url === url
        )
      ),
      firstImageUrl:
        unavailableSourceMediaUrls.has(post.firstImageUrl) || spoilerPreviewUrls.has(post.firstImageUrl)
          ? null
          : normalizedAttachments.some(
          (attachment) => attachment.reuploadSucceeded && (attachment.isGif || attachment.isImage) && attachment.url === post.firstImageUrl
        )
            ? null
            : post.firstImageUrl,
      componentFiles,
      fileComponentUrls,
      downloadableAttachments,
      attachmentCopyFailures,
      attachmentRelayPending: attachmentCopyFailures.length > 0,
      hasMoreDownloadableAttachments: downloadableAttachments.length > MAX_DOWNLOAD_BUTTONS,
      generatedVideoThumbnailUrl: shouldSuppressGeneratedVideoThumbnail ? null : post.generatedVideoThumbnailUrl,
      mediaGalleryItems
    },
    cleanup: async () => {
      await Promise.all(
        cleanupPaths.map((filePath) =>
          removeFile(filePath, logger, { sourceMessageId: post.messageId })
        )
      );
    }
  };
}

module.exports = {
  MAX_DOWNLOAD_BUTTONS,
  MAX_REUPLOAD_ATTACHMENTS,
  prepareAttachmentRelay
};
