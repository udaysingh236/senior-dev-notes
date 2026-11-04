# N+1 queries: runnable examples

The code behind the snippets and numbers on the
[N+1 Queries](https://seniordevnotes.netlify.app/databases/n-plus-one-queries/) page.

| File | What it shows |
|---|---|
| `python/n_plus_one.py` / `js/n-plus-one.mjs` | One endpoint, "a page of orders with each order's customer and items", written three ways: a naive loop (1 + 2N queries), batched with `IN` (3 queries, chunked at 500 keys), and per-order resolvers sharing a per-request loader (3 queries). Then the regression test: run the endpoint with 10 and 100 orders and fail if the query count grows |
| `postgres/run.sh` | Starts a throwaway PostgreSQL on port 5499 with 100,000 orders, runs every measurement quoted on the page, then stops it |
| `postgres/gen_scripts.py` | Writes the pgbench scripts: N+1, N+1 pipelined, batched with `IN`, one JOIN, one query with `json_agg`, and the two-collection JOIN |
| `postgres/delay_proxy.py` | A TCP proxy that adds a network round trip and counts the bytes the database sends |
| `postgres/expected-output.txt` | Our run, the source of the numbers on the page |

## Run

```bash
python3 python/n_plus_one.py
node js/n-plus-one.mjs
cd postgres && ./run.sh       # about 6 minutes; run as a normal user, not root
```

The examples need Python 3.11+ or Node 22.13+ and nothing else. SQLite in memory stands in for
the database, and every query waits 1 ms first, the round trip to a database in another
availability zone. The query counts are exact and the same in both languages; timings vary with
how precisely your machine sleeps. Node 22 prints an `ExperimentalWarning` for `node:sqlite`;
`node --no-warnings js/n-plus-one.mjs` hides it.

The Postgres run needs `initdb`, `pg_ctl`, `psql` and `pgbench` from PostgreSQL 16 or later (set
`PG_BIN` if they are not on your `PATH`) and `python3`. pgbench cannot read a column of one result
into a loop, so the scripts compute the ids the page query returns (order `i` belongs to customer
`(i × 7919) mod 10000 + 1`); the SQL the server receives is what an ORM sends. `-M extended` sends
every statement with bind parameters, unprepared, as many drivers do by default. The proxy adds
about 0.6 ms per round trip of its own on our machine, so `run.sh` asks it for less; section 0 of
the output shows what each network really measured. pgbench runs on the same machine as the
database, so throughput includes its CPU use.

Tested on 2026-10-29 with Python 3.13, Node 22.22 and PostgreSQL 16.15 on Linux, 4 vCPUs.
