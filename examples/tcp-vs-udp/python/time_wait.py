"""TIME-WAIT lands on whichever side closes first, and connection reuse makes it disappear.

A tiny server on 127.0.0.1 answers each 4-byte request with "OK\n". We make 500 requests three
ways and then count the sockets left in TIME_WAIT for that server's port, by reading
/proc/net/tcp (Linux only; on Windows or macOS run it in WSL or a container).

Run: python time_wait.py
"""

import socket
import threading

REQUESTS = 500
TIME_WAIT = "06"  # the state code in /proc/net/tcp


def time_wait_sockets(server_port: int) -> dict[str, int]:
    """Count TIME_WAIT sockets for one server port, split by which side holds them."""
    counts = {"client side": 0, "server side": 0}
    with open("/proc/net/tcp") as f:
        next(f)  # header line
        for line in f:
            fields = line.split()
            if fields[3] != TIME_WAIT:
                continue
            local_port = int(fields[1].split(":")[1], 16)
            remote_port = int(fields[2].split(":")[1], 16)
            if local_port == server_port:
                counts["server side"] += 1
            elif remote_port == server_port:
                counts["client side"] += 1
    return counts


def serve(listener: socket.socket, server_closes_first: bool) -> None:
    while True:
        conn, _ = listener.accept()
        with conn:
            # Requests are 4 bytes and the client waits for each answer, so one recv is one request.
            while conn.recv(4):
                conn.sendall(b"OK\n")
                if server_closes_first:
                    break  # answer, then close: the HTTP/1.0 way
            # otherwise recv() returned b"": the client closed first, and we close second


def request_per_connection(port: int, server_closes_first: bool) -> None:
    for _ in range(REQUESTS):
        with socket.create_connection(("127.0.0.1", port)) as s:
            s.sendall(b"GET\n")
            s.recv(3)
            if server_closes_first:
                s.recv(1)  # returns b"" once the server's FIN arrives; then we close second


def one_connection_for_all(port: int, server_closes_first: bool) -> None:
    with socket.create_connection(("127.0.0.1", port)) as s:
        for _ in range(REQUESTS):
            s.sendall(b"GET\n")
            s.recv(3)


def run(label: str, server_closes_first: bool, client) -> None:
    listener = socket.create_server(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    threading.Thread(target=serve, args=(listener, server_closes_first), daemon=True).start()
    client(port, server_closes_first)
    print(f"{label:<40} TIME_WAIT {time_wait_sockets(port)}")


if __name__ == "__main__":
    run("client closes first, 500 connections", False, request_per_connection)
    run("server closes first, 500 connections", True, request_per_connection)
    run("one connection reused for 500 requests", False, one_connection_for_all)

    with open("/proc/sys/net/ipv4/ip_local_port_range") as f:
        low, high = map(int, f.read().split())
    ports = high - low + 1
    print(f"\nephemeral ports {low}-{high}: {ports}. Linux keeps TIME_WAIT for 60 s, so one client")
    print(f"can open at most about {ports // 60} new connections a second to one server address and port.")
