"""Mutual TLS: the server checks the client's certificate too, then authorizes by identity.

A payments service accepts connections only from services holding a certificate from our CA, reads
the caller's SPIFFE ID from the certificate, and decides what that caller may do. Run
../make-certs.sh first. Standard library only.
"""

import socket
import ssl
import threading
from pathlib import Path

CERTS = Path(__file__).resolve().parent.parent / "certs"

# Authorization: which identity may call which operation. Authentication (the certificate) says
# who is calling; this table says what they are allowed to do.
ALLOWED = {
    "spiffe://shop.internal/orders": {"POST /charge"},
    "spiffe://shop.internal/reports": {"GET /summary"},
}


def caller_identity(cert: dict) -> str | None:
    """The URI in the certificate's Subject Alternative Name, e.g. spiffe://shop.internal/orders."""
    return next((value for kind, value in cert.get("subjectAltName", ()) if kind == "URI"), None)


def payments_server() -> int:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERTS / "server-fullchain.pem", CERTS / "server.key")
    context.verify_mode = ssl.CERT_REQUIRED  # this one line is what makes it *mutual* TLS
    context.load_verify_locations(CERTS / "root.pem")  # client certs must chain to our root
    listener = socket.create_server(("127.0.0.1", 0))

    def handle(conn: socket.socket) -> None:
        spare = conn.dup()  # wrap_socket() takes over conn; keep a handle for the failure path
        try:
            with context.wrap_socket(conn, server_side=True) as tls:
                who = caller_identity(tls.getpeercert())
                operation = tls.recv(1024).decode().strip()
                allowed = operation in ALLOWED.get(who, set())
                tls.sendall(f"{'200 OK' if allowed else '403 Forbidden'} for {who}".encode())
        except (ssl.SSLError, OSError):
            # No certificate, or one we do not trust: the handshake failed and OpenSSL has sent
            # an alert. Read what the client already sent before closing, so the close is a
            # clean FIN and the alert is not lost to a TCP reset (Windows does that).
            spare.settimeout(2)
            try:
                while spare.recv(65536):  # until the client, having read the alert, hangs up
                    pass
            except OSError:
                pass
        finally:
            spare.close()

    def run() -> None:
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=run, daemon=True).start()
    return listener.getsockname()[1]


def call(port: int, client_cert: str | None, operation: str) -> str:
    context = ssl.create_default_context(cafile=CERTS / "root.pem")
    if client_cert:
        context.load_cert_chain(CERTS / f"{client_cert}-fullchain.pem", CERTS / f"{client_cert}.key")
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
            with context.wrap_socket(raw, server_hostname="localhost") as tls:
                tls.sendall(operation.encode())
                return tls.recv(1024).decode()
    except ssl.SSLError as err:
        # In TLS 1.3 the client finishes its side of the handshake first, so the server's
        # rejection arrives as an alert on the first read.
        return f"refused: {err.reason}"


def main() -> None:
    port = payments_server()
    for cert, operation in [
        (None, "POST /charge"),
        ("orders", "POST /charge"),
        ("reports", "GET /summary"),
        ("reports", "POST /charge"),
    ]:
        print(f"  {str(cert or 'no cert'):<8} {operation:<13} -> {call(port, cert, operation)}")


if __name__ == "__main__":
    main()
