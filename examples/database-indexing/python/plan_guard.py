"""Watch SQLite's query plan change as indexes are added, then fail a test when a query scans.

The query is the usual "latest 20 orders of one customer". Each step drops the previous index and
creates a better one, prints the plan SQLite chose and how long the query takes.
Run: python plan_guard.py   (Python 3.11+, standard library only)
"""

import sqlite3
import time

ROWS = 200_000
QUERY = """SELECT id, created_at, amount_cents FROM orders
           WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20"""

STEPS = [
    ("no index", None),
    ("index on (customer_id)", "CREATE INDEX idx ON orders (customer_id)"),
    ("index on (customer_id, created_at)", "CREATE INDEX idx ON orders (customer_id, created_at)"),
    ("covering: (customer_id, created_at, amount_cents)",
     "CREATE INDEX idx ON orders (customer_id, created_at, amount_cents)"),
]


def build() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("""CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL, amount_cents INTEGER NOT NULL, note TEXT NOT NULL)""")
    rows = (
        (i, (i * 7919) % 2_000 + 1,  # 2,000 customers, 100 orders each, spread across the table
         f"2025-{1 + i * 12 // ROWS:02d}-{1 + i % 28:02d} {i % 24:02d}:00:00",
         (i * 31) % 100_000, "x" * 60)
        for i in range(1, ROWS + 1)
    )
    conn.executemany("INSERT INTO orders VALUES (?, ?, ?, ?, ?)", rows)
    return conn


def plan(conn: sqlite3.Connection, sql: str, params=()) -> list[str]:
    """The detail column of EXPLAIN QUERY PLAN: 'SCAN orders', 'SEARCH orders USING INDEX ...'."""
    return [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params)]


def assert_uses_index(conn: sqlite3.Connection, sql: str, params=()) -> None:
    """For a test suite: fail if the plan reads a whole table or index, or sorts in a temp B-tree."""
    bad = [step for step in plan(conn, sql, params) if step.startswith("SCAN") or "TEMP B-TREE" in step]
    if bad:
        raise AssertionError(f"query plan has {bad}")


def ms_per_query(conn: sqlite3.Connection, sql: str, params, repeat: int = 20) -> float:
    start = time.perf_counter()
    for _ in range(repeat):
        conn.execute(sql, params).fetchall()
    return (time.perf_counter() - start) * 1000 / repeat


def main() -> None:
    conn = build()
    for label, ddl in STEPS:
        conn.execute("DROP INDEX IF EXISTS idx")
        if ddl:
            conn.execute(ddl)
        print(f"{label}: {ms_per_query(conn, QUERY, (1234,)):.3f} ms")
        for step in plan(conn, QUERY, (1234,)):
            print(f"    {step}")

    # With an index on created_at, a range on the column passes the guard. Wrapping the column
    # in a function hides it from the index, and the guard catches that.
    conn.execute("CREATE INDEX orders_created ON orders (created_at)")
    month = "SELECT count(*) FROM orders WHERE created_at >= ? AND created_at < ?"
    assert_uses_index(conn, month, ("2025-06", "2025-07"))
    print("guard: range on created_at uses the index")
    try:
        assert_uses_index(conn, "SELECT count(*) FROM orders WHERE substr(created_at, 1, 7) = ?", ("2025-06",))
    except AssertionError as err:
        print(f"guard: substr(created_at, 1, 7) fails: {err}")


if __name__ == "__main__":
    main()
