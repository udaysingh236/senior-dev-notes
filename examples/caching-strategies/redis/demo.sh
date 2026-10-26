#!/bin/sh
# Replays the reader/writer race against a real Redis with the versioned script.
# Needs redis-server and redis-cli on PATH. Starts a throwaway server on port 6390.
set -e
redis-server --port 6390 --save '' --daemonize yes > /dev/null
sleep 0.3
cli() { redis-cli -p 6390 "$@"; }
cli DEL product:42 > /dev/null
echo "default eviction policy: $(cli CONFIG GET maxmemory-policy | tail -1)"
echo "reader fills v1 after a miss:            $(cli --eval versioned_set.lua product:42 , 1 value price=90 60000)"
echo "writer commits v2, writes marker v2:     $(cli --eval versioned_set.lua product:42 , 2 marker '' 60000)"
echo "slow reader fills the v1 it read before: $(cli --eval versioned_set.lua product:42 , 1 value price=90 60000)"
echo "next reader misses, fills v2:            $(cli --eval versioned_set.lua product:42 , 2 value price=95 60000)"
echo "cache now: $(cli HGET product:42 version) $(cli HGET product:42 kind) $(cli HGET product:42 payload)"
cli SHUTDOWN NOSAVE > /dev/null 2>&1 || true
