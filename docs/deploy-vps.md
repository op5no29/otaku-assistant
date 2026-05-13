# Otaku Assistant VPS deployment

## First deploy by `rsync`

Local machine:

```bash
cd /Users/shionshimada/otaku-assistant
rsync -av --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'config.json' \
  ./ user@your-vps:/opt/otaku-assistant/
```

VPS:

```bash
cd /opt/otaku-assistant
npm ci --omit=dev
cp .env.example .env
cp config.example.json config.json
# .env と config.json を本番値で編集
npm run check
npm run register-commands
sudo cp deploy/otaku-assistant.service /etc/systemd/system/otaku-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable otaku-assistant
sudo systemctl start otaku-assistant
sudo systemctl status otaku-assistant --no-pager
```

## Future deploy by `git pull`

```bash
cd /opt/otaku-assistant
git pull
npm ci --omit=dev
npm run check
sudo systemctl restart otaku-assistant
sudo systemctl status otaku-assistant --no-pager
```

## Logs

```bash
journalctl -u otaku-assistant -f
journalctl -u otaku-assistant -n 100 --no-pager
```

## Notes

- `.env` and `config.json` stay on the VPS and are not tracked by Git.
- `systemd` is the default production process manager.
- `/maintenance restart` assumes `systemd` or another process manager will restart the bot.
