"""What a TLS client checks, and what happens when you turn the checks off.

A local TLS server presents a different certificate in each case. The client trusts only our test
root CA (run ../make-certs.sh first). Standard library only.
"""

import socket
import ssl
import threading
from pathlib import Path

CERTS = Path(__file__).resolve().parent.parent / "certs"

CASES = [  # (label, certificate chain the server sends, its key)
    ("good: leaf + intermediate", "server-fullchain.pem", "server.key"),
    ("missing intermediate", "server.pem", "server.key"),
    ("expired", "expired-fullchain.pem", "server.key"),
    ("wrong name", "wrongname-fullchain.pem", "server.key"),
    ("impostor's own CA", "rogue.pem", "rogue.key"),
]


def serve_once(chain: str, key: str) -> int:
    """Start a TLS server that answers one connection with a line of text. Returns its port."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERTS / chain, CERTS / key)
    listener = socket.create_server(("127.0.0.1", 0))

    def run() -> None:
        with listener:
            conn, _ = listener.accept()
            try:
                with context.wrap_socket(conn, server_side=True) as tls:
                    secret = tls.recv(1024)  # whatever the client sends us
                    tls.sendall(b"server got: " + secret)
            except (ssl.SSLError, OSError):
                pass  # the client hung up during the handshake: that is the point of most cases

    threading.Thread(target=run, daemon=True).start()
    return listener.getsockname()[1]


def connect(port: int, context: ssl.SSLContext) -> str:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        # server_hostname turns on two things: SNI, and checking the name in the certificate
        with context.wrap_socket(raw, server_hostname="localhost") as tls:
            tls.sendall(b"password=hunter2")
            reply = tls.recv(1024).decode()
            return f"OK  {tls.version()} {tls.cipher()[0]} -> {reply!r}"


def main() -> None:
    # The right client: default checks on, trusting only the CA we chose.
    strict = ssl.create_default_context(cafile=CERTS / "root.pem")

    print("Client with verification on (the default):")
    for label, chain, key in CASES:
        try:
            result = connect(serve_once(chain, key), strict)
        except ssl.SSLCertVerificationError as err:
            result = f"REFUSED  {err.verify_message}"
        print(f"  {label:<27} {result}")

    # The "fix" people paste from the internet when they see CERTIFICATE_VERIFY_FAILED.
    lax = ssl.create_default_context()
    lax.check_hostname = False
    lax.verify_mode = ssl.CERT_NONE

    print("\nClient with verify=False (CERT_NONE, no hostname check):")
    for label, chain, key in CASES:
        print(f"  {label:<27} {connect(serve_once(chain, key), lax)}")


if __name__ == "__main__":
    main()
