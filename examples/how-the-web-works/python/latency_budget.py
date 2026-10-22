"""Where the time goes when a browser fetches one HTML response on a new connection.

A latency budget in round trips: the naive estimate (size / bandwidth) against a model that counts
DNS, connection set-up, the request, server work and TCP slow start. No network needed.

Run: python latency_budget.py
"""

import math

MSS = 1460  # bytes of payload in one TCP packet
INITCWND = 10  # packets in the first round trip of data (RFC 6928)


def data_rounds(size_bytes: int, initcwnd: int = INITCWND) -> int:
    """Round trips of data a fresh connection needs: the window doubles every round trip."""
    packets = math.ceil(size_bytes / MSS)
    rounds, window = 0, initcwnd
    while packets > 0:
        packets -= window
        window *= 2
        rounds += 1
    return rounds


def naive_ms(size_kb: int, mbps: float) -> float:
    """What most people estimate: bytes divided by bandwidth."""
    return size_kb * 1000 * 8 / (mbps * 1000)


def fetch_ms(size_kb: int, rtt: float, mbps: float, server: float = 50, dns: float = 40,
             setup_rtts: int = 2, origin_rtt: float = 0) -> float:
    """First byte to last byte of one response on a new connection.

    setup_rtts: 2 for TCP + TLS 1.3, 1 for QUIC, 0 for a connection that is already open.
    origin_rtt: for an edge that forwards to the origin on its own open, warm connection.
    """
    rounds = data_rounds(size_kb * 1000)
    wire = naive_ms(size_kb, mbps)  # the bandwidth term: only matters once the window is large
    return dns + setup_rtts * rtt + rtt + origin_rtt + server + (rounds - 1) * rtt + wire


if __name__ == "__main__":
    size = 100  # KB of HTML
    print(f"{size} KB of HTML on a new connection, TCP + TLS 1.3, 50 ms of server work\n")
    print(f"{'RTT':>6} {'bandwidth':>10} {'naive':>8} {'real':>8}")
    for rtt in (20, 75, 150):
        for mbps in (10, 100, 1000):
            print(f"{rtt:>4} ms {mbps:>5} Mbit/s {naive_ms(size, mbps):>5.1f} ms "
                  f"{fetch_ms(size, rtt, mbps):>5.0f} ms")

    print(f"\nRound trips of data for a fresh window of {INITCWND} packets:")
    for kb in (14, 15, 30, 100, 1000):
        print(f"  {kb:>4} KB -> {data_rounds(kb * 1000)}")

    direct = fetch_ms(30, rtt=150, mbps=100)
    edge = fetch_ms(30, rtt=20, mbps=100, origin_rtt=150)
    print(f"\n30 KB page that no cache can hold, user 150 ms from the origin:")
    print(f"  direct:                        {direct:.0f} ms")
    print(f"  through an edge 20 ms away:    {edge:.0f} ms")
