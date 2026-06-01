const {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder
} = require('discord.js');

const ANNOUNCEMENT_CHANNEL_ID = '1224747669604536382';
const TEMP_ROLE_PANEL_KIND = 'temp_role_panel';
const TEMP_ROLE_PANEL_OVERFLOW_KIND = 'temp_role_panel_overflow';
const ROLE_PANEL_ACCENT_COLOR = 0xef4444;

const ROLE_MAPPINGS = [
  { emoji: '🎬', label: '映像制作', roleId: '1228130088755662868' },
  { emoji: '🎮', label: 'ゲーム制作', roleId: '1228011188231733369' },
  { emoji: '🎨', label: 'イラスト', roleId: '1228685602707345498' },
  { emoji: '🧪', label: 'メディアアート', roleId: '1261854695224246352' },
  { emoji: '🖌️', label: 'デザイン', roleId: '1388927716132389045' },
  { emoji: '🎧', label: 'DTM', roleId: '1228011239846973450' },
  { emoji: '🎛️', label: 'DJ', roleId: '1503766807822073956' },
  { emoji: '1️⃣', label: 'Ae', roleId: '1224783046411292724' },
  { emoji: '2️⃣', label: 'DaVinci Resolve', roleId: '1224783139591688213' },
  { emoji: '3️⃣', label: 'Blender', roleId: '1224783081668476930' },
  { emoji: '4️⃣', label: 'Unity', roleId: '1228010718000054424' },
  { emoji: '5️⃣', label: 'Maya', roleId: '1224783180968628286' },
  { emoji: '6️⃣', label: 'Houdini', roleId: '1224783283250790511' },
  { emoji: '7️⃣', label: 'C4D', roleId: '1224783208634388611' },
  { emoji: '8️⃣', label: 'Unreal Engine', roleId: '1228010775076016200' },
  { emoji: '9️⃣', label: 'クリスタ', roleId: '1257162951006228500' },
  { emoji: '🔟', label: 'Ableton', roleId: '1228201818916520006' },
  { emoji: '🇱', label: 'Logic Pro', roleId: '1228010875659489432' },
  { emoji: '🇫', label: 'FL Studio', roleId: '1228010985931931718' },
  { emoji: '🇸', label: 'Studio One', roleId: '1228011035253014550' },
  { emoji: '🇨', label: 'Cubase', roleId: '1228010923336400987' },
  { emoji: '🧠', label: '知りたがり', roleId: '1510927153246502972' }
];

function normalizeEmojiKey(value) {
  return String(value || '').normalize('NFC').replace(/\uFE0F/gu, '');
}

const MAIN_ROLE_MAPPINGS = ROLE_MAPPINGS.slice(0, 15);
const OVERFLOW_ROLE_MAPPINGS = ROLE_MAPPINGS.slice(15);
const TRACKED_ROLE_PANEL_KINDS = new Set([
  TEMP_ROLE_PANEL_KIND,
  TEMP_ROLE_PANEL_OVERFLOW_KIND
]);

const ROLE_BY_EMOJI_BY_PANEL_KIND = new Map([
  [
    TEMP_ROLE_PANEL_KIND,
    new Map(MAIN_ROLE_MAPPINGS.map((entry) => [normalizeEmojiKey(entry.emoji), entry]))
  ],
  [
    TEMP_ROLE_PANEL_OVERFLOW_KIND,
    new Map(OVERFLOW_ROLE_MAPPINGS.map((entry) => [normalizeEmojiKey(entry.emoji), entry]))
  ]
]);

function buildSectionBlock(title, lines) {
  return [`**${title}**`, '', ...lines].join('\n');
}

