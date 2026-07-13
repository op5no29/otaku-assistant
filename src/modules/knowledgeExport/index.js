const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AttachmentBuilder, PermissionsBitField } = require('discord.js');
const {
  createUniqueDisplayFileName,
  hasSpoilerPrefix,
  resolveBestAttachmentFileName,
  sanitizeDisplayFileName,
  splitFileName
} = require('../../utils/text');
const { createZip } = require('./zip');

const DEFAULT_FORUM_ID = '1503762457779376179';
const MAX_DISCORD_UPLOAD_BYTES = 25_000_000;
const USER_COOLDOWN_MS = 60_000;
const ALLOWED_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'media.discordapp.com'
]);

class KnowledgeExportUserError extends Error {
  constructor(message, code = 'knowledge_export_user_error') {
    super(message);
    this.name = 'KnowledgeExportUserError';
    this.code = code;
  }
}

function getConfig(client) {
  return {
    enabled: client.appConfig?.knowledgeExport?.enabled !== false,
    forumChannelId: String(client.appConfig?.knowledgeExport?.forumChannelId || DEFAULT_FORUM_ID),
    maxMessages: Number(client.appConfig?.knowledgeExport?.maxMessages ?? 5000),
    maxTotalAttachmentBytes: Number(client.appConfig?.knowledgeExport?.maxTotalAttachmentBytes ?? 50_000_000),
    fetchTimeoutMs: Number(client.appConfig?.knowledgeExport?.fetchTimeoutMs ?? 15_000),
    maxConcurrentExports: Number(client.appConfig?.knowledgeExport?.maxConcurrentExports ?? 2),
    timezone: String(client.appConfig?.knowledgeExport?.timezone || 'Asia/Tokyo')
  };
}

function isThreadChannel(channel) {
  return Boolean(channel?.isThread?.());
}

function getJapaneseError(code) {
  const messages = {
    disabled: 'このエクスポート機能は現在無効です。',
    not_thread: 'このコマンドは「知りたいこと」のスレッド内で実行してください。',
    wrong_forum: 'このコマンドは「知りたいこと」フォーラム内のスレッドでのみ使えます。',
    unsupported_thread: 'このスレッド形式はエクスポートに対応していません。',
    missing_history_permission: 'Botにこのスレッドの履歴を読む権限がないため、エクスポートできません。',
    busy_thread: 'このスレッドのエクスポートはすでに実行中です。完了してからもう一度お試しください。',
    busy_global: '現在ほかのエクスポート処理が実行中です。少し待ってからもう一度お試しください。',
    cooldown: '短時間に連続してエクスポートはできません。少し待ってからもう一度お試しください。',
    too_many_messages: 'このスレッドのメッセージ数がエクスポート上限を超えています。管理者に設定変更を依頼してください。',
    fetch_failed: 'スレッド履歴を取得できませんでした。Botの権限またはDiscord側の状態を確認してください。'
  };
  return messages[code] || 'エクスポートを実行できませんでした。時間をおいてもう一度お試しください。';
}

function ensureCooldown(client, userId) {
  const now = Date.now();
  const lastRun = client.knowledgeExportUserCooldowns?.get(userId) || 0;
  if (now - lastRun < USER_COOLDOWN_MS) {
    throw new KnowledgeExportUserError(getJapaneseError('cooldown'), 'cooldown');
  }

  client.knowledgeExportUserCooldowns.set(userId, now);
  setTimeout(() => {
    if (client.knowledgeExportUserCooldowns?.get(userId) === now) {
      client.knowledgeExportUserCooldowns.delete(userId);
    }
  }, USER_COOLDOWN_MS).unref();
}

