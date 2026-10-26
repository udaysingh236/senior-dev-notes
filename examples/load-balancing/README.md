# Load balancing: runnable examples

The code behind the snippets and numbers on the
[Load Balancing](https://seniordevnotes.netlify.app/traffic/load-balancing/) page.
Python 3.11+ and Node 22+, standard library only, nothing to install.

| File | What it shows |
|---|---|
| `python/weighted.py` / `js/weighted.mjs` | Weighted round robin for weights 5, 1, 1: in blocks (`a a a a a b c`) and nginx's smooth version (`a a b a c a a`), with the counters at every step |
| `python/fleet.py` / `js/fleet.mjs` | Eight backends, one 3× slower, at 70% load behind 1 or 50 balancers: p50, p99 and the slow backend's share for round robin, least loaded and P2C on a shared table refreshed every 500 ms, P2C on each balancer's own counts, and P2C with peak EWMA; then p99 as the shared table ages from live to 500 ms |
| `python/subsets.py` / `js/subsets.mjs` | 300 frontends, 300 backends, subsets of 10: clients per backend for deterministic subsetting and rendezvous hashing, and how many connections move when one backend is removed |

## Run

```bash
python python/weighted.py
node js/weighted.mjs
python python/fleet.py      # about 2 s
node js/fleet.mjs
python python/subsets.py
node js/subsets.mjs
```

Each pair uses the same seeded random generator (mulberry32) and prints identical output.

Tested on 2026-10-26 with Python 3.13 and Node 22.22 on Linux.
