const fs = require('node:fs/promises');
const path = require('node:path');
const { extractTimelineComponentData, walkComponents, collectAttachmentUrls } = require('./componentsParser');
const {
  fetchWithRedirectLimit,
  mirrorMediaCandidate,
  resolvePermanentPath,
  stableUploadName
} = require('./mediaMirror');

async function urlAccessible(url, timeoutMs) {
  if (!/^https?:\/\//iu.test(String(url || ''))) return false;
  try {
    const response = await fetchWithRedirectLimit(url, { timeoutMs, maxRedirects: 4 });
    await response.body?.cancel?.().catch(() => null);
    return response.ok || response.status === 206;
  } catch {
    return false;
  }
}

function isLikelyVideo(url) {
  return /\.(?:mp4|webm|mov)(?:[?#]|$)/iu.test(String(url || ''));
}

function cloneComponents(components) {
  return JSON.parse(JSON.stringify(components || []));
}

function replaceComponentUrls(components, replacements) {
  walkComponents(components, (value) => {
    if (typeof value.url === 'string' && replacements.has(value.url)) value.url = replacements.get(value.url);
    if (value.media && typeof value.media.url === 'string' && replacements.has(value.media.url)) {
      value.media.url = replacements.get(value.media.url);
    }
    if (value.file && typeof value.file.url === 'string' && replacements.has(value.file.url)) {
      value.file.url = replacements.get(value.file.url);
    }
  });
  return components;
}

async function auditTimelineMedia(client, { repair = false } = {}) {
  const mappings = client.db.timelineRestoration.snapshots.listRelayMappings()
    .filter((mapping) => !mapping.destinationChannelId
      || String(mapping.destinationChannelId) === String(client.appConfig.timelineChannelId));
  const grouped = new Map();
  const seenMappings = new Set();
  for (const mapping of mappings) {
    const mappingKey = `${mapping.sourceMessageId}:${mapping.relayedMessageId}`;
    if (seenMappings.has(mappingKey)) continue;
    seenMappings.add(mappingKey);
    if (!grouped.has(mapping.relayedMessageId)) grouped.set(mapping.relayedMessageId, []);
    grouped.get(mapping.relayedMessageId).push(mapping);
  }
  const report = {
    mode: repair ? 'repair' : 'dry-run',
    cardsScanned: 0,
    attachmentReferencesFound: 0,
    missingMatchingAttachments: 0,
    inaccessibleImageUrls: 0,
    inaccessibleVideoUrls: 0,
    zeroByteAttachments: 0,
    expiredSourceAttachmentUrls: 0,
    repairableFromSource: 0,
    repairableFromPermanentMirror: 0,
    repairableFromComponentsV2Media: 0,
    permanentlyUnrecoverableCards: 0,
    repairedCards: 0,
    estimatedDownloadUploadBytes: 0
  };
  const guildId = process.env.GUILD_ID || client.guilds.cache.first()?.id;
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const timeline = guild ? await guild.channels.fetch(client.appConfig.timelineChannelId).catch(() => null) : null;
  if (!timeline?.isTextBased?.()) throw new Error('Timeline channel is unavailable');

  const accessibilityCache = new Map();
  const isAccessible = (url) => {
    if (!accessibilityCache.has(url)) {
      accessibilityCache.set(url, urlAccessible(
        url,
        Math.min(Number(client.appConfig.timelineRestoration.mediaFetchTimeoutMs || 20_000), 8000)
      ));
    }
    return accessibilityCache.get(url);
  };
  const processCard = async ([timelineMessageId, sources]) => {
    const message = await timeline.messages.fetch(timelineMessageId).catch(() => null);
    if (!message) return;
    report.cardsScanned += 1;
    const parsed = extractTimelineComponentData(message);
    const attachments = collectAttachmentUrls(message);
    const byName = new Map(attachments.map((attachment) => [attachment.name, attachment]));
    const brokenUrls = new Set();
    const missingReferences = parsed.attachmentReferences.filter((reference) => !byName.has(reference.filename));
    report.attachmentReferencesFound += parsed.attachmentReferences.length;
    report.missingMatchingAttachments += missingReferences.length;
    missingReferences.forEach((reference) => brokenUrls.add(reference.url));
    for (const attachment of attachments) {
      if (attachment.size <= 0) {
        report.zeroByteAttachments += 1;
        brokenUrls.add(`attachment://${attachment.name}`);
      }
    }
    const externalItems = [...parsed.mediaItems, ...parsed.fileItems]
      .filter((item) => /^https?:\/\//iu.test(String(item.url || '')));
    const accessibleExternalItems = [];
    for (const item of externalItems) {
      if (await isAccessible(item.url)) {
        accessibleExternalItems.push(item);
        continue;
      }
      brokenUrls.add(item.url);
      if (isLikelyVideo(item.url)) report.inaccessibleVideoUrls += 1;
      else report.inaccessibleImageUrls += 1;
      if (/cdn\.discordapp\.com|media\.discordapp\.net/iu.test(item.url)) report.expiredSourceAttachmentUrls += 1;
    }
    if (!brokenUrls.size) return;

    const snapshots = sources
      .map((source) => client.db.timelineRestoration.snapshots.get(guild.id, source.sourceMessageId))
      .filter(Boolean);
    const mediaRows = snapshots.flatMap((snapshot) => client.db.timelineRestoration.media.listBySnapshot(snapshot.snapshotId));
    let permanent = [];
    for (const row of mediaRows) {
      const filePath = row.downloadStatus === 'complete' ? resolvePermanentPath(row.localPath) : null;
      const stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
      if (stat?.isFile() && stat.size > 0) permanent.push({ row, filePath, size: stat.size });
    }
    let sourceRepairable = false;
    let recoverableSource = null;
    if (!permanent.length) {
      const sourceCandidates = mediaRows.flatMap((row) => (
        [row.timelineAttachmentUrl, row.sourceUrl, row.componentMediaUrl, row.proxyUrl]
          .filter((url) => /^https?:\/\//iu.test(String(url || '')))
          .map((url) => ({ row, url }))
      ));
      const checked = new Set();
      for (const candidate of sourceCandidates) {
        if (checked.has(candidate.url)) continue;
        checked.add(candidate.url);
        if (await isAccessible(candidate.url)) {
          sourceRepairable = true;
          recoverableSource = candidate;
          break;
        }
      }
    }
    const recoverableSnapshot = recoverableSource
      ? snapshots.find((snapshot) => Number(snapshot.snapshotId) === Number(recoverableSource.row.snapshotId))
      : null;
    if (repair && !permanent.length && recoverableSource && recoverableSnapshot) {
      const mirrored = await mirrorMediaCandidate(client, recoverableSnapshot, {
        index: recoverableSource.row.mediaId,
        url: recoverableSource.url,
        proxyUrl: recoverableSource.row.proxyUrl,
        originalFilename: recoverableSource.row.originalFilename,
        safeFilename: recoverableSource.row.safeFilename,
        contentType: recoverableSource.row.contentType,
        byteSize: recoverableSource.row.byteSize,
        mediaKind: recoverableSource.row.mediaKind,
        sourceKind: 'audit_recovery',
        spoiler: Boolean(recoverableSource.row.spoiler)
      });
      const filePath = mirrored?.downloadStatus === 'complete' ? resolvePermanentPath(mirrored.localPath) : null;
      const stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
      if (stat?.isFile() && stat.size > 0) permanent = [{ row: mirrored, filePath, size: stat.size }];
    }
    if (permanent.length) {
      report.repairableFromPermanentMirror += 1;
      report.estimatedDownloadUploadBytes += permanent.reduce((sum, entry) => sum + entry.size, 0);
    } else if (sourceRepairable) {
      report.repairableFromSource += 1;
    } else if (missingReferences.length && accessibleExternalItems.length) {
      report.repairableFromComponentsV2Media += 1;
    } else {
      report.permanentlyUnrecoverableCards += 1;
    }
    client.logger.warn('broken timeline media detected', {
      guildId: guild.id,
      timelineMessageId,
      sourceMessageIds: sources.map((source) => source.sourceMessageId),
      missingReferenceCount: missingReferences.length,
      brokenExternalCount: [...brokenUrls].filter((url) => /^https?:/iu.test(url)).length,
      repairableFromMirror: permanent.length > 0
    });
    if (!repair || !permanent.length) return;

    const replacements = new Map();
    const files = [];
    const usedNames = new Set(attachments.map((attachment) => attachment.name));
    let candidateIndex = 0;
    const usedMediaIds = new Set();
    for (const brokenUrl of brokenUrls) {
      if (files.length >= 10) break;
      const brokenFilename = String(brokenUrl).startsWith('attachment://')
        ? decodeURIComponent(String(brokenUrl).slice('attachment://'.length))
        : null;
      let candidate = permanent.find((entry) => !usedMediaIds.has(entry.row.mediaId) && brokenFilename
        && [entry.row.safeFilename, entry.row.originalFilename].includes(brokenFilename));
      if (!candidate && /^https?:\/\//iu.test(String(brokenUrl))) {
        candidate = permanent.find((entry) => !usedMediaIds.has(entry.row.mediaId)
          && [entry.row.sourceUrl, entry.row.timelineAttachmentUrl, entry.row.componentMediaUrl, entry.row.proxyUrl].includes(brokenUrl));
      }
      if (!candidate && brokenUrls.size === 1 && permanent.length === 1) candidate = permanent[0];
      if (!candidate) break;
      usedMediaIds.add(candidate.row.mediaId);
      candidateIndex += 1;
      const sourceId = sources[0]?.sourceMessageId || timelineMessageId;
      let name = candidate.row.safeFilename
        || stableUploadName(sourceId, candidateIndex - 1, candidate.row.originalFilename || path.basename(candidate.filePath), candidate.row.spoiler);
      while (usedNames.has(name)) name = stableUploadName(sourceId, candidateIndex + usedNames.size, name, candidate.row.spoiler);
      usedNames.add(name);
      files.push({ attachment: candidate.filePath, name });
      replacements.set(brokenUrl, `attachment://${name}`);
    }
    if (!files.length) return;
    const before = { brokenUrls: [...brokenUrls], attachmentNames: attachments.map((attachment) => attachment.name) };
    const nextComponents = replaceComponentUrls(cloneComponents(parsed.rawComponents), replacements);
    const edited = await message.edit({
      flags: message.flags.bitfield,
      components: nextComponents,
      files,
      attachments: attachments.map((attachment) => ({ id: attachment.id }))
    });
    const verified = extractTimelineComponentData(edited);
    const verifiedAttachments = collectAttachmentUrls(edited);
    const verifiedNames = new Set(verifiedAttachments.map((attachment) => attachment.name));
    const stillMissing = verified.attachmentReferences.filter((reference) => !verifiedNames.has(reference.filename));
    const status = stillMissing.length ? 'repair_verification_failed' : 'repaired';
    client.db.timelineRestoration.audit.record({
      guildId: guild.id,
      sourceMessageId: sources[0]?.sourceMessageId || null,
      timelineMessageId,
      status,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify({ attachmentNames: verifiedAttachments.map((attachment) => attachment.name), missingReferenceCount: stillMissing.length }),
      errorCode: stillMissing.length ? 'attachment_reference_missing' : null
    });
    if (!stillMissing.length) {
      report.repairedCards += 1;
      client.logger.info('broken timeline media repaired', {
        guildId: guild.id,
        timelineMessageId,
        replacementCount: replacements.size,
        attachmentCount: verifiedAttachments.length
      });
    }
  };
  const entries = [...grouped.entries()];
  const concurrency = repair ? 1 : 8;
  for (let index = 0; index < entries.length; index += concurrency) {
    await Promise.all(entries.slice(index, index + concurrency).map(processCard));
  }

  client.logger.info(repair ? 'timeline media repair completed' : 'timeline media audit dry run completed', report);
  return report;
}

module.exports = {
  auditTimelineMedia,
  urlAccessible,
  replaceComponentUrls
};
