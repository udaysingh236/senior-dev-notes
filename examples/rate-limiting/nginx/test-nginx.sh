#!/usr/bin/env bash
# Starts nginx with nginx.conf from this folder, sends a burst of 20 requests, waits one
# second, sends 5 more, and prints the status codes. Needs nginx and curl on the PATH
# (or set NGINX_BIN=/path/to/nginx). Not NGINX: nginx itself reads that name.
set -euo pipefail
cd "$(dirname "$0")"
NGINX_BIN="${NGINX_BIN:-nginx}"
mkdir -p logs

"$NGINX_BIN" -p "$PWD" -c "$PWD/nginx.conf" -t 2>&1 | tail -1
"$NGINX_BIN" -p "$PWD" -c "$PWD/nginx.conf"
trap '"$NGINX_BIN" -p "$PWD" -c "$PWD/nginx.conf" -s stop' EXIT
sleep 0.5

# Sends N requests in parallel, so they arrive together, and counts the status codes.
burst() {
  local urls=()
  for _ in $(seq "$1"); do urls+=(-o /dev/null http://127.0.0.1:8088/api/products); done
  curl -s --parallel --parallel-max "$1" -w '%{http_code}\n' "${urls[@]}" |
    sort | uniq -c | sed 's/^ */  /'
}

echo "burst of 20:"
burst 20
sleep 1
echo "one second later, 5 more:"
burst 5
echo "nginx logged:"
grep -m1 "limiting requests" logs/error.log | sed 's/.*\(limiting requests.*zone "api"\).*/  \1/'