function acquireExportLock(client, threadId, config) {
  if (client.knowledgeExportThreadLocks.has(threadId)) {
    throw new KnowledgeExportUserError(getJapaneseError('busy_thread'), 'busy_thread');
  }

  if (client.knowledgeExportActiveCount >= config.maxConcurrentExports) {
    throw new KnowledgeExportUserError(getJapaneseError('busy_global'), 'busy_global');
  }

  client.knowledgeExportThreadLocks.add(threadId);
  client.knowledgeExportActiveCount += 1;

  return () => {
    client.knowledgeExportThreadLocks.delete(threadId);
    client.knowledgeExportActiveCount = Math.max(0, client.knowledgeExportActiveCount - 1);
  };
}

async function validateThread(interaction, config) {
  const thread = interaction.channel;
  if (!config.enabled) {
    throw new KnowledgeExportUserError(getJapaneseError('disabled'), 'disabled');
  }

  if (!isThreadChannel(thread)) {
    throw new KnowledgeExportUserError(getJapaneseError('not_thread'), 'not_thread');
  }

  if (String(thread.parentId || '') !== config.forumChannelId) {
    throw new KnowledgeExportUserError(getJapaneseError('wrong_forum'), 'wrong_forum');
  }

  if (!thread.guild || !thread.id) {
    throw new KnowledgeExportUserError(getJapaneseError('unsupported_thread'), 'unsupported_thread');
  }

  const me = interaction.guild?.members?.me || await interaction.guild?.members.fetchMe().catch(() => null);
  const permissions = me ? thread.permissionsFor(me) : null;
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel) ||
      !permissions?.has(PermissionsBitField.Flags.ReadMessageHistory)) {
    throw new KnowledgeExportUserError(getJapaneseError('missing_history_permission'), 'missing_history_permission');
  }

  return thread;
}

async function fetchAllThreadMessages(thread, config) {
  const byId = new Map();
  let before = null;

  while (true) {
    const options = before ? { limit: 100, before } : { limit: 100 };
    let batch;
    try {
      batch = await thread.messages.fetch(options);
    } catch {
      throw new KnowledgeExportUserError(getJapaneseError('fetch_failed'), 'fetch_failed');
    }

    if (!batch.size) {
      break;
    }

    const orderedNewestFirst = Array.from(batch.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const message of orderedNewestFirst) {
      byId.set(message.id, message);
    }

    before = orderedNewestFirst[orderedNewestFirst.length - 1]?.id || before;

    if (byId.size >= config.maxMessages) {
      const older = await thread.messages.fetch({ limit: 1, before }).catch(() => null);
      if (older?.size) {
        throw new KnowledgeExportUserError(getJapaneseError('too_many_messages'), 'too_many_messages');
      }
      break;
    }

    if (batch.size < 100) {
      break;
    }
  }

  if (!byId.has(thread.id)) {
    const starter = await thread.messages.fetch(thread.id).catch(() => null);
    if (starter) {
      byId.set(starter.id, starter);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.createdTimestamp === b.createdTimestamp) {
      return String(a.id).localeCompare(String(b.id));
    }
    return a.createdTimestamp - b.createdTimestamp;
  });
}

function safeYamlString(value) {
  return JSON.stringify(String(value || ''));
}

function safeMarkdownText(value) {
  return String(value || '').replace(/\]/g, '\\]');
}

function formatDateTime(date, timezone) {
  const value = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(value);
}

function formatIsoDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

