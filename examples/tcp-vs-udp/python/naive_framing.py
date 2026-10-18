"""The bug almost everyone writes first: treating each recv() on a TCP socket as one message.

A quiz server receives score updates as JSON over TCP. The client sends five small messages and
one big one. The server, busy for a moment, then reads with recv() and parses each chunk as a
message. TCP is a byte stream, so chunks and messages do not line up.

Run: python naive_framing.py
"""

import json
import socket
import threading
import time

HOST = "127.0.0.1"


def server(listener: socket.socket, done: threading.Event) -> None:
    conn, _ = listener.accept()
    with conn:
        time.sleep(0.05)  # the server was busy for 50 ms; bytes piled up in the kernel buffer
        reads = 0
        while True:
            chunk = conn.recv(65536)  # "one recv = one message" -- the naive assumption
            if not chunk:
                break
            reads += 1
            start = chunk[:24].decode(errors="replace")
            try:
                message = json.loads(chunk)
                print(f"  recv #{reads}: {len(chunk):>6} bytes, starts {start!r} -> parsed {message['type']}")
            except json.JSONDecodeError as err:
                print(f"  recv #{reads}: {len(chunk):>6} bytes, starts {start!r} -> {err.msg}")
    done.set()


def main() -> None:
    listener = socket.create_server((HOST, 0))
    port = listener.getsockname()[1]
    done = threading.Event()
    threading.Thread(target=server, args=(listener, done), daemon=True).start()

    messages = [{"type": "score", "player": f"p{i}", "points": 10 * i} for i in range(1, 6)]
    messages.append({"type": "leaderboard", "rows": [{"player": f"p{i}", "points": i} for i in range(6000)]})

    with socket.create_connection((HOST, port)) as client:
        for m in messages:
            client.sendall(json.dumps(m).encode())  # six separate sends...
    done.wait(5)
    sizes = [len(json.dumps(m)) for m in messages]
    print(f"\nclient: {len(messages)} send() calls of {sizes} bytes")
    print("server: the reads above. Message boundaries did not survive the trip.")


if __name__ == "__main__":
    main()
