# Timeouts: runnable examples

The code behind the snippets and numbers on the
[Timeouts](https://seniordevnotes.in/resilience/timeouts/) page.

| File | What it shows |
|---|---|
| `python/timeouts.py` | A server that sends its answer one byte a second, read with `urlopen(timeout=3)` (20 s, no error) and with a total deadline (fails at 3 s). Then a handler that needs 2 s, called with a 0.5 s deadline: once ignoring the caller, once reading the caller's remaining time from a header and stopping early |
| `js/timeouts.mjs` | The same with `fetch` and `AbortSignal.timeout` / `AbortSignal.any`, plus Node's `http.get` with the `timeout` option against a trickling server and a silent one |
| `postgres/run.sh` | Starts a throwaway PostgreSQL and shows what happens to an 8 s query when its client dies, with `client_connection_check_interval`, after a cancel request, and with `statement_timeout` and `lock_timeout` |
| `postgres/expected-output.txt` | Our run of `run.sh` |

## Run

```bash
python3 python/timeouts.py    # about 30 s
node js/timeouts.mjs          # about 50 s
cd postgres && ./run.sh       # about 40 s; run as a normal user, not root
```

The examples need Python 3.11+ or Node 20.3+ (for `AbortSignal.any`) and nothing else. Each starts
its own small HTTP server on a free localhost port. Both print the same results for the cases they
share; the times are measured, so they can differ by a few hundredths of a second.

The Postgres run needs `initdb`, `pg_ctl` and `psql` from PostgreSQL 16 or later (set `PG_BIN` if
they are not on your `PATH`), and `bc`.

Tested on 2026-11-06 with Python 3.13, Node 22.22 and PostgreSQL 16.15 on Linux.
