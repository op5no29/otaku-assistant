const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { postAnimeToChannel, getAnimeById, updateAnimeChannelCard, updateAnimeReviewCard } = require('../anime');
const { notifyOpsChannel } = require('../ops/notify');

const PROVIDER = 'annict';
const ENCRYPTION_VERSION = 1;
const OAUTH_SCOPE = ['read', 'write'];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GRAPHQL_ENDPOINT = 'https://api.annict.com/graphql';
const API_BASE = 'https://api.annict.com';
const ANNICT_ACCOUNT_URL = 'https://annict.com/sign_up';
const DELAYED_EMBED_INSPECTION_MS = 3500;
const YOUTUBE_OEMBED_TIMEOUT_MS = 4000;
const PREVIEW_CACHE_TTL_MS = 60 * 60 * 1000;
const VALID_SYNC_STATES = new Set(['WANNA_WATCH', 'WATCHING', 'WATCHED']);
const DEFAULT_WATCHED_IMPORT_WORKER_INTERVAL_MS = 60 * 1000;
const STATUS_TO_ANNICT_KIND = {
  interested: 'wanna_watch',
  watched: 'watched'
};
const STATUS_TO_GRAPHQL_STATE = {
  wanna_watch: 'WANNA_WATCH',
  watching: 'WATCHING',
  watched: 'WATCHED'
};
const GRAPHQL_STATE_TO_STATUS = {
  WANNA_WATCH: 'wanna_watch',
  WATCHING: 'watching',
  WATCHED: 'watched'
};

class AnnictUserIntegrationError extends Error {
  constructor(message, code = 'annict_user_integration_error') {
    super(message);
    this.name = 'AnnictUserIntegrationError';
    this.code = code;
  }
}

function getConfig(client) {
  return client.appConfig?.annictUserIntegration || {};
}

function getWatchedImportConfig(client) {
  const config = getConfig(client).watchedImport || {};
  return {
    enabled: config.enabled !== false,
    pageSize: Math.max(1, Math.min(Number(config.pageSize || 50), 100)),
    maxCardsPerBatch: Math.max(1, Math.min(Number(config.maxCardsPerBatch || 3), 10)),
    batchIntervalMinutes: Math.max(1, Number(config.batchIntervalMinutes || 5)),
    delayBetweenCardsMs: Math.max(0, Number(config.delayBetweenCardsMs || 5000)),
    repairMissingMessages: config.repairMissingMessages !== false,
    maxAttemptsPerWork: Math.max(1, Number(config.maxAttemptsPerWork || 3))
  };
}

function getEnv(config, name) {
  return String(process.env[config?.[name] || ''] || '').trim();
}

function getRuntimeStatus(client) {
  const config = getConfig(client);
  if (config.enabled === false) {
    return { ok: false, code: 'disabled', message: 'Annict連携は現在無効です。' };
  }

  const clientId = getEnv(config, 'oauthClientIdEnv');
  const clientSecret = getEnv(config, 'oauthClientSecretEnv');
  if (!clientId || !clientSecret) {
    return { ok: false, code: 'oauth_env_missing', message: 'Annict OAuth設定が不足しています。管理者に確認してください。' };
  }

  const key = getEncryptionKey(config);
  if (!key) {
    return { ok: false, code: 'encryption_key_invalid', message: 'Annict連携の暗号化キーが未設定または不正です。管理者に確認してください。' };
  }

  return {
    ok: true,
    config,
    clientId,
    clientSecret,
    encryptionKey: key
  };
}

function getEncryptionKey(config) {
  const raw = getEnv(config, 'tokenEncryptionKeyEnv');
  if (!raw) {
    return null;
  }

  try {
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function buildAad(guildId, discordUserId) {
  return Buffer.from(`${PROVIDER}:${guildId}:${discordUserId}`, 'utf8');
}

function encryptAccessToken(token, { guildId, discordUserId, key, keyId = 'default' }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(buildAad(guildId, discordUserId));
  const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encryptedAccessToken: encrypted.toString('base64'),
    tokenIv: iv.toString('base64'),
    tokenAuthTag: tag.toString('base64'),
    encryptionVersion: ENCRYPTION_VERSION,
    encryptionKeyId: keyId
  };
}

function decryptAccessToken(connection, { guildId, discordUserId, key }) {
  if (!connection || Number(connection.encryptionVersion) !== ENCRYPTION_VERSION) {
    throw new AnnictUserIntegrationError('Annict連携情報の暗号化バージョンに対応していません。', 'unsupported_encryption_version');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(connection.tokenIv, 'base64'));
    decipher.setAAD(buildAad(guildId, discordUserId));
    decipher.setAuthTag(Buffer.from(connection.tokenAuthTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(connection.encryptedAccessToken, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new AnnictUserIntegrationError('Annict連携情報の復号に失敗しました。管理者に確認してください。', 'decrypt_failed');
  }
}

function buildAbortSignal(timeoutMs = 15_000) {
  if (AbortSignal?.timeout) {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function annictFetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || buildAbortSignal(options.timeoutMs)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new AnnictUserIntegrationError(`Annict API HTTP ${response.status}`, response.status === 401 ? 'annict_unauthorized' : 'annict_api_error');
    error.httpStatus = response.status;
    throw error;
  }
  return body;
}

async function exchangeAuthorizationCode(client, code, redirectUri) {
  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    throw new AnnictUserIntegrationError(runtime.message, runtime.code);
  }

  const form = new FormData();
  form.set('client_id', runtime.clientId);
  form.set('client_secret', runtime.clientSecret);
  form.set('grant_type', 'authorization_code');
  form.set('redirect_uri', redirectUri);
  form.set('code', String(code || '').trim());

  return annictFetchJson(`${API_BASE}/oauth/token`, {
    method: 'POST',
    body: form,
    timeoutMs: Number(client.appConfig.annict?.timeoutMs || 15_000)
  });
}

async function getTokenInfo(client, accessToken) {
  return annictFetchJson(`${API_BASE}/oauth/token/info`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    timeoutMs: Number(client.appConfig.annict?.timeoutMs || 15_000)
  });
}

async function getMe(client, accessToken) {
  const url = new URL(`${API_BASE}/v1/me`);
  url.searchParams.set('fields', 'id,username,name');
  return annictFetchJson(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    timeoutMs: Number(client.appConfig.annict?.timeoutMs || 15_000)
  });
}

async function revokeToken(client, accessToken) {
  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    return false;
  }

  const form = new FormData();
  form.set('client_id', runtime.clientId);
  form.set('client_secret', runtime.clientSecret);
  form.set('token', accessToken);

  await annictFetchJson(`${API_BASE}/oauth/revoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: form,
    timeoutMs: Number(client.appConfig.annict?.timeoutMs || 15_000)
  }).catch((error) => {
    if (error.code !== 'annict_unauthorized') {
      throw error;
    }
  });
  return true;
}

async function postAnnictStatus(client, accessToken, workId, kind) {
  const url = new URL(`${API_BASE}/v1/me/statuses`);
  url.searchParams.set('work_id', String(workId));
  url.searchParams.set('kind', kind);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    signal: buildAbortSignal(Number(client.appConfig.annict?.timeoutMs || 15_000))
  });

  if (response.status === 204) {
    return true;
  }
  if (response.status === 401) {
    throw new AnnictUserIntegrationError('Annict連携が無効になっています。再連携してください。', 'annict_unauthorized');
  }
  throw new AnnictUserIntegrationError(`Annict API HTTP ${response.status}`, 'annict_api_error');
}

async function graphql(client, accessToken, query, variables = {}) {
  const response = await annictFetchJson(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables }),
    timeoutMs: Number(client.appConfig.annict?.timeoutMs || 15_000)
  });

  if (Array.isArray(response.errors) && response.errors.length) {
    throw new AnnictUserIntegrationError('Annict GraphQL API error', 'annict_graphql_error');
  }

  return response.data || {};
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return String(value || '').split(/\s+/u).filter(Boolean);
}

function hasReadWriteScopes(scopes) {
  const set = new Set(normalizeScopes(scopes));
  return set.has('read') && set.has('write');
}

function randomState() {
  return crypto.randomBytes(32).toString('base64url');
}

function buildAuthorizationUrl(client, state, redirectUri) {
  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    throw new AnnictUserIntegrationError(runtime.message, runtime.code);
  }

  const url = new URL('https://annict.com/oauth/authorize');
  url.searchParams.set('client_id', runtime.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPE.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

function getConnectionPromptContent() {
  return [
    'Annict連携が必要です。`/annict connect` を実行して、表示された認可リンクから連携してください。',
    '',
    'Annictのアクセストークンはサーバー上のDBでは暗号化して保存され、Annict APIを呼び出す時だけBotが一時的に復号します。'
  ].join('\n');
}

function parseCursor(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAnnictWorkMediaFromGraphql(work) {
  return {
    provider: 'annict',
    providerMediaId: String(work.annictId),
    titleNative: work.title || null,
    titleKana: work.titleKana || null,
    titleRomaji: work.titleRo || null,
    titleEnglish: work.titleEn || null,
    titleUserPreferred: work.title || work.titleRo || work.titleEn || null,
    aliases: [work.title, work.titleKana, work.titleRo, work.titleEn].filter(Boolean),
    description: null,
    siteUrl: work.annictId ? `https://annict.com/works/${work.annictId}` : null,
    officialSiteUrl: work.officialSiteUrl || null,
    malAnimeId: work.malAnimeId || null,
    coverImageUrl: work.image?.recommendedImageUrl || work.image?.facebookOgImageUrl || null,
    bannerImageUrl: work.image?.facebookOgImageUrl || null,
    imageCandidates: [],
    season: work.seasonName ? String(work.seasonName).toLowerCase() : null,
    seasonYear: Number.isFinite(Number(work.seasonYear)) ? Number(work.seasonYear) : null,
    status: work.media || null,
    format: work.media || null,
    episodes: null,
    duration: null,
    cast: []
  };
}

