# Database indexing: runnable examples

The code behind the snippets and numbers on the
[Database Indexing](https://seniordevnotes.netlify.app/databases/database-indexing/) page.

| File | What it shows |
|---|---|
| `python/plan_guard.py` / `js/plan-guard.mjs` | SQLite's plan for "latest 20 orders of a customer" as the index improves: full scan and sort, index plus sort, composite index, covering index. Then a test helper that fails when a plan scans, catching a predicate that wraps the column in a function |
| `python/pages_touched.py` / `js/pages-touched.mjs` | The share of table pages a query touches when its rows are spread at random, and the selectivity at which an uncorrelated index scan stops beating a full scan |
| `postgres/run.sh` | Starts a throwaway PostgreSQL on port 5499, builds a 5,000,000-row table, runs every measurement quoted on the page, then stops it |
| `postgres/setup.sql`, `experiments.sql`, `write_cost.sh` | The data, the measurements (point lookup, selectivity sweep, composite column order, covering index and the visibility map, predicates that cannot use an index) and the write cost of extra indexes |
| `postgres/expected-output.txt` | Our run, the source of the numbers on the page |

## Run

```bash
python python/plan_guard.py
python python/pages_touched.py
node js/plan-guard.mjs        # Node 22.5+; node:sqlite prints an "experimental" warning
node js/pages-touched.mjs
cd postgres && ./run.sh       # about 6 minutes; run as a normal user, not root
```

Python 3.11+ and Node 22.5+, standard library only, nothing to install (`node:sqlite` is built
into Node). The Postgres run needs `initdb`, `pg_ctl` and `psql` from PostgreSQL 16 or later; set
`PG_BIN` if they are not on your `PATH`. Each Python/JavaScript pair prints the same output, apart
from timings. Page counts in the Postgres output are the same on every run (the data is seeded);
times depend on the machine.

Tested on 2026-10-26 with Python 3.13, Node 22.22 (SQLite 3.50), Python's SQLite 3.45 and
PostgreSQL 16.15 on Linux, 4 vCPUs, warm cache.
