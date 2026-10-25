# Latency vs throughput: runnable examples

The code behind the snippets on the
[Latency vs Throughput](https://seniordevnotes.netlify.app/foundations/latency-vs-throughput/) page.
Python 3.11+ and Node 22+, standard library only, nothing to install.

| File | What it shows |
|---|---|
| `python/queue_lab.py` / `js/queue-lab.mjs` | One server with random arrivals, 200,000 simulated requests per utilisation: measured mean latency against the formula S / (1 − u), the same with fixed-time work, a Little's law check, and four separate queues against one shared queue |
| `python/micro_batcher.py` / `js/micro-batcher.mjs` | A real micro-batcher (asyncio / promises) in front of a backend that costs 2 ms per call plus 0.05 ms per item, under an open load of 100, 400 and 1,000 writes a second |

## Run

```bash
python python/queue_lab.py       # about 6 s
node js/queue-lab.mjs
python python/micro_batcher.py   # about 15 s
node js/micro-batcher.mjs
```

`queue_lab` uses the same seeded random generator in both languages and prints identical output.
`micro_batcher` uses real timers, so its numbers vary a little from run to run and between Python
and Node: each `sleep` in this sandbox overshoots by about a millisecond in Python, so the
one-at-a-time writer tops out near 330 writes a second there and near 450 in Node, against the
theoretical 488. The shape of the result does not change: at 100 writes a second batching costs a
couple of milliseconds, at 400 it is faster, and at 1,000 the one-at-a-time writer falls behind
without limit while the batched one keeps up.

Tested on 2026-10-25 with Python 3.13 and Node 22.22 on Linux.