function buildRolePanelPayload() {
  const container = new ContainerBuilder().setAccentColor(ROLE_PANEL_ACCENT_COLOR);
  const textBlocks = [
    '@everyone',
    [
      '再度ロールの整理がいつでもできるように、ここにロール付与用の投稿を置いておきます！',
      '',
      '下のリアクションを押すと、そのロールを自分で付けられます。',
      'もう一度整理したい時や、新しく使い始めたソフトがある時に使ってください。',
      '',
      'リアクションを外すと、そのロールも外れます。',
      'すでに持っているロールのリアクションを押しても、特に追加の通知はありません。'
    ].join('\n'),
    buildSectionBlock('制作ジャンル', [
      '🎬 映像制作',
      '🎮 ゲーム制作',
      '🎨 イラスト',
      '🧪 メディアアート',
      '🖌️ デザイン',
      '🎧 DTM',
      '🎛️ DJ'
    ]),
    buildSectionBlock('映像・CG・ゲーム系ソフト', [
      '1️⃣ After Effects / Ae',
      '2️⃣ DaVinci Resolve',
      '3️⃣ Blender',
      '4️⃣ Unity',
      '5️⃣ Maya',
      '6️⃣ Houdini',
      '7️⃣ Cinema 4D / C4D',
      '8️⃣ Unreal Engine'
    ])
  ];

  textBlocks.forEach((block, index) => {
    if (index > 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
  });

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: ['everyone'] }
  };
}

function buildRolePanelOverflowPayload() {
  const container = new ContainerBuilder().setAccentColor(ROLE_PANEL_ACCENT_COLOR);
  const textBlocks = [
    '@everyone',
    [
      'ロール付与用の追加パネルです。',
      '',
      'イラスト系ソフト、DAW・音楽制作ソフト、知識共有系のロールはこちらから付け外しできます。',
      '',
      'リアクションを押すとロールが付き、リアクションを外すとロールも外れます。',
      'すでに持っているロールのリアクションを押しても、特に追加の通知はありません。'
    ].join('\n'),
    buildSectionBlock('イラスト系ソフト', [
      '9️⃣ CLIP STUDIO PAINT / クリスタ'
    ]),
    buildSectionBlock('DAW・音楽制作ソフト', [
      '🔟 Ableton',
      '🇱 Logic Pro',
      '🇫 FL Studio',
      '🇸 Studio One',
      '🇨 Cubase'
    ]),
    buildSectionBlock('知識共有', [
      '🧠 知りたがり',
      '「知りたいこと」チャンネルに新しい投稿があった時に通知を受け取りたい人向けのロールです。',
      '誰かの疑問・相談・調べものを一緒に見たい人は付けてください。'
    ])
  ];

  textBlocks.forEach((block, index) => {
    if (index > 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
  });

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: ['everyone'] }
  };
}

async function addRolePanelReactions(message, logger, roleMappings, panelKind) {
  const isOverflow = panelKind === TEMP_ROLE_PANEL_OVERFLOW_KIND;

  for (const entry of roleMappings) {
    try {
      await message.react(entry.emoji);
      logger.info(isOverflow ? 'role panel overflow reaction added' : 'role panel reaction added', {
        messageId: message.id,
        panelKind,
        emoji: entry.emoji,
        roleId: entry.roleId,
        label: entry.label
      });
    } catch (error) {
      logger.warn(isOverflow ? 'role panel overflow reaction add failed' : 'role panel reaction add failed', {
        messageId: message.id,
        panelKind,
        emoji: entry.emoji,
        roleId: entry.roleId,
        label: entry.label,
        error: error.message
      });
    }
  }
}

async function upsertRolePanelMessage({
  client,
  guildId,
  channel,
  panelKind,
  payload,
  roleMappings
}) {
  const logger = client.logger;
  const existing = client.db.rolePanels.get(guildId, panelKind);
  const existingMessage = existing?.messageId
    ? await channel.messages.fetch(existing.messageId).catch(() => null)
    : null;

  if (existingMessage) {
    try {
      await existingMessage.delete();
      logger.info('role panel existing message deleted for repost', {
        guildId,
        channelId: channel.id,
        messageId: existingMessage.id,
        panelKind
      });
    } catch (error) {
      logger.warn('role panel existing message delete failed', {
        guildId,
        channelId: channel.id,
        messageId: existingMessage.id,
        panelKind,
        error: error.message
      });
      throw error;
    }
  }

  const message = await channel.send(payload);
  logger.info(panelKind === TEMP_ROLE_PANEL_OVERFLOW_KIND
    ? 'role panel overflow message posted'
    : 'role panel message posted', {
    guildId,
    channelId: channel.id,
    messageId: message.id,
    panelKind,
    replacedMessageId: existingMessage?.id || null,
    replacedMissingMessageId: existingMessage ? null : existing?.messageId || null
  });

  client.db.rolePanels.upsert({
    guildId,
    panelKind,
    channelId: channel.id,
    messageId: message.id
  });
  await addRolePanelReactions(message, logger, roleMappings, panelKind);

  return message;
}

