const fs = require('node:fs');
const path = require('node:path');

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.filter(Boolean).map(String);
}

function ensureTagMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([forumId, tagConfig]) => {
      if (!tagConfig || typeof tagConfig !== 'object') {
        throw new Error(`${label}.${forumId} must be an object`);
      }

      return [
        String(forumId),
        {
          resolved: String(tagConfig.resolved || ''),
          open: String(tagConfig.open || '')
        }
      ];
    })
  );
}

function ensureBotHashtagRoutes(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([routeKey, route]) => {
      if (!route || typeof route !== 'object') {
        throw new Error(`${label}.${routeKey} must be an object`);
      }

      return [
        String(routeKey),
        {
          aliases: ensureArray(route.aliases || [], `${label}.${routeKey}.aliases`),
          display: String(route.display || `#${routeKey}`),
          channelId: String(route.channelId || '')
        }
      ];
    })
  );
}

function ensureOpsConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      logChannelId: '',
      developerPortalUrl: '',
      allowRestartCommand: false
    };
  }

  return {
    logChannelId: String(value.logChannelId || ''),
    developerPortalUrl: String(value.developerPortalUrl || ''),
    allowRestartCommand: value.allowRestartCommand === true
  };
}

function loadConfig(configPath) {
  if (!process.env.DISCORD_TOKEN) {
    throw new Error('DISCORD_TOKEN is missing in .env');
  }

  if (!process.env.CLIENT_ID) {
    throw new Error('CLIENT_ID is missing in .env');
  }

  if (!process.env.GUILD_ID) {
    throw new Error('GUILD_ID is missing in .env');
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}. Copy ${path.basename(configPath, '.json')}.example.json first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    entranceChannelId: String(parsed.entranceChannelId || ''),
    timelineChannelId: String(parsed.timelineChannelId || ''),
    introChannelId: String(parsed.introChannelId || ''),
    watchedForums: {
      question: ensureArray(parsed.watchedForums?.question || [], 'watchedForums.question'),
      tweet: ensureArray(parsed.watchedForums?.tweet || [], 'watchedForums.tweet'),
      knowledge: ensureArray(parsed.watchedForums?.knowledge || [], 'watchedForums.knowledge')
    },
    voiceProfileChannels: Array.isArray(parsed.voiceProfileChannels)
      ? parsed.voiceProfileChannels.map((entry) => ({
          name: String(entry.name || ''),
          profileChannelId: String(entry.profileChannelId || '')
        }))
      : [],
    timeline: {
      maxContentLength: Number(parsed.timeline?.maxContentLength ?? 800),
      includeFirstImage: parsed.timeline?.includeFirstImage !== false,
      ignoreBotPosts: parsed.timeline?.ignoreBotPosts !== false
    },
    voiceProfile: {
      ignoreBots: parsed.voiceProfile?.ignoreBots !== false
    },
    mediaRelay: {
      maxReuploadBytes: Number(parsed.mediaRelay?.maxReuploadBytes ?? 25_000_000),
      tempDir: String(parsed.mediaRelay?.tempDir || './tmp/relay-media')
    },
    questions: {
      resolvedPrefix: String(parsed.questions?.resolvedPrefix || '[解決済]'),
      allowResolveBy: ensureArray(
        parsed.questions?.allowResolveBy || ['threadOwner', 'administrator'],
        'questions.allowResolveBy'
      ),
      moderatorRoleIds: ensureArray(parsed.questions?.moderatorRoleIds || [], 'questions.moderatorRoleIds')
    },
    ops: ensureOpsConfig(parsed.ops),
    questionForumTags: ensureTagMap(parsed.questionForumTags, 'questionForumTags'),
    botHashtagRoutes: ensureBotHashtagRoutes(parsed.botHashtagRoutes, 'botHashtagRoutes')
  };
}

module.exports = {
  loadConfig
};
