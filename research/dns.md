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

## Update 2026-10-21: trimmed to the reading budget

- Page cut from about 63 min (9,850 words, 357 code lines) to about 43 min (about 7,700 words,
  157 code lines). Removed: the toy server and DoH code on the page (still in examples/),
  repeated TCP 53, ndots and resolve-once gotchas, the second TTL table, the HTTPS-record and
  DNSSEC-adoption paragraph. All diagrams, both step-throughs and both sim modes kept.
- "As of" facts re-checked: the network in this session could not reach IANA, root-servers.org or
  ICANN, so the 1,437 TLD count and the root key rollover are still from the 2026-10-18 reading.
  A search confirmed KSK-2024 was scheduled to sign the root zone from 11 October 2026; no
  post-rollover report was found, so the page no longer claims "no widespread disruption".

## Update 2026-10-22: rewritten to the owner's standard (hook, mechanisms, mechanism sims)

Angle: a DNS answer is a lease nobody can recall. The page now spends its words on what each layer
does to the TTL, migration lead time, negative and failure caching, outage spread, name server
selection, DNS load balancing, size limits and DNSSEC costs. The resolution walk, record-type
tables, DoT/DoH/DoQ detail and the CNAME apex section were cut (known to the reader or covered on
how-the-web-works). WebFetch could not resolve hosts in this session; facts below came from
WebSearch results and are worth a second look where marked (*).

### New facts and sources

- BIND 9 defaults: `max-cache-ttl` 604800 (7 d), `max-ncache-ttl` 10800 (3 h, hard cap 7 d),
  `stale-answer-enable no`. https://bind9.readthedocs.io/en/stable/reference.html
  (stale-cache-enable default differs between versions; not used on the page.)
- Unbound defaults: `cache-max-ttl` 86400, `cache-max-negative-ttl` 3600, `cache-min-ttl` 0,
  `serve-expired no`. https://unbound.docs.nlnetlabs.nl/en/latest/manpages/unbound.conf.html