async function postTempRolePanel(client, guildId) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.()) {
    throw new Error(`Role panel announcement channel is unavailable: ${ANNOUNCEMENT_CHANNEL_ID}`);
  }

  const mainMessage = await upsertRolePanelMessage({
    client,
    guildId,
    channel,
    panelKind: TEMP_ROLE_PANEL_KIND,
    payload: buildRolePanelPayload(),
    roleMappings: MAIN_ROLE_MAPPINGS
  });
  const overflowMessage = await upsertRolePanelMessage({
    client,
    guildId,
    channel,
    panelKind: TEMP_ROLE_PANEL_OVERFLOW_KIND,
    payload: buildRolePanelOverflowPayload(),
    roleMappings: OVERFLOW_ROLE_MAPPINGS
  });

  return {
    mainMessage,
    overflowMessage
  };
}

function getRoleMappingForPanelKind(panelKind, emojiName) {
  return ROLE_BY_EMOJI_BY_PANEL_KIND.get(panelKind)?.get(normalizeEmojiKey(emojiName)) || null;
}

async function resolveRolePanelContext(reaction, user) {
  if (user?.bot) {
    return null;
  }

  const fullReaction = reaction.partial
    ? await reaction.fetch().catch(() => reaction)
    : reaction;
  const message = fullReaction.message?.partial
    ? await fullReaction.message.fetch().catch(() => fullReaction.message)
    : fullReaction.message;
  if (!message?.id || !message.guildId) {
    return null;
  }

  const panel = message.client.db.rolePanels.getByMessageId(message.id);
  if (!panel) {
    if (message.channelId === ANNOUNCEMENT_CHANNEL_ID) {
      message.client.logger.info('role panel reaction ignored untracked message', {
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guildId,
        emoji: fullReaction.emoji?.name || null,
        userId: user?.id || null
      });
    }
    return null;
  }
  if (!TRACKED_ROLE_PANEL_KINDS.has(panel.panelKind)) {
    return null;
  }

  if (String(panel.guildId) !== String(message.guildId) || String(panel.channelId) !== String(message.channelId)) {
    message.client.logger.warn('role panel reaction ignored due to stored message mismatch', {
      messageId: message.id,
      storedGuildId: panel.guildId,
      messageGuildId: message.guildId,
      storedChannelId: panel.channelId,
      messageChannelId: message.channelId
    });
    return null;
  }

  const roleMapping = getRoleMappingForPanelKind(panel.panelKind, fullReaction.emoji?.name);
  if (!roleMapping) {
    message.client.logger.info('role panel reaction ignored unmapped emoji', {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      panelKind: panel.panelKind,
      emoji: fullReaction.emoji?.name || null,
      userId: user?.id || null
    });
    return {
      message,
      panel,
      roleMapping: null
    };
  }

  message.client.logger.info('role panel reaction matched tracked panel', {
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    panelKind: panel.panelKind,
    emoji: roleMapping.emoji,
    roleId: roleMapping.roleId,
    label: roleMapping.label,
    userId: user?.id || null
  });

  return {
    message,
    panel,
    roleMapping
  };
}

