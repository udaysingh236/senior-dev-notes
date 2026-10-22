# IRCTC Tatkal booking: runnable examples

The code behind the snippets on the
[How IRCTC Tatkal Booking Works](https://seniordevnotes.netlify.app/case-studies/irctc-tatkal-booking/)
page. Python 3.11+ and Node 20+, standard library only. Each file prints its results, so you can
check them against the page.

| File (Python / JavaScript) | What it shows |
|---|---|
| `berth_allocator.py` / `berth-allocator.mjs` | Segment-wise inventory in SQLite: one bitmask per berth, 40 concurrent requests. Read-work-write double-books segments; best-fit plus a conditional `UPDATE ... WHERE mask & need = 0` does not |
| `seat_hold.py` / `seat-hold.mjs` | Seat holds that expire, an idempotent payment callback, a late payment that becomes a refund, and a reconciliation sweep that finds a lost callback |

## Run

```bash
# Python
cd python
python berth_allocator.py
python seat_hold.py

# JavaScript
cd js
node --no-warnings berth-allocator.mjs   # node:sqlite, Node 22.5+
node seat-hold.mjs
```

Both languages generate the same journeys from the same small random generator and print the same
lines. The naive line always shows overlapping pairs; the correct line always shows 0.

Tested on 2026-10-22 with Python 3.13.16 and Node 22.22.0.
