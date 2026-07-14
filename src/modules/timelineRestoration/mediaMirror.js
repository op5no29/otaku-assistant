const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const sharp = require('sharp');

const PERMANENT_ROOT = path.resolve(process.cwd(), 'data', 'timeline-restore-media');

function safeFilePart(value, fallback = 'attachment') {
  const normalized = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  return normalized || fallback;
}

function stableUploadName(messageId, index, originalName, spoiler = false) {
  const raw = safeFilePart(originalName || `attachment-${index + 1}`);
  const name = `${safeFilePart(messageId, 'message')}-${index + 1}-${raw}`;
  return spoiler && !name.startsWith('SPOILER_') ? `SPOILER_${name}` : name;
}

function isPrivateHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value === 'localhost' || value.endsWith('.localhost') || value === '::1') return true;
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(value)) return isPrivateHostname(value) || value === '0.0.0.0';
  if (!net.isIPv6(value)) return false;
  if (value === '::' || value === '::1') return true;
  if (/^(?:fc|fd)/u.test(value) || /^fe[89ab]/u.test(value)) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

async function assertPublicResolution(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw Object.assign(new Error('Private media address is not allowed'), { code: 'unsafe_media_url' });
    return;
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error('Media hostname resolved to a private address'), { code: 'unsafe_media_url' });
  }
}

function validateRemoteUrl(value) {
  const url = new URL(String(value || ''));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw Object.assign(new Error('Unsupported media URL'), { code: 'unsafe_media_url' });
  }
  return url;
}

function detectType(buffer, declaredContentType = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png', kind: 'image' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg', kind: 'image' };
  }
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return { contentType: 'image/gif', extension: 'gif', kind: 'image' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp', kind: 'image' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
    return { contentType: 'application/pdf', extension: 'pdf', kind: 'file' };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { contentType: 'video/mp4', extension: 'mp4', kind: 'video' };
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { contentType: 'video/webm', extension: 'webm', kind: 'video' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return { contentType: declaredContentType.startsWith('audio/') ? declaredContentType : 'audio/ogg', extension: 'ogg', kind: 'file' };
  }
  if (buffer.subarray(0, 2).toString('ascii') === 'PK') {
    return { contentType: declaredContentType || 'application/zip', extension: 'zip', kind: 'file' };
  }

  const normalized = String(declaredContentType || '').split(';')[0].trim().toLowerCase();
  if (normalized.startsWith('text/html')) {
    throw Object.assign(new Error('HTML response is not restoration media'), { code: 'invalid_media_type' });
  }
  if (normalized.startsWith('image/')) {
    throw Object.assign(new Error('Declared image failed file signature validation'), { code: 'invalid_image_signature' });
  }
  if (normalized.startsWith('video/')) {
    return { contentType: normalized, extension: normalized.split('/')[1] || 'video', kind: 'video' };
  }
  return { contentType: normalized || 'application/octet-stream', extension: null, kind: 'file' };
}

function extensionFromName(name) {
  const extension = path.extname(String(name || '')).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return extension.slice(0, 10) || null;
}

async function fetchWithRedirectLimit(url, { timeoutMs, maxRedirects }) {
  let current = validateRemoteUrl(url);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertPublicResolution(current.hostname);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'OtakuAssistant/1.0 timeline-preservation' }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel?.().catch(() => null);
    if (redirectCount >= maxRedirects) {
      throw Object.assign(new Error('Media redirect limit exceeded'), { code: 'redirect_limit' });
    }
    const location = response.headers.get('location');
    if (!location) throw Object.assign(new Error('Media redirect had no location'), { code: 'redirect_missing' });
    current = validateRemoteUrl(new URL(location, current).toString());
  }
  throw Object.assign(new Error('Media redirect limit exceeded'), { code: 'redirect_limit' });
}

