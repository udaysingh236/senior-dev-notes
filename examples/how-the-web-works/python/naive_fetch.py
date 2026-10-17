"""The way most of us first fetch a page: one call, no timeout, one number at the end.

Standard library only. Run:  python naive_fetch.py

It works, and it tells you nothing. When the page is slow you cannot see which step was slow,
and when a step never answers, the call waits for as long as the operating system lets it.
"""

from __future__ import annotations

import threading
import time
import urllib.request


def naive_fetch(url: str) -> None:
    started = time.perf_counter()
    with urllib.request.urlopen(url) as response:  # no timeout: waits as long as the OS allows
        body = response.read()
    elapsed = (time.perf_counter() - started) * 1000
    print(f"{url}: {response.status}, {len(body)} bytes in {elapsed:.0f} ms. Which part was slow? No idea.")


if __name__ == "__main__":
    naive_fetch("https://example.com/")

    # 10.255.255.1 is a private address that nothing answers on most networks, so the TCP
    # handshake never completes. Run the naive fetch in the background and check on it.
    worker = threading.Thread(target=naive_fetch, args=("http://10.255.255.1/",), daemon=True)
    started = time.perf_counter()
    worker.start()
    worker.join(timeout=5)
    if worker.is_alive():
        print(f"http://10.255.255.1/: still waiting after {time.perf_counter() - started:.1f} s, "
              "with no error and no idea why. Giving up on it.")
