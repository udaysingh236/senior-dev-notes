"""The same question over UDP and over TCP, against a real server on the internet.

We ask Cloudflare's public resolver 1.1.1.1 for the A record of example.com. Over UDP that is one
datagram out and one back. Over TCP we first pay for the handshake, then send the same bytes with
a 2-byte length prefix (DNS over TCP frames its messages exactly like framing.py). Then we ask
again on the open TCP connection to see what reuse buys.

Run: python dns_udp_vs_tcp.py      (needs outgoing UDP and TCP to port 53)
"""

import secrets
import socket
import statistics
import struct
import time

SERVER = ("1.1.1.1", 53)
ROUNDS = 7


def query(name: str) -> bytes:
    """A minimal DNS query: header with recursion desired, one question, type A, class IN."""
    header = struct.pack(">HHHHHH", secrets.randbits(16), 0x0100, 1, 0, 0, 0)
    labels = b"".join(bytes([len(p)]) + p.encode() for p in name.split("."))
    return header + labels + b"\x00" + struct.pack(">HH", 1, 1)


def recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def ms(seconds: float) -> str:
    return f"{seconds * 1000:5.1f} ms"


def main() -> None:
    q = query("example.com")
    udp, tcp_connect, tcp_first, tcp_reused = [], [], [], []
    for _ in range(ROUNDS):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2)
            t = time.perf_counter()
            s.sendto(q, SERVER)
            s.recvfrom(4096)
            udp.append(time.perf_counter() - t)

        t = time.perf_counter()
        with socket.create_connection(SERVER, timeout=2) as s:
            tcp_connect.append(time.perf_counter() - t)  # SYN, SYN-ACK: one round trip
            for timings in (tcp_first, tcp_reused):
                t2 = time.perf_counter()
                s.sendall(struct.pack(">H", len(q)) + q)  # 2-byte length, then the message
                (length,) = struct.unpack(">H", recv_exactly(s, 2))
                recv_exactly(s, length)
                timings.append(time.perf_counter() - t2)
        time.sleep(0.2)

    med = statistics.median
    print(f"median of {ROUNDS} rounds, asking {SERVER[0]} for example.com A")
    print(f"  UDP                        {ms(med(udp))}   one round trip, no setup")
    print(f"  TCP, new connection        {ms(med(tcp_connect) + med(tcp_first))}   "
          f"= connect {ms(med(tcp_connect)).strip()} + query {ms(med(tcp_first)).strip()}")
    print(f"  TCP, connection reused     {ms(med(tcp_reused))}   the handshake is already paid for")


if __name__ == "__main__":
    main()
