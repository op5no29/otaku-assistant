# Otaku Assistant

Otaku Assistant is a Discord community assistant bot built with Node.js, discord.js, SQLite, and Discord Components V2.

It was originally built for a Japanese creator community, but the repository is public and can be configured for other Discord servers. It helps a server turn everyday posts into organized timeline cards, route tagged posts to topic channels, manage anime discussion cards and reviews, show voice-channel profile cards, and run lightweight welcome/self-introduction workflows.

The bot is systemd-compatible and stores its local state in SQLite.

## Main Features

- Timeline relay from configured personal/tweet forum threads.
- Hashtag route relay for normal messages, thread messages, and replies:
  - `##技術` / `##tool` / `##開発`
  - `##いい映像`
  - `##いい音楽`
  - `##アニメ` / `##anime`
  - `##飯` / `##food`
- Post-hoc hashtag routing: reply to an existing message with route tags and the bot routes the original message.
- Edit-based route adding: add route tags by editing a message; only missing destinations are created.
- `@silent` control token to suppress timeline/route relay for a post.
- Spoiler attachment preservation for relayed images/files where Discord supports it.
- Anime system:
  - Annict metadata provider.
  - AniList read-only image fallback.
  - Anime parent cards in the anime channel.
  - Per-anime discussion threads.
  - Interested/watched reactions.
  - Discord-local reviews and review cards.
  - Optional review milestone roles.
- VC profile cards:
  - Show users currently in configured voice-channel categories.
  - Pull intro profile text/images from the self-introduction channel.
  - Per-channel accent colors.
  - Periodic reconciliation to clean stale cards.
- Intro/self-introduction system:
  - Tracks each user's first valid intro post.
  - Intro reactions.
  - No-intro DM reminders via queue/state tables.
- Welcome DM:
  - `welcome_join` prompt for new members.
  - One-time send state in SQLite.
- Question resolver:
  - `/resolve` and `/unresolve`.
  - Thread title/tag sync for open/resolved state.
- Welcome reactions / intro reactions.
- Optional LLM reply and user-memory features through local Ollama.

## Requirements

- Node.js 20 or newer recommended.
- npm.
- SQLite support through `better-sqlite3`.
- A Discord application and bot token.
- A Discord server where you can invite the bot and register guild slash commands.
- Optional: Annict API token for anime metadata.
- Optional: local Ollama server for LLM features.
- Optional: `ffmpeg` for richer video thumbnails.
- Optional: Odesli API key for richer music link previews.

Required Discord gateway intents are defined in [src/client.js](src/client.js):

- Guilds
- GuildMembers
- GuildMessages
- GuildMessageReactions
- DirectMessages
- MessageContent
- GuildVoiceStates

Enable the matching privileged intents in the Discord Developer Portal, especially `Message Content Intent` and `Server Members Intent`.

## Installation

```bash
git clone https://github.com/op5no29/otaku-assistant.git
cd otaku-assistant
npm ci
cp .env.example .env
cp config.example.json config.json
```

Then edit `.env` and `config.json` for your server.

Check the project:

```bash
npm run check
```

Register guild slash commands:

```bash
npm run register-commands
```

Start locally:

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

## .env Setup

Create `.env` from [.env.example](.env.example). Do not commit `.env`.

```env
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
CLIENT_ID=YOUR_DISCORD_APPLICATION_ID
GUILD_ID=YOUR_DISCORD_SERVER_ID
NODE_ENV=production
ANNICT_ACCESS_TOKEN=YOUR_ANNICT_ACCESS_TOKEN
ODESLI_API_KEY=
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:4b
```

