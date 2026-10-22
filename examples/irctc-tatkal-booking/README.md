# IRCTC Tatkal booking: runnable examples

The code behind the snippets on the
[How IRCTC Tatkal Booking Works](https://seniordevnotes.netlify.app/case-studies/irctc-tatkal-booking/)
page. Python 3.11+ and Node 20+, standard library only. Each file prints its results, so you can
check them against the page.

| File (Python / JavaScript) | What it shows |
|---|---|
| `oversell.py` / `oversell.mjs` | 1,000 concurrent bookings for 120 seats: check-then-act oversells, check-and-take in one step does not |
| `conditional_update.py` | The check-and-take as one SQL `UPDATE ... WHERE available >= 2`, run against SQLite |
| `seat_hold.py` / `seat-hold.mjs` | Seat holds that expire, an idempotent payment callback, a late payment that becomes a refund, and a reconciliation sweep that finds a lost callback |

## Run

```bash
# Python
cd python
python oversell.py
python conditional_update.py
python seat_hold.py

# JavaScript
cd js
node oversell.mjs
node seat-hold.mjs
```

The exact naive oversell numbers depend on the random seed and differ slightly between the two
languages; the atomic line always sells exactly 120 seats. `seat_hold` prints the same lines in
both languages.

Tested on 2026-10-22 with Python 3.13.16 and Node 22.22.0.
