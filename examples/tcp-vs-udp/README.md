# TCP vs UDP: runnable examples

The code behind every snippet and output on the [TCP vs UDP](https://seniordevnotes.netlify.app/networking/tcp-vs-udp/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install. Everything runs on
`127.0.0.1` and works offline.

| File (Python / JavaScript) | What it shows |
|---|---|
| `naive_framing.py` / `naive-framing.mjs` | Treating each read on a TCP socket as one message: messages merge and split |
| `framing.py` / `framing.mjs` | The fix: a 4-byte length prefix, reading exactly that many bytes, with a size limit |
| `udp_loss.py` / `udp-loss.mjs` | UDP datagrams silently dropped on your own machine when the receiver falls behind, and pacing as the fix |
| `reliable_udp.py` / `reliable-udp.mjs` | Sequence numbers, acks, adaptive timeouts and a sliding window over a lossy link: plain UDP vs stop-and-wait vs a window of 16 |
| `nagle.py` / `nagle.mjs` | Nagle's algorithm plus delayed ACKs: write-write-read costs about 44 ms per request on Linux |
| `time_wait.py` / `time-wait.mjs` | TIME-WAIT lands on the side that closes first; reusing one connection avoids it; the ephemeral port budget (Linux only) |

## Run

```bash
# Python
cd python
python naive_framing.py
python framing.py
python udp_loss.py          # about 4 s
python reliable_udp.py      # about 10 s; stop-and-wait is the slow part
python nagle.py
python time_wait.py         # Linux only: reads /proc/net/tcp

# JavaScript
cd js
node naive-framing.mjs
node framing.mjs
node udp-loss.mjs
node reliable-udp.mjs
node nagle.mjs
node time-wait.mjs          # Linux only
```

## What to expect

- **Framing.** The naive server parses none of the six messages. Chunk sizes depend on the
  operating system and runtime (Python reads up to 65,536 bytes per `recv`, Node delivers 64 KB
  `data` events), but the bug shows on every platform.
- **UDP loss.** Numbers differ on every run and machine. We saw 83–98% lost at full speed on
  Windows 11 and Linux, and none when the sender was paced to 3,000 per second. Node's receiver has
  more overhead per datagram, so it can still lose a handful while paced.
- **Reliable UDP.** The link is impaired in code, not by the network: each datagram is dropped with
  probability 10% and otherwise delayed 20–30 ms. Timer resolution on Windows is coarser, so
  stop-and-wait takes longer there (about 8.5 s against about 7 s on Linux).
- **Nagle.** On Linux the two-write client takes about 44 ms per request (the 40 ms delayed-ACK
  timer) against well under 1 ms with `TCP_NODELAY` or a single write. Windows' loopback path does
  not show the stall, so run it in Linux, WSL or a container to see it. Over a real network Windows
  delays ACKs too, by up to 200 ms by default.
- **TIME-WAIT.** 500 TIME_WAIT sockets on the client side when the client closes first, 500 on the
  server side when the server closes first, and 1 when one connection carries all 500 requests.
  Run it twice within 60 s and the counts are still per run, because each run uses a new server
  port. Needs Linux (`/proc/net/tcp`); on Windows or macOS use WSL or a container.

Tested on 2026-10-22 with Python 3.13.16 and Node 22.22.0 on Linux 6.18 (a container), and earlier
on 2026-10-18 with Python 3.14.7 and Node 24.19.0 on Windows 11, and Python 3.12.3 and Node 24.19.0
on Ubuntu 24.04 (WSL 2).