- Unbound server selection: random among servers within a 400 ms RTT band of the fastest; unknown
  server assumed 376 ms; infra-cache entries live 15 min.
  https://unbound.docs.nlnetlabs.nl/en/latest/reference/history/info-timeout-server-selection.html
  (A GitHub issue, #567, argues the band is only 400 ms at first.) (*)
- RFC 9520 (Dec 2023): resolvers MUST cache resolution failures (SERVFAIL, timeouts, validation
  failures) for at least 1 s and at most 5 min; SHOULD back off. https://www.rfc-editor.org/rfc/rfc9520.html
- RFC 8767 serve-stale: stale answers get TTL 30 s; keep stale data 1–3 days (the RFC also mentions
  a 7-day cap as common practice). (*) https://www.rfc-editor.org/rfc/rfc8767
- RFC 8020: NXDOMAIN means nothing exists below the name. RFC 8198: aggressive use of NSEC/NSEC3
  proofs to synthesize NXDOMAIN for ranges; on by default since BIND 9.12 (`synth-from-dnssec`).
  https://www.rfc-editor.org/rfc/rfc8198 · https://blog.apnic.net/2018/02/06/aggressive-nsec-caching-bind-9-12/
- Moura et al., "When the Dike Breaks" (IMC 2018): caching not effective for ~30% of clients
  during a DDoS; retries raise authoritative traffic up to 8×; with fresh caches 35–70% of clients
  served from cache. https://ant.isi.edu/~johnh/PAPERS/Moura18b.pdf
- Moura et al., "Cache Me If You Can" (IMC 2019): most resolvers are child-centric (prefer TTLs of
  authoritative child answers). https://ant.isi.edu/bib/Moura19b.html
- Müller et al., "Recursives in the Wild" (IMC 2017): most resolvers query all authoritatives over
  time; about half prefer lower latency; recommend anycast on every NS.
  https://ant.isi.edu/~johnh/PAPERS/Mueller17b.pdf
- Chrome: 60 s cache when using the OS resolver (no TTL known); built-in resolver uses TTL with a
  60 s minimum. https://textslashplain.com/2022/03/31/chromiums-dns-cache/ (*)
- Java: `networkaddress.cache.ttl` 30 s, `networkaddress.cache.negative.ttl` 10 s (java.security).
- glibc getaddrinfo sorts addresses by RFC 3484/6724 rules, which can defeat round robin.
  https://cern.ch/twiki/bin/view/LinuxSupport/GlibcDnsLoadBalancing · https://sourceware.org/bugzilla/show_bug.cgi?id=24282
- Route 53 health checks: 30 s interval default (10 s option), failure threshold 3; AWS suggests
  60 s TTL on failover records. https://aws.amazon.com/blogs/aws/route-53-health-check-improvements-faster-interval-and-configurable-failover/
- ECS cache effects: cache size up to an order of magnitude larger, hit rates for ECS queries under
  half of normal (one CDN + one public resolver). (*) https://akamai.com/site/en/documents/research-paper/a-look-at-the-ecs-behavior-of-dns-resolvers.pdf
- DNSKEY response sizes (APNIC, Huston 2021): 1 RSA-4096 key 1,245 B, 2 keys 1,755 B, 3 keys
  2,237 B; 1 ECDSA P-256 key 347 B. (*) https://labs.apnic.net/presentations/store/2021-11-25-rsa4096.pdf
  Signature sizes: RSA-2048 256 B, ECDSA P-256 64 B.
- DNSSEC deployment: ~36% of users behind validating resolvers, ~7% secure delegations in 2025
  (CircleID, Feb 2026, citing an APNIC post that could not be opened). (*)
  https://circleid.com/posts/dnssec-doesnt-need-a-better-story-it-needs-a-better-tuesday
  .com signing rate 4.3% (Verisign, 2023).
- KeyTrap CVE-2023-50387: specification flaw; one packet could stall BIND up to 16 h; fixed in
  BIND 9.16.48 / 9.18.24 / 9.19.21 (Feb 2024). https://kb.isc.org/docs/cve-2023-50387 · https://arxiv.org/pdf/2406.03133
- AWS DynamoDB 2025: DNS restored 2:25 AM; customers reconnected as cached records expired; DynamoDB
  errors ended 2:40 AM. https://aws.amazon.com/message/101925/

### Sim checks (seed 42, headless, numbers quoted on the page)

- migration-model, defaults (old TTL 3600, lead 0, off after 10 min, 2% pinned): 176 of 200 caches
  on the old address at switch-off; 13,182 of 47,817 lookups after it failed (28%); last unpinned
  cache switched at +1 h 00 min; DNS queries 2.8/min before → ~147/min with 60 s TTL (~52×).
  Lead 30: 68 caches, 6%, last +30 min. Lead 60: 4 (pinned) caches, 2%, last +2 min.
- outage-model 'unreachable', defaults (TTL 300, 60 min, 0% stale): 100% failing from minute 5.
  TTL 3600: 58% at minute 30, 99% at minute 59. Stale 50%: ~51% failing. Stale 100%: 0.
- outage-model 'empty', defaults (TTL 300, 50 min, negative TTL 900): 83–89% still failing in the
  ten minutes after the fix; last failure at +64.9 min (~15 min after the fix). Negative TTL 60:
  last failure +51 min.
- rr-model, defaults (10 resolvers Zipf, 100% first address, TTL 300): largest resolver 34% of
  users; worst moment 3.46× fair share; some server above 1.5× 100% of the time; longest one server
  stayed above 1.5×: 10 min; busiest server's 2-hour average 1.19×. 200 resolvers: worst 2.16×,
  hot 43% of the time, biggest 17%. First address 0%: even. TTL 30: longest hot 90 s; TTL 1800: 47 min.

### Sandbox note

UDP port 53 in this session returned fake answers (NXDOMAIN for example.com from "1.1.1.1"), so no
live lookups were run; `lookup.py`/`lookup.mjs` were removed with the page sections that used them.
