# Research notes: What Happens When You Type a URL

Track: `foundations` · Slug: `how-the-web-works` · Order: 1 · Post #: new · Researched: 2026-10-18

Notes for understanding, not for pasting. Quotes kept under 15 words.

## Key facts, with sources

### URL and the address bar

- URL syntax: scheme, authority (userinfo, host, port), path, query, fragment. RFC 3986 §3.
  Browsers actually follow the WHATWG URL Standard, which is more forgiving than RFC 3986.
  https://www.rfc-editor.org/rfc/rfc3986#section-3 · https://url.spec.whatwg.org/
- The fragment (`#...`) is never sent to the server; it is handled by the browser. RFC 3986 §3.5.
- Chrome's UI thread first decides whether the input is a search query or a URL (the omnibox is
  both). https://developer.chrome.com/blog/inside-browser-part2
- Non-ASCII host names are converted to punycode (IDNA) before DNS. (alex/what-happens-when)
- HSTS (RFC 6797): a site sends `Strict-Transport-Security`; the browser then only uses HTTPS
  for that host for `max-age`. The preload list is built into Chrome and used by Firefox,
  Safari, Edge. Requirements: max-age ≥ 31536000, includeSubDomains, preload. Removal takes
  months. Chrome and Safari already upgrade HTTP navigations to HTTPS by default (hstspreload.org).
  https://hstspreload.org/
- Google announced (Oct 2025) that Chrome 154, scheduled for October 2026, turns on
  "Always Use Secure Connections" by default: Chrome asks before first visiting a public HTTP
  site. Chrome 147 (April 2026) enabled it for Enhanced Safe Browsing users. In their test,
  warnings appeared on < 3% of navigations. https://blog.google/security/https-by-defau/
  Could not confirm on 2026-10-18 that 154 has reached stable. Write "scheduled for".

### DNS

- Lookup chain: browser cache → OS stub resolver/cache → recursive resolver (ISP, 1.1.1.1,
  8.8.8.8) → root → TLD → authoritative. RFC 1034/1035.
  https://www.rfc-editor.org/rfc/rfc1034 · https://www.rfc-editor.org/rfc/rfc1035
- Root server system: 13 identities (A–M), 12 operators, 2,047 instances (root-servers.org,
  read 2026-10-17). Anycast: one address, many physical servers. https://root-servers.org/
- Measured with our `dns_walk.py` from a network in India (Cloudflare edge in Mumbai), 2026-10-18: root 126 ms,
  .com TLD 122 ms, Cloudflare authoritative 12 ms; total cold walk 265 ms. com. NS referral TTL
  172800 s (2 days); example.com A TTL 300 s; github.com A TTL 60 s; www.wikipedia.org is a
  CNAME to dyna.wikimedia.org (TTL 86400), whose A has TTL 180. Cold walk for wikipedia 810 ms.
  Through the OS resolver (cached): 15–40 ms.
- Cloudflare says most 1.1.1.1 queries are answered under 10 ms (from cache) during the Facebook
  outage post.
- Glue records: the parent zone sends name server addresses with the referral, to avoid a
  chicken-and-egg lookup.

### TCP

- Three-way handshake SYN / SYN-ACK / ACK; client can send data with the ACK, so cost = 1 RTT
  before the first request byte. RFC 9293. https://www.rfc-editor.org/rfc/rfc9293
- Initial congestion window 10 segments, max 14,600 bytes (RFC 6928, April 2013): the
  origin of the "14 KB rule" — what fits in the first round trip of data.
  https://www.rfc-editor.org/rfc/rfc6928
- Happy Eyeballs v2 (RFC 8305): query AAAA and A together; prefer IPv6; 50 ms resolution delay;
  stagger connection attempts by 250 ms (min 100 ms, max 2 s); first to succeed wins.
  https://www.rfc-editor.org/rfc/rfc8305
- Default connect timeouts measured 2026-10-18 against an unanswered address (10.255.255.1):
  Windows 11 21.1 s; Linux (WSL, tcp_syn_retries=6) 134.8 s; Node 24 `fetch` (undici)
  10.8 s (UND_ERR_CONNECT_TIMEOUT); Python `urllib` with no timeout: waits for the OS.

