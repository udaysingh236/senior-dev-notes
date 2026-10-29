# N+1 queries — research notes

Track: databases · slug: `n-plus-one-queries` · researched 2026-10-29.
Most docs sites were not reachable from the research container; ORM docs were read from their
source files on GitHub (same text as the published docs), the rest through search results.

## Key facts, with sources

- **Definition, as the ORMs state it.** Django 6.1 docs (fetch modes): default `FETCH_ONE` gives
  1 query for the books + N for the missing `author`, "the N+1 queries problem".
  Rails guides: `Book.limit(10)` then `book.author` = 11 queries; `includes` = 2.
  Sources: github.com/django/django `docs/topics/db/fetch-modes.txt`;
  github.com/rails/rails `guides/source/active_record_querying.md` (living docs, checked Oct 2026).
- **Django 6.1 (5 Aug 2026) fetch modes.** `QuerySet.fetch_mode(models.FETCH_PEERS)`: first lazy
  access fetches the field for every instance from the same QuerySet ("peers") in one query → 2
  queries. `FETCH_RAISE` raises `FieldFetchBlocked`. Applies to FK, OneToOne, deferred fields, generic
  relations; not to related managers (reverse FK / M2M collections). Peers tracked by weak refs.
  Mode copies to related objects fetched. Source: Django 6.1 release notes + fetch-modes doc.
  Django on PyPI: 6.1.2, uploaded 2026-10-06.
- **Django select_related vs prefetch_related.** select_related = SQL JOIN, single-valued
  relations, same query. prefetch_related = separate lookup per relationship, "joining" in Python;
  `pizza.toppings.filter()` after prefetch is a new query (prefetch cache ignored); with
  `iterator()` prefetch only works if `chunk_size` given. Source: `docs/ref/models/querysets.txt`.
- **Rails includes / preload / eager_load.** includes picks preload (separate `IN` query per
  association) unless conditions reference the association table (hash `where` or `references`),
  then a single `LEFT OUTER JOIN` (eager_load). Same guide.
- **Rails strict_loading** (6.1, 2020): raises `ActiveRecord::StrictLoadingViolationError` on lazy
  load. Per record, association (`has_many :books, strict_loading: true`), model, or app-wide
  `config.active_record.strict_loading_by_default`; `action_on_strict_loading_violation = :log`.
  `mode: :n_plus_one_only` raises only when the lazy load would cause N+1 (Rails 7.2 tweak: does not
  raise for `first`/`last`). Sources: Rails guide; Saeloun 2020, 2024; thoughtbot (Rails 8).
- **SQLAlchemy 2.x.** Default relationship loading is lazy ("select"). `selectinload`: second SELECT
  with `IN` of parent PKs, **up to 500 PKs per statement**; recommended for one-to-many /
  many-to-many collections. `joinedload`: LEFT OUTER JOIN, recommended for many-to-one; collection
  joinedload multiplies rows, needs `.unique()`. `subqueryload` legacy. `raiseload("*")` blocks lazy
  loads. Source: `doc/build/orm/queryguide/relationships.rst` on GitHub (SQLAlchemy 2.1.6 on PyPI).
