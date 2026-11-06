"""POST /payments with an Idempotency-Key, two ways, over SQLite and a fake bank.

naive  checks whether the key exists, charges, then records the key.
keyed  claims the key first (a lock with a lease), creates the payment in the same transaction,
       charges with a downstream key derived from the payment, and finishes in a fenced update.

Three scenarios run against both: a duplicate that arrives while the first attempt is still
charging, a process that dies after the bank said yes, and a key reused with a different amount.
Run: python3 payments.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager

LEASE_S = 1.0  # demo value: longer than the 0.3 s bank call. In production, longer than the
               # slowest attempt can run (tens of seconds), never shorter


class Bank:
    """A fake payment processor. Like real ones, it honours its own idempotency key if given one."""

    def __init__(self, latency_s: float = 0.3):
        self.latency_s = latency_s
        self.charges: list[int] = []  # every time money actually moved
        self._by_ref: dict[str, str] = {}
        self._lock = threading.Lock()

    def charge(self, amount: int, ref: str | None = None) -> str:
        time.sleep(self.latency_s)
        with self._lock:
            if ref is not None and ref in self._by_ref:
                return self._by_ref[ref]  # a repeat: same answer, no second charge
            self.charges.append(amount)
            charge_id = f"ch_{len(self.charges)}"
            if ref is not None:
                self._by_ref[ref] = charge_id
            return charge_id


class Crash(Exception):
    """Stands in for the process dying: nothing after this line runs."""


SCHEMA = """
CREATE TABLE naive_keys (account_id TEXT, key TEXT, status INTEGER, body TEXT,
                         PRIMARY KEY (account_id, key));
CREATE TABLE idempotency_keys (
  account_id     TEXT NOT NULL,
  key            TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,       -- hash of the request body, to catch a reused key
  recovery_point TEXT NOT NULL,       -- 'created' -> 'finished'
  owner          TEXT,                -- the attempt holding the lease (for fencing)
  locked_until   REAL,                -- the lease; NULL once finished
  payment_id     TEXT NOT NULL,
  status         INTEGER,             -- the stored response, replayed to every retry
  body           TEXT,
  created_at     REAL NOT NULL,
  PRIMARY KEY (account_id, key)       -- scope keys per account
);
CREATE TABLE payments (id TEXT PRIMARY KEY, account_id TEXT, amount INTEGER,
                       state TEXT, charge_id TEXT);
