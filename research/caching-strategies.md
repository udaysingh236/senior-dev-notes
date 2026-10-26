# Research: Caching strategies

Slug: `caching/caching-strategies` · single topic · researched 2026-10-26.
Most page fetches were unavailable (DNS failures from the container); facts were checked through
search results quoting the sources, and the Redis defaults were confirmed against a local
`redis-server` 7.0.15 (`CONFIG GET maxmemory-policy` → `noeviction`). Every source is 2020 or
later, or living documentation checked in October 2026. Hit ratios, the miss-ratio curve and the
race measurements come from our own simulations in `examples/caching-strategies`. TinyLFU's
original paper (2017) and Facebook's memcache paper (2013) are older than 2020, so W-TinyLFU is
described from Caffeine's current docs and code behaviour, and leases are left to the cache
invalidation page.

## Angle

The caching track has separate pages for invalidation, stampedes, hot keys and Bloom filters.
This page owns the three decisions every cache makes: where it sits, how reads and writes reach
it (cache-aside, read-through, write-through, write-behind, refresh-ahead), and what it keeps
(eviction and admission). Explainers list the patterns as boxes and stop at "LRU". They skip:

- that load on the database is proportional to the **miss** ratio, so 99% → 98% doubles it;
- that delete-on-write is not race-free, and in a read-heavy hot key our simulation shows it
  stale more often than set-on-write; versions are what fix it (Uber's row timestamps and
  invalidation markers);
- why LRU loses to frequency-aware policies on skewed traffic with one-hit wonders, how the
  count-min sketch works, and why the newest policies (S3-FIFO, SIEVE) do nothing on a hit.

## Key facts

- Redis eviction: `maxmemory-policy` values noeviction, allkeys-lru, allkeys-lfu,
  allkeys-random, volatile-lru, volatile-lfu, volatile-random, volatile-ttl. Default
  `noeviction`: writes that need memory fail with an OOM error, reads still work. LRU is
  approximated by sampling `maxmemory-samples` keys (default 5) and keeping a pool of good
  candidates (since 3.0). https://redis.io/docs/latest/develop/reference/eviction/ (living docs)
- Redis LFU: 8-bit logarithmic counter per key, new keys start at 5, increment probability
  1 / ((counter − 5) × lfu-log-factor + 1), `lfu-log-factor` default 10, `lfu-decay-time` 1
  (minutes per decrement). Same docs page and redis.conf.
- Redis client-side caching (Redis 6+): `CLIENT TRACKING`, the server remembers keys a
  connection read and sends invalidation messages (RESP3 push or a redirect connection);
  broadcast mode by prefix. https://redis.io/docs/latest/develop/reference/client-side-caching/
- Caffeine W-TinyLFU: small admission LRU window, main Segmented LRU, TinyLFU admission: a
  candidate leaving the window replaces the main victim only if its estimated frequency is
  higher; 4-bit count-min sketch, about 8 bytes per entry; counters halved periodically (aging);
  window size tuned by hill climbing. Code defaults: window starts at 1%, protected 80% of main.
  https://github.com/ben-manes/caffeine/wiki/Efficiency (living docs)
- Caffeine refreshAfterWrite: after the refresh time, a read triggers an async reload and gets
  the old value meanwhile; expireAfterWrite evicts and the next read loads synchronously.
  https://github.com/ben-manes/caffeine/wiki/Refresh (living docs)
- S3-FIFO (Yang, Zhang, Qiu, Yue, Rashmi, SOSP 2023): small FIFO about 10%, main FIFO 90%,
  ghost FIFO of evicted keys (no data) as large as main. Insert into small (or main on a ghost
  hit). Leaving small: reused → main, else → ghost. Leaving main: reused → reinsert (2-bit
  counter decremented), else evict. "Quick demotion" of one-hit wonders is the key idea.
  Evaluated on 6,594 traces from 14 datasets; lowest mean miss ratio on 10 of 14; about 6×
  throughput of optimised LRU at 16 threads.
  https://dl.acm.org/doi/10.1145/3600006.3613147 · https://junchengyang.com/publication/sosp23-s3fifo.pdf
- SIEVE (Zhang, Yang, Yue, Vigfusson, Rashmi, NSDI 2024): one FIFO, a visited bit, a moving
  hand; hits only set the bit, so no lock on hits; 1,559 traces; prototype twice the throughput
  of optimised LRU at 16 threads. https://www.usenix.org/conference/nsdi24/presentation/zhang-yazhuo
- Twitter cache workload study (Yang, Yue, Rashmi, OSDI 2020): 153 clusters, 80+ TB of traces;
  TTL often defines the working set; FIFO performs close to or better than LRU for many
  workloads. https://www.usenix.org/conference/osdi20/presentation/yang
