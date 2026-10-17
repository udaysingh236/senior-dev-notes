#!/usr/bin/env bash
# Where did the time go? curl can report the moment each step finished.
# Run:  bash curl/timing.sh [url]   (default: https://example.com/)
#
# Every number is "seconds since curl started", so each step's own cost is the difference
# from the line above it.
set -euo pipefail
url="${1:-https://example.com/}"

curl --silent --output /dev/null --write-out '
      DNS done:  %{time_namelookup} s
 TCP connected:  %{time_connect} s
  TLS finished:  %{time_appconnect} s
  request sent:  %{time_pretransfer} s
    first byte:  %{time_starttransfer} s
         total:  %{time_total} s
  HTTP version:  %{http_version}, status %{http_code}, from %{remote_ip}
' "$url"
