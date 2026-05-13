# Otaku Assistant

Otaku Assistant is a Discord bot for a Japanese creator community. Version 1 focuses on relaying selected forum posts to a timeline channel and handling question resolution inside forum threads.

Credits: the timeline card direction is inspired by Gnu Assistant.

## Features

- Relay question thread starters, tweet-thread messages, and knowledge-thread starters from configured forum channels to the timeline channel
- Sync edited tweet-thread messages back to the existing timeline card
- Route tweet-thread posts with bot-specific `##` hashtags to additional channels
- Build timeline cards with pure Discord Components V2 using `MessageFlags.IsComponentsV2`
- Post the official entrance guide as editable Components V2 cards with channel move buttons
- Match the existing "Gnu Assistant" style with compact Components V2 cards, original text, jump link, and first image or video
- Generate a thumbnail preview for video attachments when `ffmpeg` is available, with graceful fallback to download-only when it is not
- Re-upload previewable attachments such as audio, video, and PDF files up to a safe size limit so Discord can show native file UI when possible
- Mirror Discord reply relationships into relayed timeline copies when the referenced source message was already relayed
- Prevent duplicate relays by storing processed thread IDs and tweet message IDs in SQLite
- Support `/resolve` and `/unresolve` inside watched question forum threads
- Toggle question status forum tags between `受付中` and `解決済み`
- Keep future extension points ready for unanswered-question reminders and profile registration, while supporting category-based VC profile cards
- Support Discord-side operational maintenance with `/maintenance status`, `/maintenance portal`, and `/maintenance restart`

## Requirements

- Node.js 20 or newer recommended
- Discord bot token and guild application
- `ffmpeg` optional for video thumbnail generation
- `ODESLI_API_KEY` optional for Songlink / Odesli universal music links

## Project Structure

```text
otaku-assistant/
  package.json
  .env.example
  config.example.json
  README.md
  scripts/
    check.js
  src/
    index.js
    client.js
    registerCommands.js
    config/
      loadConfig.js
    commands/
      index.js
      resolve.js
      unresolve.js
      profile.js
    events/
      ready.js
      threadCreate.js
      messageCreate.js
      messageUpdate.js
      interactionCreate.js
      voiceStateUpdate.js
    modules/
      timelineRelay/
        index.js
        buildTimelineMessage.js
        extractFirstPost.js
      questionResolver/
        index.js
        resolveThread.js
      questionWatcher/
        index.js
      vcProfile/
        buildProfileMessage.js
        findLatestIntroMessage.js
        index.js
    services/
      discordLinks.js
      logger.js
    db/
      database.js
      migrations.js
    utils/
      text.js
      permissions.js
```

## Discord Developer Portal Setup

1. Open the Discord Developer Portal and create a new application named `Otaku Assistant`.
2. In `Bot`, create a bot user and copy the token into `.env` as `DISCORD_TOKEN`.
3. In `OAuth2 > General`, copy the `Application ID` into `.env` as `CLIENT_ID`.
4. Enable these Privileged Gateway Intents in `Bot`:
   - `MESSAGE CONTENT INTENT`
   - `SERVER MEMBERS INTENT` is not required for v1
5. Under `OAuth2 > URL Generator`, select scopes:
   - `bot`
   - `applications.commands`
6. Select bot permissions:
   - `View Channels`
   - `Send Messages`
   - `Attach Files`
   - `Read Message History`
   - `Manage Threads`
   - `Use Slash Commands`
7. Open the generated invite URL, choose your server, and authorize the bot.

## Required Bot Permissions

- `View Channels`
- `Send Messages`
- `Attach Files`
- `Read Message History`
- `Manage Threads`
- `Use Slash Commands`

## Local Setup

1. Move into the project directory:
   ```bash
   cd otaku-assistant
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create `.env` from the example:
   ```bash
   cp .env.example .env
   ```
4. Create `config.json` from the example:
   ```bash
   cp config.example.json config.json
   ```
5. Fill in `.env` with:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID`
   - `ODESLI_API_KEY` optional
6. Fill in `config.json` with your actual channel IDs and role IDs.
7. Tweet forum relay works from `messageCreate` inside watched tweet threads, while question and knowledge starter relay works from `threadCreate`.
8. Register slash commands:
   ```bash
   npm run register-commands
   ```
9. Start the bot locally:
   ```bash
   npm run dev
   ```

Optional for better video previews:

```bash
brew install ffmpeg
```

If `ffmpeg` is missing, the bot falls back to the `添付動画をダウンロード` button without crashing.
Previewable attachment re-upload uses `mediaRelay.maxReuploadBytes` from `config.json` and defaults to about 25 MB per file; larger files fall back to filename display and download buttons.

## How To Get Channel IDs