### TLS

- TLS 1.3: full handshake is 1 RTT; 0-RTT resumption possible with a PSK, but 0-RTT data can
  be replayed. RFC 8446 (Aug 2018), now obsoleted by RFC 9846 (July 2026), a minor revision
  keeping the version number, which also obsoletes RFC 5246 (TLS 1.2).
  https://www.rfc-editor.org/rfc/rfc9846.html
- TLS 1.2 full handshake: 2 RTT. (Cloudflare TLS 1.3 explainer.)
  https://blog.cloudflare.com/rfc-8446-aka-tls-1-3/
- ClientHello carries SNI (server_name: which site), ALPN (h2 or http/1.1), key_share.
- Encrypted Client Hello (hides SNI): RFC 9849, 2026, Proposed Standard.
  https://www.rfc-editor.org/info/rfc9849
- Cert validity (CA/B Forum ballot SC-081v3, approved 11 April 2025): max 398 → 200 days from
  15 March 2026, 100 days from 15 March 2027, 47 days from 15 March 2029.
  https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods/ (passed 25-0-5; per-step dates from DNSimple/Sectigo summaries)
  Let's Encrypt: 90 days default; 6-day short-lived certs available; plan to 45 days by Feb 2028.
  https://letsencrypt.org/docs/cert-lifetimes/
- Post-quantum key agreement: 52% of Cloudflare's human traffic by early Dec 2025.
  https://blog.cloudflare.com/radar-2025-year-in-review

### HTTP and protocols

- Semantics: RFC 9110; HTTP/1.1: RFC 9112; HTTP/2: RFC 9113; HTTP/3: RFC 9114 (June 2022) over
  QUIC RFC 9000 (May 2021). QUIC combines transport + TLS 1.3 handshake → 1 RTT before request.
- Browser learns about HTTP/3 from `alt-svc: h3=":443"` header (we saw it on example.com) or
  from DNS HTTPS records (RFC 9460, Nov 2023).
- Cloudflare Radar 2025: HTTP/2 50%, HTTP/1.x 29%, HTTP/3 21% of requests, largely unchanged
  from 2024. IPv6: 29% of dual-stack requests.
- Web Almanac 2025 (page weight chapter, July 2025 crawl): median home page 2,862 KB desktop,
  2,559 KB mobile; ~80 / 75 requests; JS ~697 / 632 KB; images ~1,059 / 911 KB.
  https://almanac.httparchive.org/en/2025/page-weight

### Latency

- Light in fibre ≈ 200,000 km/s (refractive index ~1.5), so ~5 µs per km one way, ~1 ms RTT
  per 100 km of fibre, before any routing. https://hpbn.co/primer-on-latency-and-bandwidth/
- AWS inter-region latency (cloudping.co, read 2026-10-18): Mumbai→N. Virginia ~187 ms,
  Mumbai→London ~113 ms, Mumbai→Singapore ~62 ms.
- Measured: example.com (Cloudflare edge in Mumbai, CF-RAY suffix BOM): TCP connect 11–22 ms.
  badssl.com (Google Cloud, US): TCP connect ~230 ms.

### Rendering

- MDN: DOM, CSSOM, render tree, layout, paint, composite; preload scanner; CSS is render
  blocking and blocks JS; classic scripts block the parser; `async` / `defer`; 16.67 ms frame.
  https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work
- Chrome navigation: browser process (UI thread, network thread), renderer process picked in
  parallel, MIME sniffing, Safe Browsing, commit.
  https://developer.chrome.com/blog/inside-browser-part2

## Misconceptions and confusing points

- "DNS lookups go to the root every time." No: resolvers cache; root/TLD referrals are cached for
  2 days. Most lookups are answered from a cache within milliseconds.
- "The URL fragment is sent to the server." It is not.
- "HTTPS is slow." TLS 1.3 adds 1 RTT, often 0 with resumption; QUIC merges it with transport.
- MDN's page says TLS takes "five more round trips" and "eight round trips" in total; that counts
  messages, not round trips, and describes old TLS. TLS 1.3 is 1 RTT. Good confusion to flag
  gently without naming.
