# Idempotency keys: runnable examples

The code behind the snippets on the
[Idempotency Keys](https://seniordevnotes.in/messaging/idempotency-keys/) page.

| File | What it shows |
|---|---|
| `python/payments.py`, `js/payments.mjs` | A `POST /payments` handler two ways over SQLite and a fake bank. `naive` checks for the key, charges, then records the key. `keyed` claims the key first in a transaction that also creates the payment, holds a lease, charges with a downstream key derived from the payment id, and finishes in an update fenced on the lease owner. Each runs three scenarios: a duplicate that arrives 0.1 s into a 0.3 s charge, a process that dies after the bank said yes, and a key reused with a different amount |

## Run

```bash
cd python && python3 payments.py
cd js && node --no-warnings payments.mjs
```

Python 3.11+ (standard library `sqlite3`) or Node 22.5+ (built-in `node:sqlite`; Node 22 prints
an experimental warning without `--no-warnings`). Nothing to install. Each file takes about
5 seconds, because the fake bank and the lease use real time.

## Expected output

Each cell is the number of times money moved, then `attempt:status` in the order the attempts
finished. `crash` is an attempt whose process died after the bank charged.

```text
scenario                        naive                           keyed
duplicate while first runs      2 charges  1:201 2:500 3:201    1 charge   2:409 1:201 3:201
crash after the bank said yes   2 charges  1:crash 2:201 3:201  1 charge   1:crash 2:409 3:201
same key, different amount      1 charge   1:201 2:201          1 charge   1:201 2:422
```

Read the naive column first. The duplicate charged twice and the second attempt got a `500`
from the unique constraint, after the money had left. The crash charged twice because the key
was never written. And the reused key replayed a response for ₹11.99 to a request for ₹25.

Tested on 2026-11-06 with Python 3.13 and Node 22.22 on Linux.
