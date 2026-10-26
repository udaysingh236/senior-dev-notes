#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster (and PgBouncer, if installed), runs every measurement
# quoted on the Connection Pooling page, and stops both. Takes about 9 minutes.
# Needs initdb, pg_ctl, psql and pgbench (PostgreSQL 16 or later), openssl and python3.
# PgBouncer 1.21 or later for the pooler sections. Run as a normal user, not root.
# Usage: ./run.sh [work directory]   (default: a new temporary directory)
set -euo pipefail
cd "$(dirname "$0")"
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}
export PATH="$PG_BIN:$PATH"
DIR=${1:-$(mktemp -d)}
PORT=5498
mkdir -p "$DIR/logs"

initdb -D "$DIR/data" -A trust -U postgres > /dev/null
openssl req -new -x509 -days 30 -nodes -subj "/CN=localhost" \
  -keyout "$DIR/data/server.key" -out "$DIR/data/server.crt" 2> /dev/null
chmod 600 "$DIR/data/server.key"
# Unix socket and the postgres role: trust. The app role over TCP: SCRAM, as in production.
cat > "$DIR/data/pg_hba.conf" <<EOF
local all all trust
host  all app 127.0.0.1/32 scram-sha-256
host  all all 127.0.0.1/32 trust
EOF
pg_ctl -D "$DIR/data" -l "$DIR/postgres.log" -w -o "-p $PORT -k $DIR -c listen_addresses=localhost \
  -c max_connections=1200 -c shared_buffers=256MB -c ssl=on" start > /dev/null
PIDS_TO_STOP=()
cleanup() {
  for pid in "${PIDS_TO_STOP[@]}"; do kill "$pid" 2> /dev/null || true; done
  pg_ctl -D "$DIR/data" -m fast stop > /dev/null
}
trap cleanup EXIT

SOCK="-h $DIR -p $PORT -U postgres postgres"
psql $SOCK -X -At -c 'select version()'
echo "cores: $(nproc)"
psql $SOCK -X -q -c "create role app login password 'secret'"
pgbench -i -q -s 10 $SOCK > /dev/null 2>&1
echo 'select 1;' > "$DIR/one.sql"
echo 'select sum(i) from generate_series(1, 20000) i;' > "$DIR/cpu.sql"
printf 'select count(*) from pg_class;\n\\sleep 20 s\n' > "$DIR/idle.sql"

echo
echo '== 1. What one connection costs: "select 1", one client, 8 s, mean latency of 3 runs'
cost() {
  local label=$1; shift
  local sum=0
  for _ in 1 2 3; do
    ms=$(pgbench -n -T 8 -c 1 -f "$DIR/one.sql" "$@" 2>&1 | awk '/latency average/ {print $4}')
    sum=$(python3 -c "print($sum + $ms)")
  done
  printf '%-48s %8.3f ms\n' "$label" "$(python3 -c "print($sum / 3)")"
}
export PGPASSWORD=secret
PGSSLMODE=disable cost "reused connection (Unix socket)" $SOCK
PGSSLMODE=require cost "reused connection (TCP, TLS, SCRAM)" -h 127.0.0.1 -p $PORT -U app postgres
PGSSLMODE=disable cost "new connection per query: Unix socket, trust" -C $SOCK
PGSSLMODE=disable cost "new connection per query: TCP, trust" -C -h 127.0.0.1 -p $PORT -U postgres postgres
PGSSLMODE=disable cost "new connection per query: TCP, SCRAM" -C -h 127.0.0.1 -p $PORT -U app postgres
PGSSLMODE=require cost "new connection per query: TCP, TLS, SCRAM" -C -h 127.0.0.1 -p $PORT -U app postgres
unset PGPASSWORD

echo
echo '== 2. Memory of 500 idle connections (each ran one catalogue query first)'
pgbench -n -c 500 -j 4 -t 1 -f "$DIR/idle.sql" $SOCK > /dev/null 2>&1 &
PIDS_TO_STOP+=($!)
sleep 12
python3 - "$(pgrep -d, -f 'postgres: postgres postgres' || true)" <<'EOF'
import sys
pids = [p for p in sys.argv[1].split(",") if p]
def field(pid, name):
    for line in open(f"/proc/{pid}/smaps_rollup"):
        if line.startswith(name + ":"):
            return int(line.split()[1])
    return 0