- "Bandwidth makes pages fast." For small resources, round trips (latency) dominate.
- Wildcard certificates cover exactly one label: `*.badssl.com` does not cover
  `wrong.host.badssl.com` (we saw this in probe output).
- "A 301 is a cheap redirect." It costs a full extra round trip (often a new connection to a
  new host) and browsers cache 301s, so a mistaken one sticks.
- TTL changes don't take effect until the old TTL expires everywhere (Slack DNSSEC: DS TTL of
  24 h controlled by the parent zone).

## Real incidents (sourced)

- **Facebook, 4 Oct 2021.** Maintenance command took down backbone; DNS servers withdrew their BGP
  routes when they lost contact with data centres, so DNS became unreachable. About 5.5 hours
  of DNS unavailability (15:50–21:20 UTC per Cloudflare); resolvers saw 30× normal query load
  from retries. https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/ ·
  https://blog.cloudflare.com/october-2021-facebook-outage/
- **Slack DNSSEC, 30 Sept 2021.** ~24 h, < 1% of users; ERR_NAME_NOT_RESOLVED; DS record cached
  24 h by .com, plus a Route 53 wildcard NSEC bug. Rollback made it worse.
  https://slack.engineering/what-happened-during-slacks-dnssec-rollout/
- **Cloudflare 1.1.1.1, 14 July 2025.** 62 minutes (21:52–22:54 UTC). A dormant config error
  withdrew 1.1.1.1 routes worldwide; DoH via cloudflare-dns.com mostly stayed up.
  https://blog.cloudflare.com/cloudflare-1-1-1-1-incident-on-july-14-2025/
- **Let's Encrypt DST Root CA X3 expiry, 30 Sept 2021.** Older devices that did not trust the
  newer ISRG root started failing TLS.
  https://letsencrypt.org/docs/dst-root-ca-x3-expiration-september-2021/

## How popular explainers structure it, and what they leave out

- **alex/what-happens-when (GitHub):** keyboard interrupt → OS events → URL parse → HSTS →
  DNS → ARP → socket → TLS → HTTP → server → browser parse/render. Huge depth on hardware
  and OS; no numbers, no latency budget, single httpd server, no CDN/load balancer, little on
  failures, no HTTP/3.
- **Chrome "Inside look at modern web browser" part 2:** browser process architecture and
  navigation steps (UI thread, network thread, renderer, commit). Great on the browser's
  internals, silent on the network costs and the server side.
- **MDN "Populating the page":** navigation (DNS, TCP, TLS), response (14 KB, slow start), then
  critical rendering path in depth. Good on rendering, light on the server side, and counts TLS
  round trips in an outdated way.

**Our angle:** the journey as a time budget measured in round trips, with real numbers; the
server side (CDN, load balancer, app, database) that juniors will actually build; every step as
a place that fails, with the error a browser shows and how to find which step broke; and each
step as the doorway to a later page in the curriculum.

## Sources for Further reading

Specs & official docs
- RFC 3986 URI syntax; WHATWG URL Standard
- RFC 1034 / 1035 DNS; root-servers.org
- RFC 9293 TCP; RFC 6928 initial window; RFC 8305 Happy Eyeballs v2
- RFC 9846 TLS 1.3 (obsoletes 8446); RFC 9849 ECH
- RFC 9110 HTTP semantics; RFC 9114 HTTP/3; RFC 9000 QUIC; RFC 9460 SVCB/HTTPS records
- RFC 6797 HSTS; hstspreload.org
- Let's Encrypt certificate lifetimes; Chrome HTTPS by default announcement

Engineering blogs & data
- Facebook outage details (2021); Cloudflare's view of it (2021)
- Slack DNSSEC rollout (2021)
- Cloudflare 1.1.1.1 incident (2025)
- Cloudflare: A detailed look at RFC 8446
- Cloudflare Radar 2025 Year in Review
- HTTP Archive Web Almanac 2025, page weight

Explainers
- Chrome Developers: Inside look at modern web browser, part 2
- MDN: Populating the page: how browsers work
- alex/what-happens-when
- Ilya Grigorik: High Performance Browser Networking (latency primer)
