const {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder
} = require('discord.js');
const { getChannelJumpUrl } = require('../../services/discordLinks');
const { DEFAULT_GUIDE_SOURCE_PATH, loadEntranceGuideCards } = require('./content');

const STATIC_CHANNELS = {
  announcements: '1224747669604536382',
  welcome: '1227573832559362048',
  chat: '1345366146786005052',
  promo: '1224747669604536387',
  starRail: '1227541185296601140',
  rhythmGames: '1503797168643903518',
  listenChat: '1250753933689884713',
  musicBot: '1261853045063421982'
};

function getGuideCardLinks(cardKey, config) {
  const knowledgeChannelId = config.watchedForums.knowledge?.[0] || '';
  const tweetForumId = config.watchedForums.tweet?.[0] || '';
  const videoChannelId = config.botHashtagRoutes?.['いい映像']?.channelId || '';
  const musicChannelId = config.botHashtagRoutes?.['いい音楽']?.channelId || '';
  const questionForumIds = config.watchedForums.question || [];

  const byKey = {
    intro: [],
    overview: [],
    'map-information': [
      {
        channelId: config.entranceChannelId,
        description: 'サーバーの入口と案内の確認はこちらです。'
      },
      {
        channelId: STATIC_CHANNELS.announcements,
        description: '大事なお知らせや募集を確認する場所です。'
      },
      {
        channelId: config.introChannelId,
        description: '自己紹介を投稿する場所です。'
      },
      {
        channelId: STATIC_CHANNELS.welcome,
        description: '新しく参加した人が表示されるチャンネルです。'
      }
    ],
    'map-knowledge': [
      {
        channelId: config.timelineChannelId,
        description: 'サーバー内の投稿が集まるタイムラインです。'
      },
      {
        channelId: tweetForumId,
        description: '各自が自分のスレッドでつぶやくフォーラムです。'
      },
      {
        channelId: knowledgeChannelId,
        description: '知りたいことを投稿するフォーラムです。'
      },
      {
        channelId: videoChannelId,
        description: '良い映像を共有するチャンネルです。'
      },
      {
        channelId: musicChannelId,
        description: '良い音楽を共有するチャンネルです。'
      }
    ],
    'map-chat': [
      {
        channelId: STATIC_CHANNELS.chat,
        description: '自由に雑談する場所です。'
      },
      {
        channelId: STATIC_CHANNELS.promo,
        description: '作品やイベントの告知を投稿する場所です。'
      },
      {
        channelId: STATIC_CHANNELS.starRail,
        description: '崩壊スターレイル用のチャンネルです。'
      },
      {
        channelId: STATIC_CHANNELS.rhythmGames,
        description: '音ゲー全般の話題用です。'
      }
    ],
    'map-categories': [
      {
        channelId: questionForumIds[0],
        description: '映像制作全般の質問場所です。'
      },
      {
        channelId: questionForumIds[1],
        description: 'DTM の質問場所です。'
      },
      {
        channelId: questionForumIds[2],
        description: 'メディアアートの質問場所です。'
      },
      {
        channelId: questionForumIds[3],
        description: 'CG の質問場所です。'
      },
      {
        channelId: questionForumIds[4],
        description: '個人開発の質問場所です。'
      }
    ],
    'map-voice': [
      {
        channelId: STATIC_CHANNELS.listenChat,
        description: '聞き専向けのテキストチャンネルです。'
      },
      {
        channelId: STATIC_CHANNELS.musicBot,
        description: '音楽Botの操作コマンド用チャンネルです。'
      },
      {
        channelId: config.voiceProfileChannels?.[0]?.profileChannelId,
        description: '通話1 の VCプロフィール表示チャンネルです。'
      },
      {
        channelId: config.voiceProfileChannels?.[1]?.profileChannelId,
        description: '通話2 の VCプロフィール表示チャンネルです。'
      }
    ],
    'features-core': [
      {
        channelId: config.timelineChannelId,
        description: 'サーバー内の投稿が集まるタイムラインです。'
      },
      {
        channelId: tweetForumId,
        description: '各自が自分のスレッドでつぶやくフォーラムです。'
      },
      {
        channelId: knowledgeChannelId,
        description: '知りたいことの新規スレッドも共有されます。'
      }
    ],
    'features-tags': [
      {
        channelId: videoChannelId,
        description: '##良い映像 の投稿が共有されるチャンネルです。'
      },
      {
        channelId: musicChannelId,
        description: '##良い音楽 の投稿が共有されるチャンネルです。'
      }
    ],
    'features-questions': [
      {
        channelId: questionForumIds[0],
        description: '映像制作全般の質問場所です。'
      },
      {
        channelId: questionForumIds[1],
        description: 'DTM の質問場所です。'
      },
      {
        channelId: questionForumIds[2],
        description: 'メディアアートの質問場所です。'
      },
      {
        channelId: questionForumIds[3],
        description: 'CG の質問場所です。'
      },
      {
        channelId: questionForumIds[4],
        description: '個人開発の質問場所です。'
      }
    ],
    'features-anime': [
      {
        channelId: config.anime?.channelId,
        description: 'アニメ作品カードや感想スレッドがまとまるチャンネルです。'
      }
    ],
    'vc-profile': [
      {
        channelId: config.introChannelId,
        description: '自己紹介を書いておく場所です。'
      },
      {
        channelId: config.voiceProfileChannels?.[0]?.profileChannelId,
        description: '通話1 の VCプロフィール表示チャンネルです。'
      },
      {
        channelId: config.voiceProfileChannels?.[1]?.profileChannelId,
        description: '通話2 の VCプロフィール表示チャンネルです。'
      }
    ],
    rules: []
  };

  return (byKey[cardKey] || []).filter((entry) => entry.channelId);
}

