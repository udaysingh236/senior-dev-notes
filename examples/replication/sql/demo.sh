#!/usr/bin/env bash
# A real PostgreSQL leader and follower on one laptop, and five things the replication page claims:
#   1. the follower lags: some reads right after a commit miss the new row (asynchronous)
#   2. with synchronous_commit = remote_apply, no read misses, and each commit waits for the follower
#   3. a slow follower makes every synchronous commit as slow as itself
#   4. a synchronous commit with no follower to answer waits forever (here: until we cancel it after 2 s)
#   5. asynchronous replication + leader crash + failover = committed rows lost
# Needs the PostgreSQL 16+ server binaries (initdb, pg_ctl, pg_basebackup) on PATH and the
# dblink extension (postgresql-contrib). Run as a normal (non-root) user. Uses ports 5501 and 5502
# and a scratch folder it deletes at the start and at the end.
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
DIR="${TMPDIR:-/tmp}/replication-demo"
L=5501; F=5502
q() { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$DIR" -d postgres "$@"; }

cleanup() {
  pg_ctl -D "$DIR/leader" -m immediate stop >/dev/null 2>&1 || true
  pg_ctl -D "$DIR/follower" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
cleanup; trap cleanup EXIT
mkdir -p "$DIR"

# --- Set up: one leader, one follower copied from it -------------------------------------------
initdb -D "$DIR/leader" -U postgres -A trust >/dev/null
cat >> "$DIR/leader/postgresql.conf" <<CONF
port = $L
unix_socket_directories = '$DIR'
listen_addresses = ''
wal_level = replica
CONF
pg_ctl -D "$DIR/leader" -l "$DIR/leader.log" -w start >/dev/null
q -p $L -c "CREATE EXTENSION dblink; CREATE TABLE orders (id bigint PRIMARY KEY, address text)"

# pg_basebackup copies the leader's files and writes the settings that make the copy follow it.
pg_basebackup -h "$DIR" -p $L -U postgres -D "$DIR/follower" -R -X stream \
  -d "application_name=follower1"
echo "port = $F" >> "$DIR/follower/postgresql.conf"
pg_ctl -D "$DIR/follower" -l "$DIR/follower.log" -w start >/dev/null
sleep 1

# One experiment: insert N rows on the leader, and after each commit read it from the follower.
# Both connections are made with dblink from inside the follower, so no time is lost between the
# commit returning and the read starting. Prints: misses, average commit time in ms.
race() {
  local n=$1 start=$2
  q -p $F -c "
    SELECT dblink_connect('lead', 'host=$DIR port=$L dbname=postgres');
    SELECT dblink_connect('foll', 'host=$DIR port=$F dbname=postgres');
    DO \$\$
    DECLARE misses int := 0; seen bool; t0 timestamptz; total interval := '0';
    BEGIN
      FOR i IN $start..$start + $n - 1 LOOP
        t0 := clock_timestamp();
        PERFORM dblink_exec('lead', format('INSERT INTO orders VALUES (%s, ''new address'')', i));
        total := total + (clock_timestamp() - t0);
        SELECT e INTO seen FROM dblink('foll', format('SELECT EXISTS (SELECT 1 FROM orders WHERE id = %s)', i)) AS r(e bool);
        IF NOT seen THEN misses := misses + 1; END IF;
      END LOOP;
      RAISE WARNING '%|%', misses, round(extract(epoch FROM total) * 1000 / $n, 2);
    END \$\$;" 2>&1 | grep -o '[0-9.]*|[0-9.]*' 
}

echo "1. Asynchronous (the default): 1000 commits on the leader, each read at once on the follower"
r=$(race 1000 1)
echo "   reads that missed the row just committed: ${r%|*} of 1000, average commit ${r#*|} ms"
q -p $L -c "SELECT '   follower state: ' || state || ', sync_state: ' || sync_state FROM pg_stat_replication"

echo "2. Synchronous, remote_apply: each commit waits until the follower has applied it"
q -p $L -c "ALTER SYSTEM SET synchronous_standby_names = 'follower1'" \
        -c "ALTER SYSTEM SET synchronous_commit = 'remote_apply'" -c "SELECT pg_reload_conf()" >/dev/null
sleep 1
q -p $L -c "SELECT '   follower sync_state: ' || sync_state FROM pg_stat_replication"
r=$(race 1000 10001)
echo "   reads that missed: ${r%|*} of 1000, average commit ${r#*|} ms"

echo "3. Same, but the follower applies every change 200 ms late (a stand-in for a slow or far follower)"
q -p $F -c "ALTER SYSTEM SET recovery_min_apply_delay = '200ms'" -c "SELECT pg_reload_conf()" >/dev/null
sleep 1
r=$(race 20 20001)
echo "   reads that missed: ${r%|*} of 20, average commit ${r#*|} ms"
q -p $F -c "ALTER SYSTEM RESET recovery_min_apply_delay" -c "SELECT pg_reload_conf()" >/dev/null

echo "4. Synchronous, and the follower is stopped: a commit has nobody to wait for"
pg_ctl -D "$DIR/follower" -m fast -w stop >/dev/null
q -p $L -c "INSERT INTO orders VALUES (30001, 'stuck?')" > "$DIR/stuck.out" 2>&1 &
sleep 2
echo "   after 2 s the commit is still waiting: $(q -p $L -c "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'SyncRep'") session in wait event SyncRep"
q -p $L -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE wait_event = 'SyncRep'" >/dev/null
wait || true
out=$(cat "$DIR/stuck.out")
echo "   we cancel the wait. PostgreSQL says:"
echo "$out" | sed 's/^/     /'
q -p $L -c "SELECT '   but the row is on the leader anyway: ' || count(*) FROM orders WHERE id = 30001"

echo "5. Asynchronous again; the follower is cut off, the leader commits 500 orders and crashes"
q -p $L -c "ALTER SYSTEM RESET synchronous_standby_names" -c "ALTER SYSTEM RESET synchronous_commit" \
        -c "SELECT pg_reload_conf()" >/dev/null
pg_ctl -D "$DIR/follower" -l "$DIR/follower.log" -w start >/dev/null
sleep 1
before=$(q -p $F -c "SELECT count(*) FROM orders")
# Point the follower at a port where nobody listens: it keeps serving reads but receives nothing.
q -p $F -c "ALTER SYSTEM SET primary_conninfo = 'host=$DIR port=5999 user=postgres'" -c "SELECT pg_reload_conf()" >/dev/null
sleep 1
q -p $L -c "INSERT INTO orders SELECT g, 'placed during the cut' FROM generate_series(40001, 40500) g"
echo "   leader says committed: $(q -p $L -c "SELECT count(*) FROM orders") rows"
pg_ctl -D "$DIR/leader" -m immediate stop >/dev/null   # the crash: no clean shutdown
pg_ctl -D "$DIR/follower" -w promote >/dev/null           # failover: the follower becomes the leader
after=$(q -p $F -c "SELECT count(*) FROM orders")
echo "   new leader (the promoted follower) has: $after rows (it had $before before the cut)"
echo "   committed orders the new leader never received: $(q -p $F -c "SELECT 500 - count(*) FROM orders WHERE id BETWEEN 40001 AND 40500")"