1. In Discord, open `User Settings > Advanced` and enable `Developer Mode`.
2. Right-click each target channel and choose `Copy Channel ID`.
3. Paste IDs into `config.json`:
   - `entranceChannelId`: `案内 / Entrance`
   - `timelineChannelId`: `👀・タイムライン`
   - `introChannelId`: `👤・自己紹介`
   - `watchedForums.question`: each `❓・質問場所` forum channel ID
   - `watchedForums.tweet`: each `💬・つぶやき` forum channel ID
   - `watchedForums.knowledge`: each `知りたいこと` forum channel ID
   - `questionForumTags`: `受付中` / `解決済み` tag IDs for each watched question forum
   - `botHashtagRoutes`: bot-specific `##` hashtags and their relay destination channels
4. For VC profile display, copy only the profile text channel IDs into `voiceProfileChannels`. The bot resolves the parent category automatically on startup.
5. `/resolve` and `/unresolve` currently allow only the original question author or a user with Administrator permission. `moderatorRoleIds` is reserved for future use.

Example:

```json
{
  "entranceChannelId": "123456789012345678",
  "timelineChannelId": "123456789012345678",
  "introChannelId": "234567890123456789",
  "welcomeChannelId": "345678901234567890",
  "welcomeReactionsMax": 5,
  "watchedForums": {
    "question": ["345678901234567890"],
    "tweet": ["456789012345678901"],
    "knowledge": ["567890123456789012"]
  },
  "voiceProfileChannels": [
    {
      "name": "通話1",
      "profileChannelId": "678901234567890123"
    }
  ],
  "timeline": {
    "maxContentLength": 800,
    "includeFirstImage": true,
    "ignoreBotPosts": true
  },
  "voiceProfile": {
    "ignoreBots": true
  },
  "mediaRelay": {
    "maxReuploadBytes": 25000000,
    "tempDir": "./tmp/relay-media"
  },
  "questions": {
    "resolvedPrefix": "[解決済]",
    "allowResolveBy": ["threadOwner", "administrator"],
    "moderatorRoleIds": ["789012345678901234"]
  },
  "questionForumTags": {
    "345678901234567890": {
      "resolved": "890123456789012345",
      "open": "901234567890123456"
    }
  },
  "botHashtagRoutes": {
    "いい映像": {
      "aliases": ["いい映像", "良い映像"],
      "display": "#良い映像",
      "channelId": "012345678901234567"
    }
  }
}
```

## Commands

- `/resolve` - mark the current watched question thread as resolved
- `/unresolve` - remove the resolved mark from the current watched question thread
- `/guide-post` - post arbitrary plain text to the current channel or another chosen text channel (Administrator only)
- `/maintenance backfill-question-tags` - backfill `受付中` / `解決済み` tags for existing question threads (Administrator only)
- `/maintenance post-entrance-guide` - post or update the official Components V2 entrance guide (Administrator only)
- `/maintenance resync-vc-profiles` - rebuild current VC profile cards (Administrator only)
- `/maintenance reload-config` - explains that a restart is required for config reload (Administrator only)
- `/maintenance status` - show a safe operational summary (Administrator only)
- `/maintenance portal` - show the Discord Developer Portal link ephemerally (Administrator only)
- `/maintenance restart` - acknowledge, log, and exit cleanly for systemd/pm2 restart (Administrator only)
- `/maintenance setup-welcome-reactions` - post a setup message in the current channel and save up to 5 welcome reactions by reacting to it (Administrator only)
- `/maintenance list-welcome-reactions` - show saved welcome reactions (Administrator only)
- `/maintenance clear-welcome-reactions` - remove all saved welcome reactions (Administrator only)
- `/maintenance backfill-welcome-reactions [limit]` - apply saved welcome reactions to recent Discord join notifications in the welcome channel (Administrator only)
- `/maintenance llm-status` - show local Ollama LLM status, active request count, and archive counts (Administrator only)

## Local Run Commands

- `npm run dev` - start with `nodemon`
- `npm run start` - start with `node`
- `npm run register-commands` - register guild slash commands
- `npm run check` - syntax check all project JavaScript files
- `npm run backfill-question-tags` - apply `受付中` / `解決済み` tags to existing question threads
- `npm run post-entrance-guide` - post or update the official Components V2 entrance guide from `content/entranceGuide.md`

## Local LLM (Ollama)

Otaku Assistant can answer when mentioned by using a local Ollama model only.

Required `.env` values:

- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default: `qwen3:4b`)

Recommended models:

- `qwen3:4b`
- `gemma3:4b`

Example local setup:

```bash
ollama pull qwen3:4b
ollama serve
```

Then mention the bot in Discord:

```text
@Otaku Assistant この流れを要約して
```

The bot archives guild messages into SQLite, posts `少女祈祷中...`, calls Ollama, and edits that temporary reply with the final answer.

