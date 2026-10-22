# What happens when you type a URL: runnable examples

The code behind every snippet on the [What Happens When You Type a URL](https://seniordevnotes.netlify.app/foundations/how-the-web-works/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install.

| File (Python / JavaScript) | What it shows | Network? |
|---|---|---|
| `latency_budget.py` / `latency-budget.mjs` | A latency budget in round trips: the naive size ÷ bandwidth estimate against set-up, request, server work and TCP slow start; and what an edge does for an uncacheable page | No |
| `by_hand.py` / `by-hand.mjs` | DNS, TCP, TLS and HTTP done one step at a time and timed, then a second request on the same connection | Yes |
| `probe.py` / `probe.mjs` | A timeout on every step, and when something fails, which step and what a browser would show | Yes |
| `curl/timing.sh` | The same per-step timing with `curl -w` | Yes |

## Run

```bash
# Python
cd python
python latency_budget.py
python by_hand.py              # or: python by_hand.py wikipedia.org
python probe.py                # or: python probe.py https://your-site.example/

# JavaScript
cd js
node latency-budget.mjs
node by-hand.mjs
node probe.mjs

# curl (macOS, Linux, WSL or Git Bash)
bash curl/timing.sh https://example.com/
```

## What to expect

- `latency_budget` prints the same numbers everywhere: it is arithmetic, not measurement. Python and
  Node print identical output.
- Your timings from the other files will differ from the page: they depend on how far you are from
  each server. The page's measured output was recorded from a network in India on 2026-10-18.
- `probe` deliberately waits 3 seconds on `10.255.255.1`, a private address nothing answers on.
  On a network where something does answer there (some VPNs and corporate proxies do), that line
  will look different.
- `probe` uses [badssl.com](https://badssl.com/), a public site that serves broken certificates
  for testing, and `no-such-host.invalid`, which can never resolve (RFC 6761).
- The refused connection to `127.0.0.1:9` takes about 2 s with Python on Windows, which retries
  before reporting it, and a few milliseconds elsewhere.
- To try `by_hand` without internet access, run any local HTTPS server on port 443 with a
  certificate for `localhost` and point the client at it: `SSL_CERT_FILE=cert.pem python
  by_hand.py localhost`, or `NODE_EXTRA_CA_CERTS=cert.pem node by-hand.mjs localhost`.

Measured output on the page: 2026-10-18, Python 3.14.7 and Node 24.19.0 on Windows 11, curl 8.5.0
on Ubuntu 24.04 (WSL). All files re-run on 2026-10-22 with Python 3.13 and Node 22 on Linux
(`latency_budget` in full; the others against local targets, as the sandbox had no outside DNS).
