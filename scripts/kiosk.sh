#!/bin/zsh
# One command to run Paper-to-App unattended at a table nobody is standing at:
# build once, keep the Mac awake, restart the server if it ever dies, open the kiosk page.
set -u
cd "${0:a:h}/.."

PORT="${PORT:-8787}"
URL="http://localhost:${PORT}/?kiosk=1"

echo "[kiosk] building the app…"
pnpm build || exit 1

# The server needs a moment to bind before the browser asks for the page.
( sleep 3; open "$URL" ) &

echo "[kiosk] serving $URL"
echo "[kiosk] the Mac will stay awake while this runs. Press Control-C to stop."

# caffeinate -dimsu: no display sleep, no idle sleep, no disk sleep, stay awake even on battery.
# The until-loop brings the server back if it crashes, so an overnight fair booth survives it.
exec caffeinate -dimsu zsh -c '
  until NODE_ENV=production pnpm exec tsx --env-file=.env server/index.ts; do
    echo "[kiosk] server stopped unexpectedly — restarting in 2s"
    sleep 2
  done
'
