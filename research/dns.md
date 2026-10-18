# Research notes: DNS

Track: `networking` · Slug: `dns` · Order: 1 · Post #: 60 · Researched: 2026-10-18

Notes for understanding, not for pasting. Quotes kept under 15 words.

The foundations page `how-the-web-works` already covers: the basic resolution walk (browser → OS →
resolver → root → TLD → authoritative), TTL basics with one worked example, glue in passing, the
Facebook 2021, Slack DNSSEC 2021 and 1.1.1.1 July 2025 incidents. This page must go deeper and not
retell those; link back instead.

## Key facts, with sources

### Names, zones, delegation

- The namespace is a tree of labels; a **zone** is a connected part of the tree managed as one
  unit; a **zone cut** is where a parent hands a subtree to a child via NS records. RFC 1034 §4.2.
  https://www.rfc-editor.org/rfc/rfc1034
- Labels ≤ 63 octets, full name ≤ 255 octets. RFC 1035 §2.3.4. https://www.rfc-editor.org/rfc/rfc1035
- Trailing dot = fully qualified (absolute) name; the root is the empty label.
- Terminology reference: RFC 9499 (DNS Terminology, BCP 219, March 2024).
  https://www.rfc-editor.org/rfc/rfc9499
- TLDs in the root zone: 1,437 (IANA list version 2026101700, read 2026-10-18).
  https://data.iana.org/TLD/tlds-alpha-by-domain.txt
- Root server system: 13 identities, 12 operators, 2,047 instances (root-servers.org, Oct 2026,
  already cited on how-the-web-works).
- Glue: parent zone includes A/AAAA for name servers that live inside the child zone (in-bailiwick),
  otherwise a chicken-and-egg loop.

### Record types

- A (IPv4), AAAA (IPv6), CNAME (alias), NS (delegation), SOA (zone metadata: primary NS, admin
  mailbox, serial, refresh, retry, expire, minimum), MX (mail, with preference), TXT (free text;
  SPF, DKIM, domain verification), PTR (reverse), SRV (service location), CAA (which CAs may issue
  certs, RFC 8659), HTTPS/SVCB (RFC 9460, Nov 2023).
- CNAME rule: if a CNAME is present at a node, no other data should be present. RFC 1034 §3.6.2.
  The apex always has SOA and NS, so a CNAME can't sit at `example.com`.
  Workarounds: provider-side "ALIAS/ANAME" or Cloudflare "CNAME flattening" (resolve the target and
  answer with its A/AAAA). https://developers.cloudflare.com/dns/cname-flattening/
  Flattening caveat: can break third-party verification that expects the CNAME.
- HTTPS record (RFC 9460): AliasMode (priority 0) works at the apex; ServiceMode carries params:
  alpn (h2,h3), port, ipv4hint, ipv6hint, ech. Lets a browser learn "speaks HTTP/3" before
  connecting. https://www.rfc-editor.org/rfc/rfc9460

### Resolvers and caching

- Stub resolver (in the OS / libc) → recursive resolver (does the walk, caches) → authoritative.
  Forwarders sit between.
- Node: `dns.lookup()` uses getaddrinfo on libuv's threadpool (default 4 threads), reads
  /etc/hosts, returns no TTL; `dns.resolve*()` always queries the network, supports `{ttl:true}`.
  https://nodejs.org/api/dns.html
- Java: with no security manager, positive lookups cached ~30 s by default (`networkaddress.cache.ttl`);
  historically cached forever when a security manager was installed. Security manager is permanently
  disabled since JDK 24 (JEP 486), so modern default is 30 s. Source: JDK `InetAddressCachePolicy`,
  https://code.yawk.at/java/8/sun/net/InetAddressCachePolicy.java
