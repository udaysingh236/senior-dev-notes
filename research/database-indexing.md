# Research: Database indexing (scan vs seek)

Slug: `databases/database-indexing` · single topic · researched 2026-10-26.
Page fetches were blocked from the container (the proxy refuses most hosts), so facts were checked
through search results that quote the sources. Every number about Postgres behaviour on this page
comes from our own runs against a throwaway PostgreSQL 16.15 cluster (`examples/database-indexing/postgres`),
5,000,000 rows, warm OS cache, 4 vCPUs, parallel query off. Every source is 2020 or later, or living
documentation checked in October 2026.

## Angle

Explainers say "an index is like the index at the back of a book, it makes lookups O(log n)" and
stop there, or list index types. They skip the part that decides real performance:

- the unit of cost is the **page**, not the row; a query matching 1% of rows can touch 44% of the
  pages, because rows are spread uniformly (1 − (1 − s)^rows_per_page);
- so an index can be slower than reading the whole table, and the planner knows it;
- **correlation** (physical order vs index order) changes the cost by 40× for the same selectivity;
- composite index column order: equality first, then range; the wrong order reads 17× the pages,
  no leading equality reads the whole index (until skip scan, PG 18 / MySQL 8.0.13+);
- index-only scans depend on the visibility map, so they silently degrade when vacuum lags;
- what indexes cost on writes (measured).

Neighbouring pages own: B-tree splits and LSM internals (`b-trees-vs-lsm-trees`), planner statistics
and EXPLAIN reading in depth (`query-optimization`), MVCC and isolation (`acid-and-isolation-levels`).

## Our measurements (PostgreSQL 16.15)

The reference run behind the page is `examples/database-indexing/postgres/expected-output.txt`.
The prototype numbers below give the same page counts; timings differ by run (up to a third for
the write test). Extra checks in the reference run: the planner picks the whole-index index-only
scan for "June only" on `(country, created_at)` by itself (the index is 150 MB, the table 673 MB);
a partial index `(created_at) where status = 'pending'` is 2.2 MB against 107 MB for the full one.

Table `orders`: 5M rows, ~97-byte rows, 58 rows per 8 KB page, 86,168 heap pages (673 MB).
Primary key `bigint` index: 107 MB, 13,712 pages, `bt_metap` level 2 (3 levels: root, internal, leaf).
Root holds 48 items, internal pages ~367 items (16-byte items). 3 levels ≈ 367² × ~365 ≈ 49M keys;
4 levels ≈ 18 billion.

- Point lookup `id = 4242424`: 4 buffers in steady state (3 index levels + 1 heap page). First run in
  a session showed 7 (metapage and catalogue access). Index-only on id: 4 (3 index + visibility map).
- `customer_id = 31337` without index: parallel seq scan, all 86,168 pages, 193 ms (2 workers).
  With index: 8 buffers, 0.07 ms.
- Selectivity sweep, `customer_id <= N` (uncorrelated, correlation −0.001), pages / best-of-3 ms:

  | rows | index scan | bitmap heap scan | seq scan | planner chose |
  |---|---|---|---|---|
  | 0.01% | 505 / 0.3 | 505 / 0.5 | 86,168 / 317 | bitmap |
  | 0.1% | 4,920 / 3.5 | 4,801 / 4.9 | 86,168 / 385 | bitmap |
  | 1% | 50,074 / 140 | 38,063 / 163 | 86,168 / 405 | bitmap |
  | 2% | 100,077 / 295 | 59,401 / 249 | 86,168 / 360 | bitmap |
  | 5% | 249,351 / 647 | 82,015 / 416 | 86,168 / 354 | bitmap |
  | 25% | 1,250,946 / 3,370 | 87,582 / 646 | 86,168 / 480 | bitmap |

  Index scan buffers ≈ one per matching row (re-visits counted). Planner switches to seq scan at
  ~25.3% (between N = 126,000 and 127,000). Seq-scan times vary run to run (317–480 ms).
