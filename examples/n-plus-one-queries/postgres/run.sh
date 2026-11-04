#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster, loads 100,000 orders, and runs every measurement quoted
# on the N+1 Queries page: one "list orders" request loaded five ways, at three network round-trip
# times, then throughput, page size, the two-collection JOIN and the LIMIT-on-a-JOIN trap.
# Takes about 6 minutes. Needs initdb, pg_ctl, psql and pgbench (PostgreSQL 16 or later) and
# python3. Run as a normal user, not root.
# Usage: ./run.sh [work directory]   (default: a new temporary directory)
set -euo pipefail
cd "$(dirname "$0")"
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}
export PATH="$PG_BIN:$PATH"
DIR=${1:-$(mktemp -d)}
PORT=5499
SECS=${SECS:-8}

initdb -D "$DIR/data" -A trust -U postgres > /dev/null
pg_ctl -D "$DIR/data" -l "$DIR/postgres.log" -w -o "-p $PORT -k $DIR -c listen_addresses=localhost \
  -c shared_buffers=256MB" start > /dev/null
PIDS_TO_STOP=()
cleanup() {
  for pid in "${PIDS_TO_STOP[@]}"; do kill "$pid" 2> /dev/null || true; done
  pg_ctl -D "$DIR/data" -m fast stop > /dev/null
}
trap cleanup EXIT

SOCK="-h $DIR -p $PORT -U postgres postgres"
psql $SOCK -X -At -c 'select version()'
echo "cores: $(nproc)"
psql $SOCK -X -q <<'SQL'
CREATE TABLE customers (id int PRIMARY KEY, name text, email text, country text);
CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL REFERENCES customers,
                     status text, total_cents int, created_at timestamptz);
CREATE TABLE order_items (id serial PRIMARY KEY, order_id int NOT NULL REFERENCES orders,
                          sku text, qty int, price_cents int);
CREATE TABLE payments (id serial PRIMARY KEY, order_id int NOT NULL REFERENCES orders,
                       method text, amount_cents int);
INSERT INTO customers SELECT g, 'customer ' || g, 'c' || g || '@example.com', 'IN' FROM generate_series(1, 10000) g;
INSERT INTO orders SELECT g, (g * 7919) % 10000 + 1, 'paid', 1000 + g % 9000, now() - g * interval '1 minute'
  FROM generate_series(1, 100000) g;
INSERT INTO order_items (order_id, sku, qty, price_cents)
  SELECT o, 'SKU-' || (o * 31 + k) % 5000, 1 + k % 3, 199 + (o + k) % 800
  FROM generate_series(1, 100000) o, generate_series(1, 5) k;
INSERT INTO payments (order_id, method, amount_cents)
  SELECT o, (ARRAY['card', 'upi', 'wallet'])[k], 300 + o % 700
  FROM generate_series(1, 100000) o, generate_series(1, 3) k;
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON payments (order_id);
VACUUM ANALYZE;
SQL

mkdir -p "$DIR/scripts"
for n in 10 50 200; do python3 gen_scripts.py "$DIR/scripts" $n; done

# Proxies for a round trip of about 1 ms and 5 ms; "direct" is plain TCP over loopback. The proxy
# itself adds about 0.6 ms per round trip on our machine, so it is asked for less; section 0
# prints what each network really measures on yours.
python3 delay_proxy.py 6501 127.0.0.1 $PORT 0.4 > "$DIR/proxy1.log" & PIDS_TO_STOP+=($!)
python3 delay_proxy.py 6505 127.0.0.1 $PORT 3.9 > "$DIR/proxy5.log" & PIDS_TO_STOP+=($!)
sleep 1
net_args() {
  case $1 in
    direct) echo "-h 127.0.0.1 -p $PORT -U postgres postgres" ;;
    1ms) echo "-h 127.0.0.1 -p 6501 -U postgres postgres" ;;
    5ms) echo "-h 127.0.0.1 -p 6505 -U postgres postgres" ;;
  esac
}
proxy_log() { case $1 in 1ms) echo "$DIR/proxy1.log" ;; 5ms) echo "$DIR/proxy5.log" ;; *) echo "" ;; esac; }

