# Research: Back-of-the-envelope estimation

Slug: `back-of-the-envelope-estimation` · Track: foundations · Researched November 2026.

## Key facts (with sources)

- Estimation = break a question into factors you can guess (Fermi decomposition), keep units on
  every number, aim for the right power of ten, keep assumptions few (napkin-math suggests
  simplifying past ~6). Source: Simon Eskildsen, napkin-math README (numbers last measured
  Oct–Nov 2026). https://github.com/sirupsen/napkin-math
- napkin-math base rates (p99 for disk/network, Oct–Nov 2026, cloud VMs): memory random read
  ~150 ns; SSD random read 8 KiB ~200 µs; network same zone ~250 µs; cross zone ~1 ms;
  cross region same continent ~50 ms; US–Singapore ~200 ms; Redis/Memcached get ~25 µs + RTT;
  primary-key query MySQL/Postgres ~40 µs + RTT; HDD random read ~25 ms; SSD throughput ~5 GiB/s;
  network throughput per VM ~3 GiB/s; blob storage read ~50–100 ms.
- Light in fibre ~203,000 km/s, two-thirds of vacuum speed; 1,000 km ≈ 10 ms round trip.
  TeleGeography, "It's Time To Learn About Latency", March 2025.
  https://resources.telegeography.com/its-time-to-learn-about-latency
- Samsung 990 PRO NVMe (2022 datasheet): 7,450 MB/s sequential read; up to 1.2–1.6 M random-read
  IOPS at queue depth 32; only ~22K IOPS at queue depth 1 (one request at a time).
  https://download.semiconductor.samsung.com/resources/data-sheet/Samsung_NVMe_SSD_990_PRO_Datasheet_Rev.1.0_10129514072296.pdf
- Discord (March 2023): 177 Cassandra nodes at start of 2022 holding trillions of messages,
  moved to 72 ScyllaDB nodes with 9 TB disk each; p99 historical fetch 40–125 ms → ~15 ms; insert
  5–70 ms → 5 ms. https://discord.com/blog/how-discord-stores-trillions-of-messages
- Google SRE Workbook ch. 12, Non-Abstract Large System Design (2018, kept as history): designs
  must be turned into concrete machine, RAM, disk, network counts; ask "is it possible / can we
  do better / is it feasible / is it resilient". https://sre.google/workbook/non-abstract-design/
- Jeff Dean's "numbers everyone should know" (2009 talk, kept as history) — origin of the
  latency-ladder idea; numbers outdated, use napkin-math 2026 instead.
- Decimal vs binary prefixes (IEC 80000-13, in force): KB = 1,000 B, KiB = 1,024 B. Disk makers
  and network speeds use decimal; operating systems often show binary. Gap ~10% at TB/TiB.
- Network speeds are in bits per second; file and disk sizes in bytes. 1 byte = 8 bits.

## Real numbers used on the page

- 86,400 s/day ≈ 10^5 (rounding up by 16%). 1 million per day ≈ 12 per second.
  A year ≈ 31.5 million seconds (365 × 86,400 = 31,536,000).
- Running example (illustrative): 10M daily users, 40 sends + 100 fetches each, 200 B a message,
  50 messages per fetch, peak 3× average, 3 copies, 1,000 req/s per server at 60% busy.
  Script output: 1.4 B requests/day, 16,204 avg/s, 48,611 peak/s, 49 servers, 347 MB/s = 2.8 Gbit/s
  out at peak, 80 GB/day, 29.2 TB/year one copy, 87.6 TB with 3 copies.
  In your head: 14,000/s, 42,000 peak, 42 servers. Ranges: 15 / 49 / 146 servers; peak factor
  moves it most (32–81), then fetches (35–66).

## Misconceptions and confusing points

- Precision theatre: 48,611 is not more right than 50,000. The inputs are guesses.
- Average vs peak: sizing for the average fails at the evening peak and on sale days.
- Bits vs bytes: network in Gbit/s, data in GB; off by 8×.
- Forgetting copies (replicas, backups, indexes) in storage.
- Planning servers at 100% busy: queues explode near full (latency vs throughput page).
- Disk IOPS quoted at deep queue depth vs one request at a time (990 PRO: 1.4M vs 22K).
- Treating an estimate as a promise rather than a filter for designs.

## Incidents

None used; no sourced public incident is clearly "caused by a bad estimate". Discord's growth from
12 to 177 nodes is used as a sanity-check example of storage growth, not as an incident.

## How explainers structure it (and what they leave out)

- ByteByteGo / Alex Xu's book chapter: power-of-two table, Dean's latency numbers, availability
  nines, a Twitter QPS/storage example. Leaves out: why peak matters, ranges, units checking;
  latency numbers dated (2010s).
- Educative "Grokking": requests/s, storage, bandwidth, per-server throughput guesses
  (MySQL ~1,000 QPS, cache ~100K). Leaves out where the per-server number comes from.
- Generic blogs: formula lists. Leave out: the reader doing the arithmetic step by step,
  sensitivity (which guess matters), and using estimates to reject designs.
- Our angle: one running example done in full, in words; round-in-your-head vs exact; ranges and
  the one assumption that matters; 2026 latency numbers; estimate as a filter on designs.

## Further reading list

- napkin-math (Simon Eskildsen), measured Oct–Nov 2026 — base rates and techniques.
- TeleGeography, It's Time To Learn About Latency (2025) — fibre speed, 10 ms per 1,000 km.
- Samsung 990 PRO datasheet (2022) — IOPS at queue depth 1 vs 32.
- Discord, How Discord Stores Trillions of Messages (2023) — real storage scale to sanity-check.
- Google SRE Workbook, Non-Abstract Large System Design (2018, kept as history).
- Jeff Dean, Numbers everyone should know (2009, kept as history; mention only).

## Fresher read

Done in the publishing session, November 2026. Items found and fixed:

- Part 1 used GB and TB before they were defined → defined inline in step 6, with "byte" in plain words.
- "29 TB × 3 = about 88" made the reader do 29 × 3 = 87 → now 29.2 × 3 = 87.6, about 88.
- "30 messages instead of 40 → 46 servers" had no working → shown as 130 vs 140 requests, 7% fewer.
- Latency caption said "99th percentile" before percentiles exist on the page → "99 in every 100".
- "primary-key lookup" undefined → "fetches one row by its id".
- "3,900 ÷ 1,000 × 10" left mixed operations to the reader → 3.9 × 10 ms.
- "more than ten such machines' worth" had no working → 88 ÷ 8 = 11, 440 ÷ 8 = 55.
- Latency table rows out of order → sorted by time.
- "queue depth" in the caution used before defined → defined inline.
- "object storage" in a quiz answer undefined → "a storage service for files, such as Amazon S3".
- Code excerpt claimed units in every name and showed no copies line → wording fixed, line added to page and files.
- Banned words "just", "easy", "easily" → replaced.

List now empty. Part 1 alone lets a reader say: break the question into guesses, turn per day into
per second, size for the peak, and use the result to decide (50 servers; data will not fit one machine).

