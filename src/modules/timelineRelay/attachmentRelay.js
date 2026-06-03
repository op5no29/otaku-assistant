const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createUniqueDisplayFileName,
  ensureSpoilerFileName,
  stripSpoilerPrefix
} = require('../../utils/text');

const DEFAULT_TEMP_DIR = path.resolve(__dirname, '../../../tmp/relay-media');
const MAX_DOWNLOAD_BUTTONS = 4;
const MAX_REUPLOAD_ATTACHMENTS = 3;

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

async function downloadAttachment(url, outputPath) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    throw new Error(`Attachment download failed with status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
}

function formatDownloadLabel(attachment, index, total) {
  if (total === 1 && attachment.isVideo) {
    return '添付動画を開く';
  }

  if (total === 1) {
    const label = `${attachment.displayName || attachment.originalFileName || attachment.name} をダウンロード`;
    return label.length <= 80 ? label : '添付ファイルをダウンロード';
  }

  return `添付ファイル${index + 1}をダウンロード`;
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
    description: attachment.displayName,
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

function addDownloadFallback({
  downloadableAttachments,
  attachment,
  index,
  total,
  logger,
  context,
  reason
}) {
  downloadableAttachments.push({
    name: attachment.displayName,
    url: attachment.url,
    label: formatDownloadLabel(attachment, index, total),
    isVideo: attachment.isVideo
  });
  if (attachment.isVideo) {
    logger.warn('relay video download fallback used', {
      ...context,
      fallbackReason: reason,
      fallbackUrl: attachment.url || null
    });
  }
}

async function prepareAttachmentRelay(post, config, logger) {
  const attachments = Array.isArray(post.attachments) ? post.attachments : [];
  const cleanupPaths = [];
  const componentFiles = [...(post.componentFiles || [])];
  const fileComponentUrls = [];
  const mediaGalleryItems = [...(post.mediaGalleryItems || [])];
  const downloadableAttachments = [];
  const usedDisplayNames = new Set(
    componentFiles.map((file) => file?.name).filter(Boolean)
  );
  const maxReuploadBytes = Number(config?.mediaRelay?.maxReuploadBytes ?? 25_000_000);
  const tempDir = getTempDirectory(config);
  const normalizedAttachments = attachments.map((attachment) => {
    const originalFileName = attachment.originalName || attachment.name || 'attachment';
    const displayName = createUniqueDisplayFileName(originalFileName, usedDisplayNames);
    const normalizedDisplayName = attachment.isSpoiler ? stripSpoilerPrefix(displayName) : displayName;
    const uploadFileName = attachment.isSpoiler ? ensureSpoilerFileName(displayName) : displayName;

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
  const nonImageAttachments = normalizedAttachments.filter(
    (attachment) => !attachment.isImage || attachment.isGif || attachment.isSpoiler
  );

  if (!nonImageAttachments.length) {
    return {
      post: {
        ...post,
        attachments: normalizedAttachments
      },
      cleanup: async () => {}
    };
  }

  let reuploadedCount = 0;
  let hasReuploadedVideo = false;

  for (const [index, attachment] of nonImageAttachments.entries()) {
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
        attachmentUrl: attachment.url || null,
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
          fallbackStrategy: attachment.url ? 'original_url_media_gallery' : 'download_button'
        });
        if (addVideoMediaGalleryItem({
          mediaGalleryItems,
          attachment,
          url: attachment.url,
          logger,
          context,
          mode: 'original-url-too-large'
        })) {
          continue;
        }
      }
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
      addDownloadFallback({
        downloadableAttachments,
        attachment,
        index,
        total: nonImageAttachments.length,
        logger,
        context,
        reason: 'file_too_large'
      });
      continue;
    }

    if (reuploadedCount >= MAX_REUPLOAD_ATTACHMENTS) {
      attachment.reuploadSkippedReason = 'preview_upload_limit_reached';
      if (attachment.isVideo && addVideoMediaGalleryItem({
        mediaGalleryItems,
        attachment,
        url: attachment.url,
        logger,
        context,
        mode: 'original-url-upload-limit'
      })) {
        continue;
      }
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
      addDownloadFallback({
        downloadableAttachments,
        attachment,
        index,
        total: nonImageAttachments.length,
        logger,
        context,
        reason: 'preview_upload_limit_reached'
      });
      continue;
    }

    const extension = path.extname(attachment.originalFileName || attachment.name || '');
    const tempName = `${sanitizeTempName(post.messageId)}-${sanitizeTempName(attachment.id || `${index}`)}${extension}`;
    const filePath = path.join(tempDir, tempName);
    context.safeTempFileName = tempName;

    try {
      if (attachment.isVideo) {
        logger.info('relay video attachment reupload started', context);
      }
      logger.info('Attachment download started', context);
      await downloadAttachment(attachment.url, filePath);
      logger.info('Attachment download finished', context);
      cleanupPaths.push(filePath);

      logger.info('Attachment re-upload attempted', {
        ...context,
        displayFileName: attachment.displayName,
        uploadFileName: attachment.uploadFileName
      });
      attachment.reuploadSucceeded = true;
      attachment.displayLine = attachment.displayName;
      reuploadedCount += 1;

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
          description: attachment.displayName,
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
      logger.warn('Attachment re-upload failed; using fallback', {
        ...context,
        error: error.message,
        fallbackReason: 'download_or_upload_failed'
      });
      if (attachment.isVideo) {
        logger.warn('relay video relay failed', {
          ...context,
          error: error.message,
          fallbackStrategy: attachment.url ? 'original_url_media_gallery' : 'download_button'
        });
        if (addVideoMediaGalleryItem({
          mediaGalleryItems,
          attachment,
          url: attachment.url,
          logger,
          context,
          mode: 'original-url-reupload-failed'
        })) {
          await removeFile(filePath, logger, context);
          continue;
        }
      }
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
      addDownloadFallback({
        downloadableAttachments,
        attachment,
        index,
        total: nonImageAttachments.length,
        logger,
        context,
        reason: 'download_or_upload_failed'
      });
    }
  }

  for (const [index, attachment] of nonImageAttachments.entries()) {
    if ((attachment.reuploadSucceeded || attachment.playableMediaSucceeded) && attachment.isVideo) {
      continue;
    }

    if (attachment.reuploadSucceeded) {
      continue;
    }

    if (downloadableAttachments.some((entry) => entry.name === attachment.displayName && entry.url === attachment.url)) {
      continue;
    }

    downloadableAttachments.push({
      name: attachment.displayName,
      url: attachment.url,
      label: formatDownloadLabel(attachment, index, nonImageAttachments.length),
      isVideo: attachment.isVideo
    });
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
        (url) => !spoilerPreviewUrls.has(url) && !normalizedAttachments.some(
          (attachment) => attachment.reuploadSucceeded && (attachment.isGif || attachment.isImage) && attachment.url === url
        )
      ),
      firstImageUrl:
        spoilerPreviewUrls.has(post.firstImageUrl)
          ? null
          : normalizedAttachments.some(
          (attachment) => attachment.reuploadSucceeded && (attachment.isGif || attachment.isImage) && attachment.url === post.firstImageUrl
        )
            ? null
            : post.firstImageUrl,
      componentFiles,
      fileComponentUrls,
      downloadableAttachments,
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
