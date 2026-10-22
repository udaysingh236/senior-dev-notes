#!/usr/bin/env bash
# Starts the demo backends and nginx with nginx.conf, sends a few requests, then stops both.
set -euo pipefail
cd "$(dirname "$0")"
NGINX_BIN="${NGINX_BIN:-nginx}"
WORK="$(mktemp -d)"

python3 ../python/front_door.py --backends >/dev/null &
BACKENDS=$!
trap '"$NGINX_BIN" -p "$WORK" -c "$PWD/nginx.conf" -e "$WORK/error.log" -s stop 2>/dev/null || true; sleep 0.3; kill $BACKENDS; rm -rf "$WORK"' EXIT
sleep 1
"$NGINX_BIN" -p "$WORK" -c "$PWD/nginx.conf" -e "$WORK/error.log"
sleep 0.5

req() { PATH_="$1"; shift; printf '  GET %-12s ' "$PATH_"; curl -s -o /tmp/body.$$ -w '%{http_code}  ' "$@" "http://127.0.0.1:8080$PATH_"; cat /tmp/body.$$; echo; }

echo "no key:"
req /orders/1
echo "asha, 4 requests in a row (limit 3 at once):"
for i in 0 1 2 3; do req "/orders/$i" -H 'X-Api-Key: key-asha' -H 'X-Forwarded-For: 6.6.6.6'; done
echo "ravi:"
req /users/ravi -H 'X-Api-Key: key-ravi'
req /admin -H 'X-Api-Key: key-ravi'
rm -f /tmp/body.$$
