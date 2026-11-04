#!/usr/bin/env bash
# What each extra index costs on writes: insert 500,000 rows into a 1,000,000-row copy of orders
# with the primary key only, then with 1, 3 and 6 secondary indexes. Prints time and WAL written.
# Needs the orders table from setup.sql. Usage: ./write_cost.sh "psql connection args"
set -euo pipefail
PSQL="psql $1 -X -q -t -A -v ON_ERROR_STOP=1"

indexes_for() {
  case $1 in
    0) ;;
    1) echo "create index on w (customer_id);" ;;
    3) echo "create index on w (customer_id); create index on w (created_at); create index on w (country, created_at);" ;;
    6) echo "create index on w (customer_id); create index on w (created_at); create index on w (country, created_at);
             create index on w (status); create index on w (amount_cents); create index on w (customer_id, created_at);" ;;
  esac
}

for k in 0 1 3 6; do
  $PSQL <<SQL
drop table if exists w;
create table w (like orders including identity);
alter table w add primary key (id);
insert into w (customer_id, status, country, created_at, amount_cents, note)
  select customer_id, status, country, created_at, amount_cents, note from orders where id <= 1000000;
$(indexes_for $k)
checkpoint;
SQL
  case $k in 0) label="primary key only" ;; 1) label="+ 1 secondary index" ;; *) label="+ $k secondary indexes" ;; esac
  $PSQL -v k_label="$label" <<'SQL' | grep -v '^$'
set synchronous_commit = off;
select pg_current_wal_lsn() as lsn, clock_timestamp() as t0 \gset
insert into w (customer_id, status, country, created_at, amount_cents, note)
  select (random() * 499999)::int + 1, status, country, created_at + interval '400 days',
         (random() * 100000)::int, note
  from orders where id between 1000001 and 1500000;
select format('%-24s %6s s  %s WAL', :'k_label', round(extract(epoch from clock_timestamp() - :'t0'::timestamptz)::numeric, 2),
              pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn')));
SQL
done
$PSQL -c "drop table w"
