# Retries, exponential backoff and jitter: runnable examples

The code behind the snippets and numbers on the
[Retries, Exponential Backoff and Jitter](https://seniordevnotes.in/resilience/retries-and-backoff/) page.

| File | What it shows |
|---|---|
| `python/retries.py`, `js/retries.mjs` | A naive retry loop, a correct one (transient errors only, capped exponential backoff with full jitter, inside a deadline, honouring Retry-After) and the same with a 10% retry budget, each run for 10,000 requests against a dependency failing 5%, 20% and 100% of the time |
| `python/jitter_storm.py`, `js/jitter-storm.mjs` | 600 clients that fail at the same moment and retry against a server that completes 60 attempts per 100 ms: no jitter, ±20% jitter and full jitter. The same model draws the jitter diagram on the page |

## Run

```bash
cd python && python3 retries.py && python3 jitter_storm.py
cd js && node retries.mjs && node jitter-storm.mjs
```

Python 3.11+ or Node 20+, nothing else. Each file runs in about a second: the dependency and the
clock are fakes, and `sleep` moves a virtual clock forward instead of waiting. Both languages use
the same seeded generator (Mulberry32), so they print identical numbers.

## Expected output

```text
 failing  policy    succeeded  attempts/request
      5%  naive       100.00%              1.05
      5%  backoff     100.00%              1.05
      5%  budget      100.00%              1.05
     20%  naive        99.84%              1.26
     20%  backoff      99.84%              1.26
     20%  budget       87.58%              1.10
    100%  naive         0.00%              4.00
    100%  backoff       0.00%              4.00
    100%  budget        0.00%              1.10

jitter   done in 12 s   last success   attempts   busiest retry slot
none        300/600          8 s      2,400            540
±20%        600/600        4.2 s      1,697            282
full        600/600        2.5 s      1,435            134
```

Tested on 2026-11-06 with Python 3.13 and Node 22.22 on Linux.
