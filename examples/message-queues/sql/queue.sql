-- A job queue in one Postgres table: leases, acks and a dead-letter table.
-- Used by demo.sh. Tested with PostgreSQL 16.

DROP TABLE IF EXISTS jobs, dead_jobs;

CREATE TABLE jobs (
  id         bigserial   PRIMARY KEY,
  body       jsonb       NOT NULL,
  visible_at timestamptz NOT NULL DEFAULT now(), -- hidden from workers until this time
  receives   int         NOT NULL DEFAULT 0,     -- how many times a worker took it
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_visible ON jobs (visible_at);
CREATE TABLE dead_jobs (LIKE jobs);

-- Claim: take the oldest visible job and hide it for 30 s (its lease).
-- SKIP LOCKED: if another worker is claiming a row right now, skip it instead of waiting.
PREPARE claim AS
  UPDATE jobs
     SET visible_at = now() + interval '30 seconds',
         receives   = receives + 1
   WHERE id = (SELECT id FROM jobs
                WHERE visible_at <= now() AND receives < 5
                ORDER BY id
                LIMIT 1
                FOR UPDATE SKIP LOCKED)
  RETURNING id, body, receives;

-- Ack: delete it, but only if we still hold the lease we were given.
-- `receives` works as a fencing number: after a redelivery it has gone up, so a late
-- ack from the first worker matches no row and cannot delete the second worker's job.
PREPARE ack(bigint, int) AS
  DELETE FROM jobs WHERE id = $1 AND receives = $2;

-- Dead letters: jobs that used up 5 receives and whose last lease ran out.
PREPARE move_dead AS
  WITH moved AS (DELETE FROM jobs
                  WHERE receives >= 5 AND visible_at <= now()
                  RETURNING *)
  INSERT INTO dead_jobs SELECT * FROM moved;
