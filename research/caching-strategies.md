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
- Race, one key, 500 reads/s, 10 ms DB reads, TTL 60 s, 20 writes/s, 10 simulated minutes,
  counting the cache as outdated only while it holds a version older than one a writer has already
  told it about: 0.96% for set on write, 7.14% for delete on write, 0.00% for versioned markers
  (re-run 2026-11-09; an earlier count that included the ~1 ms between each commit and its cache
  command gave 2.90% / 8.72% / 1.70%). At 1 write/s delete on write had a 1.49 s stale stretch.
- Zipf s = 1 over 10,000 keys, worked by hand for the page: 1 + 1/2 + … + 1/100 = 5.19,
  … + 1/1,000 = 7.49, … + 1/10,000 = 9.79, so the top 100 keys get 53.0% and the top 1,000 76.5%.
  A static cache would need the top 9,068 keys (over 90% of them) to reach a 99% hit ratio.

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

## Fresher read (2026-11-09, rewrite under the November standard)

The page was rewritten fresher-first: a new Part 1 (the question about one shop's prices, a
seven-step running example with product 42, a new mental-model diagram `MentalModel.astro`, five
building blocks with the four steps, and "If you stop here"), then Part 2 opening with the sharp
question. What the fresher read found and fixed:

- Terms used before being explained, now introduced with a plain sentence, why and an example
  before use: cache, key, value, source of truth, fill, hit and miss ratio, stale, TTL, eviction,
  eviction policy, admission, in-process and remote cache, Redis, percentile and p99, Zipf
  distribution and its exponent s, best static cache, cluster, commit, deploy, read replica,
  memoization, CDN, microsecond and nanosecond, deserialisation, pod, feature flags, race
  condition, in flight, version, marker, atomic, Lua, loader, coalescing, background refresh,
  acknowledgement (ack), dirty keys and flush, recency and frequency, one-hit wonder, doubly linked
  list, constant time, scan, thread, lock, bit and byte, logarithmic counter, hash function,
  collision, count-min sketch, hill climbing, FIFO queue, trace, SOSP and NSDI, fork (Valkey),
  change data capture and binlog, rolling deploy, Redis hash fields.
- Numbers without working, now shown step by step with units: 99% to 98% doubling the database
  load (10,000 ÷ 100 × 2 = 200 reads/s), the average read time at 99% and 90% hits, the Zipf
  shares (sums of 1/k), the 26% more database reads for LRU (32.4 ÷ 25.8), 50 times the load on a
  cold cache (100 ÷ 2), the 100 GB of copies (50 × 2 GB), stale seconds from the race percentages
  (600 s × 0.0714 ≈ 43 s), the Redis LFU probability at counters 5 and 15, 4-bit and 8-bit value
  ranges, Meta's consistency figures as 1 in a million against 1 in ten billion, the interview
  "five times" (5% ÷ 1%), and the write-behind loss (5 × 2,000).
- A wrong figure fixed: the frequency-aware policies stay within one point (not half a point) of
  their steady hit ratio under the batch job (W-TinyLFU moves 0.7 points). The LFU shift number now
  says it is the second half of the run, against the steady-traffic figure.
- Figures: the count-min sketch figure moved after the three-part W-TinyLFU description, because it
  shows the window candidate and the main-area victim; every figure now has a sentence before it
  saying what to look at. The write-paths diagram says "says OK" instead of "acks", and its first
  note moved left so the enlarge button no longer covers it. The eviction table's "notice" line
  corrected to the last three rows.
- Missing steps: why the two writers' `SET`s can arrive out of order; why the delete leaves
  nothing to compare a version with; why the check and the store must be atomic; a "read it like
  this" paragraph after the S3-FIFO code and a note on the Lua script's `HMGET`/`HSET`/`PEXPIRE`.

Second read: no unexplained terms, unworked numbers or figures without a lead-in found.

The three-sentence explanation a student could give after Part 1 alone: "A cache is a small, fast
copy of data that really lives in a slower database; the app asks the cache first and only goes to
the database on a miss, saving a copy on the way back. Since the database only sees the misses, a
small drop in the hit ratio, from 99% to 98%, doubles its work. The cache is smaller than the data,
so when full it throws out what is least likely to be read again, and since it cannot see the
database change, a write must delete the cached copy, with a time limit on every copy as the safety
net."
