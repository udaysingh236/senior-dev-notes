"""What a TLS handshake costs on the real internet: TLS 1.2 vs TLS 1.3, and a resumed session.

Times the TCP connect (one round trip) and then the TLS handshake on top of it, several times,
and reports medians. Needs the internet. Standard library only.
"""

import socket
import ssl
import statistics
import time

HOST = "www.cloudflare.com"
ROUNDS = 7
# Look the address up once, so the timings below measure TCP and TLS, not DNS.
ADDRESS = socket.getaddrinfo(HOST, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4]


def pinned(version: ssl.TLSVersion) -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.minimum_version = context.maximum_version = version
    return context


# One context per version: a session can only be resumed through the context that created it.
CONTEXTS = {v: pinned(v) for v in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3)}


def handshake(version: ssl.TLSVersion, session: ssl.SSLSession | None = None):
    context = CONTEXTS[version]
    t0 = time.perf_counter()
    raw = socket.create_connection(ADDRESS, timeout=5)
    t1 = time.perf_counter()
    tls = context.wrap_socket(raw, server_hostname=HOST, session=session)  # handshake happens here
    t2 = time.perf_counter()
    # TLS 1.3 sends resumption tickets after the handshake, so make one request to receive them.
    tls.sendall(f"HEAD / HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n".encode())
    while tls.recv(65536):
        pass
    saved, reused = tls.session, tls.session_reused
    tls.close()
    return (t1 - t0) * 1000, (t2 - t1) * 1000, saved, reused


def main() -> None:
    rows = {"TLS 1.2, full": [], "TLS 1.3, full": [], "TLS 1.3, resumed": []}
    tcp = []
    reused_count = 0
    for _ in range(ROUNDS):
        c, h, _, _ = handshake(ssl.TLSVersion.TLSv1_2)
        tcp.append(c)
        rows["TLS 1.2, full"].append(h)
        c, h, session, _ = handshake(ssl.TLSVersion.TLSv1_3)
        tcp.append(c)
        rows["TLS 1.3, full"].append(h)
        c, h, _, reused = handshake(ssl.TLSVersion.TLSv1_3, session)
        tcp.append(c)
        rows["TLS 1.3, resumed"].append(h)
        reused_count += reused
        time.sleep(0.2)

    rtt = statistics.median(tcp)
    print(f"{HOST}, median of {ROUNDS} rounds")
    print(f"  TCP connect          {rtt:6.1f} ms   = one round trip")
    for label, times in rows.items():
        ms = statistics.median(times)
        print(f"  {label:<20} {ms:6.1f} ms   = {ms / rtt:.1f} round trips")
    print(f"  resumption accepted in {reused_count} of {ROUNDS} tries")


if __name__ == "__main__":
    main()
