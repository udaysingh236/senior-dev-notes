# Connection pooling: runnable examples

The code behind the snippets and numbers on the
[Connection Pooling](https://seniordevnotes.netlify.app/databases/connection-pooling/) page.

| File | What it shows |
|---|---|
| `python/pool.py` / `js/pool.mjs` | A bounded pool with an acquire timeout, rollback on release and a jittered maximum lifetime, then three experiments: a new connection per request against a pool, a slow call made inside versus after the transaction, and two requests deadlocking on nested acquires until the timeout breaks it |
| `postgres/run.sh` | Starts a throwaway PostgreSQL (and PgBouncer, if installed) on ports 5498 and 6432, runs every measurement quoted on the page, then stops both |
| `postgres/sweep.py` | Runs one pgbench workload at a series of client counts and prints throughput, p50 and p99 from pgbench's per-transaction log |
| `postgres/expected-output.txt` | Our run, the source of the numbers on the page |

## Run

```bash
python3 python/pool.py
node js/pool.mjs
cd postgres && ./run.sh       # about 9 minutes; run as a normal user, not root
```

The pool examples need Python 3.11+ or Node 20+ and nothing else: the database is a stand-in whose
`connect()` takes 10 ms and whose queries take 1 ms, so the output is about the pool, not about a
server. Both print the same results apart from timings.

The Postgres run needs `initdb`, `pg_ctl`, `psql` and `pgbench` from PostgreSQL 16 or later (set
`PG_BIN` if they are not on your `PATH`), plus `openssl` and `python3`. Sections 4 to 6 need
PgBouncer 1.21 or later and are skipped without it. pgbench runs on the same machine as the
database, so throughput numbers include its CPU use; the shape of the results matters more than
the exact figures.

Tested on 2026-10-26 with Python 3.13, Node 22.22, PostgreSQL 16.15 and PgBouncer 1.22.0 on Linux,
4 vCPUs.
