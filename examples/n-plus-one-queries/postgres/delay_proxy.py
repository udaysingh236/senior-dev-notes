"""A TCP proxy that delays every chunk by half a round trip in each direction.

Stands in for the network between an app server and its database, so the same benchmark can
run with the database "in another availability zone" on one machine. Also counts the bytes the
server sends, so we can compare how much data each loading strategy moves.

    python3 delay_proxy.py LISTEN_PORT TARGET_HOST TARGET_PORT RTT_MS

Prints one line per closed connection: bytes sent to the server, bytes received from it.
Threads and time.sleep, not asyncio: the event loop's timers round up to whole milliseconds,
which would turn a 1 ms round trip into 3.
"""

import queue
import socket
import sys
import threading
import time


def pump(src: socket.socket, dst: socket.socket, delay: float, counter: list[int]) -> None:
    """Copies src to dst, holding each chunk back by `delay` seconds, in order."""
    pending: queue.Queue[tuple[float, bytes]] = queue.Queue()

    def deliver() -> None:
        while True:
            due, data = pending.get()
            if not data:
                break
            wait = due - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            dst.sendall(data)
        dst.shutdown(socket.SHUT_WR)

    sender = threading.Thread(target=deliver, daemon=True)
    sender.start()
    try:
        while data := src.recv(65536):
            counter[0] += len(data)
            pending.put((time.monotonic() + delay, data))
    except OSError:
        pass
    pending.put((0.0, b""))
    sender.join()


def handle(client: socket.socket, target: tuple[str, int], one_way: float) -> None:
    server = socket.create_connection(target)
    for s in (client, server):
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    up, down = [0], [0]
    t = threading.Thread(target=pump, args=(client, server, one_way, up), daemon=True)
    t.start()
    pump(server, client, one_way, down)
    t.join()
    client.close()
    server.close()
    print(f"connection closed: {up[0]} bytes up, {down[0]} bytes down", flush=True)


def main() -> None:
    listen_port, host, port, rtt_ms = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
    listener = socket.create_server(("127.0.0.1", listen_port), reuse_port=False)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=handle, args=(client, (host, port), rtt_ms / 2000), daemon=True).start()


if __name__ == "__main__":
    main()
