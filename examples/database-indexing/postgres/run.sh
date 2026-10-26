#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster on port 5499, builds the data, runs every measurement
# quoted on the Database Indexing page, and stops the cluster. Takes about 3 minutes.
# Needs initdb, pg_ctl and psql (PostgreSQL 16 or later). Run as a normal user, not root.
# Usage: ./run.sh [data directory]   (default: a new temporary directory)
set -euo pipefail
cd "$(dirname "$0")"
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}
DIR=${1:-$(mktemp -d)}
PORT=5499

"$PG_BIN/initdb" -D "$DIR/data" -A trust -U postgres > /dev/null
"$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
  -o "-p $PORT -k $DIR -c shared_buffers=128MB -c max_wal_size=4GB" start > /dev/null
trap '"$PG_BIN/pg_ctl" -D "$DIR/data" -m fast stop > /dev/null' EXIT

CONN="-h $DIR -p $PORT -U postgres"
psql $CONN -X -q -v ON_ERROR_STOP=1 -c 'select version()' -t
psql $CONN -X -q -v ON_ERROR_STOP=1 -f setup.sql > /dev/null
psql $CONN -X -q -v ON_ERROR_STOP=1 -f experiments.sql
echo '== 9. Write cost: insert 500,000 rows into a 1,000,000-row table'
./write_cost.sh "$CONN"
