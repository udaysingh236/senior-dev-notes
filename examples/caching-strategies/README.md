# Caching strategies: runnable examples

The code behind the snippets and numbers on the
[Caching Strategies](https://seniordevnotes.netlify.app/caching/caching-strategies/) page.
Python 3.11+ and Node 22+, standard library only, nothing to install. The Redis demo needs
`redis-server` and `redis-cli` (tested with Redis 7.0).

| File | What it shows |
|---|---|
| `python/policies.py` / `js/policies.mjs` | LRU, LFU, W-TinyLFU (simplified) and S3-FIFO on 10,000 Zipf-popular keys, at 1%, 5% and 10% cache sizes: steady traffic, a batch job reading one-time keys, and popularity flipping halfway |
| `python/race.py` / `js/race.mjs` | Cache-aside writes racing reads: the two classic interleavings replayed step by step, then one hot key for 10 simulated minutes measuring how long the cache stays outdated with set on write, delete on write and versioned markers |
| `redis/versioned_set.lua` | A Lua script that stores a cache entry only if its version is newer than what the cache holds; writers use it to leave a marker instead of `DEL` |
| `redis/demo.sh` | Replays the reader/writer race against a throwaway Redis on port 6390, and prints the default `maxmemory-policy` |

## Run

```bash
python python/policies.py   # about 20 s
node js/policies.mjs        # about 3 s
python python/race.py
node js/race.mjs
cd redis && ./demo.sh
```

Each Python/JavaScript pair uses the same seeded random generator (mulberry32) and prints
identical output.

Tested on 2026-10-26 with Python 3.13, Node 22.22 and Redis 7.0.15 on Linux.