async function ensureAnnictCardForWork(client, guild, work) {
  const annictWorkId = String(work.annictId || '');
  if (!annictWorkId) {
    return null;
  }

  const existing = client.db.anime.getEntryByProviderMediaId(guild.id, 'annict', annictWorkId);
  if (existing?.animeChannelMessageId) {
    return existing;
  }

  const media = buildAnnictWorkMediaFromGraphql(work);
  const posted = await postAnimeToChannel(guild, media, client.user?.id || null, media.aliases || []);
  return posted.entry || null;
}

async function hasExistingAnimeCardMessage(client, entry) {
  if (!entry?.animeChannelId || !entry?.animeChannelMessageId) {
    return false;
  }
  const channel = await client.channels.fetch(entry.animeChannelId).catch(() => null);
  if (!channel?.messages?.fetch) {
    return false;
  }
  const message = await channel.messages.fetch(entry.animeChannelMessageId).catch(() => null);
  if (!message) {
    return false;
  }
  if (!entry.threadId) {
    return false;
  }
  const thread = await client.channels.fetch(entry.threadId).catch(() => null);
  return Boolean(thread?.isThread?.() || thread?.isTextBased?.());
}

async function ensureAnnictCardForWatchedImport(client, guild, work, { repairMissingMessages = true } = {}) {
  const annictWorkId = String(work.annictId || '');
  if (!annictWorkId) {
    return { entry: null, action: 'failed', requiresCardWrite: false };
  }

  const existing = client.db.anime.getEntryByProviderMediaId(guild.id, 'annict', annictWorkId);
  if (existing?.animeChannelMessageId) {
    const existsInDiscord = await hasExistingAnimeCardMessage(client, existing);
    if (existsInDiscord) {
      return { entry: existing, action: 'skipped_existing', requiresCardWrite: false };
    }
    if (!repairMissingMessages) {
      return { entry: existing, action: 'skipped_existing', requiresCardWrite: false };
    }
    client.db.anime.clearBindings(existing.id);
    const media = buildAnnictWorkMediaFromGraphql(work);
    const posted = await postAnimeToChannel(guild, media, client.user?.id || null, media.aliases || []);
    return { entry: posted.entry || client.db.anime.getEntryById(existing.id), action: 'repaired', requiresCardWrite: true };
  }

  if (existing) {
    if (!repairMissingMessages) {
      return { entry: existing, action: 'skipped_existing', requiresCardWrite: false };
    }
    client.db.anime.clearBindings(existing.id);
    const media = buildAnnictWorkMediaFromGraphql(work);
    const posted = await postAnimeToChannel(guild, media, client.user?.id || null, media.aliases || []);
    return { entry: posted.entry || client.db.anime.getEntryById(existing.id), action: 'repaired', requiresCardWrite: true };
  }

  const media = buildAnnictWorkMediaFromGraphql(work);
  const posted = await postAnimeToChannel(guild, media, client.user?.id || null, media.aliases || []);
  return { entry: posted.entry || null, action: 'posted', requiresCardWrite: true };
}

async function getStoredAccessToken(client, guildId, discordUserId) {
  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    throw new AnnictUserIntegrationError(runtime.message, runtime.code);
  }

  const connection = client.db.annictUserIntegration.getConnection(guildId, discordUserId);
  if (!connection || connection.tokenStatus !== 'active') {
    throw new AnnictUserIntegrationError(getConnectionPromptContent(), 'not_connected');
  }

  const accessToken = decryptAccessToken(connection, {
    guildId,
    discordUserId,
    key: runtime.encryptionKey
  });
  return { accessToken, connection, runtime };
}

async function markConnectionInvalid(client, guildId, discordUserId, errorCode) {
  const current = client.db.annictUserIntegration.getConnection(guildId, discordUserId);
  if (!current) {
    return;
  }
  client.db.annictUserIntegration.updateConnectionSync({
    guildId,
    discordUserId,
    lastSuccessfulSyncAt: current.lastSuccessfulSyncAt || null,
    syncCursor: current.syncCursor || {},
    tokenStatus: 'invalid',
    lastErrorCode: errorCode
  });
}

function buildConnectContainer(authorizationUrl, expiresAt) {
  const container = new ContainerBuilder()
    .setAccentColor(0x22c55e)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### Annict連携'),
      new TextDisplayBuilder().setContent([
        'Annictの認可画面で `read / write` 権限を確認して許可してください。',
        'write権限は、Discord側の「気になる」「視聴済み」をAnnictの作品ステータスへ反映するために使います。',
        '',
        'Annictのアクセストークンはサーバー上のDBでは暗号化して保存され、Annict APIを呼び出す時だけBotが一時的に復号します。',
        '連携情報はユーザーごとに分離され、あなたの操作が他のユーザーのAnnictアカウントへ反映されることはありません。',
        '',
        `認証コードの有効期限: ${new Date(expiresAt).toLocaleString('ja-JP')}`
      ].join('\n'))
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Annictで認可する')
          .setStyle(ButtonStyle.Link)
          .setURL(authorizationUrl),
        new ButtonBuilder()
          .setCustomId(`annict:oauth:code:${authorizationUrl.match(/[?&]state=([^&]+)/)?.[1] || 'unknown'}`)
          .setLabel('認証コードを入力')
          .setStyle(ButtonStyle.Primary)
      )
    );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] }
  };
}

async function handleConnectCommand(interaction) {
  const runtime = getRuntimeStatus(interaction.client);
  if (!runtime.ok) {
    await interaction.editReply(runtime.message);
    return;
  }

  interaction.client.db.annictUserIntegration.deleteExpiredOauthStates();
  const state = randomState();
  const redirectUri = runtime.config.redirectUri || 'urn:ietf:wg:oauth:2.0:oob';
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  interaction.client.db.annictUserIntegration.insertOauthState({
    state,
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    redirectUri,
    scopes: OAUTH_SCOPE,
    expiresAt
  });

  const authorizationUrl = buildAuthorizationUrl(interaction.client, state, redirectUri);
  await interaction.editReply(buildConnectContainer(authorizationUrl, expiresAt));
}