You can also pass a different guide source file:

```bash
npm run post-entrance-guide -- path/to/final-guide.md
```

## Production deployment on VPS

### 推奨: `systemd`

本番 VPS では `systemd` を標準運用として推奨します。Linux 標準で、起動時自動実行、異常終了後の再起動、ログ確認が単純です。`pm2` は代替として使えます。

### 必須環境変数

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`

`.env` はコミットしないでください。

### 初回セットアップ

```bash
cd /opt/otaku-assistant
npm ci
cp config.example.json config.json
# .env を作成して DISCORD_TOKEN / CLIENT_ID / GUILD_ID を設定
npm run check
npm run register-commands
```

詳細手順は `docs/deploy-vps.md` を参照してください。

### `systemd` サービス

サンプルユニットファイルは `deploy/otaku-assistant.service` にあります。VPS に合わせて `WorkingDirectory`、`EnvironmentFile`、`User` を修正してから以下へ配置してください。

- `/etc/systemd/system/otaku-assistant.service`

起動:

```bash
sudo systemctl daemon-reload
sudo systemctl enable otaku-assistant
sudo systemctl start otaku-assistant
sudo systemctl status otaku-assistant
journalctl -u otaku-assistant -f
```

### 代替: `pm2`

```bash
npm install -g pm2
pm2 start src/index.js --name otaku-assistant
pm2 save
pm2 startup
pm2 logs otaku-assistant
```

## GitHub update workflow

初回は `rsync` で VPS に配置し、その後は private repository を VPS に clone して `git pull` で更新する運用を想定しています。

更新手順:

```bash
cd /opt/otaku-assistant
git pull
npm ci --omit=dev
npm run check
sudo systemctl restart otaku-assistant
sudo systemctl status otaku-assistant --no-pager
```

補助スクリプト:

```bash
bash scripts/vps-update.sh
```

### Discord からの運用

- `/maintenance status`
- `/maintenance portal`
- `/maintenance restart`

`/maintenance restart` は Bot が自分で新しいプロセスを起動しません。現在のプロセスを正常終了し、`systemd` または `pm2` に再起動させます。

### 運用ログ

`config.json` の `ops.logChannelId` を設定すると、以下を Discord の運用ログチャンネルへ通知します。

- 起動完了
- シャットダウン
- 再起動要求
- `unhandledRejection`
- `uncaughtException`

## Testing Checklist

- Bot comes online and logs `Bot ready`
- Creating a new thread in a watched `💬・つぶやき` forum relays to `👀・タイムライン`
- Creating a new thread in a watched `❓・質問場所` forum relays to `👀・タイムライン`
- Creating a new thread in a watched `知りたいこと` forum relays once to `👀・タイムライン`
- Timeline relay renders as a Components V2 card, not an embed
- Tweet posts containing configured bot hashtags such as `##いい映像` relay to the timeline and the configured destination channel
- Exact bot hashtag lines are removed from the reposted body and shown separately as normalized tags such as `#良い映像`
- `##良い音楽` / `##いい音楽` posts with supported music URLs resolve a Songlink / Odesli universal link and add an `音楽リンクを開く` button when lookup succeeds
- Odesli lookup prefers `userCountry=JP`, then retries without country, then `userCountry=US`, and keeps the response with the richest available service links
- Running `/resolve` inside a watched question thread renames it with `[解決済]`
- Running `/unresolve` removes the `[解決済]` prefix
- Creating a new watched question thread applies the `受付中` forum tag
- Running `/resolve` switches the forum tag to `解決済み`
- Running `/unresolve` switches the forum tag back to `受付中`
- Posting multiple messages inside an existing watched `💬・つぶやき` thread relays each message once
- Editing an already relayed tweet message updates the existing timeline card instead of posting a duplicate
- Restarting the bot does not cause the same question or tweet message to relay again
- New questions post a short public guide message inside the question thread after the timeline relay succeeds
- The official entrance guide is stored in `content/entranceGuide.md` and posted as Components V2 cards with `チャンネルに移動` buttons
- `/guide-post` stays a plain text admin utility and defaults to the current channel, while the official entrance guide uses Components V2
- Each active voice channel keeps one live profile card in the profile text channel
- Moving within the same voice category updates the affected room cards
- Moving from `通話1` to `通話2` updates/deletes the old room card and updates/creates the new room card
- Empty voice rooms delete their live profile card

## Notes For Future Features

- `src/modules/questionWatcher/` contains the placeholder entry for unanswered-question reminders
- VC profile mapping now derives the category from each configured profile text channel's parent, so adding new voice channels inside that category does not require `config.json` changes
- VC profile display is grouped by voice room, not by user
- Discord does not support ephemeral messages from `threadCreate` events; question guidance is posted publicly inside the question thread instead
- No DM guide is sent