function getThreadDatePrefix(thread, messages, timezone) {
  const date = thread.createdAt || messages[0]?.createdAt || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function sanitizeExportFileName(value, fallback = 'knowledge-export') {
  const sanitized = sanitizeDisplayFileName(value)
    .replace(/[:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/\.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);

  return sanitized || fallback;
}

function getDisplayNameFromMemberOrUser(member, user) {
  return member?.displayName || user?.globalName || user?.username || user?.tag || user?.id || 'Unknown user';
}

async function buildResolverContext({ interaction, thread, parent, messages }) {
  const users = new Map();
  const members = new Map();
  const channels = new Map();
  const roles = new Map();
  const rawUserMentionIds = new Set();
  const rawChannelMentionIds = new Set();
  const rawRoleMentionIds = new Set();

  for (const message of messages) {
    if (message.author?.id) {
      users.set(message.author.id, message.author);
      if (message.member) {
        members.set(message.author.id, message.member);
      }
    }

    for (const user of message.mentions?.users?.values?.() || []) {
      users.set(user.id, user);
    }
    for (const member of message.mentions?.members?.values?.() || []) {
      members.set(member.id, member);
    }
    for (const channel of message.mentions?.channels?.values?.() || []) {
      channels.set(channel.id, channel);
    }
    for (const role of message.mentions?.roles?.values?.() || []) {
      roles.set(role.id, role);
    }

    for (const match of String(message.content || '').matchAll(/<@!?(\d+)>/g)) {
      rawUserMentionIds.add(match[1]);
    }
    for (const match of String(message.content || '').matchAll(/<#(\d+)>/g)) {
      rawChannelMentionIds.add(match[1]);
    }
    for (const match of String(message.content || '').matchAll(/<@&(\d+)>/g)) {
      rawRoleMentionIds.add(match[1]);
    }
  }

  for (const id of rawUserMentionIds) {
    if (!users.has(id)) {
      const user = interaction.client.users.cache.get(id) || await interaction.client.users.fetch(id).catch(() => null);
      if (user) {
        users.set(id, user);
      }
    }
    if (!members.has(id)) {
      const member = await interaction.guild.members.fetch(id).catch(() => null);
      if (member) {
        members.set(id, member);
      }
    }
  }

  for (const id of rawChannelMentionIds) {
    if (!channels.has(id)) {
      const channel = interaction.guild.channels.cache.get(id) || await interaction.guild.channels.fetch(id).catch(() => null);
      if (channel) {
        channels.set(id, channel);
      }
    }
  }

  for (const id of rawRoleMentionIds) {
    if (!roles.has(id)) {
      const role = interaction.guild.roles.cache.get(id) || await interaction.guild.roles.fetch(id).catch(() => null);
      if (role) {
        roles.set(id, role);
      }
    }
  }

  const ownerId = thread.ownerId || messages[0]?.author?.id || '';
  let ownerUser = ownerId ? users.get(ownerId) : null;
  let ownerMember = ownerId ? members.get(ownerId) : null;
  if (ownerId && !ownerUser) {
    ownerUser = await interaction.client.users.fetch(ownerId).catch(() => null);
    if (ownerUser) {
      users.set(ownerId, ownerUser);
    }
  }
  if (ownerId && !ownerMember) {
    ownerMember = await interaction.guild.members.fetch(ownerId).catch(() => null);
    if (ownerMember) {
      members.set(ownerId, ownerMember);
    }
  }

  return {
    users,
    members,
    channels,
    roles,
    parent,
    ownerId,
    ownerName: getDisplayNameFromMemberOrUser(ownerMember, ownerUser)
  };
}

function displayNameForUserId(userId, context) {
  return getDisplayNameFromMemberOrUser(context.members.get(userId), context.users.get(userId)) || `user_${userId}`;
}

function replaceOutsideCodeFences(content, replacer) {
  const lines = String(content || '').split('\n');
  let inFence = false;
  let fenceMarker = '';

  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      return line;
    }

    return inFence ? line : replacer(line);
  }).join('\n');
}

function convertContent(content, context) {
  return replaceOutsideCodeFences(content, (line) => {
    return line
      .replace(/<a:([A-Za-z0-9_]{2,32}):(\d+)>/g, (match, name, id) =>
        `![${safeMarkdownText(name)}](https://cdn.discordapp.com/emojis/${id}.gif)`
      )
      .replace(/<:([A-Za-z0-9_]{2,32}):(\d+)>/g, (match, name, id) =>
        `![${safeMarkdownText(name)}](https://cdn.discordapp.com/emojis/${id}.webp)`
      )
      .replace(/<@!?(\d+)>/g, (match, id) => {
        const name = displayNameForUserId(id, context);
        return `@${name} <!-- Discord user: ${id} -->`;
      })
      .replace(/<#(\d+)>/g, (match, id) => {
        const name = context.channels.get(id)?.name || `channel_${id}`;
        return `#${name} <!-- Discord channel: ${id} -->`;
      })
      .replace(/<@&(\d+)>/g, (match, id) => {
        const name = context.roles.get(id)?.name || `role_${id}`;
        return `@${name} <!-- Discord role: ${id} -->`;
      });
  });
}

