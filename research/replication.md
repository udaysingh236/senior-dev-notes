# Replication — research notes

Track: databases, order 9, slug `replication`. Single-topic page (`template.mdx`).
Researched November 2026. Read replicas (how to route reads) has its own planned page,
`read-replicas`; failover, quorums, consensus, CAP and consistency models have planned pages too.
This page teaches the mechanism and links to those.

## Key facts (with sources)

- PostgreSQL ships its write-ahead log (WAL) to standbys: file-based log shipping, one 16 MB
  segment at a time, or streaming, record by record. Standbys can serve read-only queries (hot
  standby). — PostgreSQL docs, "High Availability, Load Balancing, and Replication" (current
  version, 18; standard in force).
- `synchronous_commit` levels: `off`, `local`, `remote_write`, `on`, `remote_apply`. With
  synchronous standbys named, `on` waits until the standby has flushed the commit record to disk;
  `remote_write` until it has written it to the OS; `remote_apply` until it has applied it so queries
  on the standby see it. With `synchronous_standby_names` empty, remote levels behave like `on`
  locally. — PostgreSQL docs, runtime-config-wal (v18).
- `synchronous_standby_names` supports `FIRST n (a, b, c)` (priority) and `ANY n (a, b, c)` (quorum).
  — same docs.
- A commit waiting for a synchronous standby that never answers waits forever; cancelling it gives
  the warning "The transaction has already committed locally, but might not have been replicated to
  the standby." — reproduced in examples/replication/sql/demo.sh (PostgreSQL 16.15).
- Replication slots stop the primary from removing WAL a standby still needs; an abandoned slot
  makes WAL pile up until the disk fills (`max_slot_wal_keep_size` caps it). — PostgreSQL docs v18.
- `pg_stat_replication` on the primary: one row per standby, with `write_lag`, `flush_lag`,
  `replay_lag`, `sync_state`. — PostgreSQL docs, monitoring stats (v18).
- Hot standby conflicts: a long query on a standby can delay WAL replay
  (`max_standby_streaming_delay`, default 30 s) or be cancelled. — PostgreSQL docs v18; Percona
  blog "PostgreSQL Replication and Conflicts" (2023).
- MySQL semisynchronous replication: the source waits for at least one replica to acknowledge it
  has received (not applied) the transaction; `rpl_semi_sync_source_timeout` default 10000 ms, after
  which it silently falls back to asynchronous, and returns to semisync when a replica catches up.
  — MySQL 8.4 Reference Manual, 19.4.10.
- Patroni `maximum_lag_on_failover`: the most bytes a replica may be behind and still be promoted;
  default 1 MB (1048576). Not a hard bound on loss. `synchronous_mode` only promotes a standby known
  to have every acknowledged commit. — Patroni docs, "Replication modes" (v4, 2024–2025).
- DynamoDB global tables (multi-Region eventual consistency mode): concurrent writes to the same
  item in different Regions resolved by last writer wins on an internal timestamp, per item; also
  offers multi-Region strong consistency mode (2025). — AWS DynamoDB developer guide, "How global
  tables work" (as of 2026).
- Cassandra (leaderless): each request names a consistency level; with replication factor 3,
  QUORUM is 2; QUORUM writes + QUORUM reads overlap because 2 + 2 > 3. — DataStax docs, "How is
  the consistency level configured?" (Cassandra 3.x docs, current concept); Apache Cassandra docs.
- Aurora: storage keeps 6 copies across 3 Availability Zones, writes need 4 of 6, reads 3 of 6;
  replicas share the storage volume, so they do not replay from a shipped copy of the data. — AWS
  Database Blog, "Amazon Aurora under the hood: quorums and correlated failure" (2017 blog, kept
  only for the design, confirmed by AWS Aurora User Guide 2025 "Aurora storage and reliability").
- GitHub, October 21 2018 (kept as history): 43 s of lost connectivity between a hub and the
  primary US East data centre; Orchestrator promoted a US West primary; writes on the East side not
  yet replicated; 24 h 11 min degraded service while writes were reconciled. — github.blog
  post-incident analysis, 2018-10-30.
- Cloudflare, November 2 2020: a partially failing switch caused etcd/Raft trouble, which caused
  unneeded Postgres primary promotions and replica rebuilds; API and dashboard impaired 6 h 33 min.
  — blog.cloudflare.com/a-byzantine-failure-in-the-real-world (2020-11-27).
- PostgreSQL 19 adds a `WAIT FOR` command that waits until a standby has replayed past a given log
  position, to give read-your-writes on async replicas. — ClickHouse blog, August 2026.
  Fast-moving: mention as "as of August 2026"; the page teaches the general technique with
  `pg_last_wal_replay_lsn()`, which exists in every supported version.

## Measured here (examples/replication/sql/demo.sh, PostgreSQL 16.15, one laptop, November 2026)

- Async, 1000 commits each followed at once by a read on the follower: 975–988 reads missed the row.
  Average commit 0.33–0.36 ms.
- Sync `remote_apply`: 0 of 1000 missed; average commit 0.97–0.98 ms (about 3 times slower even
  with the follower on the same machine).