# run SCRIPT NET CLIENTS: prints "latency_ms tps transactions"
run() {
  local out
  out=$(pgbench -n -M extended -T "$SECS" -c "$3" -j "$3" -f "$1" $(net_args "$2") 2>&1)
  echo "$out" | awk '/latency average/ {lat=$4} /^tps/ {tps=$3} /actually processed/ {tx=$NF; sub("/.*", "", tx)} END {print lat, tps, tx}'
}
statements() { grep -c '^SELECT' "$1"; }

echo 'select 1;' > "$DIR/one.sql"
echo
echo '== 0. One "select 1", one client: what each network adds per round trip'
for net in direct 1ms 5ms; do
  read -r lat _ _ < <(run "$DIR/one.sql" $net 1)
  printf '%-8s %8.3f ms per query\n' "$net" "$lat"
done

echo
echo '== 1. One request for a page of 50 orders with customer and items, one client'
printf '%-12s %8s %12s %12s %12s %16s\n' strategy queries "direct" "1 ms RTT" "5 ms RTT" "bytes from db"
for s in n_plus_one pipelined batched joined json_agg; do
  f="$DIR/scripts/${s}_50.sql"
  row=$(printf '%-12s %8s' $s "$(statements "$f")")
  bytes=""
  for net in direct 1ms 5ms; do
    log=$(proxy_log $net)
    read -r lat _ tx < <(run "$f" $net 1)
    row+=$(printf ' %9.2f ms' "$lat")
    if [ "$net" = 1ms ]; then
      sleep 0.3
      down=$(tail -1 "$log" | awk '{print $6}')
      bytes=$((down / tx))
    fi
  done
  printf '%s %16s\n' "$row" "$bytes"
done

echo
echo '== 2. Throughput: 8 clients over the Unix socket (no network delay), page of 50'
for s in n_plus_one batched json_agg; do
  out=$(pgbench -n -M extended -T "$SECS" -c 8 -j 4 -f "$DIR/scripts/${s}_50.sql" $SOCK 2>&1)
  printf '%-12s %10s requests/s\n' $s "$(echo "$out" | awk '/^tps/ {printf "%.0f", $3}')"
done

echo
echo '== 3. Page size at 1 ms RTT, one client'
for n in 10 50 200; do
  read -r a _ _ < <(run "$DIR/scripts/n_plus_one_${n}.sql" 1ms 1)
  read -r b _ _ < <(run "$DIR/scripts/batched_${n}.sql" 1ms 1)
  printf 'N = %-4s n_plus_one %4s queries %9.2f ms   batched 3 queries %7.2f ms\n' $n $((2 * n + 1)) "$a" "$b"
done

echo
echo '== 4. Two collections (5 items and 3 payments per order), page of 50, 1 ms RTT'
for s in two_joined two_batched; do
  read -r lat _ tx < <(run "$DIR/scripts/${s}_50.sql" 1ms 1)
  sleep 0.3
  down=$(tail -1 "$DIR/proxy1.log" | awk '{print $6}')
  printf '%-12s %9.2f ms %10s bytes from db\n' $s "$lat" $((down / tx))
done
psql $SOCK -X -At <<'SQL'
SELECT 'rows returned by one JOIN of items and payments: ' || count(*)
  FROM (SELECT * FROM orders WHERE id >= 1000 ORDER BY id LIMIT 50) o
  LEFT JOIN order_items i ON i.order_id = o.id LEFT JOIN payments p ON p.order_id = o.id;
SELECT 'rows returned by the batched queries: ' || (50 + (SELECT count(*) FROM order_items WHERE order_id BETWEEN 1000 AND 1049)
  + (SELECT count(*) FROM payments WHERE order_id BETWEEN 1000 AND 1049));
SQL

echo
echo '== 5. LIMIT on a JOIN limits rows, not orders'
psql $SOCK -X -At <<'SQL'
SELECT 'orders on the "page" when LIMIT 50 is applied to orders JOIN order_items: ' || count(DISTINCT o.id)
  FROM (SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id ORDER BY o.id LIMIT 50) o;
SQL

echo
echo '== 6. Is it the planning? The N+1 page of 50 with prepared statements (-M prepared), one client'
for net in direct 1ms; do
  out=$(pgbench -n -M prepared -T "$SECS" -c 1 -f "$DIR/scripts/n_plus_one_50.sql" $(net_args $net) 2>&1)
  printf '%-8s %9s ms\n' $net "$(echo "$out" | awk '/latency average/ {print $4}')"
done