- `DISCORD_TOKEN`: Bot token from the Discord Developer Portal.
- `CLIENT_ID`: Discord application/client ID.
- `GUILD_ID`: Target server ID. Slash commands are registered as guild commands.
- `ANNICT_ACCESS_TOKEN`: Optional but recommended for anime features. Used read-only.
- `ODESLI_API_KEY`: Optional Songlink/Odesli key for music links.
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL`: Optional local LLM settings.

## config.json Setup

Copy [config.example.json](config.example.json) to `config.json` and replace every `YOUR_*` placeholder with your own server's channel, forum, tag, role, and user IDs.

`config.json` is intentionally ignored by git because it contains server-specific IDs.

Important sections:

- `entranceChannelId`: Channel where the entrance guide can be posted.
- `timelineChannelId`: Main timeline relay destination.
- `introChannelId`: Self-introduction channel. Intro profiles and VC cards read from here.
- `welcomeChannelId`: Welcome/join notification channel for welcome reactions.
- `ops.logChannelId`: Operational log channel for startup/errors/DM reports.
- `watchedForums.question`: Question forum channel IDs.
- `watchedForums.tweet`: Personal/tweet forum channel IDs.
- `watchedForums.knowledge`: Knowledge forum channel IDs.
- `questionForumTags`: Per-question-forum open/resolved tag IDs.
- `questionRolePrompt`: Optional role-select prompt before question cards are relayed, plus optional role mentions for knowledge/"知りたいこと" cards.
- `voiceProfileChannels`: Text channels used to display VC profile cards. The parent category of each profile channel determines which voice channels are tracked. `voiceStatusLabel` can provide a manual fallback label for that category.
- `voiceProfile.channelAccentColors`: Optional map of voice channel ID to accent color.
- `voiceProfile.channelStatusLabels`: Optional map of voice channel ID to a status label shown when Discord's voice channel status text is not exposed by discord.js/API.
- `globalHashtagRoutes`: Route tags such as tech/anime/food. These can also relay to timeline.
- `botHashtagRoutes`: Bot-specific route tags such as `##いい映像` and `##いい音楽`.
- `vcListenOnlyChannelIds`: Channels where route tags can be listened for without normal tweet relay.
- `anime`: Anime system settings and review role thresholds.
- `annict`: Annict API settings. `accessTokenEnv` defaults to `ANNICT_ACCESS_TOKEN`.
- `introDm`: No-intro reminder queue settings.
- `welcomeDm`: One-time new-member welcome DM settings.
- `mediaRelay`: Attachment re-upload limits and temp directory.
- `twitterMedia`: Link/media preview resolver options.
- `llm*` / `ollama*`: Optional advanced LLM behavior.

### Route Colors

Routes and VC cards support optional accent colors:

```json
{
  "botHashtagRoutes": {
    "いい映像": {
      "aliases": ["いい映像", "良い映像"],
      "display": "#良い映像",
      "channelId": "YOUR_GOOD_VIDEO_CHANNEL_ID",
      "accentColor": "#06b6d4"
    }
  },
  "voiceProfile": {
    "channelAccentColors": {
      "YOUR_VOICE_CHANNEL_ID": "#14b8a6"
    },
    "channelStatusLabels": {
      "YOUR_VOICE_CHANNEL_ID": "作業"
    }
  }
}
```

When multiple route tags are present, the current priority is:

```text
anime white > good-video > good-music > tech > food > default
```

## Discord Permissions

Grant the bot only the permissions it needs for your server. Typical permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Create Private Threads if your workflow uses them
- Manage Threads if the bot needs to update/archive thread state
- Add Reactions
- Read Message History
- Manage Messages for cleanup/deleting prompt messages
- Manage Roles if anime review milestone roles are enabled
- Attach Files
- Embed Links
- Use External Emojis if your reaction setup uses them
- Use Slash Commands

DMs are controlled by each user's privacy settings. If a user blocks server DMs, welcome/no-intro DMs will fail and the failure is recorded.

## Slash Commands

Register commands with:

```bash
npm run register-commands
```

Command groups currently include:

- `/resolve`: Mark the current question thread resolved.
- `/unresolve`: Remove resolved state from the current question thread.
- `/anime`:
  - `search`, `post`, `find`, `index`
  - `cast`
  - `season current`, `season next`
  - `review`, `reviews`
  - `my`, `profile`
- `/intro`:
  - DM status/test/enqueue/process commands.
  - Guild member/profile backfill commands.
  - Intro reaction setup/list/clear/backfill commands.
- `/welcome`:
  - Welcome reaction setup/list/clear/backfill commands.
- `/maintenance`:
  - `status`, `llm-status`, `hashtag-route-status`
  - question tag backfill
  - VC profile resync
  - entrance guide post/update
  - config/restart/portal helpers
- `/guide-post`: Post an arbitrary guide message.
- `/profile`: Placeholder profile command.

Some commands are intended for administrators or operators. Check the command handlers before exposing operational commands broadly.

## Anime Provider Notes

Otaku Assistant uses Annict for Japanese anime metadata and AniList as a read-only image fallback.

Important behavior:

- Annict is used for metadata lookup/search.
- AniList is used only to fill image gaps such as icon/banner fallback.
- The bot does not write Annict records/statuses/activities/reviews.
- The bot does not write AniList data.
- Discord user reviews are stored locally in SQLite.

Anime cards are designed around a dedicated anime channel. Normal user relay cards are blocked from being posted directly into the anime parent-card channel.

## Timeline and Hashtag Routing

Personal/tweet forum thread messages can be relayed to the timeline.

Route tags can be placed in messages:

```text
##技術
Useful tool link here
```

