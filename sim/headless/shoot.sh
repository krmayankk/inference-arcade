#!/usr/bin/env bash
# Headless renders of the game with a bot playing. Captures the WebGL canvas itself (toDataURL)
# because headless Chrome's --screenshot composites a canvas driven outside requestAnimationFrame
# unreliably (blank panels in some frames even though the canvas has them).
#   sim/headless/shoot.sh out-dir            -> out-dir/tw-{l1,l3x,phone}.png
set -euo pipefail
OUT="${1:-/tmp/tokenworks-shots}"; mkdir -p "$OUT"
cd "$(dirname "$0")/../.."
python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
CH="${CHROME:-google-chrome}"
grab() { # name query window-size
  timeout 200 "$CH" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --window-size="$3" \
    --virtual-time-budget=13000 --dump-dom "http://127.0.0.1:8765/game/?bot=1&trace=1&grab=11000&$2" 2>/dev/null \
    | grep -o 'id="grab">data:image/png;base64,[^<]*' | sed 's/.*base64,//' | base64 -d > "$OUT/tw-$1.png" || true
}
grab l1 "lvl=0&shoot=1" 1400,900 &
grab l3x "lvl=2&x=1" 1400,900 &
grab phone "lvl=2" 420,860 &
wait
ls -la "$OUT"