pss = [field(p, "Pss") for p in pids]
rss = [field(p, "Rss") for p in pids]
print(f"backends: {len(pids)}, private memory (PSS) {sum(pss) / 1024:.0f} MB in total, "
      f"{sum(pss) / len(pids) / 1024:.2f} MB each; RSS {sum(rss) / len(pids) / 1024:.1f} MB each "
      f"(RSS counts shared memory once per process)")
EOF
wait

echo
echo '== 3. More connections than cores (pgbench client runs on the same machine)'
python3 sweep.py "3a. CPU-bound query, about 2 ms of CPU each" "1 2 4 8 16 32 64 128 256 512" "$DIR/logs" \
  -f "$DIR/cpu.sql" $SOCK
python3 sweep.py "3b. pgbench tpcb-like, scale 10: 7 statements, 3 updates, 10 branch rows" \
  "1 2 4 8 16 32 64 128 256 512" "$DIR/logs" -b tpcb-like $SOCK

PGBOUNCER=$(command -v pgbouncer || echo /usr/sbin/pgbouncer)
if [ ! -x "$PGBOUNCER" ]; then
  echo; echo 'pgbouncer not found: skipping sections 4 and 5'; exit 0
fi
cat > "$DIR/pgbouncer.ini" <<EOF
[databases]
postgres = host=$DIR port=$PORT dbname=postgres
shared1 = host=$DIR port=$PORT dbname=postgres pool_size=1
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
unix_socket_dir =
auth_type = trust
auth_file = $DIR/userlist.txt
pool_mode = transaction
default_pool_size = 8
max_client_conn = 2000
max_prepared_statements = MAXPREP
logfile = $DIR/pgbouncer.log
pidfile = $DIR/pgbouncer.pid
EOF
echo '"postgres" ""' > "$DIR/userlist.txt"
start_bouncer() {
  [ -f "$DIR/pgbouncer.pid" ] && kill "$(cat "$DIR/pgbouncer.pid")" 2> /dev/null && sleep 1
  sed "s/MAXPREP/$1/" "$DIR/pgbouncer.ini" > "$DIR/pgbouncer-run.ini"
  (ulimit -n 10000; "$PGBOUNCER" -d "$DIR/pgbouncer-run.ini")
  sleep 1
  PIDS_TO_STOP+=("$(cat "$DIR/pgbouncer.pid")")
}
BOUNCE="-h 127.0.0.1 -p 6432 -U postgres"
start_bouncer 100
echo
echo "== 4. The same workloads through $("$PGBOUNCER" --version | head -1), transaction mode, 8 server connections"
python3 sweep.py "4a. CPU-bound query through PgBouncer" "8 64 512" "$DIR/logs" -f "$DIR/cpu.sql" $BOUNCE postgres
python3 sweep.py "4b. tpcb-like through PgBouncer" "8 64 512" "$DIR/logs" -b tpcb-like $BOUNCE postgres

echo
echo '== 5. Transaction mode and session state (pool of 1 server connection, so every client shares it)'
psql $BOUNCE -X -At shared1 -c "set statement_timeout = 50" \
  -c "select 'client A: backend ' || pg_backend_pid() || ', statement_timeout ' || current_setting('statement_timeout')"
psql $BOUNCE -X -At shared1 \
  -c "select 'client B: backend ' || pg_backend_pid() || ', statement_timeout ' || current_setting('statement_timeout')" \
  -c "select pg_sleep(0.1)" 2>&1 | sed '/^ERROR/s/^/client B: /' || true
psql $BOUNCE -X -At shared1 -c "select pg_advisory_lock(42)" > /dev/null
psql $BOUNCE -X -At shared1 -c "select 'after client C disconnected, advisory lock 42 is still held by backend ' || pid from pg_locks where locktype = 'advisory'"

echo
echo '== 6. Protocol-level prepared statements in transaction mode (pgbench -M prepared, 16 clients, 5 s)'
for maxprep in 0 100; do
  start_bouncer $maxprep
  result=$(pgbench -n -T 5 -c 16 -j 4 -M prepared -b select-only $BOUNCE postgres 2>&1 \
    | grep -m1 -oE 'prepared statement "[^"]+" (does not exist|already exists)|tps = [0-9]+' || true)
  echo "max_prepared_statements = $maxprep: $result"
done