Users can also route an existing message after the fact:

```text
User A:
自動ウェイト
https://example.com/tool

User B replies:
##技術
##tool
```

The bot routes User A's original message, not User B's route-tag reply.

If a user adds route tags by editing a message, only new missing destinations are created.

Use `@silent` to suppress relay:

```text
@silent
今日のメモ...
```

The control token is not displayed in relayed cards.

## Spoiler Attachments

The relay layer detects Discord spoiler attachments through `attachment.spoiler` and `SPOILER_` filenames.

When re-uploading files, the bot keeps or adds the `SPOILER_` prefix. If a spoiler image cannot be safely re-uploaded, the bot avoids turning it into a visible raw CDN MediaGallery preview and logs the fallback.

Discord's spoiler rendering behavior can vary by component type and client version, so test spoiler relay in your own server before relying on it for sensitive content.

## Database

The SQLite database is created at:

```text
data/otaku-assistant.db
```

Migrations run automatically on startup and during `npm run check` against a temporary database.

The database stores Discord IDs, message IDs, relay records, intro profiles, anime entries/reviews/statuses, DM send states, reaction setup state, and optional LLM memories.

Back up the database before deployment updates:

```bash
cp data/otaku-assistant.db data/otaku-assistant.db.bak
```

Do not commit `data/*.db`; the repository `.gitignore` excludes local DB files.

## Deployment with systemd

Example service:

```ini
[Unit]
Description=Otaku Assistant Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/otaku-assistant
EnvironmentFile=/path/to/otaku-assistant/.env
ExecStart=/usr/bin/node --max-old-space-size=256 src/index.js
Restart=always
RestartSec=5
User=otaku-assistant
Group=otaku-assistant

[Install]
WantedBy=multi-user.target
```

Install and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable otaku-assistant
sudo systemctl start otaku-assistant
journalctl -u otaku-assistant -f
```

## Updating

Suggested update flow:

```bash
cd /path/to/otaku-assistant
git pull
npm ci --omit=dev
npm run check
npm run register-commands
sudo systemctl restart otaku-assistant
journalctl -u otaku-assistant -f
```

Only run `npm run register-commands` when command definitions changed or after initial setup.

## Safety and Privacy

- Do not commit `.env`, `config.json`, SQLite DB files, or logs.
- Server admins should disclose bot behavior to their community if needed.
- The bot stores Discord IDs, message IDs, intro profiles, anime reviews, DM send states, and relay records in SQLite.
- Welcome DMs and no-intro reminder DMs can be disabled in `config.json`.
- LLM features are optional/advanced. If enabled, local message content may be sent to your configured Ollama endpoint.
- Annict/AniList integrations are read-only in this bot.

## Troubleshooting

- `DISCORD_TOKEN is missing in .env`: Create `.env` from `.env.example` and fill required values.
- `config.json not found`: Copy `config.example.json` to `config.json`.
- Slash commands do not appear: Run `npm run register-commands` with correct `CLIENT_ID`, `GUILD_ID`, and token.
- Bot cannot read message content: Enable Message Content Intent in the Discord Developer Portal.
- Bot cannot DM a user: User DMs may be closed. The bot records failed DM state and logs it.
- Bot cannot delete/update messages: Check channel permissions, especially Manage Messages and Read Message History.
- Bot cannot create/update threads: Check thread permissions and forum/channel access.
- Anime search cannot find a title: Annict provider coverage or naming may be limited. Add local aliases in code only when needed.
- Anime images are missing: AniList fallback may not have a matching image.
- Spoiler media appears visible: Discord component/client behavior may vary. Check logs for spoiler relay fallback.
- VC card keeps stale users: Ensure GuildVoiceStates intent is enabled; periodic reconciliation should also correct stale cards.
- VC status text does not show: discord.js/API support may not expose the status field in your runtime. Check `vc profile status text resolved` logs.
- Native modules fail during install: `better-sqlite3` may require a working Node build toolchain on some platforms.

## Development

Useful commands:

```bash
npm run check
git diff --check
npm run register-commands
npm start
```

`npm run check` syntax-checks JavaScript files, creates a temporary SQLite DB to verify migrations, validates command option counts, and validates anime quote role config.

Logs are structured JSON-style records through the local logger, which makes `journalctl -u otaku-assistant -f` practical in production.

When changing behavior, keep these invariants in mind:

- Avoid relay loops.
- Do not route bot messages.
- Do not post normal relay cards into the anime parent-card channel.
- Keep Annict and AniList read-only.
- Preserve spoiler attachment behavior where Discord supports it.
- Avoid repeated DM sends by using SQLite state.