function summarizeReply(message, messageMap, context) {
  const referenceId = message.reference?.messageId;
  if (!referenceId) {
    return null;
  }

  const referenced = messageMap.get(referenceId);
  if (!referenced) {
    return '> Replying to: 参照元メッセージを取得できませんでした。';
  }

  const authorName = displayNameForUserId(referenced.author?.id, context);
  const converted = convertContent(referenced.content || '', context)
    .replace(/\s+/g, ' ')
    .trim();
  const attachmentSummary = referenced.attachments?.size
    ? `添付${referenced.attachments.size}件`
    : '';
  const summary = (converted || attachmentSummary || '本文なし').slice(0, 120);
  return `> Replying to ${authorName}: ${summary}${summary.length >= 120 ? '...' : ''}`;
}

function getAvailableTags(parent) {
  const tags = parent?.availableTags;
  if (!tags) {
    return [];
  }

  if (typeof tags.values === 'function') {
    return Array.from(tags.values());
  }

  return Array.isArray(tags) ? tags : [];
}

function getAppliedTagNames(thread, parent) {
  const tags = getAvailableTags(parent);
  const byId = new Map(tags.map((tag) => [String(tag.id), tag]));
  return (thread.appliedTags || [])
    .map((id) => byId.get(String(id))?.name || String(id))
    .filter(Boolean);
}

function normalizeAttachmentForExport(attachment, message, index, usedNames) {
  const originalName = resolveBestAttachmentFileName(attachment, {
    sourceContent: message.content,
    sourceMessageId: message.id
  });
  const extension = splitFileName(originalName).extension || splitFileName(attachment.name).extension || '';
  const safeOriginalName = sanitizeExportFileName(originalName, `attachment-${index + 1}${extension}`);
  const prefixedName = `${message.id}-attachment-${index + 1}${extension || ''}`;
  const displayName = createUniqueDisplayFileName(prefixedName, usedNames);

  return {
    id: String(attachment.id || `${message.id}-${index + 1}`),
    messageId: message.id,
    index,
    originalName: safeOriginalName,
    fileName: displayName,
    assetPath: `assets/${displayName}`,
    url: attachment.url,
    contentType: attachment.contentType || '',
    size: Number(attachment.size || 0),
    isImage: String(attachment.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(originalName),
    isSpoiler: Boolean(attachment.spoiler || hasSpoilerPrefix(attachment.name) || hasSpoilerPrefix(originalName)),
    skippedReason: null,
    downloaded: false
  };
}

function collectAttachments(messages) {
  const usedNames = new Set();
  const attachments = [];

  for (const message of messages) {
    let index = 0;
    for (const attachment of message.attachments?.values?.() || []) {
      attachments.push(normalizeAttachmentForExport(attachment, message, index, usedNames));
      index += 1;
    }
  }

  return attachments;
}

function isAllowedDiscordAttachmentUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' && ALLOWED_ATTACHMENT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function contentTypesMatch(expected, actual, fileName) {
  const normalizedActual = String(actual || '').split(';')[0].trim().toLowerCase();
  const normalizedExpected = String(expected || '').split(';')[0].trim().toLowerCase();

  if (!normalizedActual || normalizedActual === 'text/html') {
    return false;
  }

  if (!normalizedExpected || normalizedActual === 'application/octet-stream') {
    return true;
  }

  if (normalizedActual === normalizedExpected) {
    return true;
  }

  const expectedTop = normalizedExpected.split('/')[0];
  const actualTop = normalizedActual.split('/')[0];
  if (expectedTop && expectedTop === actualTop) {
    return true;
  }

  if (/\.pdf$/i.test(fileName)) {
    return normalizedActual === 'application/pdf';
  }

  return false;
}

