"""UDP loses datagrams even on your own machine, and nobody tells you.

A sender fires 5,000 numbered datagrams of 1,000 bytes as fast as it can. The receiver does a
little work per datagram (here, 0.2 ms of busy loop), so it falls behind. When its
socket's receive buffer is full, the kernel drops new datagrams on the floor. No error reaches
the sender or the receiver. The sequence numbers we added are the only way to notice.

Run: python udp_loss.py
"""

import multiprocessing as mp
import socket
import struct
import time

HOST = "127.0.0.1"
COUNT = 5000
SIZE = 1000
SEQ = struct.Struct(">I")


def busy(seconds: float) -> None:
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        pass


def receiver(ready, results) -> None:
    """Runs in its own process, so it really is slower than the sender, not just sharing a CPU."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 64 * 1024)  # a small, but real, buffer
    sock.bind((HOST, 0))
    ready.put(sock.getsockname())
    sock.settimeout(1.0)  # a second of silence means the sender has finished
    expected, received, gaps, reordered = 0, 0, 0, 0
    try:
        while True:
            data, _ = sock.recvfrom(2048)
            (seq,) = SEQ.unpack_from(data)
            received += 1
            if seq > expected:
                gaps += 1  # one or more datagrams before this one never arrived (yet)
            elif seq < expected:
                reordered += 1
            expected = max(expected, seq + 1)
            busy(0.0002)  # 0.2 ms of "work" per datagram: at most 5,000 per second
    except TimeoutError:
        pass
    results.put({"received": received, "gaps": gaps, "reordered": reordered})


def run(rate: int | None) -> None:
    """Send COUNT datagrams, as fast as possible (rate=None) or paced to `rate` per second."""
    ready, results = mp.Queue(), mp.Queue()
    proc = mp.Process(target=receiver, args=(ready, results))
    proc.start()
    address = ready.get()

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    payload = bytes(SIZE - SEQ.size)
    errors = 0
    start = time.perf_counter()
    for seq in range(COUNT):
        try:
            tx.sendto(SEQ.pack(seq) + payload, address)  # returns at once, every time
        except OSError:
            errors += 1
        if rate and seq % 40 == 39:  # pacing: 40 datagrams, then wait until they are "due"
            time.sleep(max(0.0, start + (seq + 1) / rate - time.perf_counter()))
    elapsed = time.perf_counter() - start
    result = results.get()
    proc.join()

    lost = COUNT - result["received"]
    print("full speed:" if rate is None else f"paced to {rate:,} per second:")
    print(f"sender:   {COUNT} datagrams sent in {elapsed * 1000:.0f} ms, {errors} send errors")
    print(f"receiver: {result['received']} received, {lost} lost ({lost / COUNT:.0%}), "
          f"{result['gaps']} gaps, {result['reordered']} out of order")


def main() -> None:
    run(rate=None)
    print()
    run(rate=3000)  # well below the receiver's 5,000 per second
    print("\nNobody got an error about lost datagrams. Only the sequence numbers show the gaps,")
    print("and only the sender slowing down prevented them. UDP will not slow down for you.")


if __name__ == "__main__":
    main()