function buildGuideCardPayload({ card, config, guildId }) {
  const container = new ContainerBuilder().setAccentColor(card.accentColor);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${card.title}`)
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(card.body)
  );

  for (const link of getGuideCardLinks(card.key, config)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**<#${link.channelId}>**\n${link.description}`)
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setLabel('チャンネルに移動')
            .setStyle(ButtonStyle.Link)
            .setURL(
              getChannelJumpUrl({
                guildId,
                channelId: link.channelId
              })
            )
        )
    );
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: {
      parse: []
    }
  };
}

async function deleteStaleGuidePosts({ channel, existingPosts, activeKeys, logger }) {
  for (const existing of existingPosts) {
    if (activeKeys.has(existing.guideKey)) {
      continue;
    }

    const staleMessage = await channel.messages.fetch(existing.messageId).catch(() => null);

    if (staleMessage) {
      await staleMessage.delete().catch(() => null);
      logger.info('Entrance guide stale section deleted', {
        channelId: existing.channelId,
        guideKey: existing.guideKey,
        messageId: existing.messageId
      });
    }

    channel.client.db?.guides?.deleteGuidePost(existing.channelId, existing.guideKey);
  }
}

async function postEntranceGuide({ client, sourcePath = DEFAULT_GUIDE_SOURCE_PATH, channelId = null, logger = null }) {
  const activeLogger = logger || client.logger;
  const guideChannelId = String(channelId || client.appConfig.entranceChannelId || '');

  if (!guideChannelId) {
    throw new Error('entranceChannelId is not configured');
  }

  const targetChannel = await client.channels.fetch(guideChannelId).catch(() => null);
  if (!targetChannel?.isTextBased?.()) {
    throw new Error(`Entrance guide destination is not text-based: ${guideChannelId}`);
  }

  const cards = loadEntranceGuideCards(sourcePath);
  const activeKeys = new Set(cards.map((card) => card.key));
  const existingPosts = client.db?.guides?.listGuidePosts(guideChannelId) || [];
  const results = [];

  await deleteStaleGuidePosts({
    channel: targetChannel,
    existingPosts,
    activeKeys,
    logger: activeLogger
  });

  for (const card of cards) {
    const payload = buildGuideCardPayload({
      card,
      config: client.appConfig,
      guildId: targetChannel.guildId || process.env.GUILD_ID
    });

    const existing = client.db?.guides?.getGuidePost(guideChannelId, card.key) || null;
    let sentMessage = null;

    if (existing) {
      const existingMessage = await targetChannel.messages.fetch(existing.messageId).catch(() => null);

      if (existingMessage) {
        sentMessage = await existingMessage.edit(payload);
        activeLogger.info('Entrance guide section updated', {
          channelId: guideChannelId,
          guideKey: card.key,
          messageId: sentMessage.id
        });
      }
    }

    if (!sentMessage) {
      sentMessage = await targetChannel.send(payload);
      activeLogger.info('Entrance guide section posted', {
        channelId: guideChannelId,
        guideKey: card.key,
        messageId: sentMessage.id
      });
    }

    client.db?.guides?.upsertGuidePost({
      channelId: guideChannelId,
      guideKey: card.key,
      messageId: sentMessage.id
    });

    results.push({
      key: card.key,
      title: card.title,
      messageId: sentMessage.id,
      url: sentMessage.url
    });
  }

  return results;
}

module.exports = {
  postEntranceGuide,
  buildGuideCardPayload
};