- Same sweep on `created_at` (correlation 1.0): 1% → 1,016 pages, 7 ms; 5% → 5,054 pages, 41 ms;
  25% → 25,286 pages, 214 ms; planner index scan throughout.
- Composite, index-only counts for June 2025 (432,000 rows) and `country = 'IN'` (24,023 rows):
  `(country, created_at)` 96 pages; `(created_at, country)` 1,659 pages (walks all 432,000 June
  entries); June only on `(country, created_at)` 19,161 pages = the whole index (19,255 pages).
- Covering: `sum(amount_cents) where customer_id between 1 and 5000` (50,017 rows): bitmap scan
  38,063 pages, 187 ms; `(customer_id) include (amount_cents)` index-only, Heap Fetches 0, 136 page
  reads, 5.7 ms. After `update ... where id % 20 = 0` (5% of rows, every page touched): Heap Fetches
  52,405, 313 ms. After `vacuum`: Heap Fetches 0, 6.0 ms.
- `customers` 500k rows, 4,166 pages: `email = ...` 4 buffers, 0.04 ms; `lower(email) = ...` seq scan
  150 ms; expression index on `lower(email)`: 4 buffers, 0.04 ms. `created_at::date = ...` seq scan
  29 ms; half-open range on `created_at`: 19 buffers, 0.18 ms. `LIKE 'User4242%'` seq scan with the
  default btree under collation C.UTF-8 (the LIKE prefix optimisation needs collation "C" or
  `text_pattern_ops`); with `text_pattern_ops` index scan, 25 buffers. `LIKE '%4242@...'` always seq.
- Write cost: insert 500,000 rows into a 1M-row table (synchronous_commit off):

  | indexes | time | WAL |
  |---|---|---|
  | primary key only | 1.72 s | 109 MB |
  | + 1 (customer_id) | 2.74 s | 163 MB |
  | + 3 | 4.42 s | 231 MB |
  | + 6 | 8.39 s | 385 MB |

- Defaults (`SHOW`, PG 16): random_page_cost 4, seq_page_cost 1, cpu_tuple_cost 0.01,
  cpu_index_tuple_cost 0.005, cpu_operator_cost 0.0025, effective_cache_size 4GB.

## Key facts with sources

- PostgreSQL 18 released 2025-09-25; adds B-tree **skip scan**: multicolumn B-tree indexes usable
  when a prefix column has no `=` condition (the scan adds a "skip array" for that column).
  https://www.postgresql.org/docs/release/18/ · feature matrix
  https://www.postgresql.org/about/featurematrix/detail/skip-scan-on-multicolumn-b-tree-indexes
  PG 18 also adds `uuidv7()`. As of October 2026 PG 19 is at release candidate, not GA
  (PG 19 beta announcements; jamsql/EDB coverage), so PG 18 is the current stable major.
- Index-only scans: visibility is stored only in heap tuples; the visibility map has one
  all-visible bit per heap page; index-only scan checks the bit and visits the heap if unset.
  `INCLUDE` adds non-key payload columns to a B-tree (PG 11+). PG docs, "Index-Only Scans and
  Covering Indexes" (living docs, current 18).
- B-tree deduplication on by default since PG 13 (`deduplicate_items`); Cybertec measured an index
  shrinking 408 MB → 126 MB on ~20M rows with duplicates (2020).
  https://www.cybertec-postgresql.com/en/b-tree-index-deduplication/
- Bitmap heap scan: exact vs lossy pages, bitmap held in `work_mem`; lossy pages need recheck.
  pganalyze docs https://pganalyze.com/docs/explain/scan-nodes/bitmap-heap-scan (living).
- random_page_cost default 4.0 dates from spinning disks; 1.1–1.5 commonly recommended for SSD;
  pganalyze "5mins of Postgres" on tuning random_page_cost (2022)
  https://pganalyze.com/blog/5mins-postgres-tuning-random-page-cost