async function downloadToPermanentMirror(url, {
  guildId,
  originalFilename,
  maxBytes,
  timeoutMs,
  maxRedirects
}) {
  const response = await fetchWithRedirectLimit(url, { timeoutMs, maxRedirects });
  if (!response.ok) {
    throw Object.assign(new Error(`Media download failed with status ${response.status}`), { code: `http_${response.status}` });
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw Object.assign(new Error('Media exceeds configured byte limit'), { code: 'media_too_large' });
  }
  if (!response.body?.getReader) {
    throw Object.assign(new Error('Media response did not provide a stream'), { code: 'stream_unavailable' });
  }

  const tempDirectory = path.join(PERMANENT_ROOT, '.tmp');
  await fs.mkdir(tempDirectory, { recursive: true });
  const tempPath = path.join(tempDirectory, `${crypto.randomUUID()}.partial`);
  const file = await fs.open(tempPath, 'wx');
  const hash = crypto.createHash('sha256');
  const headerChunks = [];
  let headerBytes = 0;
  let total = 0;
  const reader = response.body.getReader();
  let streamError = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        throw Object.assign(new Error('Media exceeds configured byte limit'), { code: 'media_too_large' });
      }
      if (headerBytes < 512) {
        const headerPart = chunk.subarray(0, Math.min(chunk.length, 512 - headerBytes));
        headerChunks.push(headerPart);
        headerBytes += headerPart.length;
      }
      hash.update(chunk);
      await file.write(chunk);
    }
  } catch (error) {
    streamError = error;
  } finally {
    await reader.cancel().catch(() => null);
    await file.close();
  }
  if (streamError) {
    await fs.unlink(tempPath).catch(() => null);
    throw streamError;
  }

  if (total <= 0) {
    await fs.unlink(tempPath).catch(() => null);
    throw Object.assign(new Error('Downloaded media was empty'), { code: 'zero_byte_media' });
  }

  let detected;
  try {
    detected = detectType(Buffer.concat(headerChunks), response.headers.get('content-type') || '');
  } catch (error) {
    await fs.unlink(tempPath).catch(() => null);
    throw error;
  }
  const sha256 = hash.digest('hex');
  const extension = detected.extension || extensionFromName(originalFilename) || 'bin';
  const relativePath = path.join('data', 'timeline-restore-media', safeFilePart(guildId), sha256.slice(0, 2), `${sha256}.${extension}`);
  const permanentPath = path.resolve(process.cwd(), relativePath);
  if (!permanentPath.startsWith(`${PERMANENT_ROOT}${path.sep}`)) {
    await fs.unlink(tempPath).catch(() => null);
    throw Object.assign(new Error('Permanent media path escaped its root'), { code: 'invalid_media_path' });
  }
  await fs.mkdir(path.dirname(permanentPath), { recursive: true });
  const existing = await fs.stat(permanentPath).catch(() => null);
  if (existing?.isFile() && existing.size === total) {
    await fs.unlink(tempPath).catch(() => null);
  } else {
    try {
      await fs.rename(tempPath, permanentPath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => null);
      throw error;
    }
  }

  let dimensions = {};
  if (detected.kind === 'image') {
    dimensions = await sharp(permanentPath).metadata().then((metadata) => ({
      width: metadata.width || null,
      height: metadata.height || null
    })).catch(() => ({}));
  }

  return {
    sha256,
    localPath: relativePath,
    byteSize: total,
    contentType: detected.contentType,
    mediaKind: detected.kind,
    extension,
    width: dimensions.width || null,
    height: dimensions.height || null
  };
}

