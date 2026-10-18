"""Nagle's algorithm meets delayed ACKs: the mysterious 40 ms.

The client sends each request in two writes, a 4-byte length header and then the body, and then
waits for the reply (write-write-read). With Nagle's algorithm on, the second small write is held
back until the first is acknowledged. The server has nothing to say until it has the whole
request, so it delays its ACK, hoping to piggyback it on a reply. Each side waits for the other
until the delayed-ACK timer fires.

Three clients, 50 requests each on one connection:
  nagle on        two writes, default socket options
  TCP_NODELAY     two writes, Nagle switched off
  one write       Nagle left on, but header and body sent in a single write

Run: python nagle.py      (the effect is clearest on Linux; see the README)
"""

import socket
import statistics
import struct
import threading
import time

HOST = "127.0.0.1"
REQUESTS = 50


def recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def serve(listener: socket.socket) -> None:
    while True:
        conn, _ = listener.accept()
        with conn:
            try:
                while True:
                    (length,) = struct.unpack(">I", recv_exactly(conn, 4))
                    recv_exactly(conn, length)  # cannot answer until the whole request is here
                    conn.sendall(b"OK")
            except ConnectionError:
                pass


def client(port: int, nodelay: bool, one_write: bool) -> list[float]:
    timings = []
    with socket.create_connection((HOST, port)) as sock:
        if nodelay:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        body = b'{"op": "get", "key": "user:42"}'
        for _ in range(REQUESTS):
            start = time.perf_counter()
            header = struct.pack(">I", len(body))
            if one_write:
                sock.sendall(header + body)
            else:
                sock.sendall(header)  # write...
                sock.sendall(body)  # ...write...
            recv_exactly(sock, 2)  # ...read
            timings.append((time.perf_counter() - start) * 1000)
    return timings[10:]  # skip the first few: Linux ACKs at once early in a connection


def main() -> None:
    listener = socket.create_server((HOST, 0))
    threading.Thread(target=serve, args=(listener,), daemon=True).start()
    port = listener.getsockname()[1]
    for label, nodelay, one_write in [("nagle on, two writes", False, False),
                                      ("TCP_NODELAY, two writes", True, False),
                                      ("nagle on, one write", False, True)]:
        t = client(port, nodelay, one_write)
        print(f"{label:<24} median {statistics.median(t):6.2f} ms   worst {max(t):6.2f} ms")


if __name__ == "__main__":
    main()
