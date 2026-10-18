"""Length-prefixed framing: the fix for "one recv = one message".

Every message goes out as a 4-byte big-endian length followed by that many bytes of JSON. The
reader keeps calling recv() until it has exactly the bytes it needs, however TCP chunks them.
Same traffic as naive_framing.py.

Run: python framing.py
"""

import json
import socket
import struct
import threading
import time

HOST = "127.0.0.1"
HEADER = struct.Struct(">I")  # 4-byte unsigned length, network byte order
MAX_MESSAGE = 1 << 20  # refuse anything over 1 MB: a bad length must not make us allocate 4 GB


class ConnectionClosed(Exception):
    pass


def send_message(sock: socket.socket, message: dict) -> None:
    body = json.dumps(message).encode()
    sock.sendall(HEADER.pack(len(body)) + body)  # one buffer: header and body leave together


def recv_exactly(sock: socket.socket, n: int) -> bytes:
    """Read exactly n bytes. recv() may return fewer than asked for, so loop."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(min(n - len(buf), 65536))
        if not chunk:  # the peer closed: clean only if we were between messages
            raise ConnectionClosed("peer closed mid-message" if buf else "peer closed")
        buf += chunk
    return bytes(buf)


def recv_message(sock: socket.socket) -> dict:
    (length,) = HEADER.unpack(recv_exactly(sock, HEADER.size))
    if length > MAX_MESSAGE:
        raise ValueError(f"message of {length} bytes is over the {MAX_MESSAGE}-byte limit")
    return json.loads(recv_exactly(sock, length))


def server(listener: socket.socket, done: threading.Event) -> None:
    conn, _ = listener.accept()
    with conn:
        time.sleep(0.05)  # busy for 50 ms, exactly as before
        count = 0
        while True:
            try:
                message = recv_message(conn)
            except ConnectionClosed:
                break
            count += 1
            size = len(json.dumps(message))
            print(f"  message #{count}: {size:>6} bytes -> parsed {message['type']}")
    done.set()


def main() -> None:
    listener = socket.create_server((HOST, 0))
    done = threading.Event()
    threading.Thread(target=server, args=(listener, done), daemon=True).start()

    messages = [{"type": "score", "player": f"p{i}", "points": 10 * i} for i in range(1, 6)]
    messages.append({"type": "leaderboard", "rows": [{"player": f"p{i}", "points": i} for i in range(6000)]})

    with socket.create_connection((HOST, listener.getsockname()[1])) as client:
        for m in messages:
            send_message(client, m)
    done.wait(5)
    print(f"\n{len(messages)} messages sent, every one parsed, whatever the chunks looked like.")


if __name__ == "__main__":
    main()
