# Research: Connection pooling

Slug: `databases/connection-pooling` · single topic · researched 2026-10-26.
Page fetches were blocked from the container (DNS for most hosts fails), so web facts were checked
through search results that quote the sources. Library defaults were checked in the source code of
the packages themselves (downloaded with pip, npm and apt). Every number about PostgreSQL and
PgBouncer behaviour comes from our own runs (`examples/connection-pooling/postgres`, PostgreSQL
16.15, PgBouncer 1.22.0, 4 vCPUs, pgbench on the same machine). Every source is 2020 or later, or
living documentation checked in October 2026.

## Angle

Explainers say "opening a connection is expensive, so reuse them; use PgBouncer" and stop. What they
skip, and what this page is about:

- a pool has two jobs that pull against each other: keep connections **open** (setup costs 2–10 ms
  against a 0.05 ms query) and keep their number **small** (past about 2× cores, more active
  connections means less throughput and far worse tail latency, measured);
- the capacity of a pool is set by how long each request **holds** a connection, not by query time
  (Little's law; HTTP calls inside transactions);
- the waiting has to go somewhere: in the pool's queue (cheap, bounded by an acquire timeout) or
  inside the database (expensive, lock and CPU contention);
- the connection budget multiplies: pods × pool size, and doubles during a rolling deploy;
- transaction pooling (PgBouncer, RDS Proxy) changes what a "session" means: SET, advisory locks,
  prepared statements leak or break (measured);
- pool deadlock from nested acquires; acquire timeouts and client deadlines interacting with a
  pooler (Inngest, October 2026).

Neighbouring pages own: Little's law and queueing (`latency-vs-throughput`, linked, not re-taught),
TCP and TLS handshakes in general (`tcp-vs-udp`, `tls`), timeouts in general (`timeouts`),
query cost (`database-indexing`, `query-optimization`).

## Our measurements (PostgreSQL 16.15, reference run in `expected-output.txt`)

- Cost of a connection, `select 1`, one client, mean of 3 × 8 s runs:
  reused, Unix socket 0.040 ms; reused, TCP + TLS + SCRAM 0.054 ms;
  new per query: Unix socket trust 2.26 ms, TCP trust 2.35 ms, TCP SCRAM 6.68 ms,
  TCP + TLS + SCRAM 9.52 ms (prototype runs: 2.4 / 2.5 / 8.0 / 11.7 ms). Localhost: no network
  round-trip time included. pgbench `-C` includes client-side SCRAM work (PBKDF2, 4096 iterations
  by default) as well as the server's.
- Memory: 500 idle backends that ran one catalogue query: PSS 1.29 MB each (646 MB total), RSS
  18.4 MB each (shared memory counted per process). Matches Freund's "below 2 MiB with huge pages".
- More connections than cores, CPU-bound `sum(generate_series(1, 20000))`, ≈2 ms CPU:
  tps 516 (1), 1,753 (4), 1,966 (8), 2,026 (32), 1,826 (512); p99 3.3 ms (1), 9.7 ms (8),
  83 ms (64), 624 ms (512). Throughput flat from 8; latency grows linearly with connections.
- pgbench tpcb-like scale 10 (10 branch rows, 3 updates per transaction): peak at 8 connections
  (6,598 tps in the reference run, 7,581 in the prototype), 4,802 at 64, 4,118 at 128, and down to
  about a third of the peak at 512; p99 3.6 ms at 8 → 74 ms at 64 → 1.7 s at 512 (prototype).
- Through PgBouncer 1.22, transaction mode, `default_pool_size = 8`: see reference run section 4.
  Prototype: tpcb-like 3,925 tps at 8 clients (below direct: each of the 7 statements is an extra
  hop through a single-threaded process sharing the same 4 cores), 3,543 tps at 512 clients with
  p99 190 ms (direct: 2,459 tps, p99 1,711 ms). CPU-bound: 2,095 tps at 512, p99 323 ms (direct
  1,683, p99 634 ms).
- Transaction mode, pool of 1: client A's `SET statement_timeout = 50` is seen by client B, whose
  `pg_sleep(0.1)` is cancelled. `pg_advisory_lock(42)` stays held by the server process after the
  client that took it disconnects.
- Protocol-level prepared statements (`pgbench -M prepared`) through transaction mode:
  `max_prepared_statements = 0` → `prepared statement "P_0" already exists` / `does not exist`;
  `= 100` → works, about the same tps as simple protocol.

## Library defaults (read from source, October 2026)

- node-postgres `pg-pool` 3.14.0: `max` 10, `idleTimeoutMillis` 10,000, `connectionTimeoutMillis`
  unset = wait forever, `maxLifetimeSeconds` 0 (off), `maxUses` Infinity.
- `psycopg_pool` 3.3.3: `min_size` 4, `max_size` = min_size, `timeout` 30 s, `max_waiting` 0
  (unbounded), `max_lifetime` 3600 s with −5% jitter, `max_idle` 600 s.
- SQLAlchemy 2.1.6 `QueuePool`: `pool_size` 5, `max_overflow` 10, `timeout` 30 s.
- PgBouncer 1.22 man page: `pool_mode` session, `default_pool_size` 20, `max_client_conn` 100,
  `query_wait_timeout` 120 s, `server_lifetime` 3600 s, `server_idle_timeout` 600 s,
  `server_reset_query` DISCARD ALL (not used in transaction mode), `idle_transaction_timeout` off,
  `max_prepared_statements` 0 in 1.22; 200 by default since 1.24 (January 2025).
- HikariCP README (living): `maximumPoolSize` 10, `connectionTimeout` 30 s, `maxLifetime` 30 min,
  set several seconds shorter than any infrastructure connection limit.
- Go `database/sql` (go.dev docs): `MaxOpenConns` unlimited by default, 2 idle connections kept.
- Prisma ORM v6 docs: default `connection_limit` = physical CPUs × 2 + 1, `pool_timeout` 10 s;
  v7 with the `pg` adapter: 10 connections, no acquire timeout.
- PostgreSQL: `max_connections` 100, `superuser_reserved_connections` 3, `reserved_connections` 0
  (added in 16), checked with SHOW on 16.15.

## Key facts and sources

- Postgres uses one OS process per connection; snapshot computation (`GetSnapshotData`) was the
  main scalability limit with many connections; idle connections cut throughput (1 active
  connection: 33,457 tps alone vs 14,496 with 10,000 idle). Fixed in PostgreSQL 14. Memory per
  connection below 2 MiB with huge pages.
  https://www.citusdata.com/blog/2020/10/08/analyzing-connection-scalability/ (2020),
  https://blog.anarazel.de/2020/10/07/measuring-the-memory-overhead-of-a-postgres-connection/ (2020)
- AWS: idle connections consume memory and CPU; throughput drop with 1,000 idle connections.
  https://aws.amazon.com/blogs/database/resources-consumed-by-idle-postgresql-connections/ (2021,
  reviewed 2023), https://aws.amazon.com/blogs/database/performance-impact-of-idle-postgresql-connections/