async function readResponseWithLimit(response, maxBytes) {
  const chunks = [];
  let total = 0;

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error('download_size_limit_exceeded');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('download_size_limit_exceeded');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function downloadAttachmentToTemp(attachment, tempRoot, remainingBytes, config) {
  if (!isAllowedDiscordAttachmentUrl(attachment.url)) {
    attachment.skippedReason = 'unsupported_attachment_url';
    return null;
  }

  if (attachment.size > remainingBytes) {
    attachment.skippedReason = 'attachment_size_limit_exceeded';
    return null;
  }

  const response = await fetch(attachment.url, {
    signal: AbortSignal.timeout(config.fetchTimeoutMs)
  });

  if (!response.ok) {
    attachment.skippedReason = 'download_failed';
    return null;
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > remainingBytes) {
    attachment.skippedReason = 'attachment_size_limit_exceeded';
    return null;
  }

  const responseContentType = response.headers.get('content-type') || '';
  if (!contentTypesMatch(attachment.contentType, responseContentType, attachment.fileName)) {
    attachment.skippedReason = 'content_type_mismatch';
    return null;
  }

  const buffer = await readResponseWithLimit(response, remainingBytes);
  const outputPath = path.join(tempRoot, attachment.assetPath);
  const relativeCheck = path.relative(tempRoot, outputPath);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    attachment.skippedReason = 'unsafe_output_path';
    return null;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer, { flag: 'wx' });
  attachment.downloaded = true;
  attachment.downloadedBytes = buffer.length;
  return {
    name: attachment.assetPath,
    data: buffer
  };
}

async function prepareZipAssets(attachments, config, logger, context) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otaku-knowledge-export-'));
  const entries = [];
  let downloadedBytes = 0;

  try {
    for (const attachment of attachments) {
      const remainingBytes = config.maxTotalAttachmentBytes - downloadedBytes;
      if (remainingBytes <= 0) {
        attachment.skippedReason = 'total_attachment_size_limit_exceeded';
        continue;
      }

      try {
        const entry = await downloadAttachmentToTemp(attachment, tempRoot, remainingBytes, config);
        if (entry) {
          downloadedBytes += entry.data.length;
          entries.push(entry);
        }
      } catch (error) {
        attachment.skippedReason = error.name === 'TimeoutError' ? 'download_timeout' : 'download_failed';
      }
    }

    logger.info('Knowledge export attachments prepared', {
      ...context,
      attachmentCount: attachments.length,
      downloadedAttachmentCount: entries.length,
      downloadedBytes,
      skippedAttachmentCount: attachments.filter((attachment) => !attachment.downloaded).length
    });

    return {
      tempRoot,
      entries,
      downloadedBytes,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => null);
    throw error;
  }
}

function formatAttachmentMarkdown(attachment, useLocalAssets) {
  const target = useLocalAssets && attachment.downloaded
    ? encodeURI(attachment.assetPath)
    : attachment.url;
  const label = safeMarkdownText(attachment.originalName || attachment.fileName);
  const lines = [];

  if (attachment.isSpoiler) {
    lines.push('> Spoiler attachment');
  }

  if (!target) {
    lines.push(`添付ファイル: ${label}（URLなし）`);
    return lines.join('\n');
  }

  if (useLocalAssets && !attachment.downloaded) {
    lines.push(`添付ファイルはZIPに保存できませんでした: [${label}](${target})`);
    if (attachment.skippedReason) {
      lines.push(`> Attachment skipped: ${attachment.skippedReason}`);
    }
    return lines.join('\n');
  }

  if (attachment.isImage) {
    lines.push(`![${label}](${target})`);
  } else {
    lines.push(`[${label}](${target})`);
  }

  return lines.join('\n');
}