- Negative caching RFC 2308: NXDOMAIN (name doesn't exist, RCODE 3) vs NODATA (name exists, no
  records of that type: NOERROR + empty answer + SOA). Negative TTL = min(SOA MINIMUM, SOA's own TTL).
  "Values of one to three hours" sensible as cap; over a day "problematic".
  https://www.rfc-editor.org/rfc/rfc2308
- Serve-stale RFC 8767 (March 2020): answer from expired cache when authorities can't be reached.
  Stale TTL 30 s recommended; client response timer 1.8 s; keep stale data 1–3 days; recheck failed
  authorities no more than every 30 s. https://www.rfc-editor.org/rfc/rfc8767
- QNAME minimisation RFC 9156 (2021, Standards Track): send root only "org", not the full name.
  Privacy; costs up to 26% more lookups in a cited study. https://www.rfc-editor.org/rfc/rfc9156
- EDNS Client Subnet RFC 7871 (May 2016, Informational): resolver passes /24 (IPv4) or /56 (IPv6) of
  the client so GeoDNS/CDNs answer for the user's location rather than the resolver's. Privacy cost;
  authors say they'd not design it this way. https://www.rfc-editor.org/rfc/rfc7871
- Kubernetes pods: `nameserver 10.x`, `search <ns>.svc.cluster.local svc.cluster.local cluster.local`,
  `options ndots:5`. Names with fewer than 5 dots try every search suffix first → many extra queries
  (A and AAAA each). Fix: trailing dot, or `dnsConfig` with lower ndots.
  https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/

### Transport

- Classic UDP limit 512 bytes (RFC 1035). EDNS(0) (RFC 6891) lets client advertise bigger buffer.
- DNS Flag Day 2020: default EDNS buffer 1232 bytes (1280 IPv6 min MTU − 48 bytes headers) to avoid
  IP fragmentation. Google planned 1400. https://www.dnsflagday.net/2020/
- Too big → server sets TC (truncated) bit → client retries over TCP. RFC 9210 (BCP 235, 2022):
  all resolvers and servers MUST support UDP and TCP; operators MUST allow both; filtering TCP 53 is
  harmful. https://www.rfc-editor.org/rfc/rfc9210
- Encrypted: DoT RFC 7858 (port 853, 2016), DoH RFC 8484 (Oct 2018; `application/dns-message`, GET
  `?dns=` base64url or POST; ID 0 for cacheability; HTTP/2 minimum recommended; HTTP freshness ≤
  smallest TTL), DoQ RFC 9250 (2022). https://www.rfc-editor.org/rfc/rfc8484

### DNSSEC

- Each zone signs its records (RRSIG) with keys published as DNSKEY; parent publishes a DS (hash of
  the child's key) — chain of trust from the root's key (trust anchor) down. NSEC/NSEC3 prove
  non-existence. RFC 4033–4035.
- DNSSEC gives integrity/authenticity, not privacy. DoH/DoT give privacy to the resolver, not
  end-to-end authenticity.
- Root KSK rollover: KSK-2024 (key tag 38696) began signing the root DNSKEY set on 11 Oct 2026 at
  14:00 UTC; ICANN: "No indications of widespread operational disruption" (read 2026-10-18). KSK-2017
  (20326) revocation scheduled 11 Jan 2027. https://www.icann.org/resources/pages/ksk-rollover-en
  https://www.iana.org/dnssec/files
- Validation measured per user by APNIC Labs; varies hugely by country/ISP. https://stats.labs.apnic.net/dnssec

### DNS as a traffic tool

- Route 53 routing policies: simple, failover, geolocation, geoproximity, latency, IP-based,
  multivalue (up to 8 healthy records at random), weighted.
  https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html
- DNS load balancing is coarse: caches, clients that pin an address, no knowledge of server load.

## Real incidents (sourced)

- **AWS DynamoDB us-east-1, 19–20 Oct 2025.** DNS automation: Planner makes plans; three Enactors
  (one per AZ) apply them to Route 53. A delayed Enactor applied a stale plan after a faster one had
  applied a newer plan; the faster one's clean-up then deleted that old plan, which was now live,
  removing all IPs: `dynamodb.us-east-1.amazonaws.com` had an empty record. Start 11:48 PM PDT
  19 Oct; cause identified 12:38 AM; DNS restored 2:25 AM; cached records expired and clients
  recovered by 2:40 AM. Downstream (EC2, NLB) effects until 2:20 PM 20 Oct. Automation disabled
  worldwide pending fix. https://aws.amazon.com/message/101925/
- **.de DNSSEC failure, 5 May 2026.** During a key rollover DENIC's new signing system produced three
  key pairs (one per HSM) but published only one key (tag 33834): about a third of signatures
  validated. Validating resolvers returned SERVFAIL for .de, including unsigned domains (NSEC3
  delegation proofs failed). ~3 hours (Cloudflare: ~19:30 to 22:17 UTC on 1.1.1.1). Monitoring
  detected it but alerts weren't processed. Big resolvers applied negative trust anchors; serve-stale
  cushioned impact; failures grew as caches expired. https://blog.denic.de/en/analysis-of-the-dns-outage-on-5-may-2026/
  https://blog.cloudflare.com/de-tld-outage-dnssec/
- **Dyn, 21 Oct 2016.** DDoS from Mirai botnet on Dyn's managed DNS; waves ~11:10–13:20 and
  15:50–17:00 UTC; Twitter, GitHub, Netflix, Reddit, Spotify unreachable for many. Lesson: a single
  DNS provider is a single point of failure; NS sets can list two providers.
  https://blog.apnic.net/2016/10/26/quick-look-attack-dyn/ ·
  https://www.helpnetsecurity.com/2016/10/27/dyn-ddos-post-mortem/
- Already on how-the-web-works (link, don't retell): Facebook 2021, Slack DNSSEC 2021, 1.1.1.1 2025.

## Common misconceptions

- "DNS propagation" is not a push. Nothing spreads; caches expire on their own schedules.
  (jvns.ca/blog/how-updating-dns-works/)
- Lowering the TTL at the moment of the change doesn't help; the old TTL is what's cached.
- "TTL = how long until users see the change" — only an upper bound for well-behaved caches;
  apps and JVMs, browser caches, and clients pinning connections ignore it.
- NXDOMAIN gets cached too (negative caching): query a name before creating it and you wait.
- DNS isn't only UDP: TCP is mandatory, and big answers (DNSSEC, many TXT) need it.
- DoH ≠ DNSSEC. Privacy vs authenticity.
- A CNAME at the apex is not allowed; that's why ALIAS/flattening exist.
- DNS round-robin isn't load balancing in the health-aware sense.

## How explainers structure it, and what they leave out

- Cloudflare Learning Center "What is DNS": phone book analogy, the four servers (recursor, root,
  TLD, authoritative), 8 steps of a lookup, caching layers. Leaves out: negative caching,
  TTL trade-offs in operations, failure modes, transport details, application-level caching.
- Julia Evans, "How updating DNS works": dig experiments; propagation = caches expiring; NS change
  takes 48 h because of the 172800 TTL. Leaves out negative caching, serve-stale, apps.
- Typical interview prep: lists record types and the resolution walk. Leaves out how DNS is
  operated: changing records safely, automation, multi-provider, application caching, k8s ndots.
- **Our angle:** DNS as a distributed cache you can't flush. Teach it as an operator: how to change
  records safely, why every app layer caches differently, how DNS fails, and how to make your
  services survive it. Build a toy authoritative server and a TTL-respecting, serve-stale client.

## Measured by us (examples/dns, 2026-10-18)

From a network in India, Windows 11, Python 3.14.7 and Node 24.19.0:

- UDP to 1.1.1.1, cached answers: 12–20 ms (one 33 ms outlier); cache misses 105–141 ms.
- Remaining TTLs differ by cache instance: example.com A seen as 264, 81 and 300 s at the same time
  (UDP 1.1.1.1, DoH cloudflare-dns.com, DoH dns.google). Counting down between runs (153, 173, 110, 33).
- www.github.com CNAME github.com (TTL 2998 left), github.com A 20.207.73.82 (TTL 46–60).
- gmail.com MX 5/10/20/30/40; google.com CAA `0 issue "pki.goog"`; cloudflare.com HTTPS
  `1 . alpn=h3,h2 ipv4hint=… ipv6hint=…`; example.com NS hera/elliott.ns.cloudflare.com; SOA minimum 1800;
  example.com TXT `v=spf1 -all`; example.com MX `0 .` (null MX).
- no-such-name.wikipedia.org → NXDOMAIN (negative TTL 3600). no-such-name.example.com → NOERROR
  with empty answer (Cloudflare compact denial of existence, RFC 9824; negative TTL 1800).
- DoH: first request to cloudflare-dns.com 213–222 ms (new TCP + TLS), reused connection 17 ms,
  same as UDP 18 ms. dns.google 67–129 ms first request.
- Python on Windows could not verify cloudflare-dns.com (SSL.com ECC root missing from the Windows
  store); worked from WSL Python and from Node (bundled roots).
- Toy server: big TXT 2,835 bytes over TCP; UDP reply with TC=1 was 39 bytes.
- Dead upstream on 127.0.0.1:5399: Windows Python gets ConnectionResetError at once (16 ms);
  Node on Windows and Python on Linux wait the 400 ms timeout.
- Port 5353 is taken on Windows by mDNS listeners; examples use 8053.
- Sim check (model.ts, defaults): compare mode, 5 resolvers × 10 lookups/min over 1.5 h: TTL 60 s →
  408 authoritative queries; TTL 3600 s → 7 (≈58×).

## Further reading list

Specs: RFC 1034, RFC 1035, RFC 2308, RFC 6891, RFC 7858, RFC 7871, RFC 8484, RFC 8767, RFC 9156,
RFC 9210, RFC 9250, RFC 9460, RFC 9499, RFC 4033, DNS Flag Day 2020, IANA TLD list, ICANN KSK
rollover page, Kubernetes DNS docs, Node dns docs, Route 53 routing policies, Cloudflare CNAME
flattening.
Engineering: AWS DynamoDB summary, DENIC analysis, Cloudflare .de post, APNIC on Dyn.
Explainers: Julia Evans, Cloudflare Learning Center.
