-- The measurements quoted on the Database Indexing page. Run after setup.sql (run.sh does both).
-- "pages" is shared buffers hit + read from EXPLAIN (ANALYZE, BUFFERS): the number of 8 KB pages
-- the plan touched, counting a page again each time it is visited. Times are best of 3, warm cache.
\pset pager off
\pset footer off
set max_parallel_workers_per_gather = 0;
set jit = off;

-- Runs a query under one plan ('auto' lets the planner choose) and reports plan, pages, ms.
create or replace function measure(q text, plan text default 'auto')
returns table (plan_used text, pages bigint, heap_fetches bigint, ms numeric)
language plpgsql as $$
declare
  r json;
  best numeric := 1e12;
begin
  -- 'auto' turns every scan type back on, so settings never leak from the previous call.
  perform set_config('enable_seqscan', (plan in ('auto', 'seq'))::text, true);
  perform set_config('enable_indexscan', (plan in ('auto', 'index'))::text, true);
  perform set_config('enable_bitmapscan', (plan in ('auto', 'bitmap'))::text, true);
  perform set_config('enable_indexonlyscan', (plan in ('auto', 'indexonly'))::text, true);
  for i in 1..3 loop
    execute 'explain (analyze, buffers, format json) ' || q into r;
    best := least(best, (r -> 0 ->> 'Execution Time')::numeric);
  end loop;
  -- Report the scan node: under an Aggregate it is the first child.
  r := r -> 0 -> 'Plan';
  if r ->> 'Node Type' = 'Aggregate' then r := r -> 'Plans' -> 0; end if;
  plan_used := r ->> 'Node Type';
  pages := (r ->> 'Shared Hit Blocks')::bigint + (r ->> 'Shared Read Blocks')::bigint;
  heap_fetches := (r ->> 'Heap Fetches')::bigint;
  ms := round(best, 2);
  return next;
end $$;

\echo '== 1. Sizes: heap pages, rows per page, B-tree levels'
select pg_relation_size('orders') / 8192 as heap_pages,
       round(reltuples / relpages) as rows_per_page,
       pg_relation_size('orders_pkey') / 8192 as pk_pages,
       (select level + 1 from bt_metap('orders_pkey')) as pk_levels
from pg_class where relname = 'orders';

\echo '== 2. Point lookup by primary key (warm): 3 index levels + 1 heap page'
select * from measure('select * from orders where id = 4242424');

\echo '== 3. customer_id = 31337, no index, then with one'
select * from measure('select * from orders where customer_id = 31337');
create index orders_customer_idx on orders (customer_id);
create index orders_created_idx on orders (created_at);
analyze orders;
select * from measure('select * from orders where customer_id = 31337');

\echo '== 4. Selectivity sweep. customer_id is uncorrelated, created_at follows the physical order'
select c.col, s.pct || '%' as rows,
       a.plan_used as planner_chose,
       i.pages as index_pages, i.ms as index_ms,
       b.pages as bitmap_pages, b.ms as bitmap_ms,
       q.pages as seq_pages, q.ms as seq_ms
from (values ('customer_id'), ('created_at')) c(col)
cross join (values (0.01), (0.1), (1), (2), (5), (25)) s(pct)
cross join lateral (select case c.col
  when 'customer_id' then format('select * from orders where customer_id <= %s', (5000 * s.pct)::int)
  else format('select * from orders where created_at < %L::timestamptz + interval ''%s seconds''',
              '2025-01-01 00:00:00+00', (300000 * s.pct)::int) end as q) qq
cross join lateral measure(qq.q) a
cross join lateral measure(qq.q, 'index') i
cross join lateral measure(qq.q, 'bitmap') b
cross join lateral measure(qq.q, 'seq') q;

\echo '== 5. Composite column order: June 2025 (432,000 rows), country IN (24,023 rows), index only'
drop index orders_created_idx;
vacuum orders;
create index orders_country_created_idx on orders (country, created_at);
select 'IN + June on (country, created_at)' as test, pages, ms
  from measure($q$select count(*) from orders where country = 'IN'
                 and created_at >= '2025-06-01' and created_at < '2025-07-01'$q$, 'indexonly')
union all
select 'June only on (country, created_at)', pages, ms
  from measure($q$select count(*) from orders
                 where created_at >= '2025-06-01' and created_at < '2025-07-01'$q$, 'indexonly');
select 'planner, unforced, June only' as test, plan_used, pages
  from measure($q$select count(*) from orders
                 where created_at >= '2025-06-01' and created_at < '2025-07-01'$q$);
drop index orders_country_created_idx;
create index orders_created_country_idx on orders (created_at, country);
select 'IN + June on (created_at, country)' as test, pages, ms
  from measure($q$select count(*) from orders where country = 'IN'
                 and created_at >= '2025-06-01' and created_at < '2025-07-01'$q$, 'indexonly');
drop index orders_created_country_idx;
select pg_relation_size('orders') / 8192 as heap_pages;

\echo '== 6. Covering index and the visibility map: sum(amount_cents) for 1% of customers'
select 'customer_id index' as test, * from measure(
  'select sum(amount_cents) from orders where customer_id between 1 and 5000');
create index orders_customer_cov_idx on orders (customer_id) include (amount_cents);
vacuum analyze orders;
select 'covering, after vacuum' as test, * from measure(
  'select sum(amount_cents) from orders where customer_id between 1 and 5000');
update orders set note = repeat('y', 60) where id % 20 = 0;
select 'covering, 5% of rows updated' as test, * from measure(
  'select sum(amount_cents) from orders where customer_id between 1 and 5000');
vacuum orders;
select 'covering, vacuumed again' as test, * from measure(
  'select sum(amount_cents) from orders where customer_id between 1 and 5000');

\echo '== 7. Predicates that cannot use the index, and the fixes (customers: 500,000 rows)'
select 'email = ...' as test, * from measure($q$select * from customers where email = 'User4242@Example.com'$q$)
union all
select 'lower(email) = ...', * from measure($q$select * from customers where lower(email) = 'user4242@example.com'$q$)
union all
select 'created_at::date = ...', * from measure($q$select * from customers where created_at::date = '2024-03-01'$q$)
union all
select 'created_at half-open range', * from measure($q$select * from customers
  where created_at >= '2024-03-01' and created_at < '2024-03-02'$q$)
union all
select 'email like ''User4242%''', * from measure($q$select * from customers where email like 'User4242%'$q$);
create index customers_email_lower_idx on customers (lower(email));
create index customers_email_pattern_idx on customers (email text_pattern_ops);
analyze customers;
select 'lower(email), expression index' as test, * from measure($q$select * from customers where lower(email) = 'user4242@example.com'$q$)
union all
select 'like, text_pattern_ops index', * from measure($q$select * from customers where email like 'User4242%'$q$);

\echo '== 8. Partial index: pending orders (2% of rows) against a full index on created_at'
create index orders_pending_idx on orders (created_at) where status = 'pending';
create index orders_created_idx on orders (created_at);
select relname as index, pg_size_pretty(pg_relation_size(oid)) as size
from pg_class where relname in ('orders_pending_idx', 'orders_created_idx', 'orders_pkey') order by 1;
drop index orders_pending_idx, orders_created_idx;