async function handleOauthCodeButton(interaction) {
  const state = String(interaction.customId || '').split(':').pop();
  const record = interaction.client.db.annictUserIntegration.getOauthState(state);
  if (!record || record.consumedAt || new Date(record.expiresAt).getTime() < Date.now()) {
    await interaction.reply({
      content: 'このAnnict認証リンクは期限切れです。もう一度 `/annict connect` を実行してください。',
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  if (String(record.guildId) !== String(interaction.guildId) || String(record.discordUserId) !== String(interaction.user.id)) {
    await interaction.reply({
      content: 'この認証コード入力は、連携を開始した本人のみ利用できます。',
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`annict:oauth:modal:${state}`)
    .setTitle('Annict認証コード');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('code')
        .setLabel('Annictに表示された認証コード')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(8)
        .setMaxLength(256)
    )
  );
  await interaction.showModal(modal);
  return true;
}

async function handleOauthCodeModal(interaction) {
  const state = String(interaction.customId || '').split(':').pop();
  const code = interaction.fields.getTextInputValue('code').trim();
  await interaction.deferReply({ ephemeral: true });

  const record = interaction.client.db.annictUserIntegration.getOauthState(state);
  if (!record || record.consumedAt || new Date(record.expiresAt).getTime() < Date.now()) {
    await interaction.editReply('このAnnict認証コード入力は期限切れです。もう一度 `/annict connect` を実行してください。');
    return true;
  }

  if (String(record.guildId) !== String(interaction.guildId) || String(record.discordUserId) !== String(interaction.user.id)) {
    await interaction.editReply('この認証コード入力は、連携を開始した本人のみ利用できます。');
    return true;
  }

  const runtime = getRuntimeStatus(interaction.client);
  if (!runtime.ok) {
    await interaction.editReply(runtime.message);
    return true;
  }

  try {
    const tokenResponse = await exchangeAuthorizationCode(interaction.client, code, record.redirectUri);
    const accessToken = String(tokenResponse.access_token || '');
    const scopes = normalizeScopes(tokenResponse.scope || record.scopes);
    if (!accessToken || !hasReadWriteScopes(scopes)) {
      throw new AnnictUserIntegrationError('Annict連携には read / write 権限が必要です。', 'scope_missing');
    }

    const tokenInfo = await getTokenInfo(interaction.client, accessToken);
    if (!hasReadWriteScopes(tokenInfo.scopes || scopes)) {
      throw new AnnictUserIntegrationError('Annict連携には read / write 権限が必要です。', 'scope_missing');
    }

    const me = await getMe(interaction.client, accessToken).catch(() => null);
    const encrypted = encryptAccessToken(accessToken, {
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      key: runtime.encryptionKey,
      keyId: runtime.config.tokenEncryptionKeyId || 'default'
    });
    const now = new Date().toISOString();
    const baselineCursor = {
      baselineAt: now,
      newestCursor: null,
      initialImportCompleted: false
    };

    interaction.client.db.annictUserIntegration.upsertConnection({
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      annictResourceOwnerId: String(tokenInfo.resource_owner_id || me?.id || ''),
      ...encrypted,
      scopes: tokenInfo.scopes || scopes,
      connectedAt: now,
      lastSuccessfulSyncAt: now,
      syncCursor: baselineCursor,
      tokenStatus: 'active'
    });
    interaction.client.db.annictUserIntegration.consumeOauthState(state);

    await establishSyncBaseline(interaction.client, interaction.guildId, interaction.user.id).catch((error) => {
      interaction.client.logger.warn('annict baseline sync failed', {
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        error: error.message
      });
    });

    await interaction.editReply([
      `Annict連携が完了しました。${me?.username ? `（Annict: ${me.username}）` : ''}`,
      '',
      '初回連携では過去の視聴履歴を自動取り込みしません。必要な場合は `/annict sync import-history:true` を実行してください。',
      'Annictのアクセストークンはサーバー上のDBでは暗号化して保存され、Annict APIを呼び出す時だけBotが一時的に復号します。'
    ].join('\n'));
  } catch (error) {
    interaction.client.logger.warn('annict oauth code exchange failed', {
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      errorCode: error.code || null,
      error: error.message
    });
    await interaction.editReply(error instanceof AnnictUserIntegrationError
      ? error.message
      : 'Annict認証コードの確認に失敗しました。もう一度 `/annict connect` からやり直してください。');
  }
  return true;
}

async function handleStatusCommand(interaction) {
  const runtime = getRuntimeStatus(interaction.client);
  if (!runtime.ok) {
    await interaction.editReply(runtime.message);
    return;
  }

  const connection = interaction.client.db.annictUserIntegration.getConnection(interaction.guildId, interaction.user.id);
  if (!connection) {
    await interaction.editReply('Annictとはまだ連携されていません。`/annict connect` を実行してください。');
    return;
  }

  if (connection.tokenStatus !== 'active') {
    await interaction.editReply('Annict連携は無効になっています。`/annict disconnect` のあと、もう一度 `/annict connect` を実行してください。');
    return;
  }

  let validationLine = 'トークン確認: 未実行';
  try {
    const { accessToken } = await getStoredAccessToken(interaction.client, interaction.guildId, interaction.user.id);
    const info = await getTokenInfo(interaction.client, accessToken);
    validationLine = `トークン確認: 有効 / scopes: ${normalizeScopes(info.scopes).join(', ')}`;
  } catch (error) {
    if (error.code === 'annict_unauthorized') {
      await markConnectionInvalid(interaction.client, interaction.guildId, interaction.user.id, error.code);
      validationLine = 'トークン確認: 無効。再連携してください。';
    } else {
      validationLine = 'トークン確認: 失敗しました。時間をおいて再確認してください。';
    }
  }

  await interaction.editReply([
    'Annict連携状態',
    `- 状態: ${connection.tokenStatus}`,
    `- Annict resource owner ID: ${connection.annictResourceOwnerId}`,
    `- 連携日時: ${connection.connectedAt}`,
    `- 最終同期: ${connection.lastSuccessfulSyncAt || 'なし'}`,
    `- ${validationLine}`
  ].join('\n'));
}

function buildDisconnectConfirmPayload() {
  return {
    content: [
      'Annict連携を解除しますか？',
      'Annict側でトークン失効を試みたうえで、このサーバーに保存されている暗号化トークンを削除します。',
      'ローカルの作品ステータス履歴は集計整合性のため保持します。'
    ].join('\n'),
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('annict:disconnect:confirm')
          .setLabel('解除する')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('annict:disconnect:cancel')
          .setLabel('キャンセル')
          .setStyle(ButtonStyle.Secondary)
      )
    ],
    allowedMentions: { parse: [] }
  };
}

async function handleDisconnectCommand(interaction) {
  const connection = interaction.client.db.annictUserIntegration.getConnection(interaction.guildId, interaction.user.id);
  if (!connection) {
    await interaction.editReply('Annictとはまだ連携されていません。');
    return;
  }
  await interaction.editReply(buildDisconnectConfirmPayload());
}

async function handleDisconnectButton(interaction) {
  await interaction.deferUpdate().catch(() => null);
  if (interaction.customId === 'annict:disconnect:cancel') {
    await interaction.editReply({ content: 'Annict連携の解除をキャンセルしました。', components: [] }).catch(() => null);
    return true;
  }

  const connection = interaction.client.db.annictUserIntegration.getConnection(interaction.guildId, interaction.user.id);
  if (!connection) {
    await interaction.editReply({ content: 'Annictとはすでに連携されていません。', components: [] }).catch(() => null);
    return true;
  }

  let revoked = false;
  try {
    const { accessToken } = await getStoredAccessToken(interaction.client, interaction.guildId, interaction.user.id);
    revoked = await revokeToken(interaction.client, accessToken);
  } catch (error) {
    interaction.client.logger.warn('annict revoke failed during disconnect', {
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      errorCode: error.code || null,
      error: error.message
    });
  }

  interaction.client.db.annictUserIntegration.deleteConnection(interaction.guildId, interaction.user.id);
  await interaction.editReply({
    content: revoked
      ? 'Annict連携を解除し、Annict側のトークン失効も実行しました。ローカルの作品ステータス履歴は保持しています。'
      : 'Annict連携を解除しました。Annict側のトークン失効は確認できませんでした。必要に応じてAnnictの設定画面からアプリ連携を解除してください。',
    components: [],
    allowedMentions: { parse: [] }
  }).catch(() => null);
  return true;
}

async function resolveAnnictWorkIdForEntry(client, entry) {
  if (!entry) {
    return null;
  }
  if (String(entry.provider || '') === 'annict' && entry.providerMediaId) {
    return String(entry.providerMediaId);
  }
  return null;
}

async function updateAnnictStatusForAnimeEntry(client, {
  guildId,
  userId,
  entry,
  action,
  idempotencyKey,
  source = 'discord_action',
  updateLocal = true
}) {
  if (!entry || String(entry.guildId) !== String(guildId)) {
    throw new AnnictUserIntegrationError('対象の作品カードを確認できませんでした。', 'anime_entry_missing');
  }

  const annictWorkId = await resolveAnnictWorkIdForEntry(client, entry);
  if (!annictWorkId) {
    throw new AnnictUserIntegrationError('この作品カードはAnnict作品IDを確認できないため、Annictには反映できません。', 'annict_work_id_missing');
  }

  const targetKind = STATUS_TO_ANNICT_KIND[action];
  if (!targetKind) {
    throw new AnnictUserIntegrationError('未対応のAnnict操作です。', 'unsupported_annict_action');
  }

  const lockKey = `${guildId}:${userId}:${annictWorkId}`;
  if (client.annictStatusLocks.has(lockKey)) {
    throw new AnnictUserIntegrationError('同じ作品のAnnict更新を処理中です。少し待ってからもう一度お試しください。', 'status_update_locked');
  }

  client.annictStatusLocks.add(lockKey);
  try {
    const { accessToken } = await getStoredAccessToken(client, guildId, userId);
    await postAnnictStatus(client, accessToken, annictWorkId, targetKind);

    const now = new Date().toISOString();
    client.db.annictUserIntegration.upsertUserWorkState({
      guildId,
      discordUserId: userId,
      annictWorkId,
      animeEntryId: entry.id,
      status: targetKind,
      source,
      sourceUpdatedAt: now,
      syncedAt: now
    });
    client.db.annictUserIntegration.upsertStatusWriteLog({
      guildId,
      discordUserId: userId,
      annictWorkId,
      targetStatus: targetKind,
      idempotencyKey,
      status: 'success'
    });
    if (updateLocal) {
      await updateLocalAnimeStatus(client, guildId, entry.id, userId, action);
    }
    client.logger.info('annict anime status update succeeded', {
      guildId,
      discordUserId: userId,
      animeEntryId: entry.id,
      annictWorkId,
      action,
      source
    });
    return { annictWorkId, targetKind };
  } catch (error) {
    if (error.code === 'annict_unauthorized') {
      await markConnectionInvalid(client, guildId, userId, error.code);
    }
    throw error;
  } finally {
    client.annictStatusLocks.delete(lockKey);
  }
}

async function handleAnimeCardAction(interaction, action, animeEntryId) {
  const client = interaction.client;
  const entry = client.db.anime.getEntryById(Number(animeEntryId));
  if (!entry || String(entry.guildId) !== String(interaction.guildId)) {
    await interaction.reply({
      content: '対象の作品カードを確認できませんでした。',
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await updateAnnictStatusForAnimeEntry(client, {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      entry,
      action,
      idempotencyKey: `${interaction.id}:${action}`,
      source: 'discord_button',
      updateLocal: true
    });
    await interaction.editReply(action === 'interested'
      ? 'Annictの「見たい」に追加しました。'
      : 'Annictで「見た」に更新しました。');
  } catch (error) {
    if (error.code === 'not_connected') {
      await interaction.editReply(error.message);
    } else if (error.code === 'status_update_locked') {
      await interaction.editReply(error.message);
    } else if (error.code === 'annict_work_id_missing' || error.code === 'anime_entry_missing') {
      await interaction.editReply(error.message);
    } else if (error.code === 'annict_unauthorized') {
      await markConnectionInvalid(client, interaction.guildId, interaction.user.id, error.code);
      await interaction.editReply('Annict連携が無効になっています。`/annict disconnect` のあと、もう一度 `/annict connect` を実行してください。');
    } else if (error.code === 'decrypt_failed') {
      await interaction.editReply(error.message);
    } else {
      client.logger.warn('annict status update failed', {
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        animeEntryId: entry.id,
        action,
        errorCode: error.code || null,
        error: error.message
      });
      await interaction.editReply('Annictの更新に失敗しました。時間をおいてもう一度お試しください。');
    }
  }
  return true;
}

async function updateLocalAnimeStatus(client, guildId, animeEntryId, userId, action) {
  const current = client.db.anime.getUserStatus(guildId, animeEntryId, userId) || null;
  const now = new Date().toISOString();
  client.db.anime.upsertUserStatus({
    guildId,
    animeEntryId,
    userId,
    interested: action === 'interested' ? 1 : (current?.interested ? 1 : 0),
    watched: action === 'watched' ? 1 : (current?.watched ? 1 : 0),
    interestedAt: action === 'interested' ? now : (current?.interestedAt || null),
    watchedAt: action === 'watched' ? now : (current?.watchedAt || null)
  });
  const entry = client.db.anime.getEntryById(animeEntryId);
  await updateAnimeChannelCard(client, entry).catch(() => null);
  await updateAnimeReviewCard(client, entry).catch(() => null);
}

async function fetchLibraryEntries(client, accessToken, { first, after = null }) {
  const query = `
    query AnnictUserLibraryEntries($first: Int!, $after: String) {
      viewer {
        libraryEntries(
          first: $first,
          after: $after,
          states: [WANNA_WATCH, WATCHING, WATCHED],
          orderBy: { field: LAST_TRACKED_AT, direction: DESC }
        ) {
          edges {
            cursor
            node {
              status { state createdAt }
              work {
                id
                annictId
                title
                titleKana
                titleRo
                titleEn
                malAnimeId
                media
                seasonName
                seasonYear
                officialSiteUrl
                image {
                  recommendedImageUrl
                  facebookOgImageUrl
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;
  const data = await graphql(client, accessToken, query, { first, after });
  return data.viewer?.libraryEntries || { edges: [], pageInfo: {} };
}

async function fetchWatchedLibraryEntries(client, accessToken, { first, after = null }) {
  const query = `
    query AnnictUserWatchedLibraryEntries($first: Int!, $after: String) {
      viewer {
        libraryEntries(
          first: $first,
          after: $after,
          states: [WATCHED],
          orderBy: { field: LAST_TRACKED_AT, direction: DESC }
        ) {
          edges {
            cursor
            node {
              status { state createdAt }
              work {
                id
                annictId
                title
                titleKana
                titleRo
                titleEn
                malAnimeId
                media
                seasonName
                seasonYear
                officialSiteUrl
                image {
                  recommendedImageUrl
                  facebookOgImageUrl
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;
  const data = await graphql(client, accessToken, query, { first, after });
  return data.viewer?.libraryEntries || { edges: [], pageInfo: {} };
}

function addMinutesIso(minutes) {
  return new Date(Date.now() + Math.max(1, Number(minutes || 1)) * 60 * 1000).toISOString();
}

function formatJobDate(value) {
  return value || 'なし';
}

function compactCursor(value) {
  if (!value) {
    return 'なし';
  }
  const text = String(value);
  return text.length > 14 ? `...${text.slice(-14)}` : text;
}

async function markWatchedImportLocalState(client, {
  guildId,
  discordUserId,
  annictWorkId,
  animeEntryId,
  sourceUpdatedAt = null
}) {
  const now = new Date().toISOString();
  client.db.annictUserIntegration.upsertUserWorkState({
    guildId,
    discordUserId,
    annictWorkId,
    animeEntryId: animeEntryId || null,
    status: 'watched',
    source: 'annict_watched_import',
    sourceUpdatedAt: sourceUpdatedAt || now,
    syncedAt: now
  });
  if (animeEntryId) {
    await updateLocalAnimeStatus(client, guildId, animeEntryId, discordUserId, 'watched');
  }
}

async function processWatchedImportJob(client, job) {
  const config = getWatchedImportConfig(client);
  if (!config.enabled) {
    return;
  }

  const lockKey = `${job.guildId}:${job.discordUserId}`;
  if (client.annictWatchedImportLocks.has(lockKey)) {
    client.logger.info('annict watched import duplicate prevented', {
      guildId: job.guildId,
      discordUserId: job.discordUserId
    });
    return;
  }

  client.annictWatchedImportLocks.add(lockKey);
  client.logger.info('annict watched import batch started', {
    guildId: job.guildId,
    discordUserId: job.discordUserId
  });

  let scannedDelta = 0;
  let postedDelta = 0;
  let skippedExistingDelta = 0;
  let repairedDelta = 0;
  let failedDelta = 0;
  let batchScanned = 0;
  let batchPosted = 0;
  let batchSkippedExisting = 0;
  let batchRepaired = 0;
  let batchFailed = 0;
  let cursor = job.graphqlCursor || null;
  let lastProcessedAt = job.lastProcessedAt || null;
  let status = 'active';
  let nextRunAt = addMinutesIso(config.batchIntervalMinutes);
  let completedAt = null;
  let cancelledAt = null;
  let hasNextPage = job.hasNextPage == null ? true : Boolean(job.hasNextPage);
  let lastErrorCode = null;
  let shouldPersistProgress = true;

  const persistProgress = () => {
    batchScanned += scannedDelta;
    batchPosted += postedDelta;
    batchSkippedExisting += skippedExistingDelta;
    batchRepaired += repairedDelta;
    batchFailed += failedDelta;
    client.db.annictUserIntegration.updateWatchedImportJobProgress({
      guildId: job.guildId,
      discordUserId: job.discordUserId,
      status,
      graphqlCursor: cursor,
      hasNextPage,
      scannedDelta,
      postedDelta,
      skippedExistingDelta,
      repairedDelta,
      failedDelta,
      lastProcessedAt,
      nextRunAt,
      completedAt,
      cancelledAt,
      lastErrorCode
    });
    scannedDelta = 0;
    postedDelta = 0;
    skippedExistingDelta = 0;
    repairedDelta = 0;
    failedDelta = 0;
  };

  try {
    const latestJob = client.db.annictUserIntegration.getWatchedImportJob(job.guildId, job.discordUserId);
    if (!latestJob || latestJob.status !== 'active') {
      shouldPersistProgress = false;
      return;
    }
    cursor = latestJob.graphqlCursor || null;

    const guild = client.guilds.cache.get(job.guildId) || await client.guilds.fetch(job.guildId).catch(() => null);
    if (!guild) {
      throw new AnnictUserIntegrationError('対象サーバーを確認できませんでした。', 'guild_missing');
    }

    const { accessToken } = await getStoredAccessToken(client, job.guildId, job.discordUserId);
    const page = await fetchWatchedLibraryEntries(client, accessToken, {
      first: config.pageSize,
      after: cursor
    });
    const edges = Array.isArray(page.edges) ? page.edges : [];
    hasNextPage = Boolean(page.pageInfo?.hasNextPage);

    if (!edges.length) {
      status = 'completed';
      nextRunAt = null;
      completedAt = new Date().toISOString();
      hasNextPage = false;
      client.logger.info('annict watched import completed', {
        guildId: job.guildId,
        discordUserId: job.discordUserId
      });
      return;
    }

    let cardWrites = 0;
    let exhaustedPage = true;
    for (const edge of edges) {
      const currentJob = client.db.annictUserIntegration.getWatchedImportJob(job.guildId, job.discordUserId);
      if (!currentJob || currentJob.status !== 'active') {
        status = currentJob?.status || 'cancelled';
        nextRunAt = null;
        completedAt = currentJob?.completedAt || null;
        cancelledAt = currentJob?.cancelledAt || null;
        lastErrorCode = currentJob?.lastErrorCode || null;
        exhaustedPage = false;
        break;
      }

      const state = edge.node?.status?.state;
      const work = edge.node?.work || null;
      const annictWorkId = work?.annictId ? String(work.annictId) : null;
      if (state !== 'WATCHED' || !annictWorkId) {
        scannedDelta += 1;
        failedDelta += 1;
        cursor = edge.cursor || cursor;
        lastProcessedAt = new Date().toISOString();
        lastErrorCode = 'invalid_watched_work';
        persistProgress();
        continue;
      }

      const existingItem = client.db.annictUserIntegration.getWatchedImportItem(job.guildId, job.discordUserId, annictWorkId);
      if (existingItem && Number(existingItem.attempts || 0) >= config.maxAttemptsPerWork && existingItem.status === 'failed') {
        scannedDelta += 1;
        failedDelta += 1;
        cursor = edge.cursor || cursor;
        lastProcessedAt = new Date().toISOString();
        lastErrorCode = 'max_attempts_exceeded';
        persistProgress();
        continue;
      }

      const existingEntry = client.db.anime.getEntryByProviderMediaId(job.guildId, 'annict', annictWorkId);
      const existingCardPresent = existingEntry?.animeChannelMessageId
        ? await hasExistingAnimeCardMessage(client, existingEntry)
        : false;
      const wouldWriteCard = !existingEntry || (!existingCardPresent && config.repairMissingMessages);
      if (wouldWriteCard && cardWrites >= config.maxCardsPerBatch) {
        exhaustedPage = false;
        break;
      }

      client.db.annictUserIntegration.upsertWatchedImportItem({
        guildId: job.guildId,
        discordUserId: job.discordUserId,
        annictWorkId,
        status: 'processing',
        attemptsDelta: 1
      });

      try {
        const result = existingEntry && existingCardPresent
          ? { entry: existingEntry, action: 'skipped_existing', requiresCardWrite: false }
          : await ensureAnnictCardForWatchedImport(client, guild, work, {
            repairMissingMessages: config.repairMissingMessages
          });
        const entry = result.entry || null;
        await markWatchedImportLocalState(client, {
          guildId: job.guildId,
          discordUserId: job.discordUserId,
          annictWorkId,
          animeEntryId: entry?.id || null,
          sourceUpdatedAt: edge.node?.status?.createdAt || null
        });

        scannedDelta += 1;
        if (result.action === 'posted') {
          postedDelta += 1;
          cardWrites += 1;
          client.logger.info('annict watched import card posted', {
            guildId: job.guildId,
            discordUserId: job.discordUserId,
            annictWorkId,
            animeEntryId: entry?.id || null
          });
        } else if (result.action === 'repaired') {
          repairedDelta += 1;
          cardWrites += 1;
          client.logger.info('annict watched import missing card repaired', {
            guildId: job.guildId,
            discordUserId: job.discordUserId,
            annictWorkId,
            animeEntryId: entry?.id || null
          });
        } else {
          skippedExistingDelta += 1;
          client.logger.info('annict watched import work skipped existing', {
            guildId: job.guildId,
            discordUserId: job.discordUserId,
            annictWorkId,
            animeEntryId: entry?.id || null
          });
        }

        client.db.annictUserIntegration.upsertWatchedImportItem({
          guildId: job.guildId,
          discordUserId: job.discordUserId,
          annictWorkId,
          status: result.action,
          animeEntryId: entry?.id || null,
          attemptsDelta: 0,
          processedAt: new Date().toISOString()
        });

        cursor = edge.cursor || cursor;
        lastProcessedAt = new Date().toISOString();
        lastErrorCode = null;
        persistProgress();
        if (result.requiresCardWrite && config.delayBetweenCardsMs > 0 && cardWrites < config.maxCardsPerBatch) {
          await sleep(config.delayBetweenCardsMs);
        }
      } catch (error) {
        scannedDelta += 1;
        failedDelta += 1;
        cursor = edge.cursor || cursor;
        lastProcessedAt = new Date().toISOString();
        lastErrorCode = error.code || 'work_failed';
        client.db.annictUserIntegration.upsertWatchedImportItem({
          guildId: job.guildId,
          discordUserId: job.discordUserId,
          annictWorkId,
          status: 'failed',
          attemptsDelta: 0,
          lastErrorCode
        });
        client.logger.warn('annict watched import work failed', {
          guildId: job.guildId,
          discordUserId: job.discordUserId,
          annictWorkId,
          errorCode: error.code || null,
          error: error.message
        });
        persistProgress();
      }
    }

    if (exhaustedPage && !page.pageInfo?.hasNextPage) {
      status = 'completed';
      nextRunAt = null;
      completedAt = new Date().toISOString();
      hasNextPage = false;
      client.logger.info('annict watched import completed', {
        guildId: job.guildId,
        discordUserId: job.discordUserId
      });
    }
  } catch (error) {
    failedDelta += 1;
    lastErrorCode = error.code || 'batch_failed';
    if (error.code === 'annict_unauthorized' || error.code === 'decrypt_failed') {
      await markConnectionInvalid(client, job.guildId, job.discordUserId, error.code);
      status = 'failed';
      nextRunAt = null;
      hasNextPage = false;
    }
    client.logger.warn('annict watched import batch failed', {
      guildId: job.guildId,
      discordUserId: job.discordUserId,
      errorCode: error.code || null,
      error: error.message
    });
  } finally {
    if (shouldPersistProgress) {
      persistProgress();
      client.logger.info('annict watched import batch completed', {
        guildId: job.guildId,
        discordUserId: job.discordUserId,
        status,
        scannedDelta: batchScanned,
        postedDelta: batchPosted,
        skippedExistingDelta: batchSkippedExisting,
        repairedDelta: batchRepaired,
        failedDelta: batchFailed,
        nextRunAt
      });
    }
    client.annictWatchedImportLocks.delete(lockKey);
  }
}

async function runAnnictWatchedImportDueJobs(client) {
  const config = getWatchedImportConfig(client);
  if (!config.enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    client.logger.warn('annict watched import skipped', { reason: runtime.code });
    return { skipped: true, reason: runtime.code };
  }

  if (client.annictWatchedImportRunning) {
    return { skipped: true, reason: 'already_running' };
  }

  client.annictWatchedImportRunning = true;
  let processed = 0;
  try {
    const jobs = client.db.annictUserIntegration.listDueWatchedImportJobs(new Date().toISOString(), 5);
    for (const job of jobs) {
      await processWatchedImportJob(client, job);
      processed += 1;
    }
  } finally {
    client.annictWatchedImportRunning = false;
  }
  return { processed };
}

function startAnnictWatchedImportWorker(client) {
  const config = getWatchedImportConfig(client);
  if (!config.enabled) {
    return;
  }

  if (client.annictWatchedImportInterval) {
    clearInterval(client.annictWatchedImportInterval);
  }

  client.annictWatchedImportInterval = setInterval(() => {
    void runAnnictWatchedImportDueJobs(client).catch((error) => {
      client.logger.warn('annict watched import loop failed', { error: error.message });
    });
  }, DEFAULT_WATCHED_IMPORT_WORKER_INTERVAL_MS);
  client.annictWatchedImportInterval.unref?.();
  setTimeout(() => {
    void runAnnictWatchedImportDueJobs(client).catch((error) => {
      client.logger.warn('annict watched import startup tick failed', { error: error.message });
    });
  }, 1000).unref?.();
}

async function establishSyncBaseline(client, guildId, discordUserId) {
  const { accessToken, connection } = await getStoredAccessToken(client, guildId, discordUserId);
  const result = await fetchLibraryEntries(client, accessToken, { first: 1 });
  const newestCursor = result.edges?.[0]?.cursor || null;
  client.db.annictUserIntegration.updateConnectionSync({
    guildId,
    discordUserId,
    lastSuccessfulSyncAt: new Date().toISOString(),
    syncCursor: {
      ...parseCursor(connection.syncCursor),
      newestCursor,
      baselineAt: new Date().toISOString(),
      initialImportCompleted: false
    },
    tokenStatus: 'active',
    lastErrorCode: null
  });
}

async function syncOneConnection(client, connection, { importHistory = false, manual = false } = {}) {
  const guild = client.guilds.cache.get(connection.guildId) || await client.guilds.fetch(connection.guildId).catch(() => null);
  if (!guild) {
    return { processed: 0, skipped: 0 };
  }

  const config = getConfig(client);
  const maxWorks = Number(config.maxWorksPerSync || 100);
  const { accessToken } = await getStoredAccessToken(client, connection.guildId, connection.discordUserId);
  const cursor = parseCursor(connection.syncCursor);
  const previousNewestCursor = cursor.newestCursor || null;
  let nextAfter = null;
  let newNewestCursor = null;
  let processed = 0;
  let skipped = 0;
  let stop = false;

  while (!stop && processed + skipped < maxWorks) {
    const page = await fetchLibraryEntries(client, accessToken, {
      first: Math.min(50, maxWorks - processed - skipped),
      after: nextAfter
    });
    const edges = Array.isArray(page.edges) ? page.edges : [];
    if (!edges.length) {
      break;
    }
    if (!newNewestCursor) {
      newNewestCursor = edges[0].cursor || null;
    }

    for (const edge of edges) {
      if (!importHistory && previousNewestCursor && edge.cursor === previousNewestCursor) {
        stop = true;
        break;
      }

      if (!importHistory && !previousNewestCursor) {
        skipped += 1;
        continue;
      }

      const state = edge.node?.status?.state;
      const status = GRAPHQL_STATE_TO_STATUS[state] || null;
      const work = edge.node?.work || null;
      if (!status || !work?.annictId || !VALID_SYNC_STATES.has(state)) {
        skipped += 1;
        continue;
      }

      const entry = await ensureAnnictCardForWork(client, guild, work).catch((error) => {
        client.logger.warn('annict sync ensure anime card failed', {
          guildId: connection.guildId,
          discordUserId: connection.discordUserId,
          annictWorkId: work.annictId ? String(work.annictId) : null,
          error: error.message
        });
        return null;
      });

      const now = new Date().toISOString();
      client.db.annictUserIntegration.upsertUserWorkState({
        guildId: connection.guildId,
        discordUserId: connection.discordUserId,
        annictWorkId: String(work.annictId),
        animeEntryId: entry?.id || null,
        status,
        source: importHistory ? 'annict_import' : 'annict_sync',
        sourceUpdatedAt: edge.node?.status?.createdAt || now,
        syncedAt: now
      });
      if (entry?.id) {
        await updateLocalAnimeStatus(client, connection.guildId, entry.id, connection.discordUserId, status === 'watched' ? 'watched' : 'interested');
      }
      processed += 1;
    }

    if (!page.pageInfo?.hasNextPage) {
      break;
    }
    nextAfter = page.pageInfo.endCursor || null;
    if (!nextAfter) {
      break;
    }
  }

  client.db.annictUserIntegration.updateConnectionSync({
    guildId: connection.guildId,
    discordUserId: connection.discordUserId,
    lastSuccessfulSyncAt: new Date().toISOString(),
    syncCursor: {
      ...cursor,
      newestCursor: newNewestCursor || previousNewestCursor || null,
      initialImportCompleted: importHistory ? true : cursor.initialImportCompleted === true,
      lastManualSyncAt: manual ? new Date().toISOString() : cursor.lastManualSyncAt || null
    },
    tokenStatus: 'active',
    lastErrorCode: null
  });

  return { processed, skipped };
}

async function runAnnictUserSync(client, { guildId = process.env.GUILD_ID, importHistory = false, manual = false, discordUserId = null } = {}) {
  if (client.annictSyncRunning && !manual) {
    return { skipped: true, reason: 'already_running' };
  }

  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    client.logger.warn('annict user sync skipped', { reason: runtime.code });
    return { skipped: true, reason: runtime.code };
  }

  client.annictSyncRunning = true;
  let processedConnections = 0;
  let processedWorks = 0;
  let failedConnections = 0;
  try {
    const connections = discordUserId
      ? [client.db.annictUserIntegration.getConnection(guildId, discordUserId)].filter(Boolean)
      : client.db.annictUserIntegration.listActiveConnections(guildId);

    for (const connection of connections) {
      try {
        const result = await syncOneConnection(client, connection, { importHistory, manual });
        processedConnections += 1;
        processedWorks += result.processed;
      } catch (error) {
        failedConnections += 1;
        if (error.code === 'annict_unauthorized' || error.code === 'decrypt_failed') {
          await markConnectionInvalid(client, connection.guildId, connection.discordUserId, error.code);
        } else {
          client.db.annictUserIntegration.updateConnectionSync({
            guildId: connection.guildId,
            discordUserId: connection.discordUserId,
            lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt || null,
            syncCursor: connection.syncCursor || {},
            tokenStatus: connection.tokenStatus || 'active',
            lastErrorCode: error.code || 'sync_failed'
          });
        }
        client.logger.warn('annict user sync connection failed', {
          guildId: connection.guildId,
          discordUserId: connection.discordUserId,
          errorCode: error.code || null,
          error: error.message
        });
      }
    }
  } finally {
    client.annictSyncRunning = false;
  }

  return { processedConnections, processedWorks, failedConnections };
}

function startAnnictUserSync(client) {
  const runtime = getRuntimeStatus(client);
  if (!runtime.ok) {
    client.logger.warn('annict user integration disabled at startup', { reason: runtime.code });
    return;
  }

  if (client.annictSyncInterval) {
    clearInterval(client.annictSyncInterval);
  }

  const intervalMs = Math.max(1, Number(runtime.config.syncIntervalMinutes || 10)) * 60 * 1000;
  client.annictSyncInterval = setInterval(() => {
    void runAnnictUserSync(client).catch((error) => {
      client.logger.warn('annict user sync loop failed', { error: error.message });
    });
  }, intervalMs);
  client.annictSyncInterval.unref?.();
}

async function handleSyncCommand(interaction) {
  const importHistory = interaction.options.getBoolean('import-history') === true;
  if (importHistory && interaction.client.appConfig.annictUserIntegration?.initialImportEnabled !== true) {
    await interaction.editReply('過去履歴の取り込みは現在無効です。管理者に設定変更を依頼してください。');
    return;
  }

  const connection = interaction.client.db.annictUserIntegration.getConnection(interaction.guildId, interaction.user.id);
  if (!connection || connection.tokenStatus !== 'active') {
    await interaction.editReply('Annictとはまだ連携されていません。`/annict connect` を実行してください。');
    return;
  }

  if (importHistory) {
    await interaction.editReply({
      content: [
        'Annictの過去履歴を取り込みますか？',
        `最大 ${Number(interaction.client.appConfig.annictUserIntegration?.maxWorksPerSync || 100)} 件まで処理します。既存のアニメカードがない作品はカードを作成する可能性があります。`
      ].join('\n'),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('annict:sync:import:confirm')
            .setLabel('取り込む')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('annict:sync:import:cancel')
            .setLabel('キャンセル')
            .setStyle(ButtonStyle.Secondary)
        )
      ],
      allowedMentions: { parse: [] }
    });
    return;
  }

  const result = await runAnnictUserSync(interaction.client, {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    importHistory,
    manual: true
  });
  await interaction.editReply([
    importHistory ? 'Annictの過去履歴を取り込みました。' : 'Annict同期を実行しました。',
    `- 処理した作品: ${result.processedWorks || 0}`,
    `- 失敗した接続: ${result.failedConnections || 0}`
  ].join('\n'));
}

async function handleWatchedImportCommand(interaction) {
  const action = interaction.options.getString('action', true);
  const config = getWatchedImportConfig(interaction.client);
  if (!config.enabled) {
    await interaction.editReply('Annictの「見た」作品取り込みは現在無効です。');
    return;
  }

  if (action === 'start') {
    const connection = interaction.client.db.annictUserIntegration.getConnection(interaction.guildId, interaction.user.id);
    if (!connection || connection.tokenStatus !== 'active') {
      await interaction.editReply('Annictとはまだ連携されていません。`/annict connect` を実行してください。');
      return;
    }

    const existing = interaction.client.db.annictUserIntegration.getWatchedImportJob(interaction.guildId, interaction.user.id);
    const job = interaction.client.db.annictUserIntegration.startOrResumeWatchedImportJob({
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      nextRunAt: new Date().toISOString()
    });
    interaction.client.logger.info(existing ? 'annict watched import resumed' : 'annict watched import started', {
      guildId: interaction.guildId,
      discordUserId: interaction.user.id
    });
    setTimeout(() => {
      void runAnnictWatchedImportDueJobs(interaction.client).catch((error) => {
        interaction.client.logger.warn('annict watched import manual kick failed', { error: error.message });
      });
    }, 500).unref?.();

    await interaction.editReply([
      'Annictの「見た」作品取り込みを開始しました。',
      '既存カードがある作品はスキップし、カードがない作品だけ少しずつ追加します。',
      `- 状態: ${job?.status || 'active'}`,
      `- 1バッチのカード作成上限: ${config.maxCardsPerBatch}`,
      `- バッチ間隔: ${config.batchIntervalMinutes}分`
    ].join('\n'));
    return;
  }

  if (action === 'status') {
    const job = interaction.client.db.annictUserIntegration.getWatchedImportJob(interaction.guildId, interaction.user.id);
    if (!job) {
      await interaction.editReply('Annictの「見た」作品取り込みジョブはまだありません。`/annict import-watched action:start` で開始できます。');
      return;
    }

    await interaction.editReply([
      'Annict「見た」作品取り込み状況',
      `- 状態: ${job.status}`,
      `- スキャン済み: ${Number(job.scannedCount || 0)}`,
      `- 新規カード: ${Number(job.postedCount || 0)}`,
      `- 既存カードをスキップ: ${Number(job.skippedExistingCount || 0)}`,
      `- 削除/欠落カード修復: ${Number(job.repairedCount || 0)}`,
      `- 失敗: ${Number(job.failedCount || 0)}`,
      `- カーソル: ${compactCursor(job.graphqlCursor)}`,
      `- 最終処理: ${formatJobDate(job.lastProcessedAt)}`,
      `- 次回処理: ${formatJobDate(job.nextRunAt)}`,
      `- 続きのページ: ${job.hasNextPage ? 'あり' : 'なし'}`
    ].join('\n'));
    return;
  }

  if (action === 'cancel') {
    const job = interaction.client.db.annictUserIntegration.cancelWatchedImportJob(interaction.guildId, interaction.user.id);
    interaction.client.logger.info('annict watched import cancelled', {
      guildId: interaction.guildId,
      discordUserId: interaction.user.id
    });
    await interaction.editReply(job
      ? 'Annictの「見た」作品取り込みをキャンセルしました。作成済みカードは削除しません。再開する場合は `/annict import-watched action:start` を実行してください。'
      : 'Annictの「見た」作品取り込みジョブはまだありません。');
    return;
  }

  await interaction.editReply('未対応の取り込み操作です。');
}

async function handleImportHistoryButton(interaction) {
  await interaction.deferUpdate().catch(() => null);
  if (interaction.customId === 'annict:sync:import:cancel') {
    await interaction.editReply({ content: 'Annict過去履歴の取り込みをキャンセルしました。', components: [] }).catch(() => null);
    return true;
  }

  if (interaction.client.appConfig.annictUserIntegration?.initialImportEnabled !== true) {
    await interaction.editReply({ content: '過去履歴の取り込みは現在無効です。', components: [] }).catch(() => null);
    return true;
  }

  const connection = interaction.client.db.annictUserIntegration.getConnection(interaction.guildId, interaction.user.id);
  if (!connection || connection.tokenStatus !== 'active') {
    await interaction.editReply({ content: 'Annictとはまだ連携されていません。`/annict connect` を実行してください。', components: [] }).catch(() => null);
    return true;
  }

  const result = await runAnnictUserSync(interaction.client, {
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    importHistory: true,
    manual: true
  });
  await interaction.editReply({
    content: [
      'Annictの過去履歴を取り込みました。',
      `- 処理した作品: ${result.processedWorks || 0}`,
      `- 失敗した接続: ${result.failedConnections || 0}`
    ].join('\n'),
    components: [],
    allowedMentions: { parse: [] }
  }).catch(() => null);
  return true;
}

function stripQuotedAndCodeText(content) {
  const lines = String(content || '').split(/\r?\n/u);
  let inFence = false;
  const kept = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*>/u.test(line)) {
      continue;
    }
    kept.push(line.replace(/`[^`]*`/gu, ' '));
  }
  return kept.join('\n');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&#x27;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, ' ')
    .replace(/&nbsp;/giu, ' ');
}

function normalizeCandidateText(value) {
  return decodeHtmlEntities(value)
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeTitleText(value) {
  return normalizeCandidateText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・･\-ー~〜!！?？:：,，.。()[\]【】『』「」"'“”‘’]/gu, '');
}

function getEmbedFieldTexts(embed) {
  const fields = Array.isArray(embed?.fields)
    ? embed.fields
    : Array.isArray(embed?.data?.fields)
      ? embed.data.fields
      : [];

  return fields.flatMap((field) => [
    { source: 'discord_embed_field_name', text: field?.name || '' },
    { source: 'discord_embed_field_value', text: field?.value || '' }
  ]);
}

function collectVisibleTextSources(message, options = {}) {
  const sourceOptions = options || {};
  const sources = [];
  const content = stripQuotedAndCodeText(message.content || '');
  if (content.trim()) {
    sources.push({ source: 'message_content', text: content });
  }

  for (const embed of message.embeds || []) {
    const title = embed?.title || embed?.data?.title || '';
    const description = embed?.description || embed?.data?.description || '';
    const authorName = embed?.author?.name || embed?.data?.author?.name || '';
    const providerName = embed?.provider?.name || embed?.data?.provider?.name || '';
    sources.push(
      { source: 'discord_embed_title', text: title },
      { source: 'discord_embed_description', text: description },
      { source: 'discord_embed_author_name', text: authorName },
      { source: 'discord_embed_provider_name', text: providerName },
      ...getEmbedFieldTexts(embed)
    );
  }

  for (const preview of sourceOptions.previewMetadata || []) {
    sources.push(preview);
  }

  return sources
    .map((entry) => ({ ...entry, text: normalizeCandidateText(entry.text) }))
    .filter((entry) => entry.text);
}

function getClearAnimeKeyword(text) {
  const normalized = normalizeCandidateText(text);
  if (/TVアニメ|テレビアニメ|劇場版アニメ|アニメーション|夏アニメ|春アニメ|秋アニメ|冬アニメ|アニメ/u.test(normalized)) {
    return normalized.match(/TVアニメ|テレビアニメ|劇場版アニメ|アニメーション|夏アニメ|春アニメ|秋アニメ|冬アニメ|アニメ/u)?.[0] || 'アニメ';
  }
  return null;
}

function getSignalLogMessage(source) {
  if (source === 'message_content') {
    return 'annict feature intro anime signal found in message content';
  }
  if (source === 'discord_embed_title') {
    return 'annict feature intro anime signal found in embed title';
  }
  if (source.startsWith('youtube_') || source.startsWith('twitter_')) {
    return 'annict feature intro anime signal found in preview metadata';
  }
  return 'annict feature intro anime signal found in embed metadata';
}

function getAuditTriggerType(source) {
  if (source === 'message_content' || source === 'discord_embed_title' || source === 'discord_embed_description') {
    return source;
  }
  if (source === 'youtube_oembed_title' || source === 'twitter_preview_text') {
    return source;
  }
  if (source.startsWith('discord_embed_')) {
    return 'discord_embed_description';
  }
  return source;
}

function findAnimeSignalInSources(client, message, sources) {
  for (const source of sources) {
    const keyword = getClearAnimeKeyword(source.text);
    if (keyword) {
      client.logger.info(getSignalLogMessage(source.source), {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        signalSource: source.source,
        matchedKeyword: keyword,
        animeEntryId: null
      });
      return {
        triggerType: getAuditTriggerType(source.source),
        signalSource: source.source,
        matchedKeyword: keyword,
        matchedAnimeEntryId: null
      };
    }
  }

  const minTitleLength = Number(client.appConfig.annictUserIntegration?.introDm?.minTitleLength || 4);
  const entries = client.db.anime.listAllEntries(message.guildId);
  for (const source of sources) {
    const normalizedText = normalizeTitleText(source.text);
    if (normalizedText.length < minTitleLength) {
      continue;
    }
    for (const entry of entries) {
      const aliases = [
        entry.titleNative,
        entry.titleUserPreferred,
        entry.titleRomaji,
        entry.titleEnglish,
        entry.titleKana,
        ...safeParseArray(entry.aliasesJson)
      ].filter(Boolean);
      for (const alias of aliases) {
        const normalizedAlias = normalizeTitleText(alias);
        if (normalizedAlias.length < minTitleLength) {
          continue;
        }
        if (normalizedText.includes(normalizedAlias)) {
          client.logger.info(getSignalLogMessage(source.source), {
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            userId: message.author?.id || null,
            signalSource: 'known_anime_alias',
            matchedKeyword: null,
            animeEntryId: entry.id
          });
          return {
            triggerType: 'known_anime_alias',
            signalSource: source.source,
            matchedKeyword: null,
            matchedAnimeEntryId: entry.id
          };
        }
      }
    }
  }
  return null;
}

function findAnimeIntroTrigger(client, message, options = {}) {
  return findAnimeSignalInSources(client, message, collectVisibleTextSources(message, options || {}));
}

function cleanUrlToken(value) {
  return String(value || '')
    .trim()
    .replace(/[.,、。!?！？;；]+$/u, '');
}

function extractUrls(value) {
  return Array.from(String(value || '').matchAll(/https?:\/\/[^\s<>()]+/giu))
    .map((match) => cleanUrlToken(match[0]))
    .filter(Boolean);
}

function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(cleanUrlToken(value));
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    if (host === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0] || null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host.endsWith('.youtube.com')) {
      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v') || null;
      }
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live'].includes(parts[0])) {
        return parts[1] || null;
      }
    }
  } catch {}
  return null;
}

function getYouTubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

async function fetchYouTubeOEmbedTitle(client, message, videoId, originalUrl) {
  if (!videoId) {
    return null;
  }

  const cacheKey = `youtube:${videoId}`;
  if (!client.annictIntroDmPreviewCache) {
    client.annictIntroDmPreviewCache = new Map();
  }
  const cached = client.annictIntroDmPreviewCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PREVIEW_CACHE_TTL_MS) {
    return cached.title ? { source: 'youtube_oembed_title', text: cached.title } : null;
  }

  const requestUrl = new URL('https://www.youtube.com/oembed');
  requestUrl.searchParams.set('url', getYouTubeWatchUrl(videoId));
  requestUrl.searchParams.set('format', 'json');

  try {
    const response = await fetch(requestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 compatible preview fetcher',
        Accept: 'application/json,*/*;q=0.8'
      },
      signal: buildAbortSignal(YOUTUBE_OEMBED_TIMEOUT_MS)
    });
    if (!response.ok) {
      client.annictIntroDmPreviewCache.set(cacheKey, { fetchedAt: Date.now(), title: null });
      return null;
    }
    const payload = await response.json();
    const title = normalizeCandidateText(payload?.title || '');
    client.annictIntroDmPreviewCache.set(cacheKey, { fetchedAt: Date.now(), title });
    if (!title) {
      return null;
    }
    client.logger.info('annict feature intro anime signal preview metadata fetched', {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author?.id || null,
      signalSource: 'youtube_oembed_title',
      matchedKeyword: null,
      animeEntryId: null
    });
    return { source: 'youtube_oembed_title', text: title };
  } catch {
    client.annictIntroDmPreviewCache.set(cacheKey, { fetchedAt: Date.now(), title: null });
    return null;
  }
}

function messageHasExternalUrl(message) {
  return extractUrls(stripQuotedAndCodeText(message.content || '')).length > 0;
}

async function resolvePreviewMetadataForMessage(client, message) {
  const metadata = [];
  const seenVideoIds = new Set();
  for (const url of extractUrls(stripQuotedAndCodeText(message.content || ''))) {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId || seenVideoIds.has(videoId)) {
      continue;
    }
    seenVideoIds.add(videoId);
    const title = await fetchYouTubeOEmbedTitle(client, message, videoId, url);
    if (title) {
      metadata.push(title);
    }
    if (metadata.length >= 3) {
      break;
    }
  }
  return metadata;
}

function getDelayedCheckMap(client) {
  if (!client.annictIntroDmDelayedChecks) {
    client.annictIntroDmDelayedChecks = new Map();
  }
  return client.annictIntroDmDelayedChecks;
}

function scheduleDelayedAnnictIntroInspection(message) {
  const client = message.client;
  const checks = getDelayedCheckMap(client);
  if (checks.has(message.id)) {
    client.logger.info('annict feature intro delayed embed inspection deduplicated', {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author?.id || null,
      signalSource: null,
      matchedKeyword: null,
      animeEntryId: null
    });
    return false;
  }

  const timeout = setTimeout(async () => {
    checks.delete(message.id);
    try {
      const fetched = await message.channel.messages.fetch(message.id);
      const previewMetadata = await resolvePreviewMetadataForMessage(client, fetched);
      await handleAnnictIntroDmCandidate(fetched, {
        allowDelayedInspection: false,
        allowPreviewFallback: false,
        previewMetadata
      });
    } catch (error) {
      client.logger.warn('annict feature intro delayed embed inspection failed', {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        userId: message.author?.id || null,
        error: error.message
      });
    }
  }, DELAYED_EMBED_INSPECTION_MS);
  timeout.unref?.();
  checks.set(message.id, timeout);
  client.logger.info('annict feature intro delayed embed inspection scheduled', {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author?.id || null,
    signalSource: null,
    matchedKeyword: null,
    animeEntryId: null
  });
  return true;
}

function cancelDelayedAnnictIntroInspection(client, message) {
  const checks = getDelayedCheckMap(client);
  const timeout = checks.get(message.id);
  if (!timeout) {
    return false;
  }
  clearTimeout(timeout);
  checks.delete(message.id);
  client.logger.info('annict feature intro delayed embed inspection deduplicated', {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author?.id || null,
    signalSource: null,
    matchedKeyword: null,
    animeEntryId: null
  });
  return true;
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildIntroDmPayload() {
  const container = new ContainerBuilder()
    .setAccentColor(0x60a5fa)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### このサーバーではアニメの視聴履歴を管理できます'),
      new TextDisplayBuilder().setContent([
        'このサーバーにはアニメ作品カードと視聴状態を管理する機能があります。',
        'Annictという外部のアニメ視聴管理サービスと任意で連携できます。',
        '',
        '- Discord側の「気になる」でAnnictの「見たい」に登録できます。',
        '- Discord側の「視聴済み」でAnnictの「見た」に更新できます。',
        '- 話数単位ではなく作品単位の管理です。',
        '- 連携しなくても通常のアニメカードは閲覧できます。',
        '- 連携は任意で、いつでも `/annict disconnect` で解除できます。',
        '',
        'Annictのアクセストークンはサーバー上のデータベースでは暗号化して保存され、Annict APIを利用する時だけBotが一時的に復号します。連携情報はユーザーごとに分離され、あなたの操作が他のユーザーのAnnictアカウントへ反映されることはありません。'
      ].join('\n')),
      new TextDisplayBuilder().setContent([
        '**使う順番**',
        '1. `/annict connect`',
        '2. `/annict status`',
        '3. アニメカードの「気になる」または「視聴済み」',
        '4. `/annict sync`',
        '5. `/annict disconnect`',
        '',
        '**Annictアカウントがない場合**',
        '1. Annictのアカウントを作成する',
        '2. Discordで `/annict connect` を実行する',
        '3. 表示されたAnnictの認可画面で `read / write` 権限を確認して許可する',
        '4. Discordに戻り、連携完了を確認する',
        '5. アニメカードの「気になる」または「視聴済み」を使用する',
        '6. 必要に応じて `/annict sync` を実行する'
      ].join('\n'))
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Annictアカウントを作成')
          .setStyle(ButtonStyle.Link)
          .setURL(ANNICT_ACCOUNT_URL)
      )
    );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] }
  };
}

async function handleAnnictIntroDmCandidate(message, options = {}) {
  const client = message.client;
  const config = client.appConfig.annictUserIntegration?.introDm || {};
  if (client.appConfig.annictUserIntegration?.enabled === false || config.enabled === false) {
    return false;
  }
  if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system) {
    return false;
  }
  if (config.excludedChannelIds?.includes?.(String(message.channelId))) {
    return false;
  }

  let previewMetadata = Array.isArray(options.previewMetadata) ? options.previewMetadata : [];
  let trigger = findAnimeIntroTrigger(client, message, { previewMetadata });
  if (!trigger && options.allowPreviewFallback) {
    previewMetadata = await resolvePreviewMetadataForMessage(client, message);
    trigger = findAnimeIntroTrigger(client, message, { previewMetadata });
  }
  if (!trigger) {
    if (options.allowDelayedInspection !== false && messageHasExternalUrl(message)) {
      scheduleDelayedAnnictIntroInspection(message);
    }
    return false;
  }

  const lockKey = `${message.guildId}:${message.author.id}`;
  if (client.annictIntroDmLocks.has(lockKey)) {
    return false;
  }
  client.annictIntroDmLocks.add(lockKey);
  try {
    client.logger.info('annict feature intro dm candidate detected', {
      guildId: message.guildId,
      discordUserId: message.author.id,
      triggerMessageId: message.id,
      triggerType: trigger.triggerType,
      signalSource: trigger.signalSource,
      matchedKeyword: trigger.matchedKeyword || null,
      matchedAnimeEntryId: trigger.matchedAnimeEntryId || null
    });

    const connection = client.db.annictUserIntegration.getConnection(message.guildId, message.author.id);
    if (connection?.tokenStatus === 'active') {
      client.logger.info('annict feature intro dm skipped already_connected', {
        guildId: message.guildId,
        discordUserId: message.author.id
      });
      return false;
    }

    const state = client.db.annictUserIntegration.getIntroDmState(message.guildId, message.author.id);
    if (state?.sentAt) {
      client.logger.info('annict feature intro dm skipped already_sent', {
        guildId: message.guildId,
        discordUserId: message.author.id
      });
      return false;
    }

    if (state?.status === 'failed') {
      const retryAt = new Date(new Date(state.updatedAt || state.firstTriggeredAt).getTime() + Number(config.retryCooldownDays || 14) * 24 * 60 * 60 * 1000);
      if (retryAt.getTime() > Date.now()) {
        client.logger.info('annict feature intro dm retry cooldown', {
          guildId: message.guildId,
          discordUserId: message.author.id
        });
        return false;
      }
    }

    const waitMs = Math.max(0, Number(config.globalSendIntervalMs || 3000) - (Date.now() - Number(client.annictIntroDmLastSentAt || 0)));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    client.db.annictUserIntegration.upsertIntroDmState({
      guildId: message.guildId,
      discordUserId: message.author.id,
      triggerMessageId: message.id,
      triggerType: trigger.triggerType,
      matchedTerm: trigger.matchedKeyword || null,
      matchedAnimeEntryId: trigger.matchedAnimeEntryId || null,
      status: 'pending'
    });

    const dm = await message.author.send(buildIntroDmPayload());
    client.annictIntroDmLastSentAt = Date.now();
    client.db.annictUserIntegration.upsertIntroDmState({
      guildId: message.guildId,
      discordUserId: message.author.id,
      triggerMessageId: message.id,
      triggerType: trigger.triggerType,
      matchedTerm: trigger.matchedKeyword || null,
      matchedAnimeEntryId: trigger.matchedAnimeEntryId || null,
      sentAt: new Date().toISOString(),
      dmMessageId: dm.id,
      status: 'sent'
    });
    client.logger.info('annict feature intro dm sent', {
      guildId: message.guildId,
      discordUserId: message.author.id,
      triggerType: trigger.triggerType,
      signalSource: trigger.signalSource,
      matchedKeyword: trigger.matchedKeyword || null,
      matchedAnimeEntryId: trigger.matchedAnimeEntryId || null
    });
    await notifyOpsChannel(client, [
      'Annict feature intro DM sent',
      `- Guild: ${message.guildId}`,
      `- User: ${message.author.id}`,
      `- Trigger: ${trigger.triggerType}`
    ].join('\n'), {
      severity: 'info',
      eventType: 'annict_intro_dm_sent',
      immediateDashboard: true
    }).catch(() => null);
    return true;
  } catch (error) {
    client.db.annictUserIntegration.upsertIntroDmState({
      guildId: message.guildId,
      discordUserId: message.author.id,
      triggerMessageId: message.id,
      triggerType: trigger.triggerType,
      matchedTerm: trigger.matchedKeyword || null,
      matchedAnimeEntryId: trigger.matchedAnimeEntryId || null,
      status: 'failed',
      lastErrorCode: error.code || 'dm_failed'
    });
    client.logger.warn('annict feature intro dm failed', {
      guildId: message.guildId,
      discordUserId: message.author.id,
      triggerType: trigger.triggerType,
      signalSource: trigger.signalSource,
      errorCode: error.code || null,
      error: error.message
    });
    await notifyOpsChannel(client, [
      'Annict feature intro DM failed',
      `- Guild: ${message.guildId}`,
      `- User: ${message.author.id}`,
      `- Trigger: ${trigger.triggerType}`,
      `- Error: ${error.code || 'dm_failed'}`
    ].join('\n'), {
      severity: 'warn',
      eventType: 'annict_intro_dm_failed',
      immediateDashboard: true
    }).catch(() => null);
    return false;
  } finally {
    client.annictIntroDmLocks.delete(lockKey);
  }
}

async function handleAnnictPreviewMessageUpdate(oldMessage, newMessage) {
  const client = newMessage.client;
  const message = newMessage.partial ? await newMessage.fetch() : newMessage;
  if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system) {
    return false;
  }
  if (!messageHasExternalUrl(message) && !(message.embeds || []).length) {
    return false;
  }

  const sent = await handleAnnictIntroDmCandidate(message, {
    allowDelayedInspection: false,
    allowPreviewFallback: true
  });
  if (sent) {
    cancelDelayedAnnictIntroInspection(client, message);
  }
  client.logger.info('annict feature intro preview update processed', {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author?.id || null,
    signalSource: sent ? 'message_update' : null,
    matchedKeyword: null,
    animeEntryId: null
  });
  return sent;
}

async function handleAnnictCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'connect') {
    await handleConnectCommand(interaction);
    return;
  }
  if (subcommand === 'status') {
    await handleStatusCommand(interaction);
    return;
  }
  if (subcommand === 'disconnect') {
    await handleDisconnectCommand(interaction);
    return;
  }
  if (subcommand === 'sync') {
    await handleSyncCommand(interaction);
    return;
  }
  if (subcommand === 'import-watched') {
    await handleWatchedImportCommand(interaction);
    return;
  }
  await interaction.editReply('不明なAnnictコマンドです。');
}

async function handleAnnictInteraction(interaction) {
  const customId = String(interaction.customId || '');
  if (interaction.isModalSubmit?.() && customId.startsWith('annict:oauth:modal:')) {
    return handleOauthCodeModal(interaction);
  }
  if (!interaction.isButton?.()) {
    return false;
  }
  if (customId.startsWith('annict:oauth:code:')) {
    return handleOauthCodeButton(interaction);
  }
  if (customId.startsWith('annict:disconnect:')) {
    return handleDisconnectButton(interaction);
  }
  if (customId.startsWith('annict:sync:import:')) {
    return handleImportHistoryButton(interaction);
  }
  if (customId.startsWith('annict:anime:')) {
    const [, , action, animeEntryId] = customId.split(':');
    if (!['interested', 'watched'].includes(action)) {
      await interaction.reply({
        content: '未対応のAnnict操作です。',
        ephemeral: true,
        allowedMentions: { parse: [] }
      });
      return true;
    }
    return handleAnimeCardAction(interaction, action, animeEntryId);
  }
  return false;
}

module.exports = {
  handleAnnictCommand,
  handleAnnictInteraction,
  handleAnnictIntroDmCandidate,
  handleAnnictPreviewMessageUpdate,
  updateAnnictStatusForAnimeEntry,
  runAnnictUserSync,
  startAnnictUserSync,
  runAnnictWatchedImportDueJobs,
  startAnnictWatchedImportWorker,
  getRuntimeStatus,
  encryptAccessToken,
  decryptAccessToken,
  collectVisibleTextSources,
  resolvePreviewMetadataForMessage,
  findAnimeIntroTrigger
};