- InnoDB: table is a clustered index on the primary key; every secondary index record stores the
  primary key columns, used to find the row in the clustered index; long PKs inflate secondary
  indexes. MySQL 8.4 manual, "Clustered and Secondary Indexes"
  https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html ; "Use of Index Extensions"
  https://dev.mysql.com/doc/refman/8.4/en/index-extensions.html
- MySQL multiple-column indexes: usable for leftmost prefixes.
  https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html ; skip scan range access
  since 8.0.13 (range optimization docs, living).
- HOT updates: Adyen (2022): a non-HOT update on a table with 10 indexes touches 11 blocks, a HOT
  update 1; HOT needs no indexed column changed and free space on the page (fillfactor).
  https://www.adyen.com/knowledge-hub/postgresql-hot-updates ·
  https://www.adyen.com/knowledge-hub/postgresql-hot-updates-part2
- UUID keys: random v4 keys insert all over a B-tree; v7 (RFC 9562, May 2024) is time-ordered with a
  48-bit Unix-ms prefix. https://www.rfc-editor.org/rfc/rfc9562 · PlanetScale, "B-trees and database
  indexes" (Benjamin Dicken, 2024) https://planetscale.com/blog/btrees-and-database-indexes
- CREATE INDEX CONCURRENTLY: avoids blocking writes, about two table scans, a failure leaves an
  INVALID index that is still maintained on writes (PG docs, CREATE INDEX, living).
- Postgres does not create an index on the referencing side of a foreign key; deletes on the parent
  scan the child (PG docs, "Constraints").

## Incidents (sourced)

- Clerk, 2026-02-19: an automatic ANALYZE changed statistics, the planner flipped a hot query to a
  worse plan, database saturated, >95% of requests got 429, ~90 min; fixed by running ANALYZE again
  manually. https://clerk.com/blog/2026-02-19-system-outage-postmortem ; discussed in Postgres.fm
  "Plan flips" (2026) https://postgres.fm/episodes/plan-flips
- PlanetScale, "When the Postgres query planner goes rogue" (Nick Van Wiggeren, July 2026): a customer's
  CPU went to 100% with no deploy; one query pattern rose to ~50% of runtime, latency ms → 10 s timeout; per a summary the planner switched index → seq scan as data grew.
  https://planetscale.com/blog/when-the-postgres-query-planner-goes-rogue

## Misconceptions

- "An index always makes a query faster." Not past a few % of rows on an uncorrelated column.
- "Index every column in the WHERE clause." Separate indexes rarely combine well; order matters.
- "Low-cardinality columns are useless to index." Mostly true for a plain index, but a partial index
  on the rare value (status = 'pending', 2%) is small and very useful.
- "Index-only scan means the heap is never read." Only for pages marked all-visible.
- "SSD makes random and sequential reads the same." Closer, not equal; and the planner's default
  still assumes 4×.

## How explainers structure it

- Book-index analogy → B-tree picture → "O(log n)" → list of index types. Rarely mention pages,
  correlation, or the planner choosing a seq scan.
- PlanetScale's B-tree post (2024) is strong on B-tree mechanics and key choice, InnoDB-specific.
- pgMustard / pganalyze docs are strong on EXPLAIN nodes but assume the reader knows why.
Our angle: cost in pages, with measured numbers, and how column order / correlation / visibility
change that cost.

## Further reading list

- PostgreSQL 18 release notes (2025) — skip scan, uuidv7.
- PostgreSQL docs: Indexes chapter, Index-Only Scans and Covering Indexes, Multicolumn Indexes,
  CREATE INDEX (living, checked October 2026).
- MySQL 8.4 manual: Clustered and Secondary Indexes; Multiple-Column Indexes; Index Extensions (living).
- RFC 9562 (2024) — UUIDv7.
- PlanetScale: B-trees and database indexes (2024).
- PlanetScale: When the Postgres query planner goes rogue (2026).
- Clerk: 2026-02-19 system outage postmortem (2026).
- Adyen: PostgreSQL HOT updates, parts 1 and 2 (2022).
- Cybertec: B-tree index deduplication (2020).
- pganalyze: tuning random_page_cost (2022); Bitmap Heap Scan docs (living).