- PgBouncer: pool modes, prepared statement tracking since 1.21 (2023), default 200 since 1.24
  (2025-01), latest 1.25.2 (May 2026), single-threaded; `so_reuseport` to use more cores.
  https://www.pgbouncer.org/config.html, https://www.pgbouncer.org/changelog.html,
  https://www.crunchydata.com/blog/prepared-statements-in-transaction-mode-for-pgbouncer (2023)
- RDS Proxy: multiplexing after each transaction; pinning when it cannot tell reuse is safe; for
  PostgreSQL a SET pins the session; `DatabaseConnectionsCurrentlySessionPinned`.
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html (living)
- Supavisor: 1 million client connections funnelled to 400 Postgres connections on a 64-vCPU
  database. https://supabase.com/blog/supavisor-1-million (2023)
- Figma: PgBouncer added early for connection growth; later replaced by PGKeeper because of a
  vertical scaling ceiling and no way to prioritise traffic.
  https://www.figma.com/blog/how-figma-scaled-to-multiple-databases/ (2024),
  https://www.figma.com/blog/pgkeeper-building-the-bouncer-we-needed-for-postgres/ (2026)
- PostgreSQL 17 `sslnegotiation=direct` skips the SSLRequest round trip.
  PostgreSQL 17 release notes (2024).
- Vercel Fluid compute: `attachDatabasePool` releases idle connections before an instance is
  suspended. https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute (living)
- Django 5.1 (2024): native psycopg pool via `OPTIONS["pool"]`.

## Incidents

- Inngest, 2026-09-18: an account deletion held locks on the primary; blocked queries held client
  slots; PgBouncer client connections went from 427 to 6,066; both PgBouncers rejected new
  connections 16:18–16:42 UTC; restarting did not help because the blocking transactions were
  still running. https://www.inngest.com/blog/2026-09-18-incident-report-for-september-18-2026
- Inngest, 2026-10-10: short client deadlines expired while queries were queued in PgBouncer; the
  driver cancelled and closed the client connection; PgBouncer later ran the abandoned query and
  then closed the server connection instead of returning it; poolers open replacements one at a
  time, so usable connections fell to almost zero (14:00–14:48 and 15:30–16:25 UTC).
  https://www.inngest.com/blog/2026-10-15-incident-report-for-october-9-and-10-2026
- GitLab 2025-03-11: a pipeline worker held transactions open up to 600 s, saturating PgBouncer
  connections (incident issue 19464). Not used on the page: an issue tracker entry, little detail.

## Misconceptions

- "Bigger pool = more throughput." Measured: past ~2× cores, less.
- "Idle connections are free." ~1.3 MB each plus snapshot cost (much reduced since PG 14) and
  `max_connections` slots.
- "The pool waits for a connection, so it can't fail." node-postgres waits forever by default.
- "PgBouncer makes Postgres faster." It makes many clients share few connections; at low
  concurrency it adds a hop per statement (measured).
- "Transaction pooling is transparent." SET, advisory locks, LISTEN, temp tables, SQL PREPARE.

## How explainers structure it

- Typical blog: "connections are expensive → reuse → HikariCP formula → PgBouncer modes table".
  Leaves out: measured costs, hold time vs query time, the budget across pods, what breaks in
  transaction mode, the failure modes (deadlock, timeouts, incidents).
- Vendor docs (Prisma, Supabase): sizing formula + "use our pooler for serverless". Leaves out why.