function baseMediaRecord(snapshot, candidate, now) {
  return {
    guildId: snapshot.guildId,
    snapshotId: snapshot.snapshotId,
    sourceMessageId: snapshot.sourceMessageId,
    sourceUrl: candidate.url,
    proxyUrl: candidate.proxyUrl || null,
    timelineMessageId: candidate.timelineMessageId || null,
    timelineAttachmentId: candidate.timelineAttachmentId || null,
    timelineAttachmentUrl: candidate.timelineAttachmentUrl || null,
    componentMediaUrl: candidate.componentMediaUrl || null,
    originalFilename: candidate.originalFilename || null,
    safeFilename: candidate.safeFilename || null,
    contentType: candidate.contentType || null,
    byteSize: Number(candidate.byteSize || 0),
    sha256: null,
    localPath: null,
    mediaKind: candidate.mediaKind || 'file',
    sourceKind: candidate.sourceKind || 'source_attachment',
    spoiler: candidate.spoiler ? 1 : 0,
    width: candidate.width || null,
    height: candidate.height || null,
    durationSeconds: candidate.durationSeconds || null,
    downloadStatus: 'pending',
    lastErrorCode: null,
    firstDownloadedAt: null,
    lastVerifiedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

async function mirrorMediaCandidate(client, snapshot, candidate) {
  if (!candidate?.url || !client.appConfig.timelineRestoration.permanentMediaMirror) return null;
  const existing = client.db.timelineRestoration.media.listBySnapshot(snapshot.snapshotId)
    .find((row) => row.sourceKind === (candidate.sourceKind || 'source_attachment') && row.sourceUrl === candidate.url);
  if (existing?.downloadStatus === 'complete') {
    const existingPath = resolvePermanentPath(existing.localPath);
    const stat = existingPath ? await fs.stat(existingPath).catch(() => null) : null;
    if (stat?.isFile() && stat.size > 0) return existing;
  }
  const now = new Date().toISOString();
  const record = baseMediaRecord(snapshot, candidate, now);
  const shared = client.db.timelineRestoration.media.findCompleteByUrl(snapshot.guildId, candidate.url);
  if (shared) {
    const sharedPath = resolvePermanentPath(shared.localPath);
    const stat = sharedPath ? await fs.stat(sharedPath).catch(() => null) : null;
    if (stat?.isFile() && stat.size > 0) {
      const reused = {
        ...record,
        contentType: shared.contentType,
        byteSize: shared.byteSize,
        sha256: shared.sha256,
        localPath: shared.localPath,
        mediaKind: candidate.mediaKind === 'avatar' ? 'avatar' : shared.mediaKind,
        safeFilename: candidate.safeFilename || stableUploadName(
          snapshot.sourceMessageId,
          Number(candidate.index || 0),
          candidate.originalFilename || path.basename(shared.localPath),
          candidate.spoiler
        ),
        width: shared.width,
        height: shared.height,
        downloadStatus: 'complete',
        firstDownloadedAt: shared.firstDownloadedAt || now,
        lastVerifiedAt: now,
        updatedAt: now
      };
      client.db.timelineRestoration.media.upsert(reused);
      client.logger.info('media mirror completed', {
        guildId: snapshot.guildId,
        sourceMessageId: snapshot.sourceMessageId,
        snapshotId: snapshot.snapshotId,
        sourceKind: reused.sourceKind,
        mediaKind: reused.mediaKind,
        byteSize: reused.byteSize,
        sha256Prefix: String(reused.sha256 || '').slice(0, 12),
        reusedExistingMirror: true
      });
      return reused;
    }
  }
  client.db.timelineRestoration.media.upsert(record);
  client.logger.info('media mirror started', {
    guildId: snapshot.guildId,
    sourceMessageId: snapshot.sourceMessageId,
    snapshotId: snapshot.snapshotId,
    sourceKind: record.sourceKind,
    mediaKind: record.mediaKind
  });
  try {
    const result = await downloadToPermanentMirror(candidate.url, {
      guildId: snapshot.guildId,
      originalFilename: candidate.originalFilename,
      maxBytes: client.appConfig.timelineRestoration.maxMediaBytes,
      timeoutMs: client.appConfig.timelineRestoration.mediaFetchTimeoutMs,
      maxRedirects: client.appConfig.timelineRestoration.maxRedirects
    });
    const complete = {
      ...record,
      contentType: result.contentType,
      byteSize: result.byteSize,
      sha256: result.sha256,
      localPath: result.localPath,
      mediaKind: candidate.mediaKind === 'avatar' ? 'avatar' : result.mediaKind,
      safeFilename: candidate.safeFilename || stableUploadName(
        snapshot.sourceMessageId,
        Number(candidate.index || 0),
        candidate.originalFilename || `${result.sha256}.${result.extension}`,
        candidate.spoiler
      ),
      width: result.width,
      height: result.height,
      downloadStatus: 'complete',
      firstDownloadedAt: now,
      lastVerifiedAt: now,
      updatedAt: new Date().toISOString()
    };
    client.db.timelineRestoration.media.upsert(complete);
    client.logger.info('media mirror completed', {
      guildId: snapshot.guildId,
      sourceMessageId: snapshot.sourceMessageId,
      snapshotId: snapshot.snapshotId,
      sourceKind: complete.sourceKind,
      mediaKind: complete.mediaKind,
      byteSize: complete.byteSize,
      sha256Prefix: complete.sha256.slice(0, 12)
    });
    return complete;
  } catch (error) {
    const failed = {
      ...record,
      downloadStatus: 'failed',
      lastErrorCode: error.code || 'download_failed',
      updatedAt: new Date().toISOString()
    };
    client.db.timelineRestoration.media.upsert(failed);
    client.logger.warn('media mirror failed', {
      guildId: snapshot.guildId,
      sourceMessageId: snapshot.sourceMessageId,
      snapshotId: snapshot.snapshotId,
      sourceKind: failed.sourceKind,
      mediaKind: failed.mediaKind,
      errorCode: failed.lastErrorCode
    });
    return failed;
  }
}

async function mirrorSnapshotCandidates(client, snapshot, candidates) {
  const results = [];
  for (const candidate of candidates) {
    results.push(await mirrorMediaCandidate(client, snapshot, candidate));
  }
  return results.filter(Boolean);
}

function resolvePermanentPath(localPath) {
  if (!localPath) return null;
  const absolute = path.resolve(process.cwd(), localPath);
  if (!absolute.startsWith(`${PERMANENT_ROOT}${path.sep}`)) return null;
  return absolute;
}

module.exports = {
  PERMANENT_ROOT,
  safeFilePart,
  stableUploadName,
  detectType,
  downloadToPermanentMirror,
  mirrorMediaCandidate,
  mirrorSnapshotCandidates,
  resolvePermanentPath,
  validateRemoteUrl,
  fetchWithRedirectLimit
};
