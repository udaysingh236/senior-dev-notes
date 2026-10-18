# DNS: runnable examples

The code behind every snippet on the [DNS](https://seniordevnotes.netlify.app/networking/dns/) page.
Python 3.11+ and Node 20+, standard library only, nothing to install.

Most demos start their own tiny authoritative DNS server for the zone `shop.example.test` on
`127.0.0.1:8053` and talk to it with real DNS packets, so they work offline. Only `lookup` needs the
internet.

| File (Python / JavaScript) | What it shows |
|---|---|
| `dnswire.py` / `dnswire.mjs` | Building and parsing DNS messages in wire format (RFC 1035), plus UDP and TCP send helpers |
| `toy_server.py` / `toy-server.mjs` | A small authoritative server: CNAME, NXDOMAIN and NODATA with an SOA, TC bit for big answers, TCP |
| `demo.py` / `demo.mjs` | Shared scaffolding: start the server, pretend API servers, a clock |
| `naive_client.py` / `naive-client.mjs` | Resolve once and keep it for ever (breaks after a move), and resolve on every request (a lookup per request) |
| `ttl_cache.py` / `ttl-cache.mjs` | A cache that honours each TTL, including negative caching from the SOA |
| `resilient_resolver.py` / `resilient-resolver.mjs` | Several upstreams with timeouts, answer checks, TCP fallback on truncation, TTL clamps, serve-stale |
| `lookup.py` / `lookup.mjs` | A tiny `dig`: real record types from 1.1.1.1, then the same question over DNS over HTTPS |

## Run

```bash
# Python
cd python
python naive_client.py         # about 5 s
python ttl_cache.py            # about 10 s
python resilient_resolver.py   # about 3 s
python lookup.py               # or: python lookup.py github.com MX
python toy_server.py           # leave running, then in another terminal:
nslookup -port=8053 www.shop.example.test 127.0.0.1

# JavaScript
cd js
node naive-client.mjs
node ttl-cache.mjs
node resilient-resolver.mjs
node lookup.mjs                # or: node lookup.mjs github.com MX
node toy-server.mjs
```

## What to expect

- The demos use a 2 second TTL and a 5 second negative TTL so a whole migration fits in a few
  seconds. Real zones use minutes to days.
- Port 8053 must be free. (Port 5353, a common choice for test DNS servers, is taken on most
  machines by multicast DNS.)
- `resilient_resolver` asks a dead upstream on port 5399 first. On Windows, Python learns at once
  that nothing is listening (`ConnectionResetError`, from an ICMP "port unreachable"), while Node,
  and Python on Linux, wait out the 400 ms timeout. A resolver that silently drops packets always costs the full
  timeout, which is why the timeout should be short.
- `lookup` needs outgoing UDP on port 53 and HTTPS. TTLs in the output count down: they are the
  time left in the resolver's cache, so they differ from run to run and between resolvers.
- On Windows, Python reads the system trust store, which may not yet hold the root certificate
  that `cloudflare-dns.com` chains to. `lookup.py` then prints "could not connect" for that DoH
  server and carries on. Node ships its own root list and is not affected.

Tested on 2026-10-18 with Python 3.14.7 and Node 24.19.0 on Windows 11, and Python 3.12.3 on Ubuntu
24.04 (WSL).
