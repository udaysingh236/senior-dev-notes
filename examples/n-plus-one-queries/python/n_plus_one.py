"""N+1 queries, the batched fix, a per-request loader, and a test that catches regressions.

Standard library only: SQLite in memory stands in for the database, and every query first
waits ROUND_TRIP_MS, the network between an app server and a database in another availability
zone. The query counts are exact; the timings depend on your machine's sleep precision.

    python3 n_plus_one.py
"""

import asyncio
import sqlite3
import time
from collections import defaultdict
from collections.abc import Callable, Hashable, Iterable
from typing import Any

ROUND_TRIP_MS = 1.0
MAX_IN_LIST = 500  # SQLAlchemy's selectinload uses chunks of 500 keys, too


class Db:
    """A database connection that counts queries and pays one round trip for each."""

    def __init__(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.queries = 0
        self.conn.executescript("""
            CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total_cents INTEGER);
            CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty INTEGER);
            CREATE INDEX order_items_order_id ON order_items (order_id);
        """)

    def seed(self, orders: int) -> None:
        self.conn.execute("DELETE FROM customers")
        self.conn.execute("DELETE FROM orders")
        self.conn.execute("DELETE FROM order_items")
        self.conn.executemany("INSERT INTO customers VALUES (?, ?)", [(c, f"customer {c}") for c in range(1, 41)])
        self.conn.executemany("INSERT INTO orders VALUES (?, ?, ?)",
                              [(o, o * 7 % 40 + 1, 1000 + o) for o in range(1, orders + 1)])
        self.conn.executemany("INSERT INTO order_items (order_id, sku, qty) VALUES (?, ?, ?)",
                              [(o, f"SKU-{o * 31 + k}", 1 + k % 3) for o in range(1, orders + 1) for k in range(3)])

    def fetch(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        self.queries += 1
        time.sleep(ROUND_TRIP_MS / 1000)
        return self.conn.execute(sql, tuple(params)).fetchall()

    async def fetch_async(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        self.queries += 1
        await asyncio.sleep(ROUND_TRIP_MS / 1000)
        return self.conn.execute(sql, tuple(params)).fetchall()


def page_of_orders(db: Db, limit: int) -> list[dict]:
    return [dict(r) for r in db.fetch("SELECT * FROM orders ORDER BY id LIMIT ?", [limit])]


# --- 1. Naive: what a lazy-loading ORM does inside a loop ------------------------------------
def list_orders_naive(db: Db, limit: int) -> list[dict]:
    orders = page_of_orders(db, limit)  # 1 query
    for order in orders:  # + 2 queries per order
        order["customer"] = dict(db.fetch("SELECT * FROM customers WHERE id = ?", [order["customer_id"]])[0])
        order["items"] = [dict(r) for r in db.fetch("SELECT * FROM order_items WHERE order_id = ?", [order["id"]])]
    return orders


# --- 2. Correct: one query per relationship, joined up in a dict ------------------------------
def fetch_in(db: Db, sql: str, keys: list) -> list[sqlite3.Row]:
    """Runs `sql` with an IN list for `keys`, in chunks so the statement never grows unbounded."""
    rows: list[sqlite3.Row] = []
    for start in range(0, len(keys), MAX_IN_LIST):
        chunk = keys[start:start + MAX_IN_LIST]
        rows += db.fetch(sql.format(in_list=", ".join("?" * len(chunk))), chunk)
    return rows


def list_orders_batched(db: Db, limit: int) -> list[dict]:
    orders = page_of_orders(db, limit)
    customer_ids = sorted({o["customer_id"] for o in orders})  # distinct: 50 orders, 40 customers
    customers = {r["id"]: dict(r) for r in
                 fetch_in(db, "SELECT * FROM customers WHERE id IN ({in_list})", customer_ids)}
    items: dict[int, list[dict]] = defaultdict(list)
    for r in fetch_in(db, "SELECT * FROM order_items WHERE order_id IN ({in_list}) ORDER BY id",
                      [o["id"] for o in orders]):
        items[r["order_id"]].append(dict(r))
    for order in orders:
        order["customer"] = customers[order["customer_id"]]
        order["items"] = items[order["id"]]  # an order with no items gets [], not a KeyError
    return orders


# --- 3. Production-shaped: a loader for code that cannot see the loop -------------------------
class Loader:
    """Collects every load(key) made while the event loop is busy, then fetches them in one batch.

    Create one per request: the cache inside must never be shared between users.
    """

    def __init__(self, batch_fn: Callable[[list], Any]) -> None:
        self.batch_fn = batch_fn  # async (keys) -> {key: value}
        self.cache: dict[Hashable, asyncio.Future] = {}
        self.queue: list[Hashable] = []

    def load(self, key: Hashable) -> asyncio.Future:
        if key in self.cache:  # the same customer twice in one request: one fetch
            return self.cache[key]
        future = asyncio.get_running_loop().create_future()
        self.cache[key] = future
        self.queue.append(key)
        if len(self.queue) == 1:  # first key of a new batch: dispatch once everyone has asked
            asyncio.get_running_loop().call_soon(lambda: asyncio.ensure_future(self._dispatch()))
        return future

    async def _dispatch(self) -> None:
        keys, self.queue = self.queue, []
        try:
            found = await self.batch_fn(keys)
        except Exception as err:  # one failed batch fails every caller in it
            for key in keys:
                self.cache.pop(key).set_exception(err)
            return
        for key in keys:
            self.cache[key].set_result(found.get(key))


async def list_orders_with_loaders(db: Db, limit: int) -> list[dict]:
    async def customers_by_id(ids: list) -> dict:
        rows = await db.fetch_async(f"SELECT * FROM customers WHERE id IN ({', '.join('?' * len(ids))})", ids)
        return {r["id"]: dict(r) for r in rows}

    async def items_by_order(ids: list) -> dict:
        rows = await db.fetch_async(
            f"SELECT * FROM order_items WHERE order_id IN ({', '.join('?' * len(ids))}) ORDER BY id", ids)
        grouped: dict[int, list[dict]] = {i: [] for i in ids}
        for r in rows:
            grouped[r["order_id"]].append(dict(r))
        return grouped

    customers, items = Loader(customers_by_id), Loader(items_by_order)

    # Each order is resolved on its own, the way a GraphQL resolver or a nested serializer works.
    async def resolve(order: dict) -> dict:
        order["customer"] = await customers.load(order["customer_id"])
        order["items"] = await items.load(order["id"])
        return order

    orders = [dict(r) for r in await db.fetch_async("SELECT * FROM orders ORDER BY id LIMIT ?", [limit])]
    return list(await asyncio.gather(*(resolve(o) for o in orders)))


# --- 4. The test that keeps N+1 from coming back -----------------------------------------------
def query_count(db: Db, endpoint: Callable[[Db, int], Any], orders: int) -> int:
    db.seed(orders)
    before = db.queries
    result = endpoint(db, orders)
    if asyncio.iscoroutine(result):
        asyncio.run(result)
    return db.queries - before


def assert_constant_queries(endpoint: Callable[[Db, int], Any]) -> str:
    """Same request with 10 and 100 rows: the query count must not grow with the data."""
    db = Db()
    small, large = query_count(db, endpoint, 10), query_count(db, endpoint, 100)
    verdict = "ok" if large == small else "FAIL: grows with the number of rows"
    return f"{small} queries for 10 orders, {large} for 100: {verdict}"


def timed(label: str, db: Db, run: Callable[[], Any]) -> list[dict]:
    db.queries = 0
    start = time.perf_counter()
    result = run()
    if asyncio.iscoroutine(result):
        result = asyncio.run(result)
    ms = (time.perf_counter() - start) * 1000
    print(f"   {label:<29} {db.queries:>4} queries {ms:>8.1f} ms")
    return result


if __name__ == "__main__":
    db = Db()
    db.seed(200)
    print(f"1. A page of 50 orders with customer and items, {ROUND_TRIP_MS:g} ms per round trip")
    naive = timed("naive loop", db, lambda: list_orders_naive(db, 50))
    batched = timed("batched with IN", db, lambda: list_orders_batched(db, 50))
    loaded = timed("per-order resolvers + loader", db, lambda: list_orders_with_loaders(db, 50))
    print(f"   same result from all three: {naive == batched == loaded}")
    print("2. Query count as the data grows (the regression test)")
    print(f"   naive:   {assert_constant_queries(list_orders_naive)}")
    print(f"   batched: {assert_constant_queries(list_orders_batched)}")
    print(f"   loaders: {assert_constant_queries(list_orders_with_loaders)}")
