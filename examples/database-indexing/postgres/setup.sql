-- Builds the tables behind the Database Indexing page. Seeded, so every run builds the same data.
-- orders: 5,000,000 rows, about 58 to an 8 KB page. created_at rises with id (perfectly
-- correlated with the physical order); customer_id is random (not correlated at all).
create extension if not exists pageinspect;
select setseed(0.42);

drop table if exists orders, customers;

create table orders (
  id bigint generated always as identity primary key,
  customer_id int not null,
  status text not null,
  country text not null,
  created_at timestamptz not null,
  amount_cents int not null,
  note text not null
);

insert into orders (customer_id, status, country, created_at, amount_cents, note)
select (random() * 499999)::int + 1,
       case when r < 0.90 then 'delivered' when r < 0.98 then 'shipped' else 'pending' end,
       (array['IN','US','DE','BR','JP','GB','FR','ID','NG','MX'])[1 + (random() * 9)::int],
       timestamptz '2025-01-01 00:00:00+00' + g * interval '6 seconds',
       (random() * 100000)::int,
       repeat('x', 60)
from (select g, random() as r from generate_series(1, 5000000) g) s;

create table customers (id int primary key, email text not null, created_at timestamp not null);
insert into customers
select g, 'User' || g || '@Example.com', timestamp '2024-01-01' + g * interval '60 seconds'
from generate_series(1, 500000) g;
create index customers_email_idx on customers (email);
create index customers_created_idx on customers (created_at);

vacuum analyze orders;
vacuum analyze customers;
