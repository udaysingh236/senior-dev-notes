"""Rebuilding a little of TCP on top of UDP: sequence numbers, acks, timeouts and a window.

Real UDP sockets on 127.0.0.1, with an impaired "link": every datagram, in both directions, is
dropped with probability 10% and otherwise delayed by 20-30 ms (so they can also arrive out of
order). We send 100 messages three ways:

  1. plain UDP           no acks: what arrives, arrives
  2. stop-and-wait       send one, wait for its ack, retransmit on timeout
  3. sliding window      up to 16 unacked messages in flight, each with its own timer

Run: python reliable_udp.py
"""

import asyncio
import random
import struct
import time

HOST = "127.0.0.1"
COUNT = 100
LOSS, DELAY, JITTER = 0.10, 0.020, 0.010  # 10% loss, 20-30 ms each way
DATA = struct.Struct(">I")  # sequence number, then the payload
ACK = struct.Struct(">cI")  # b"A", sequence number being acknowledged
rng = random.Random(7)  # seeded, so runs are similar (timing still varies a little)


class Link:
    """Sends through a real UDP socket, but drops some datagrams and delays the rest."""

    def __init__(self, transport: asyncio.DatagramTransport):
        self.transport, self.sent, self.dropped = transport, 0, 0

    def send(self, data: bytes, addr) -> None:
        self.sent += 1
        if rng.random() < LOSS:
            self.dropped += 1
            return
        delay = DELAY + rng.random() * JITTER
        asyncio.get_running_loop().call_later(delay, self.transport.sendto, data, addr)


class Receiver(asyncio.DatagramProtocol):
    def __init__(self, reliable: bool):
        self.reliable = reliable
        self.expected = 0  # next sequence number the application may have
        self.buffer: dict[int, float] = {}  # arrived early: seq -> arrival time
        self.delivered: list[int] = []
        self.arrived = self.out_of_order = 0
        self.waits: list[float] = []  # how long each message sat waiting for an earlier one

    def connection_made(self, transport):
        self.link = Link(transport)

    def datagram_received(self, data: bytes, addr) -> None:
        (seq,) = DATA.unpack_from(data)
        self.arrived += 1
        if self.reliable:
            self.link.send(ACK.pack(b"A", seq), addr)  # ack every copy: the last ack may be lost
        if not self.reliable:  # plain UDP: hand it to the application at once, in arrival order
            self.out_of_order += bool(self.delivered) and seq < self.delivered[-1]
            self.delivered.append(seq)
            return
        if seq < self.expected or seq in self.buffer:
            return  # a duplicate, from a retransmission whose original was not lost after all
        self.buffer[seq] = time.perf_counter()
        while self.expected in self.buffer:  # deliver in order; a gap holds everything behind it
            self.waits.append(time.perf_counter() - self.buffer.pop(self.expected))
            self.delivered.append(self.expected)
            self.expected += 1


class Sender(asyncio.DatagramProtocol):
    def __init__(self, window: int, reliable: bool = True):
        self.window, self.reliable = window, reliable
        self.next_seq = 0
        self.in_flight: dict[int, dict] = {}  # seq -> {"sent": t, "retries": n, "timer": handle}
        self.srtt, self.rttvar, self.rto = None, 0.0, 0.2  # RFC 6298, scaled down for a 50 ms RTT
        self.retransmissions = 0
        self.done = asyncio.Event()

    def connection_made(self, transport):
        self.link = Link(transport)

    def start(self, peer) -> None:
        self.peer = peer
        self.fill_window()

    def fill_window(self) -> None:
        while self.next_seq < COUNT and len(self.in_flight) < self.window:
            self.transmit(self.next_seq, retries=0)
            self.next_seq += 1
        if self.next_seq == COUNT and not self.in_flight:
            self.done.set()

    def transmit(self, seq: int, retries: int) -> None:
        self.link.send(DATA.pack(seq) + bytes(200), self.peer)
        if not self.reliable:
            return
        timeout = self.rto * 2**retries  # back off: each timeout doubles the wait
        timer = asyncio.get_running_loop().call_later(timeout, self.on_timeout, seq)
        self.in_flight[seq] = {"sent": time.perf_counter(), "retries": retries, "timer": timer}

    def on_timeout(self, seq: int) -> None:
        self.retransmissions += 1
        self.transmit(seq, self.in_flight[seq]["retries"] + 1)

    def datagram_received(self, data: bytes, addr) -> None:
        _, seq = ACK.unpack(data)
        entry = self.in_flight.pop(seq, None)
        if entry is None:
            return  # a duplicate ack
        entry["timer"].cancel()
        if entry["retries"] == 0:  # Karn's rule: never time a retransmitted message
            self.update_rto(time.perf_counter() - entry["sent"])
        self.fill_window()

    def update_rto(self, rtt: float) -> None:
        if self.srtt is None:
            self.srtt, self.rttvar = rtt, rtt / 2
        else:
            self.rttvar = 0.75 * self.rttvar + 0.25 * abs(self.srtt - rtt)
            self.srtt = 0.875 * self.srtt + 0.125 * rtt
        self.rto = max(0.05, self.srtt + 4 * self.rttvar)  # a 50 ms floor, like TCP's minimum


async def run(label: str, window: int, reliable: bool) -> None:
    loop = asyncio.get_running_loop()
    rx_transport, receiver = await loop.create_datagram_endpoint(lambda: Receiver(reliable), local_addr=(HOST, 0))
    tx_transport, sender = await loop.create_datagram_endpoint(lambda: Sender(window, reliable), local_addr=(HOST, 0))
    start = time.perf_counter()
    sender.start(rx_transport.get_extra_info("sockname"))
    if reliable:
        await sender.done.wait()
    await asyncio.sleep(0.1)  # let the last datagrams land
    elapsed = time.perf_counter() - start - (0 if reliable else 0.1)
    rx_transport.close()
    tx_transport.close()

    in_order = receiver.delivered == list(range(COUNT))
    print(f"{label}")
    if not reliable:
        print(f"    {len(receiver.delivered)}/{COUNT} arrived, {COUNT - len(receiver.delivered)} lost, "
              f"{receiver.out_of_order} arrived after a later one")
        return
    waited = [w for w in receiver.waits if w > 0.001]
    print(f"    {len(receiver.delivered)}/{COUNT} delivered, in order: {in_order}, in {elapsed:.2f} s")
    print(f"    {sender.retransmissions} retransmissions; final RTO {sender.rto * 1000:.0f} ms")
    if waited:
        print(f"    {len(waited)} messages arrived but waited for an earlier one; longest wait "
              f"{max(waited) * 1000:.0f} ms")


async def main() -> None:
    print(f"link: {LOSS:.0%} loss each way, {DELAY * 1000:.0f}-{(DELAY + JITTER) * 1000:.0f} ms delay each way\n")
    await run("1. plain UDP, no acks", window=COUNT, reliable=False)
    await run("2. stop-and-wait (window of 1)", window=1, reliable=True)
    await run("3. sliding window of 16", window=16, reliable=True)


if __name__ == "__main__":
    asyncio.run(main())
