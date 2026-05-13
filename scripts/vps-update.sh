#!/usr/bin/env bash
set -euo pipefail

cd /opt/otaku-assistant
git pull
npm ci --omit=dev
npm run check
systemctl restart otaku-assistant
systemctl status otaku-assistant --no-pager
