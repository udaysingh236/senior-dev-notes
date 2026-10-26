"""A small, correct connection pool, and three experiments with it.

Standard library only. The "database" is a stand-in whose connect() sleeps 10 ms (about what our
PostgreSQL measured for TCP + TLS + SCRAM on localhost) and whose queries sleep 1 ms, so the
experiments show the pool's behaviour without needing a server. The pool itself is the real thing:
swap FakeDatabase.connect for psycopg.connect and it works the same way.

Run: python3 pool.py
"""
from __future__ import annotations

import random
import threading
import time
from collections import deque
from contextlib import contextmanager

CONNECT_S = 0.010  # opening a connection
QUERY_S = 0.001  # one query on an open connection


class FakeDatabase:
    """Counts connections the way max_connections would see them."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.open_now = 0
        self.opened_total = 0
        self.peak = 0

    def connect(self) -> FakeConnection:
        time.sleep(CONNECT_S)  # TCP, TLS, authentication, a new backend process
        with self.lock:
            self.open_now += 1
            self.opened_total += 1
            self.peak = max(self.peak, self.open_now)
        return FakeConnection(self)


class FakeConnection:
    def __init__(self, db: FakeDatabase) -> None:
        self.db = db
        self.created = time.monotonic()
        self.in_transaction = False

    def execute(self, sql: str) -> None:
        if sql == "BEGIN":
            self.in_transaction = True
        elif sql in ("COMMIT", "ROLLBACK"):
            self.in_transaction = False
        time.sleep(QUERY_S)

    def close(self) -> None:
        with self.db.lock:
            self.db.open_now -= 1


class PoolTimeout(Exception):
    pass


class Pool:
    """A bounded pool: at most max_size connections, callers wait up to `timeout` seconds."""

    def __init__(self, connect, max_size: int, timeout: float, max_lifetime: float = 1800.0):
        self.connect, self.max_size, self.timeout = connect, max_size, timeout
        self.max_lifetime = max_lifetime
        self.idle: deque[FakeConnection] = deque()
        self.size = 0  # open connections, idle or in use
        self.cond = threading.Condition()

    def acquire(self) -> FakeConnection:
        deadline = time.monotonic() + self.timeout
        with self.cond:
            while True:
                if self.idle:  # 1. reuse an idle connection
                    return self.idle.pop()
                if self.size < self.max_size:  # 2. room to open one
                    self.size += 1
                    break
                left = deadline - time.monotonic()  # 3. wait for a release, but not forever
                if left <= 0:
                    raise PoolTimeout(f"no connection within {self.timeout}s ({self.size} in use)")
                self.cond.wait(left)
        try:
            return self.connect()  # outside the lock: connecting is slow
        except BaseException:
            with self.cond:
                self.size -= 1
                self.cond.notify()
            raise

    def release(self, conn: FakeConnection, broken: bool = False) -> None:
        if conn.in_transaction and not broken:
            conn.execute("ROLLBACK")  # never hand the next caller someone else's transaction
        # Retire old connections, a little early at random so they do not all expire together.
        too_old = time.monotonic() - conn.created > self.max_lifetime * random.uniform(0.95, 1.0)
        with self.cond:
            if broken or too_old:
                conn.close()
                self.size -= 1
            else:
                self.idle.append(conn)
            self.cond.notify()

    @contextmanager
    def connection(self):
        conn = self.acquire()
        try:
            yield conn
        except BaseException:
            self.release(conn, broken=True)
            raise
        self.release(conn)


def run_requests(n: int, workers: int, handler) -> float:
    """Runs n requests on `workers` threads; returns elapsed seconds."""
    todo = iter(range(n))
    lock = threading.Lock()

    def worker() -> None:
        while True:
            with lock:
                if next(todo, None) is None:
                    return
            handler()

    start = time.monotonic()
    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return time.monotonic() - start


def experiment_connect_per_request() -> None:
    print("1. 400 requests, 8 threads, one query each")
    db = FakeDatabase()

    def connect_per_request() -> None:
        conn = db.connect()
        conn.execute("SELECT 1")
        conn.close()

    elapsed = run_requests(400, 8, connect_per_request)
    print(f"   new connection per request: {400 / elapsed:5.0f} req/s, {db.opened_total} connections opened")

    db = FakeDatabase()
    pool = Pool(db.connect, max_size=8, timeout=1.0)

    def pooled() -> None:
        with pool.connection() as conn:
            conn.execute("SELECT 1")

    elapsed = run_requests(400, 8, pooled)
    print(f"   pool of 8:                  {400 / elapsed:5.0f} req/s, {db.opened_total} connections opened")


def experiment_hold_time() -> None:
    print("2. 200 requests, 40 threads, pool of 4: what is done while holding the connection")
    for label, inside_call in (("payment call after COMMIT ", False), ("payment call inside the transaction", True)):
        db = FakeDatabase()
        pool = Pool(db.connect, max_size=4, timeout=5.0)

        def handler() -> None:
            with pool.connection() as conn:
                conn.execute("BEGIN")
                conn.execute("UPDATE orders SET status = 'paying' WHERE id = $1")
                if inside_call:
                    time.sleep(0.050)  # HTTP call to a payment provider, connection held
                conn.execute("COMMIT")
            if not inside_call:
                time.sleep(0.050)  # the same call, connection already returned

        elapsed = run_requests(200, 40, handler)
        print(f"   {label:<36} {200 / elapsed:5.0f} req/s")


def experiment_nested_acquire() -> None:
    print("3. pool of 2, two requests that each need a second connection while holding the first")
    db = FakeDatabase()
    pool = Pool(db.connect, max_size=2, timeout=0.5)
    barrier = threading.Barrier(2)

    def handler(name: str, delay: float) -> None:
        try:
            with pool.connection() as conn:
                conn.execute("BEGIN")
                barrier.wait()  # both now hold one connection each
                time.sleep(delay)
                with pool.connection() as audit:  # e.g. an audit log written "separately"
                    audit.execute("INSERT INTO audit_log ...")
                conn.execute("COMMIT")
            print(f"   {name}: done at {time.monotonic() - start:.1f}s")
        except PoolTimeout as err:
            print(f"   {name}: PoolTimeout at {time.monotonic() - start:.1f}s: {err}")

    start = time.monotonic()
    threads = [threading.Thread(target=handler, args=(f"request {i}", 0.1 * (i - 1))) for i in (1, 2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    experiment_connect_per_request()
    experiment_hold_time()
    experiment_nested_acquire()