- **Laravel.** `Model::preventLazyLoading(! app()->isProduction())`;
  `handleLazyLoadingViolationUsing` to log instead of throw. `Model::automaticallyEagerLoadRelationships()`
  (Laravel 12.8.0, April 2025, PR #53655): first lazy access loads the relation for the whole
  collection; per collection `withRelationshipAutoloading()`. Sources: laravel/docs 12.x
  `eloquent-relationships.md`; Laravel News "Laravel 12.8" (2025).
- **Prisma.** Fluent/`findUnique` calls in the same tick are batched by Prisma's internal
  dataloader; `include` without `relationLoadStrategy` = one query per table merged in app
  ("query" strategy); `relationLoadStrategy: "join"` (Feb 2024, preview flag `relationJoins`) = one
  SQL query using LATERAL joins and JSON aggregation on PostgreSQL. Source: Prisma blog 2024-02-21
  (via search; prisma.io not reachable).
- **DataLoader** (graphql/dataloader 2.2.3, npm 2024-12-03): coalesces loads within one tick;
  Node scheduling = after resolved promise jobs, then `process.nextTick`; batch fn must return
  array same length & order as keys; per-request instance; `maxBatchSize` default Infinity; cache
  is per-request memoization, not shared cache. Source: README + `src/index.js`.
- **PostgreSQL pipeline mode** (libpq, PG 14, 2021; psycopg 3.1, 2022): send many queries without
  waiting for each result; server executes in order; "100 statements at 300 ms RTT = 30 s without
  pipelining, as little as 0.3 s with". Most useful when RTT is high and many small queries.
  pgbench has `\startpipeline` / `\endpipeline`. Source: psycopg docs `advanced/pipeline.rst`.
- **Bind parameter limit.** PostgreSQL protocol's Bind message carries an Int16 parameter count;
  libpq rejects more than 65,535 ("number of parameters must be between 0 and 65535" — string
  found in local libpq.so). `= ANY($1)` with one array parameter avoids the limit and keeps one
  statement shape. Source: PostgreSQL protocol message formats (current docs, standard).
- **Sentry N+1 detector** (living docs, checked Oct 2026): sequential, non-overlapping DB spans
  with similar descriptions; total duration > 50 ms; count > threshold, "usually five"; spans
  must hold full (not truncated) queries; needs a preceding "source" span; fingerprint = parent +
  source + repeating span; parameterized queries needed for grouping. Also an "N+1 API calls"
  detector for frontend. Source: getsentry/sentry-docs
  `docs/product/issues/issue-details/performance-issues/n-one-queries.mdx`.
- **GitLab.** Each controller, API endpoint, Sidekiq worker allowed up to **100 SQL queries**; tests
  raise above that; since 17.2 `QueryLimiting.disable!` must set a new threshold. QueryRecorder
  tests: warm-up, control count, create 3 more records, expect same number of queries (fails on
  increase or decrease). Source: GitLab development docs (gitlabhq mirror on GitHub).
- **GitLab GraphQL N+1 triage epic** (gitlab-org epic 23614, created 2026-09-16): from 24 h of
  production logs, per GraphQL operation, risk = (p90 − p10) / p90 of queries per request; ≥ 0.85
  worth measuring; savings = (sum − requests × p10) / minutes. Top: `getPipelineJobs` (risk 0.92,
  p95 214 queries), `getEnvironmentDetails` (p95 666), `GetProjectIssues` (p95 1,980 queries).
  Average avoidable queries/request (mean − p10) 7.77 on 2026-09-16, 8.19 on 2026-10-01.

## Our measurements (examples/n-plus-one-queries/postgres, PostgreSQL 16.15, 4 vCPU)

See `examples/n-plus-one-queries/postgres/expected-output.txt` for the exact run quoted on the page.

## Misconceptions and confusing points

- "Each query is fast, so it's fine": per-query server time ~0.05 ms; the cost is round trips and
  per-statement overhead, invisible on localhost (0.09 ms RTT) and in slow-query logs.
- "Add an index": the lookups already use the primary key.
- "Cache it": a cache lookup per row is still N round trips (to Redis instead).
- "Always JOIN": row multiplication; two collections in one JOIN = cartesian product per parent;
  `LIMIT` on a JOIN limits rows, not parents.
- "Eager load everything": loads data the page never uses; global eager loading is its own cost.
- N+1 is not only reads: inserts/updates in a loop; and not only SQL: N+1 HTTP calls between services.
- Pipelining reduces round trips but not server work or per-statement overhead.

## Incidents

No public 2020+ postmortem found that names N+1 as the root cause of an outage. The GitLab triage
epic (2026) is the best sourced production picture. Vendor case studies (Sentry blog: 150+ queries
→ one JOIN, p95 7 s → under 2 s) are illustrative and not used on the page.

## How explainers teach it (and what they leave out)

- Typical blog/tutorial: show the loop, show `includes`/`select_related`, done. Rarely: the
  arithmetic (queries × RTT), why localhost hides it, what the JOIN costs in rows and bytes, the
  LIMIT trap, chunking/parameter limits, how to keep it from coming back (query-count tests,
  strict modes), or the GraphQL/resolver case where there is no loop to fix.
- ORM docs: mechanics of their own loaders; no cross-ORM picture.
- APM vendor posts: detection; light on why the fix choice matters.
Our angle: measure it, make the arithmetic explicit, compare the fixes on rows/bytes/server CPU,
and cover prevention.

## Sources (with year)

- Django 6.1 release notes (2026) and fetch modes docs; QuerySet reference (living, Oct 2026)
- Rails guides: Active Record query interface (living, Oct 2026)
- Saeloun: Rails strict loading (2020); Rails 7.2 n_plus_one_only (2024)
- SQLAlchemy 2.x relationship loading techniques (living, Oct 2026)
- Laravel 12.x Eloquent relationships docs (living, Oct 2026); Laravel News, Laravel 12.8 (2025)
- Prisma blog: choose the best join strategy (2024)
- graphql/dataloader README and source (2.2.3, 2024)
- psycopg 3 pipeline mode docs (living, Oct 2026)
- PostgreSQL protocol message formats (living, current standard)
- Sentry docs: N+1 queries detector (living, Oct 2026)
- GitLab docs: query count limits; QueryRecorder (living, Oct 2026)
- GitLab epic 23614: GraphQL N+1 triage (2026)