async function fetchRolePanelMemberAndRole(message, userId, roleMapping, action) {
  const logger = message.client.logger;
  const guild = message.guild || await message.client.guilds.fetch(message.guildId).catch(() => null);
  if (!guild) {
    logger.warn('role panel guild fetch failed', {
      action,
      guildId: message.guildId,
      messageId: message.id
    });
    return {};
  }

  const member = await guild.members.fetch(userId).catch((error) => {
    logger.warn('role panel member fetch failed', {
      action,
      guildId: guild.id,
      userId,
      messageId: message.id,
      error: error.message
    });
    return null;
  });
  if (!member) {
    return { guild };
  }

  const role = guild.roles.cache.get(roleMapping.roleId) || await guild.roles.fetch(roleMapping.roleId).catch((error) => {
    logger.warn('role panel role fetch failed', {
      action,
      guildId: guild.id,
      userId,
      roleId: roleMapping.roleId,
      label: roleMapping.label,
      messageId: message.id,
      error: error.message
    });
    return null;
  });
  if (!role) {
    logger.warn('role panel role missing', {
      action,
      guildId: guild.id,
      userId,
      roleId: roleMapping.roleId,
      label: roleMapping.label,
      messageId: message.id
    });
    return { guild, member };
  }

  return {
    guild,
    member,
    role
  };
}

async function handleRolePanelReactionAdd(reaction, user) {
  const context = await resolveRolePanelContext(reaction, user);
  if (!context) {
    return false;
  }

  const { message, roleMapping } = context;
  if (!roleMapping) {
    return true;
  }

  const logger = message.client.logger;
  const { member, role } = await fetchRolePanelMemberAndRole(message, user.id, roleMapping, 'add');
  if (!member || !role) {
    return true;
  }

  if (member.roles.cache.has(role.id)) {
    logger.info('role panel role add skipped existing role', {
      guildId: message.guildId,
      userId: user.id,
      roleId: role.id,
      label: roleMapping.label,
      messageId: message.id
    });
    return true;
  }

  try {
    await member.roles.add(role, 'Otaku Assistant temporary role panel reaction');
    logger.info('role panel role granted', {
      guildId: message.guildId,
      userId: user.id,
      roleId: role.id,
      label: roleMapping.label,
      emoji: roleMapping.emoji,
      messageId: message.id
    });
  } catch (error) {
    logger.warn('role panel role grant failed', {
      guildId: message.guildId,
      userId: user.id,
      roleId: role.id,
      label: roleMapping.label,
      emoji: roleMapping.emoji,
      messageId: message.id,
      error: error.message
    });
  }

  return true;
}

async function handleRolePanelReactionRemove(reaction, user) {
  const context = await resolveRolePanelContext(reaction, user);
  if (!context) {
    return false;
  }

  const { message, roleMapping } = context;
  if (!roleMapping) {
    return true;
  }

  const logger = message.client.logger;
  const { member, role } = await fetchRolePanelMemberAndRole(message, user.id, roleMapping, 'remove');
  if (!member || !role) {
    return true;
  }

  if (!member.roles.cache.has(role.id)) {
    logger.info('role panel role remove skipped missing role', {
      guildId: message.guildId,
      userId: user.id,
      roleId: role.id,
      label: roleMapping.label,
      messageId: message.id
    });
    return true;
  }

  try {
    await member.roles.remove(role, 'Otaku Assistant temporary role panel reaction removed');
    logger.info('role panel role removed', {
      guildId: message.guildId,
      userId: user.id,
      roleId: role.id,
      label: roleMapping.label,
      emoji: roleMapping.emoji,
      messageId: message.id
    });
  } catch (error) {
    logger.warn('role panel role remove failed', {
      guildId: message.guildId,
      userId: user.id,
      roleId: role.id,
      label: roleMapping.label,
      emoji: roleMapping.emoji,
      messageId: message.id,
      error: error.message
    });
  }

  return true;
}

module.exports = {
  ANNOUNCEMENT_CHANNEL_ID,
  TEMP_ROLE_PANEL_KIND,
  TEMP_ROLE_PANEL_OVERFLOW_KIND,
  ROLE_MAPPINGS,
  MAIN_ROLE_MAPPINGS,
  OVERFLOW_ROLE_MAPPINGS,
  buildRolePanelPayload,
  buildRolePanelOverflowPayload,
  postTempRolePanel,
  handleRolePanelReactionAdd,
  handleRolePanelReactionRemove,
  normalizeEmojiKey
};
