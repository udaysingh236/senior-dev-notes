#!/usr/bin/env bash
# Runs the queue from queue.sql against a local Postgres and shows three things:
# workers never claim the same job, a late ack is refused, and dead letters move out.
# Usage: PGDATABASE=queue_demo ./demo.sh   (connection from the usual PG* variables)
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")"
run() { psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

run -f queue.sql >/dev/null
run -c "DROP TABLE IF EXISTS claimed; CREATE TABLE claimed (worker int, job_id bigint)"
run -c "INSERT INTO jobs (body) SELECT jsonb_build_object('order_id', 1000 + g) FROM generate_series(1, 200) g"

# The claim statement from queue.sql, written out so each worker can record what it got.
claim="WITH c AS (
  UPDATE jobs SET visible_at = now() + interval '30 seconds', receives = receives + 1
   WHERE id = (SELECT id FROM jobs WHERE visible_at <= now() AND receives < 5
                ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING id, receives)"

echo "1. Four workers claim 200 jobs at the same time"
for w in 1 2 3 4; do
  (for i in $(seq 1 50); do run -c "$claim INSERT INTO claimed SELECT $w, id FROM c"; done) &
done
wait
run -c "SELECT '   claims: ' || count(*) || ', different jobs: ' || count(DISTINCT job_id)
               || ', claimed twice: ' || (count(*) - count(DISTINCT job_id)) FROM claimed"

echo "2. A lease runs out and a late ack is refused"
run -c "TRUNCATE jobs RESTART IDENTITY; INSERT INTO jobs (body) VALUES ('{\"order_id\": 1042}')"
# Worker A took the job (receive number 1) and its 30 s lease is over: pretend 31 s passed.
run -c "UPDATE jobs SET receives = 1, visible_at = now() - interval '1 second'"
run -c "$claim SELECT '   worker B claims job ' || id || ', receive number ' || receives FROM c"
run -c "WITH d AS (DELETE FROM jobs WHERE id = 1 AND receives = 1 RETURNING 1)
        SELECT '   worker A acks with receive number 1: rows deleted ' || count(*) FROM d"
run -c "WITH d AS (DELETE FROM jobs WHERE id = 1 AND receives = 2 RETURNING 1)
        SELECT '   worker B acks with receive number 2: rows deleted ' || count(*) FROM d"

echo "3. A job that used up 5 receives moves to dead_jobs"
run -c "INSERT INTO jobs (body, receives, visible_at) VALUES ('{\"order_id\": \"10x42\"}', 5, now())"
run -c "WITH moved AS (DELETE FROM jobs WHERE receives >= 5 AND visible_at <= now() RETURNING *)
        INSERT INTO dead_jobs SELECT * FROM moved"
run -c "SELECT '   jobs left: ' || (SELECT count(*) FROM jobs) || ', dead jobs: '
               || (SELECT count(*) FROM dead_jobs) || ' (order ' || (SELECT body->>'order_id' FROM dead_jobs) || ')'"
run -c "DROP TABLE claimed"