- Follower with `recovery_min_apply_delay = 200ms` and `remote_apply`: commits average 201.6–201.9
  ms. The leader is as slow as its synchronous follower.
- Sync with the follower stopped: commit waits (wait event `SyncRep`) until cancelled; the row is
  on the leader anyway.
- Async, follower cut off, 500 commits, leader killed, follower promoted: 500 committed orders
  missing on the new leader.

## Real numbers

- Round trip within one data centre: under 1 ms; Mumbai ↔ Singapore around 50–70 ms; Mumbai ↔
  Frankfurt around 110–130 ms (illustrative, typical public cloud inter-region figures; label as
  illustrative on the page).
- MySQL semisync fallback: 10 s default. PostgreSQL `wal_sender_timeout` 60 s default;
  `max_standby_streaming_delay` 30 s default. Patroni `ttl` 30 s, `loop_wait` 10 s,
  `maximum_lag_on_failover` 1 MB defaults.

## Misconceptions and confusing points

- "A replica is a backup." No: a mistaken `DELETE` replicates in milliseconds. Backups keep the
  past; replicas keep the present.
- "Synchronous means all replicas have it." In PostgreSQL and MySQL it means the named/first N
  standbys have it, and "have" can mean received, flushed or applied.
- "Synchronous means no stale reads." Only `remote_apply` guarantees visibility on that standby;
  `on` means flushed to disk, not yet visible.
- "Semi-sync is safe." It falls back to async after a timeout, silently.
- "Cancelling a hung synchronous commit rolls it back." It does not; it is already committed on
  the leader.
- "Replication lag is a network problem." Often it is replay: a long query on the replica, a big
  single-threaded apply, a slow disk.
- Failover is the dangerous part, not copying: detection, choosing the most up-to-date follower,
  and stopping the old leader (fencing) to avoid two leaders (split brain).

## How popular explainers structure it

- Kleppmann's DDIA chapter 5 (book 2017; second edition in progress 2025): leaders and followers,
  sync/async, setting up followers, handling outages, implementation of logs, lag problems
  (read-your-writes, monotonic reads, consistent prefix), multi-leader, leaderless. Thorough but
  dense for a fresher. Not cited (pre-2020), structure noted only.
- Typical blog/video explainers (ByteByteGo-style, 2022–2024): master-slave diagram, "reads to
  replicas, writes to master", sync vs async in one line each. They leave out: what is actually
  shipped (the log), positions, why a cancelled sync commit is still committed, that the client
  can see "saved" for a write the new leader never got, and fencing.
- Our angle: one shop, one address change, measured on a real Postgres pair; the log and its
  positions as the core idea; failover as the hard part.

## Sources (Further reading)

1. PostgreSQL docs, "High Availability, Load Balancing, and Replication", v18 (2025). Standard in force.
2. PostgreSQL docs, "Write Ahead Log" settings (`synchronous_commit`, `synchronous_standby_names`), v18 (2025).
3. PostgreSQL docs, "Monitoring Database Activity" (`pg_stat_replication`), v18 (2025).
4. MySQL 8.4 Reference Manual, "Semisynchronous Replication" (2024).
5. Patroni documentation, "Replication modes" (2024–2025).
6. AWS, "How DynamoDB global tables work" (2025–2026).
7. DataStax / Apache Cassandra docs, consistency levels (current).
8. AWS Database Blog, Amazon Aurora storage quorum (design); AWS Aurora User Guide (2025).
9. Cloudflare, "A Byzantine failure in the real world" (2020).
10. GitHub, "October 21 post-incident analysis" (2018, kept as history).
11. ClickHouse blog, "PostgreSQL 19: wait for read-your-writes" (2026).
12. Percona blog, "PostgreSQL Replication and Conflicts" (2023).

## Fresher read

Done by the publishing session, top to bottom, on 2026-11-20. Items found and fixed:

- "both machines in the same room, so to speak" (idiom) → "running on one laptop, where the network takes almost no time".
- Leader data centre and the customer's new address were both "Mumbai" → leader moved to Chennai.
- Step 2 said the leader changes the row, then logs it; the building block says log first → reordered.
- "byte offset", "in hex" → "how many bytes into the log the change sits".
- "view" in `pg_stat_replication` → "a built-in view (a table you can query)".
- "moves the shop's database address to A" (clashes with customer address) → "points the app's database connections at A".
- Patroni, lease, coordination store (etcd/Consul/ZooKeeper), keyspace, item, page, system catalogue, Kafka, CDC, runbook, threads, n/a, "hot part" — each explained in place or replaced with plain words.
- Unclear sentence about settings with no synchronous followers named → rewritten.
- "quorum" used in the synchronous section before its full explanation → one-line definition plus pointer.
- Fig. 2 labels hidden under the expand button / crossed by an arrow at 360 px → moved.
- Sim status line clipped at 360 px → shortened ("commit: …", "N waiting").

Open items: none. Part 1 alone explains the idea in three sentences: one leader logs every change
and followers replay it in order; followers lag, so reads can be old and an asynchronous leader
crash loses the newest saved writes; waiting for a follower before saying "saved" removes the loss
and costs a round trip per commit.
