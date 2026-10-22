"""Segment-wise berth inventory in SQL: one bitmask per berth, one bit per segment.

Forty concurrent requests for overlapping journeys hit one coach of 8 berths. Each request does
20 ms of other work (fare, passenger rows) between choosing a berth and writing it.

  naive    SELECT a free berth, await the work, UPDATE mask = mask | need   -> double-booked segments
  correct  choose the tightest-fitting berth, await the work, then
           UPDATE ... WHERE id = ? AND mask & need = 0; 0 rows means someone beat us: try the next

Run: python berth_allocator.py
"""
import asyncio
import os
import sqlite3
import tempfile

STATIONS = ["NDLS", "MTJ", "AGC", "GWL", "VGLJ", "BPL", "ET", "NGP"]
SEGMENTS = len(STATIONS) - 1
KINDS = ["LB", "MB", "UB", "LB", "MB", "UB", "SL", "SU"]  # one bay of a sleeper coach


def need(a: int, b: int) -> int:
    """Bits a..b-1 set: the segments a journey from station a to station b occupies."""
    return ((1 << (b - a)) - 1) << a


def waste(mask: int, a: int, b: int) -> int:
    """How much free run is left around the journey on this berth. Smaller = tighter fit."""
    lo, hi = a, b
    while lo > 0 and not mask >> (lo - 1) & 1:
        lo -= 1
    while hi < SEGMENTS and not mask >> hi & 1:
        hi += 1
    return (a - lo) + (hi - b)


def setup(path: str) -> None:
    db = sqlite3.connect(path)
    db.executescript("""
        PRAGMA journal_mode = WAL;
        CREATE TABLE berth (id INTEGER PRIMARY KEY, kind TEXT, mask INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE booking (id INTEGER PRIMARY KEY, berth_id INTEGER, from_idx INTEGER, to_idx INTEGER);
    """)
    db.executemany("INSERT INTO berth (id, kind) VALUES (?, ?)", enumerate(KINDS, start=1))
    db.commit()
    db.close()


async def book_naive(db: sqlite3.Connection, a: int, b: int) -> int | None:
    n = need(a, b)
    row = db.execute("SELECT id FROM berth WHERE mask & ? = 0 ORDER BY id LIMIT 1", (n,)).fetchone()
    if row is None:
        return None
    await asyncio.sleep(0.02)  # fare, passenger rows, ... other requests run here
    db.execute("UPDATE berth SET mask = mask | ? WHERE id = ?", (n, row[0]))
    db.execute("INSERT INTO booking (berth_id, from_idx, to_idx) VALUES (?, ?, ?)", (row[0], a, b))
    db.commit()
    return row[0]


def best_berth(db: sqlite3.Connection, a: int, b: int, senior: bool) -> int | None:
    rows = db.execute("SELECT id, kind, mask FROM berth WHERE mask & ? = 0", (need(a, b),)).fetchall()
    # Tightest fit first; seniors get lower berths first; then by berth number.
    rows.sort(key=lambda r: (waste(r[2], a, b), senior and r[1] != "LB", r[0]))
    return rows[0][0] if rows else None


async def book(db: sqlite3.Connection, a: int, b: int, senior: bool, stats: dict) -> int | None:
    n = need(a, b)
    berth_id = best_berth(db, a, b, senior)  # what the user was shown
    await asyncio.sleep(0.02)  # the same slow work; the choice above is now stale
    while berth_id is not None:
        with db:  # one short transaction: the check and the take are one statement
            taken = db.execute(
                "UPDATE berth SET mask = mask | ? WHERE id = ? AND mask & ? = 0", (n, berth_id, n)
            ).rowcount
            if taken:
                db.execute("INSERT INTO booking (berth_id, from_idx, to_idx) VALUES (?, ?, ?)", (berth_id, a, b))
                return berth_id
        stats["retries"] += 1  # an overlapping journey got this berth first: re-read, choose again
        berth_id = best_berth(db, a, b, senior)
    return None


def overlaps(path: str) -> int:
    """Pairs of bookings on the same berth that share at least one segment."""
    db = sqlite3.connect(path)
    pairs = db.execute("""
        SELECT COUNT(*) FROM booking x JOIN booking y
          ON x.berth_id = y.berth_id AND x.id < y.id
         AND x.from_idx < y.to_idx AND y.from_idx < x.to_idx
    """).fetchone()[0]
    db.close()
    return pairs


async def run(label: str, correct: bool) -> None:
    path = os.path.join(tempfile.mkdtemp(), "inventory.db")
    setup(path)
    seed = 7

    def rand(n: int) -> int:  # tiny LCG, so the JavaScript version gets the same journeys
        nonlocal seed
        seed = (seed * 1103515245 + 12345) % 2**31
        return seed % n

    journeys = []
    for _ in range(40):
        a = rand(SEGMENTS)
        journeys.append((a, a + 1 + rand(min(3, SEGMENTS - a)), rand(4) == 0))
    stats = {"retries": 0}

    async def one(a: int, b: int, senior: bool) -> int | None:
        db = sqlite3.connect(path, isolation_level=None if not correct else "DEFERRED")
        try:
            return await (book(db, a, b, senior, stats) if correct else book_naive(db, a, b))
        finally:
            db.close()

    results = await asyncio.gather(*(one(*j) for j in journeys))
    booked = sum(r is not None for r in results)
    print(f"{label:<8} {booked:>2} of 40 booked, {overlaps(path):>3} overlapping pairs, {stats['retries']:>2} retries")


async def main() -> None:
    print("8 berths x 7 segments (NDLS..NGP); 40 concurrent requests, 20 ms of work each\n")
    await run("naive", correct=False)
    await run("correct", correct=True)
    show = lambda m: "".join(str(m >> s & 1) for s in range(SEGMENTS))  # segment 0 first
    print(f"\nbitmask check: berth booked NDLS-AGC {show(need(0, 2))}, "
          f"journey AGC-BPL needs {show(need(2, 5))}, AND = {need(0, 2) & need(2, 5)} -> it fits")


if __name__ == "__main__":
    asyncio.run(main())