function formatReactions(message) {
  const reactions = Array.from(message.reactions?.cache?.values?.() || []);
  if (!reactions.length) {
    return '';
  }

  const parts = reactions.map((reaction) => {
    const emoji = reaction.emoji?.id
      ? `:${reaction.emoji.name || reaction.emoji.id}:`
      : (reaction.emoji?.name || 'reaction');
    return `${emoji} ${reaction.count || 0}`;
  });

  return `Reactions: ${parts.join(', ')}`;
}

function formatEmbeds(message) {
  const embeds = Array.from(message.embeds || [])
    .filter((embed) => embed?.title || embed?.description || embed?.url)
    .slice(0, 5);

  if (!embeds.length) {
    return [];
  }

  return embeds.map((embed) => {
    const title = String(embed.title || embed.url || 'Link preview').replace(/\s+/g, ' ').trim();
    const description = String(embed.description || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return description
      ? `> Link preview: ${title} — ${description}`
      : `> Link preview: ${title}`;
  });
}

function renderMarkdown({
  thread,
  parent,
  messages,
  attachments,
  context,
  config,
  interaction,
  useLocalAssets,
  includeReactions,
  fallbackNotice
}) {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  const title = thread.name || 'Knowledge thread';
  const threadUrl = `https://discord.com/channels/${thread.guildId}/${thread.id}/${thread.id}`;
  const appliedTags = getAppliedTagNames(thread, parent);
  const participants = Array.from(new Set(messages.map((message) => message.author?.id).filter(Boolean)))
    .map((id) => ({
      id,
      name: displayNameForUserId(id, context)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const lines = [
    '---',
    `title: ${safeYamlString(title)}`,
    `discord_thread_id: ${safeYamlString(thread.id)}`,
    `discord_forum_id: ${safeYamlString(thread.parentId)}`,
    `discord_url: ${safeYamlString(threadUrl)}`,
    `created_at: ${safeYamlString(formatIsoDate(thread.createdAt || messages[0]?.createdAt || new Date()))}`,
    `exported_at: ${safeYamlString(new Date().toISOString())}`,
    `exported_by_discord_user_id: ${safeYamlString(interaction.user.id)}`,
    appliedTags.length ? 'tags:' : 'tags: []',
    ...(appliedTags.length ? appliedTags.map((tag) => `  - ${safeYamlString(tag)}`) : []),
    participants.length ? 'participants:' : 'participants: []',
    ...participants.map((participant) => [
      `  - name: ${safeYamlString(participant.name)}`,
      `    discord_user_id: ${safeYamlString(participant.id)}`
    ].join('\n')),
    '---',
    '',
    `# ${title}`,
    '',
    '## Thread information',
    '',
    `* Forum: ${parent?.name || '知りたいこと'}`,
    `* Created by: ${context.ownerName}`,
    `* Created at: ${formatDateTime(thread.createdAt || messages[0]?.createdAt || new Date(), config.timezone)}`,
    `* Discord: ${threadUrl}`,
    `* Archived: ${thread.archived ? 'yes' : 'no'}`,
    `* Locked: ${thread.locked ? 'yes' : 'no'}`,
    `* Tags: ${appliedTags.length ? appliedTags.join(', ') : 'なし'}`,
    `* Participants: ${participants.map((participant) => participant.name).join(', ') || 'なし'}`,
    `* Exported at: ${formatDateTime(new Date(), config.timezone)}`,
    ''
  ];

  if (!useLocalAssets) {
    lines.push('> 添付ファイルはDiscord CDNの元URLを参照しています。これらのURLは将来アクセスできなくなる可能性があります。', '');
  }

  if (fallbackNotice) {
    lines.push(`> ${fallbackNotice}`, '');
  }

  lines.push('## Conversation', '');

  const attachmentsByMessage = new Map();
  for (const attachment of attachments) {
    if (!attachmentsByMessage.has(attachment.messageId)) {
      attachmentsByMessage.set(attachment.messageId, []);
    }
    attachmentsByMessage.get(attachment.messageId).push(attachment);
  }

  for (const message of messages) {
    const authorName = displayNameForUserId(message.author?.id, context);
    const edited = message.editedTimestamp ? ' （編集済み）' : '';
    lines.push(`### ${authorName} — ${formatDateTime(message.createdAt, config.timezone)}${edited}`);
    lines.push('');
    lines.push(`<!-- Discord message id: ${message.id} -->`);
    lines.push('');

    const replyLine = summarizeReply(message, messageMap, context);
    if (replyLine) {
      lines.push(replyLine, '');
    }

    const convertedContent = convertContent(message.content || '', context).trimEnd();
    if (convertedContent) {
      lines.push(convertedContent, '');
    }

    for (const attachment of attachmentsByMessage.get(message.id) || []) {
      lines.push(formatAttachmentMarkdown(attachment, useLocalAssets), '');
    }

    const embedLines = formatEmbeds(message);
    if (embedLines.length) {
      lines.push(...embedLines, '');
    }

    if (includeReactions) {
      const reactionLine = formatReactions(message);
      if (reactionLine) {
        lines.push(reactionLine, '');
      }
    }

    lines.push('---', '');
  }

  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
}

function buildBaseFileName(thread, messages, timezone) {
  const prefix = getThreadDatePrefix(thread, messages, timezone);
  const title = sanitizeExportFileName(thread.name || 'knowledge-thread');
  return sanitizeExportFileName(`${prefix}_${title}_${thread.id}`);
}

async function buildExportPayload({ interaction, thread, parent, messages, config, format, includeReactions, logger }) {
  const context = await buildResolverContext({ interaction, thread, parent, messages });
  const attachments = collectAttachments(messages);
  const baseFileName = buildBaseFileName(thread, messages, config.timezone);
  const requestedFormat = format || (attachments.length ? 'zip' : 'markdown');
  const logContext = {
    threadId: thread.id,
    forumId: thread.parentId,
    guildId: thread.guildId,
    messageCount: messages.length,
    requestedFormat,
    includeReactions
  };

  if (requestedFormat !== 'zip') {
    const markdown = renderMarkdown({
      thread,
      parent,
      messages,
      attachments,
      context,
      config,
      interaction,
      useLocalAssets: false,
      includeReactions
    });
    return {
      fileName: `${baseFileName}.md`,
      buffer: Buffer.from(markdown, 'utf8'),
      content: `エクスポートしました: ${messages.length}件のメッセージ`,
      usedFormat: 'markdown'
    };
  }

  const declaredAttachmentBytes = attachments.reduce((sum, attachment) => sum + Math.max(0, attachment.size || 0), 0);
  if (declaredAttachmentBytes > config.maxTotalAttachmentBytes) {
    const fallbackNotice = `添付ファイル合計が設定上限を超えたため、Markdownのみで書き出しました。添付は元URL参照です。`;
    const markdown = renderMarkdown({
      thread,
      parent,
      messages,
      attachments,
      context,
      config,
      interaction,
      useLocalAssets: false,
      includeReactions,
      fallbackNotice
    });
    return {
      fileName: `${baseFileName}.md`,
      buffer: Buffer.from(markdown, 'utf8'),
      content: `${fallbackNotice}\nエクスポートしました: ${messages.length}件のメッセージ`,
      usedFormat: 'markdown_fallback'
    };
  }

  const assetPreparation = await prepareZipAssets(attachments, config, logger, logContext);
  try {
    if (!assetPreparation.entries.length && !format) {
      const markdown = renderMarkdown({
        thread,
        parent,
        messages,
        attachments,
        context,
        config,
        interaction,
        useLocalAssets: false,
        includeReactions
      });
      return {
        fileName: `${baseFileName}.md`,
        buffer: Buffer.from(markdown, 'utf8'),
        content: `エクスポートしました: ${messages.length}件のメッセージ`,
        usedFormat: 'markdown'
      };
    }

    const markdown = renderMarkdown({
      thread,
      parent,
      messages,
      attachments,
      context,
      config,
      interaction,
      useLocalAssets: true,
      includeReactions
    });
    const folderName = sanitizeExportFileName(thread.name || 'knowledge-thread');
    const zipEntries = [
      {
        name: `${folderName}/index.md`,
        data: Buffer.from(markdown, 'utf8')
      },
      ...assetPreparation.entries.map((entry) => ({
        name: `${folderName}/${entry.name}`,
        data: entry.data
      }))
    ];
    const zipBuffer = createZip(zipEntries);

    if (zipBuffer.length > MAX_DISCORD_UPLOAD_BYTES) {
      const fallbackNotice = `ZIPがDiscordの送信上限を超えたため、Markdownのみで書き出しました。添付は元URL参照です。`;
      const fallbackMarkdown = renderMarkdown({
        thread,
        parent,
        messages,
        attachments,
        context,
        config,
        interaction,
        useLocalAssets: false,
        includeReactions,
        fallbackNotice
      });
      return {
        fileName: `${baseFileName}.md`,
        buffer: Buffer.from(fallbackMarkdown, 'utf8'),
        content: `${fallbackNotice}\nエクスポートしました: ${messages.length}件のメッセージ`,
        usedFormat: 'markdown_fallback'
      };
    }

    return {
      fileName: `${baseFileName}.zip`,
      buffer: zipBuffer,
      content: `エクスポートしました: ${messages.length}件のメッセージ / 添付${assetPreparation.entries.length}件`,
      usedFormat: 'zip'
    };
  } finally {
    await assetPreparation.cleanup();
  }
}

async function exportKnowledgeThread(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const client = interaction.client;
  const logger = client.logger;
  const config = getConfig(client);
  const format = interaction.options.getString('format');
  const includeReactions = interaction.options.getBoolean('include-reactions') === true;
  let releaseLock = null;

  try {
    const thread = await validateThread(interaction, config);
    ensureCooldown(client, interaction.user.id);
    releaseLock = acquireExportLock(client, thread.id, config);

    const parent = thread.parent || await client.channels.fetch(thread.parentId).catch(() => null);

    logger.info('Knowledge export started', {
      threadId: thread.id,
      forumId: thread.parentId,
      guildId: thread.guildId,
      requestedFormat: format || 'auto',
      includeReactions
    });

    const messages = await fetchAllThreadMessages(thread, config);
    const payload = await buildExportPayload({
      interaction,
      thread,
      parent,
      messages,
      config,
      format,
      includeReactions,
      logger
    });

    if (payload.buffer.length > MAX_DISCORD_UPLOAD_BYTES) {
      throw new KnowledgeExportUserError('エクスポートファイルがDiscordの送信上限を超えました。添付やメッセージ数を減らすか、管理者に相談してください。');
    }

    const attachment = new AttachmentBuilder(payload.buffer, { name: payload.fileName });
    await interaction.editReply({
      content: payload.content,
      files: [attachment],
      allowedMentions: { parse: [] }
    });

    logger.info('Knowledge export finished', {
      threadId: thread.id,
      forumId: thread.parentId,
      guildId: thread.guildId,
      messageCount: messages.length,
      outputBytes: payload.buffer.length,
      outputFormat: payload.usedFormat
    });
  } catch (error) {
    if (error instanceof KnowledgeExportUserError) {
      await interaction.editReply({
        content: error.message,
        allowedMentions: { parse: [] }
      });
      return;
    }

    logger.error('Knowledge export failed', {
      threadId: interaction.channel?.id || null,
      forumId: interaction.channel?.parentId || null,
      guildId: interaction.guildId || null,
      error: error.message
    });

    await interaction.editReply({
      content: 'エクスポート中にエラーが発生しました。時間をおいてもう一度お試しください。',
      allowedMentions: { parse: [] }
    });
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}

module.exports = {
  exportKnowledgeThread,
  fetchAllThreadMessages,
  renderMarkdown
};
