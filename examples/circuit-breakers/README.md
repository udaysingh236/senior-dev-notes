# Circuit breakers: runnable examples

The code behind the snippets and numbers on the
[Circuit Breakers](https://seniordevnotes.in/resilience/circuit-breakers/) page.

| File | What it shows |
|---|---|
| `python/breaker.py`, `js/breaker.mjs` | A naive breaker (stop after 10 failures, ever) and a real one (closed, open, half-open, deciding from the last 20 calls). A page service makes 200 calls a second to a Reviews service that hangs from 10 s to 30 s; then 10 healthy minutes where 1 call in 1,000 fails |
| `python/breaker_prod.py`, `js/breaker-prod.mjs` | A production-shaped breaker: a 10-second window in 1-second buckets, a minimum of 20 calls, 4xx not counted, slow calls counted, 3 trial calls, an open time that doubles after each failed trial with ±20% jitter, and a state-change hook |

## Run

```bash
cd python && python3 breaker.py && python3 breaker_prod.py
cd js && node breaker.mjs && node breaker-prod.mjs
```

Python 3.11+ or Node 20+, nothing else. Time is simulated, so each file runs in about a second.
Both languages use the same seeded generator (Mulberry32) and print identical output.

## Expected output

```text
40 s, Reviews down from 10 s to 30 s
none       calls made   8,000   refused       0   workers waiting on Reviews in the outage:  60.0
naive      calls made   2,067   refused   5,933   workers waiting on Reviews in the outage:   1.0
Circuit breaker (last 20 calls, open at 50%, 5 s open):
  t=10.345s  breaker -> open
  t=15.345s  breaker -> half_open
  t=15.645s  breaker -> open
  t=20.645s  breaker -> half_open
  t=20.945s  breaker -> open
  t=25.945s  breaker -> half_open
  t=26.245s  breaker -> open
  t=31.245s  breaker -> half_open
  t=31.277s  breaker -> closed
breaker    calls made   3,817   refused   4,183   workers waiting on Reviews in the outage:   1.1

10 healthy minutes, 1 call in 1,000 fails, no outage at all
naive      calls made   7,518   refused 112,482
breaker    calls made 120,000   refused       0
1. Every call returns 404 for 10 s (the caller asks for products that do not exist)
  still closed
2. Quiet traffic: 2 calls a second, and 3 of the first 4 fail
  still closed: 4 calls are too few to judge
3. 200 calls a second; Reviews answers in 2.5 s (slow, not dead) from 10 s to 40 s
  t= 16.00s  -> open      (701 of the last 1309 calls failed; trying again in 5.4 s)
  t= 21.45s  -> half_open (letting 3 trial calls through)
  t= 23.95s  -> open      (a trial call failed; trying again in 8.2 s)
  t= 32.10s  -> half_open (letting 3 trial calls through)
  t= 34.60s  -> open      (a trial call failed; trying again in 19.6 s)
  t= 54.25s  -> half_open (letting 3 trial calls through)
  t= 54.30s  -> closed    (every trial call succeeded)
```

Tested on 2026-11-18 with Python 3.13 and Node 22.22 on Linux.
