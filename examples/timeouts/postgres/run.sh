#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster and shows what happens to a query when its client gives up:
# killed, cancelled, or bounded by the server's own timeouts. Takes about 40 seconds.
# Needs initdb, pg_ctl and psql (PostgreSQL 16 or later). Run as a normal user, not root.
# Usage: ./run.sh [work directory]   (default: a new temporary directory)
set -euo pipefail
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}
export PATH="$PG_BIN:$PATH"
DIR=${1:-$(mktemp -d)}
PORT=5497

initdb -D "$DIR/data" -A trust -U postgres > /dev/null
pg_ctl -D "$DIR/data" -l "$DIR/postgres.log" -w -o "-p $PORT -k $DIR -c listen_addresses=''" start > /dev/null
trap 'pg_ctl -D "$DIR/data" -m fast stop > /dev/null' EXIT
PSQL="psql -h $DIR -p $PORT -U postgres -X -q -At postgres"
$PSQL -c 'select version()'

# Runs a query and kills its client process after 1 s, as a client-side timeout that drops the
# connection would.
kill_client_after_1s() {
  $PSQL -c "$1" &
  local pid=$!
  sleep 1
  kill -9 "$pid"
  wait "$pid" 2> /dev/null || true
}

# Is a query tagged "slow-query" still running? Prints its state, or "gone".
running() {
  $PSQL -c "select coalesce((select state || ' for ' || round(extract(epoch from now() - query_start)::numeric, 1) || ' s'
            from pg_stat_activity where query like '%slow-query%' and pid <> pg_backend_pid()), 'gone')"
}
SLOW="select pg_sleep(8) /* slow-query */"

echo
echo '== 1. The client process dies 1 s into an 8 s query (what a client-side timeout that closes the socket looks like)'
kill_client_after_1s "$SLOW"
sleep 1; echo "   at 2 s, the query is: $(running)"
sleep 7; echo "   at 9 s, the query is: $(running)"

echo
echo '== 2. The same, with client_connection_check_interval = 500ms (PostgreSQL 14+)'
kill_client_after_1s "set client_connection_check_interval = '500ms'; $SLOW"
sleep 1; echo "   at 2 s, the query is: $(running)"

echo
echo '== 3. The client sends a cancel request after 1 s (psql does this on Ctrl-C)'
timeout -s INT 1 $PSQL -c "$SLOW" 2>&1 | sed 's/^/   psql: /' || true
sleep 0.5; echo "   0.5 s later, the query is: $(running)"

echo
echo '== 4. statement_timeout = 1s: the server stops the query itself'
start=$(date +%s.%N)
$PSQL -c "set statement_timeout = '1s'; $SLOW" 2>&1 | sed 's/^/   /' || true
printf '   returned after %.1f s\n' "$(echo "$(date +%s.%N) - $start" | bc)"

echo
echo '== 5. lock_timeout = 500ms: waiting for a row lock someone else holds'
$PSQL -c 'create table accounts (id int primary key, balance int); insert into accounts values (1, 100)'
$PSQL -c "begin; update accounts set balance = balance - 10 where id = 1; select pg_sleep(5); commit" &
holder=$!
sleep 0.5
start=$(date +%s.%N)
$PSQL -c "set lock_timeout = '500ms'; update accounts set balance = balance + 10 where id = 1" 2>&1 | sed 's/^/   /' || true
printf '   returned after %.1f s\n' "$(echo "$(date +%s.%N) - $start" | bc)"
wait $holder
