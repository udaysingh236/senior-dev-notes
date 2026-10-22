"""The check-and-take as one SQL statement, run against SQLite from the standard library.

Run: python conditional_update.py
"""
import sqlite3

TAKE = """
UPDATE quota
SET    available = available - 2
WHERE  train = '12163' AND journey_date = '2026-10-24'
  AND  class = '3A' AND quota = 'TQ'
  AND  available >= 2;
"""

db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE quota (train TEXT, journey_date TEXT, class TEXT, quota TEXT, available INTEGER)")
db.execute("INSERT INTO quota VALUES ('12163', '2026-10-24', '3A', 'TQ', 5)")

for attempt in range(1, 5):
    rows = db.execute(TAKE).rowcount
    left = db.execute("SELECT available FROM quota").fetchone()[0]
    print(f"booking {attempt}: {rows} row(s) updated -> {'held 2 berths' if rows else 'not enough left'}, available {left}")
