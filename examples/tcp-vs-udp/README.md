# TCP vs UDP: runnable examples

The code behind every snippet on the [TCP vs UDP](https://seniordevnotes.netlify.app/networking/tcp-vs-udp/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install.

Everything except `dns_udp_vs_tcp` runs on `127.0.0.1` and works offline.

| File (Python / JavaScript) | What it shows |
|---|---|
| `naive_framing.py` / `naive-framing.mjs` | Treating each read on a TCP socket as one message: messages merge and split |
| `framing.py` / `framing.mjs` | The fix: a 4-byte length prefix, reading exactly that many bytes, with a size limit |
| `udp_loss.py` / `udp-loss.mjs` | UDP datagrams silently dropped on your own machine when the receiver falls behind, and pacing as the fix |
| `reliable_udp.py` / `reliable-udp.mjs` | Sequence numbers, acks, adaptive timeouts and a sliding window over a lossy link: plain UDP vs stop-and-wait vs a window of 16 |
| `nagle.py` / `nagle.mjs` | Nagle's algorithm plus delayed ACKs: write-write-read costs about 40 ms per request on Linux |
| `dns_udp_vs_tcp.py` / `dns-udp-vs-tcp.mjs` | The same DNS question to 1.1.1.1 over UDP, over a new TCP connection and over a reused one |

## Run

```bash
# Python
cd python
python naive_framing.py
python framing.py
python udp_loss.py          # about 4 s
python reliable_udp.py      # about 10 s; stop-and-wait is the slow part
python nagle.py
python dns_udp_vs_tcp.py    # needs the internet

# JavaScript
cd js
node naive-framing.mjs
node framing.mjs
node udp-loss.mjs
node reliable-udp.mjs
node nagle.mjs
node dns-udp-vs-tcp.mjs
```

## What to expect

- **Framing.** The naive server parses none of the six messages. Chunk sizes depend on the
  operating system and runtime (Python reads up to 65,536 bytes per `recv`, Node delivers 64 KB
  `data` events), but the bug shows on every platform.
- **UDP loss.** Numbers differ on every run and machine. We saw 83–96% lost at full speed on
  Windows 11 and Linux, and none when the sender was paced to 3,000 per second. Node's receiver has
  more overhead per datagram, so it can still lose a handful while paced.
- **Reliable UDP.** The link is impaired in code, not by the network: each datagram is dropped with
  probability 10% and otherwise delayed 20–30 ms. Timer resolution on Windows is coarser, so
  stop-and-wait takes longer there (about 8.5 s against about 7 s on Linux).
- **Nagle.** On Linux the two-write client takes about 44 ms per request (the 40 ms delayed-ACK
  timer) against about 0.3 ms with `TCP_NODELAY` or a single write. Windows' loopback path does not
  show the stall, so run it in Linux, WSL or a container to see it. Over a real network Windows
  delays ACKs too, by up to 200 ms by default.
- **DNS over UDP vs TCP.** Needs outgoing UDP and TCP to port 53. From a network in India we saw
  about 12–16 ms over UDP, about 24–28 ms over a new TCP connection and about 12 ms on a reused one.

Tested on 2026-10-18 with Python 3.14.7 and Node 24.19.0 on Windows 11, and Python 3.12.3 and
Node 24.19.0 on Ubuntu 24.04 (WSL 2, kernel 6.6).
