"""What an on-path observer learns from TLS traffic it cannot decrypt.

A relay sits between a client and a TLS server, the way a Wi-Fi hotspot or any router does. It has
no keys. It forwards every byte unchanged and reads only what TLS leaves in the clear: the record
headers, the ClientHello, and, in TLS 1.2, the certificate. The client fetches two pages of
different sizes over TLS 1.3 and over TLS 1.2. Run ../make-certs.sh first. Standard library only.
"""

import socket
import ssl
import threading
from pathlib import Path

CERTS = Path(__file__).resolve().parent.parent / "certs"
PAGES = {"/dental": 1_200, "/hiv-test": 5_400}  # response body sizes in bytes


def records(stream: bytes) -> list[tuple[int, int]]:
    """Split raw TLS bytes into (content type, length) using only the 5-byte plain headers."""
    out, i = [], 0
    while i + 5 <= len(stream):
        length = int.from_bytes(stream[i + 3 : i + 5], "big")
        out.append((stream[i], length))
        i += 5 + length
    return out


def server_name(client_hello: bytes) -> str:
    """Walk the plaintext ClientHello to the server_name extension (type 0)."""
    i = 5 + 4 + 2 + 32  # record header, handshake header, version, random
    i += 1 + client_hello[i]  # session id
    i += 2 + int.from_bytes(client_hello[i : i + 2], "big")  # cipher suites
    i += 1 + client_hello[i]  # compression methods
    end = i + 2 + int.from_bytes(client_hello[i : i + 2], "big")
    i += 2
    while i < end:
        kind, size = int.from_bytes(client_hello[i : i + 2], "big"), int.from_bytes(client_hello[i + 2 : i + 4], "big")
        if kind == 0:  # list length (2), name type (1), name length (2), name
            return client_hello[i + 9 : i + 9 + int.from_bytes(client_hello[i + 7 : i + 9], "big")].decode()
        i += 4 + size
    return "(none)"


def tls_server() -> int:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERTS / "server-fullchain.pem", CERTS / "server.key")
    listener = socket.create_server(("127.0.0.1", 0))

    def run() -> None:
        while True:
            conn, _ = listener.accept()
            with context.wrap_socket(conn, server_side=True) as tls:
                path = tls.recv(1024).decode().split()[1]
                tls.sendall(b"x" * PAGES[path])

    threading.Thread(target=run, daemon=True).start()
    return listener.getsockname()[1]


def observe(server_port: int, version: ssl.TLSVersion, path: str) -> dict[str, bytes]:
    """Relay one connection through a keyless observer; return the raw bytes seen each way."""
    seen = {"up": b"", "down": b""}
    relay = socket.create_server(("127.0.0.1", 0))

    def pump(src: socket.socket, dst: socket.socket, way: str) -> None:
        while data := src.recv(65536):
            seen[way] += data
            dst.sendall(data)
        dst.shutdown(socket.SHUT_WR)

    def run() -> None:
        client, _ = relay.accept()
        upstream = socket.create_connection(("127.0.0.1", server_port))
        down = threading.Thread(target=pump, args=(upstream, client, "down"))
        down.start()
        pump(client, upstream, "up")
        down.join()

    worker = threading.Thread(target=run)
    worker.start()
    context = ssl.create_default_context(cafile=CERTS / "root.pem")
    context.maximum_version = version
    with socket.create_connection(relay.getsockname()) as raw:
        with context.wrap_socket(raw, server_hostname="clinic.example.in") as tls:
            tls.sendall(f"GET {path} HTTP/1.1\r\n\r\n".encode())
            body = b""
            while len(body) < PAGES[path]:
                body += tls.recv(65536)
    worker.join()
    return seen


def main() -> None:
    port = tls_server()
    for label, version in [("TLS 1.3", ssl.TLSVersion.TLSv1_3), ("TLS 1.2", ssl.TLSVersion.TLSv1_2)]:
        for path in PAGES:
            seen = observe(port, version, path)
            up, down = records(seen["up"]), records(seen["down"])
            print(f"{label}  GET {path}")
            print(f"  server name (SNI), in the clear:  {server_name(seen['up'])}")
            print(f"  CA name readable on the wire:     {b'SDN Test Issuing CA 1' in seen['down']}")
            print(f"  request record:                   {up[-1][1]:,} bytes")
            print(f"  response record:                  {down[-1][1]:,} bytes, for a {PAGES[path]:,}-byte page")

if __name__ == "__main__":
    main()
