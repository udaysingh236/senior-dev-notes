# What happens when you type a URL: runnable examples

The code behind every snippet on the [What Happens When You Type a URL](https://seniordevnotes.netlify.app/foundations/how-the-web-works/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install. Every file prints its
results, so you can check them against the page. They need an internet connection.

| File (Python / JavaScript) | What it shows |
|---|---|
| `naive_fetch.py` / `naive-fetch.mjs` | One call, one number: no idea where the time went, and a hang when a step never answers |
| `by_hand.py` / `by-hand.mjs` | DNS, TCP, TLS and HTTP done one step at a time and timed, then a second request on the same connection |
| `dns_walk.py` / `dns-walk.mjs` | Raw DNS packets sent to a root server, following referrals down to the answer, like a recursive resolver |
| `probe.py` / `probe.mjs` | A timeout on every step, and when something fails, which step and what a browser would show |
| `curl/timing.sh` | The same per-step timing with `curl -w` |

## Run

```bash
# Python
cd python
python by_hand.py              # or: python by_hand.py wikipedia.org
python naive_fetch.py
python dns_walk.py             # or: python dns_walk.py www.wikipedia.org
python probe.py                # or: python probe.py https://your-site.example/

# JavaScript
cd js
node by-hand.mjs
node naive-fetch.mjs
node dns-walk.mjs
node probe.mjs

# curl (macOS, Linux, WSL or Git Bash)
bash curl/timing.sh https://example.com/
```

## What to expect

- Your timings will differ from the page: they depend on how far you are from each server.
- `dns_walk` needs outgoing UDP on port 53. Some office and campus networks block it; if every
  query times out, try another network.
- `probe` deliberately waits 3 seconds on `10.255.255.1`, a private address nothing answers on.
  On a network where something does answer there, that line will look different.
- `probe` uses [badssl.com](https://badssl.com/), a public site that serves broken certificates
  for testing, and `no-such-host.invalid`, which can never resolve (RFC 6761).
- The refused connection to `127.0.0.1:9` takes about 2 s with Python on Windows, which retries
  before reporting it, and a few milliseconds elsewhere.

Tested on 2026-10-18 with Python 3.14.7 and Node 24.19.0 on Windows 11, and curl 8.5.0 on Ubuntu
24.04 (WSL).