- CacheLib (Berg et al., OSDI 2020): Meta's general caching engine, DRAM plus flash, deployed
  since 2017, 70+ services. https://www.usenix.org/conference/osdi20/presentation/berg
- Uber CacheFront (2024): cache in Docstore's query engine, Redis; invalidation from CDC (Flux
  tails MySQL binlogs) brings the cache up to date within seconds instead of the 5-minute default
  TTL; invalidation writes markers rather than deleting; a Lua script deduplicates fills against
  what is cached, using row timestamps so stale values are not written; measured 99.99%
  consistent with shadow reads; explicit invalidation API after writes; opt-in per table and
  request. https://www.uber.com/blog/how-uber-serves-over-40-million-reads-per-second-using-an-integrated-cache/
  and the follow-up https://www.uber.com/blog/how-uber-serves-over-150-million-reads/
- Meta "Cache made consistent" (2022): TAO cache consistency improved from 99.9999% to
  99.99999999% by one measure; a mishandled invalidation can leave a stale value indefinitely;
  Polaris measures inconsistency without false positives; more than 10 trillion cache fills a
  day. https://engineering.fb.com/2022/06/08/core-infra/cache-made-consistent/
- AWS ElastiCache caching strategies: lazy loading (cache-aside) and write-through, TTL to bound
  staleness; write-through fills the cache with data that may never be read.
  https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html (living docs)
- Azure cache-aside pattern: expiry matched to access pattern; priming a static data set;
  don't cache sensitive data in a shared cache.
  https://learn.microsoft.com/azure/architecture/patterns/cache-aside (living docs)

## Our numbers (examples/caching-strategies)

- Zipf with s = 1 over 10,000 keys: the best static cache of 1% / 5% / 10% of keys hits 53.0% /
  69.4% / 76.5%.
- Steady traffic, 10% cache: LRU 67.6%, LFU 73.2%, W-TinyLFU 74.2%, S3-FIFO 73.7%.
- With a batch job reading one-time keys (one per two normal requests), 10% cache: LRU 58.8%,
  LFU 72.7%, W-TinyLFU 73.5%, S3-FIFO 74.2%. LRU miss ratio 41.2% against 25.8% for S3-FIFO:
  1.6× the database reads.
- Popularity flips halfway, 10% cache: LFU without aging falls to 37.2%; W-TinyLFU 71.5%,
  S3-FIFO 72.5%, LRU 67.5%.
- Race, one key, 500 reads/s, 10 ms DB reads, TTL 60 s, 20 writes/s: stale time 2.90% for set
  on write, 8.72% for delete on write, 1.70% for versioned markers (the 1.70% is the ~1 ms
  between each commit and its cache command, which no strategy avoids). At 1 write/s delete on
  write had a 1.49 s stale stretch.

## Misconceptions

- "Delete on write is race-free." It removes the two-writer reorder, not the reader-fill race.
- "A 99% hit ratio is good enough." The miss ratio is what reaches the database.
- "LFU is the frequency-aware fix for LRU." Without aging it keeps yesterday's hot keys.
- "Write-through keeps the cache consistent." Only if the two writes cannot fail separately.
- "Bigger cache is the fix." Under Zipf, each doubling buys less (miss-ratio curve).

## Incidents

No sourced public postmortem chosen for this page; Meta's and Uber's posts describe the
stale-fill problem from production. Stampedes and cold-cache incidents belong to the stampede
page.

## How explainers structure it

- Typical blog: five boxes (cache-aside, read-through, write-through, write-back, write-around),
  pros and cons table, then "use LRU". Missing: races, miss-ratio arithmetic, admission.
- Cloud docs (AWS, Azure): lazy loading vs write-through with TTL, operational advice. Missing:
  eviction internals and versioning.
- Eviction papers: deep on algorithms, silent on write paths.

## Further reading (with years)

- Yang et al., FIFO queues are all you need for cache eviction (SOSP 2023)
- Zhang et al., SIEVE is simpler than LRU (NSDI 2024)
- Yang, Yue, Rashmi, A large scale analysis of hundreds of in-memory cache clusters at Twitter (OSDI 2020)
- Berg et al., The CacheLib caching engine (OSDI 2020)
- Uber, How Uber serves over 40 million reads per second using an integrated cache (2024)
- Meta, Cache made consistent (2022)
- Redis docs: key eviction; client-side caching (living, checked October 2026)
- Caffeine wiki: Efficiency; Refresh (living, checked October 2026)
- AWS ElastiCache: caching strategies (living, checked October 2026)
- Microsoft Azure Architecture Center: cache-aside pattern (living, checked October 2026)
