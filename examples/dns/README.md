# DNS: runnable examples

The code behind every snippet on the [DNS](https://seniordevnotes.netlify.app/networking/dns/) page.
Python 3.11+ and Node 20+, standard library only, nothing to install.

Every demo starts its own tiny authoritative DNS server for the zone `shop.example.test` on
`127.0.0.1:8053` and talks to it with real DNS packets, so everything works offline.

| File (Python / JavaScript) | What it shows |
|---|---|
| `dnswire.py` / `dnswire.mjs` | Building and parsing DNS messages in wire format (RFC 1035), plus UDP and TCP send helpers |
| `toy_server.py` / `toy-server.mjs` | A small authoritative server: CNAME, NXDOMAIN and NODATA with an SOA, TC bit for big answers, TCP |
| `demo.py` / `demo.mjs` | Shared scaffolding: start the server, pretend API servers, a clock |
| `naive_client.py` / `naive-client.mjs` | Resolve once and keep it for ever (breaks after a move), and resolve on every request (a lookup per request) |
| `ttl_cache.py` / `ttl-cache.mjs` | A cache that honours each TTL, including negative caching from the SOA |
| `resilient_resolver.py` / `resilient-resolver.mjs` | Several upstreams with short timeouts, answer checks, TCP fallback on truncation, TTL clamps, serve-stale |

## Run

```bash
# Python
cd python
python naive_client.py         # about 5 s
python ttl_cache.py            # about 10 s
python resilient_resolver.py   # about 4 s
python toy_server.py           # leave running, then in another terminal:
dig -p 8053 @127.0.0.1 www.shop.example.test   # or: nslookup -port=8053 www.shop.example.test 127.0.0.1

# JavaScript
cd js
node naive-client.mjs
node ttl-cache.mjs
node resilient-resolver.mjs
node toy-server.mjs
```

## What to expect

- The demos use a 2-second TTL and a 5-second negative TTL so a whole migration fits in a few
  seconds. Real zones use minutes to days.
- Port 8053 must be free. (Port 5353, a common choice for test DNS servers, is taken on most
  machines by multicast DNS.)
- `resilient_resolver` asks a dead upstream on port 5399 first. On Linux, and in Node, it waits out
  the 400 ms timeout; on Windows, Python may learn at once that nothing is listening
  (`ConnectionResetError`, from an ICMP "port unreachable"). A resolver that silently drops
  packets always costs the full timeout, which is why the timeout should be short.

The earlier `lookup` script (real lookups against 1.1.1.1 and DNS over HTTPS) was removed when the
page was rewritten; the real-world numbers the page still quotes (remaining TTLs, negative TTLs,
the 72-byte A record) come from its October 2026 runs, recorded in `research/dns.md`.

Tested on 2026-10-22 with Python 3.13.16 and Node 22.22.0 on Linux; earlier on 2026-10-18 with
Python 3.14.7 and Node 24.19.0 on Windows 11.
