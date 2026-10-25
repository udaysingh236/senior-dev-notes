"""A micro-batcher in front of a backend with a fixed cost per call, measured with real timers.

The backend handles one call at a time (one disk, one connection) and each call costs 2 ms plus
0.05 ms per item. Writes arrive at random at a fixed rate (an open load: arrivals do not wait for
earlier writes to finish). Two writers:

  one at a time   one backend call per write
  batched         collect what is waiting; if only one or two writes are queued, wait up to 2 ms
                  for company; then send up to 100 in one call

Run: python micro_batcher.py   (timings vary a little from run to run)
"""
import asyncio
import random
import statistics
import time

OVERHEAD_S, PER_ITEM_S = 0.002, 0.00005


class Backend:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()  # one call at a time
        self.calls = 0

    async def write(self, items: list[int]) -> None:
        async with self.lock:
            self.calls += 1
            await asyncio.sleep(OVERHEAD_S + PER_ITEM_S * len(items))


class Batcher:
    def __init__(self, backend: Backend, window_s: float = 0.002, max_batch: int = 100) -> None:
        self.backend, self.window_s, self.max_batch = backend, window_s, max_batch
        self.pending: list[tuple[int, asyncio.Future]] = []
        self.wakeup = asyncio.Event()
        self.task = asyncio.create_task(self.run())

    async def write(self, item: int) -> None:
        done = asyncio.get_running_loop().create_future()
        self.pending.append((item, done))
        self.wakeup.set()
        await done  # resolves when the batch containing this write is stored

    async def run(self) -> None:
        while True:
            await self.wakeup.wait()
            self.wakeup.clear()
            if len(self.pending) < 3:
                await asyncio.sleep(self.window_s)  # a lone write waits a little for company
            batch, self.pending = self.pending[: self.max_batch], self.pending[self.max_batch:]
            if self.pending:
                self.wakeup.set()  # more are waiting: go round again straight after this call
            await self.backend.write([item for item, _ in batch])
            for _, done in batch:
                done.set_result(None)


async def run_load(rate: int, batched: bool, seconds: float = 2.0) -> str:
    backend = Backend()
    batcher = Batcher(backend) if batched else None
    rng = random.Random(42)
    latencies: list[float] = []

    async def one(i: int) -> None:
        start = time.perf_counter()
        if batcher:
            await batcher.write(i)
        else:
            await backend.write([i])
        latencies.append((time.perf_counter() - start) * 1000)

    begin = time.perf_counter()
    tasks, at = [], 0.0
    while at < seconds:  # open load: start each write on schedule, whatever the others are doing
        at += rng.expovariate(rate)
        await asyncio.sleep(max(0.0, begin + at - time.perf_counter()))
        tasks.append(asyncio.create_task(one(len(tasks))))
    await asyncio.gather(*tasks)
    took = time.perf_counter() - begin
    if batcher:
        batcher.task.cancel()
    q = statistics.quantiles(latencies, n=100)
    label = "batched" if batched else "one at a time"
    return (f"  {label:<13} {len(latencies) / took:>6.0f} writes/s   p50 {q[49]:>7.1f} ms   p99 {q[98]:>7.1f} ms"
            f"   {backend.calls} backend calls")


async def main() -> None:
    for rate in (100, 400, 1000):
        print(f"{rate} writes/s offered for 2 s:")
        print(await run_load(rate, batched=False))
        print(await run_load(rate, batched=True))


if __name__ == "__main__":
    asyncio.run(main())