"""


def connect(path: str) -> sqlite3.Connection:
    # isolation_level=None: we issue BEGIN/COMMIT ourselves. One connection per thread.
    return sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)


@contextmanager
def transaction(db: sqlite3.Connection):
    db.execute("BEGIN IMMEDIATE")  # take SQLite's write lock now, not at the first write
    try:
        yield
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise


def fingerprint(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


# --- naive: check, then act -------------------------------------------------------------------

def pay_naive(db, bank, account: str, key: str, amount: int, crash_after_charge=False):
    row = db.execute("SELECT status, body FROM naive_keys WHERE account_id = ? AND key = ?",
                     (account, key)).fetchone()
    if row:
        return row[0], json.loads(row[1])           # seen before: replay
    charge_id = bank.charge(amount)                 # the money moves here...
    if crash_after_charge:
        raise Crash()                               # ...and the key was never written
    body = {"charge": charge_id, "amount": amount}
    try:
        db.execute("INSERT INTO naive_keys VALUES (?, ?, 201, ?)", (account, key, json.dumps(body)))
    except sqlite3.IntegrityError:                  # a concurrent attempt got here first:
        return 500, {"error": "duplicate key"}      # the constraint fired after the money left
    return 201, body


# --- keyed: claim, charge with a downstream key, finish under the lease --------------------------

def claim(db, account: str, key: str, body: dict, me: str):
    """Phase 1, one local transaction. Returns (payment_id, None) to proceed, or (None, response)."""
    fp, now = fingerprint(body), time.time()
    with transaction(db):
        inserted = db.execute(
            """INSERT INTO idempotency_keys (account_id, key, fingerprint, recovery_point, owner,
                                             locked_until, payment_id, created_at)
               VALUES (?, ?, ?, 'created', ?, ?, ?, ?) ON CONFLICT DO NOTHING""",
            (account, key, fp, me, now + LEASE_S, f"pay_{uuid.uuid4().hex[:8]}", now)).rowcount
        row = db.execute("""SELECT fingerprint, recovery_point, owner, locked_until, payment_id,
                                   status, body FROM idempotency_keys
                            WHERE account_id = ? AND key = ?""", (account, key)).fetchone()
        stored_fp, point, owner, locked_until, payment_id, status, stored = row
        if stored_fp != fp:
            return None, (422, {"error": "Idempotency-Key reused with a different body"})
        if point == "finished":
            return None, (status, json.loads(stored))   # replay the first outcome
        if inserted:                                    # first attempt: create the payment too
            db.execute("INSERT INTO payments VALUES (?, ?, ?, 'pending', NULL)",
                       (payment_id, account, body["amount"]))
        elif locked_until > now:
            return None, (409, {"error": "a request with this key is in progress"})
        else:                                           # the lease ran out: take it over
            db.execute("""UPDATE idempotency_keys SET owner = ?, locked_until = ?
                          WHERE account_id = ? AND key = ?""", (me, now + LEASE_S, account, key))
    return payment_id, None


def pay_keyed(db, bank, account: str, key: str, amount: int, crash_after_charge=False):
    me, body = uuid.uuid4().hex, {"amount": amount}
    payment_id, early = claim(db, account, key, body, me)
    if early:
        return early
    # Phase 2, remote. Our payment id is the bank's idempotency key, so a second owner that
    # repeats this call after a crash gets the same charge back instead of a new one.
    charge_id = bank.charge(amount, ref=payment_id)
    if crash_after_charge:
        raise Crash()
    response = {"payment": payment_id, "charge": charge_id, "amount": amount}
    # Phase 3, one local transaction, fenced: it only commits if we still hold the lease.
    with transaction(db):
        done = db.execute("""UPDATE idempotency_keys
                             SET recovery_point = 'finished', status = 201, body = ?,
                                 owner = NULL, locked_until = NULL
                             WHERE account_id = ? AND key = ? AND owner = ?""",
                          (json.dumps(response), account, key, me)).rowcount
        if not done:  # someone took the lease over: they will finish it, not us
            return 409, {"error": "a request with this key is in progress"}
        db.execute("UPDATE payments SET state = 'paid', charge_id = ? WHERE id = ?",
                   (charge_id, payment_id))
    return 201, response


# --- the scenarios ----------------------------------------------------------------------------

def attempt(handler, path, bank, key, amount, results, label, **kw):
    db = connect(path)
    try:
        status, _ = handler(db, bank, "acct_42", key, amount, **kw)
        results.append(f"{label}:{status}")
    except Crash:
        results.append(f"{label}:crash")
    finally:
        db.close()


def run(handler, scenario: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    setup = connect(path)
    setup.executescript(SCHEMA)
    setup.close()
    bank, results, key = Bank(latency_s=0.3), [], str(uuid.uuid4())

    def go(label, amount=1199, delay=0.0, **kw):
        time.sleep(delay)
        attempt(handler, path, bank, key, amount, results, label, **kw)

    if scenario == "duplicate":  # the retry arrives 0.1 s into a 0.3 s charge
        first = threading.Thread(target=go, args=("1",))
        second = threading.Thread(target=go, args=("2",), kwargs={"delay": 0.1})
        first.start(); second.start(); first.join(); second.join()
        go("3")                                       # a later retry, after both finished
    elif scenario == "crash":   # the process dies after the bank said yes
        go("1", crash_after_charge=True)
        go("2")                                       # at once: the dead attempt still holds the lease
        go("3", delay=LEASE_S)                        # after the lease: take over and resume
    elif scenario == "mismatch":  # a client bug: the key is reused for a different amount
        go("1")
        go("2", amount=2500)
    os.remove(path)
    charged = "1 charge " if len(bank.charges) == 1 else f"{len(bank.charges)} charges"
    return f"{charged}  {' '.join(results)}"


if __name__ == "__main__":
    print(f"{'scenario':<30}  {'naive':<30}  keyed")
    for scenario, title in [("duplicate", "duplicate while first runs"),
                            ("crash", "crash after the bank said yes"),
                            ("mismatch", "same key, different amount")]:
        print(f"{title:<30}  {run(pay_naive, scenario):<30}  {run(pay_keyed, scenario)}")
