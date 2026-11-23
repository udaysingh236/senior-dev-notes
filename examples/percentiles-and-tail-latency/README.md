# Percentiles, P99 and tail latency examples

Code behind the snippets on the [Percentiles, P99 and Tail Latency](https://seniordevnotes.in/foundations/percentiles-and-tail-latency/) page.
Python 3.11+ and Node 20+, standard library only. Each Python file and its JavaScript twin print exactly the same output.

| File | What it shows | Run |
|---|---|---|
| `python/percentiles.py` | the average against p50, p90 and p100 for ten requests; then 100,000 pages that call 1, 10 or 100 backends, and the same pages with hedged calls | `python3 python/percentiles.py` |
| `js/percentiles.mjs` | the same, in JavaScript | `node js/percentiles.mjs` |
| `python/histogram.py` | a bucket histogram for two servers: why averaging their p99s is wrong, and how merging bucket counts gets close to the exact p99 | `python3 python/histogram.py` |
| `js/histogram.mjs` | the same, in JavaScript | `node js/histogram.mjs` |
| `python/load_test.py` | coordinated omission: a load test that waits for each answer hides a 1-second server freeze; one that sends on schedule sees it | `python3 python/load_test.py` |
| `js/load-test.mjs` | the same, in JavaScript | `node js/load-test.mjs` |

The latencies are made up (illustrative). Every random number comes from the same seeded
generator in both languages, so every run prints the same numbers. `percentiles.py` takes about
10 seconds, because it builds 400,000 pages.
