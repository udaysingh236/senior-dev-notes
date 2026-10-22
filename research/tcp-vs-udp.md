# Research notes: TCP vs UDP

Track: `networking` · Slug: `tcp-vs-udp` · Order: 2 · Post #: 59 · Researched: 2026-10-18

Notes for understanding, not for pasting. Quotes kept under 15 words.

Already covered elsewhere on the site, so link instead of retelling:

- `how-the-web-works`: the three-way handshake (with a diagram), ports and the 4-tuple, Happy
  Eyeballs, slow start and the 10-packet / 14.6 KB initial window, QUIC merging TCP+TLS into one
  round trip, HTTP/3 share (Cloudflare Radar 2025: HTTP/2 50%, HTTP/1.x 29%, HTTP/3 21%).
- `dns`: DNS over UDP first, TC bit, retry over TCP, 1,232-byte EDNS buffer, fragments dropped,
  RFC 9210 (TCP mandatory).

## Key facts, with sources

### IP, ports, the two transports

- IP is best effort: packets can be lost, duplicated, reordered, corrupted (caught by checksums).
- UDP, RFC 768 (28 August 1980, Postel), STD 6. Header = 4 fields × 16 bits = 8 bytes: source port
  (optional, 0 if unused), destination port, length (min 8), checksum. "Delivery and duplicate
  protection are not guaranteed." Updated by RFC 9868 (October 2025, Transport Options for UDP:
  options in the surplus area after the payload). https://www.rfc-editor.org/rfc/rfc768
  https://www.rfc-editor.org/rfc/rfc9868.html
- TCP, RFC 9293 (August 2022, STD 7), obsoletes RFC 793 and several others. "Reliable, in-order,
  byte-stream service" (§2.2). §3.7: no correlation between segment boundaries and the app's
  read/write boundaries. Header 20 bytes minimum, 60 maximum (data offset is 4 bits of 32-bit
  words). Fields: ports, sequence number, ack number, data offset, flags (CWR ECE URG ACK PSH RST
  SYN FIN), window (16 bits), checksum, urgent pointer, options.
  https://www.rfc-editor.org/rfc/rfc9293
- TCP ISN: clock-driven plus a keyed hash of the 4-tuple (MUST-8, SHLD-1) so off-path attackers
  cannot guess sequence numbers.
- TCP TIME-WAIT: 2×MSL; RFC's MSL is 2 minutes (so 4 minutes in the RFC). Linux uses a fixed 60 s
  TIME_WAIT (TCP_TIMEWAIT_LEN). Only the side that closes first enters TIME-WAIT.
- TCP keep-alive: off by default; if on, default interval MUST be ≥ 2 hours (RFC 9293 §3.8.4).
  Linux: tcp_keepalive_time 7200 s, intvl 75 s, probes 9 (≈ 11 min to declare dead after first
  probe). https://docs.kernel.org/networking/ip-sysctl.html
- Linux sysctls (docs.kernel.org, read Oct 2026): tcp_syn_retries 6 → final connect timeout ≈ 131
  s (with tcp_syn_linear_timeouts=4: first 4 retries linear at 1 s?—doc says about 67 s of
  retransmissions, ≈131 s total); tcp_retries2 15 → ≈ 924.6 s before an established connection
  gives up; tcp_fin_timeout 60 s (FIN_WAIT_2 orphans); ip_local_port_range 32768–60999 (28,232
  ports); tcp_rto_min_us 200,000 (200 ms); tcp_rmem default 131072; window scaling on; SACK on;
  tcp_tw_reuse default 2 = loopback only; tcp_slow_start_after_idle on.

### Reliability: RTO, fast retransmit

- RFC 6298: SRTT/RTTVAR with alpha 1/8, beta 1/4, K=4: RTO = SRTT + max(G, 4·RTTVAR). Initial RTO
  1 s (was 3 s). Minimum RTO SHOULD be 1 s (Linux uses 200 ms). Each timeout doubles the RTO.
  If the SYN is lost, RTO resets to 3 s when data starts. https://www.rfc-editor.org/rfc/rfc6298
- So a lost SYN costs ≈ 1 s extra on Linux: shows up as latency spikes at ~1 s, ~3 s in p99/p999
  (a classic "why is my p99 exactly 1 second" puzzle).
- Fast retransmit after 3 duplicate ACKs (RFC 5681). SACK (RFC 2018) tells the sender exactly which
  ranges arrived. RACK-TLP (RFC 8985) is time-based loss detection in Linux.
- QUIC loss detection (RFC 9002): packet threshold 3, time threshold 9/8 RTT, granularity 1 ms,
  initial RTT 333 ms (PTO ≈ 1 s). Packet numbers never reused, so no retransmission ambiguity.
  Default congestion controller NewReno-like; initial window 10 × max datagram size, capped at
  max(14,720 B, 2 × datagram). https://www.rfc-editor.org/rfc/rfc9002

### Flow and congestion control

- Receive window 16-bit = 65,535 bytes max without scaling; window scaling (RFC 7323) up to ~1 GB.
- Bandwidth-delay product: to fill 100 Mbit/s at 100 ms RTT needs 1.25 MB in flight. (HPBN: 16 KB
  window at 100 ms caps at 1.31 Mbit/s.) https://hpbn.co/building-blocks-of-tcp/
- CUBIC RFC 9438 (2023), obsoletes RFC 8312. Default in Linux, Windows and Apple stacks. β = 0.7
  (cut to 70% on loss, Reno cuts to 50%), C = 0.4. W(t) = C(t−K)³ + Wmax.
  https://www.rfc-editor.org/rfc/rfc9438
- BBR (Cardwell et al., ACM Queue 2016): model-based, measures bottleneck bandwidth and min RTT
  instead of reacting to loss. Summary reports 2–25× throughput over CUBIC on Google's WAN and
  large RTT reductions on YouTube. BBRv3 is an IETF draft (draft-cardwell-ccwg-bbr).
  https://queue.acm.org/detail.cfm?id=3022184 https://datatracker.ietf.org/doc/html/draft-cardwell-ccwg-bbr
- Why congestion control matters even for UDP apps: RFC 8085 §3.1 — apps without congestion
  control SHOULD limit their rate; bulk transfers must be TCP-friendly within an order of
  magnitude; low-volume apps ≤ 1 datagram per RTT, or one every 3 s without an RTT estimate;
  SHOULD implement a circuit breaker. https://www.rfc-editor.org/rfc/rfc8085

### UDP practicalities (RFC 8085)

- Max payload 65,507 B (IPv4) / 65,527 B (IPv6). Avoid fragmentation: stay under path MTU;
  fallback 576 B (IPv4) / 1,280 B (IPv6). Ethernet MTU 1500 − 20 IP − 8 UDP = 1,472 B payload.
- QUIC requires client Initial datagrams ≥ 1,200 bytes and caps servers at 3× bytes received
  before address validation (anti-amplification, RFC 9000 §8.1). https://www.rfc-editor.org/rfc/rfc9000
- Reliability, ordering, duplicate handling are the app's job (§3.3); be robust to duplicates for
  2 minutes.
- Keep-alives no more often than every 15 s (§3.5); NATs must keep UDP mappings ≥ 2 min (RFC 4787
  REQ-5, recommended 5 min, Jan 2007) but many don't. QUIC RFC 9000 §10.1.2: experience says
  sending every 30 s is needed to keep most middleboxes from forgetting UDP flows.
  https://www.rfc-editor.org/rfc/rfc4787
- Use random ephemeral source ports (RFC 6056) to resist spoofed injection.
- Linux conntrack: UDP entries time out (nf_conntrack_udp_timeout 30 s default) while TCP entries
  are removed on close (Kubernetes NodeLocal DNSCache docs).
  https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/

### Nagle, delayed ACK

- Nagle's algorithm (RFC 896, 1984): hold small segments while unacked data is in flight.
  Delayed ACK: receiver waits up to 40 ms (Linux TCP_DELACK_MIN) / up to 200 ms (others) before
  ACKing. Together, write-write-read stalls one delayed-ACK period. Fix: TCP_NODELAY, or buffer
  the writes into one. https://en.wikipedia.org/wiki/Nagle%27s_algorithm (secondary).
- Node: `net` sockets start with Nagle ON; `http.createServer` `noDelay` defaults to true since
  v18.0.0; server keepAliveTimeout 5,000 ms. Python sockets: Nagle on by default.
  https://nodejs.org/api/http.html https://nodejs.org/api/net.html

### QUIC

- RFC 9000 (May 2021): streams over UDP, TLS 1.3 built in, connection IDs survive address changes
  (migration; client-initiated only). No ordering between streams, so loss on one stream does not
  block others. Encrypts and authenticates as much of each packet as practical (resists
  ossification by middleboxes).
- Google SIGCOMM 2017 paper: ~7% of internet traffic was QUIC then; Google Search latency
  reduced 3.6–8%, YouTube rebuffers reduced 15–18%, gains larger at higher RTT.
  https://research.google/pubs/the-quic-transport-protocol-design-and-internet-scale-deployment/
- Uber (May 2019): QUIC cut tail latencies of HTTPS traffic by 10–30% in rider and driver apps on
  lossy mobile networks. https://www.uber.com/blog/employing-quic-protocol/
- TCP Fast Open (RFC 7413, 2014, Experimental): data in the SYN on repeat connections; hampered
  by middleboxes that drop SYNs with data; little used by browsers.

### Who uses what

- DNS: UDP first, TCP for big answers and zone transfers (see dns page).
- Voice/video: WebRTC media over UDP (SRTP). Discord (Sept 2018, Jozsef Vass): native clients
  send voice over UDP to Discord's own SFU, dropping ICE/DTLS/SDP; Salsa20 encryption; periodic
  pings keep firewalls open; 850+ voice servers, 13 regions, 2.6 M concurrent users, 220 Gbps,
  120 Mpps. https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc
- Games: Gaffer on Games (Glenn Fiedler, 2008) argues time-critical state must never go over TCP
  because a lost packet stalls newer data; latest state beats reliable old state.
  https://gafferongames.com/post/udp_vs_tcp/
- VPNs: WireGuard is UDP only; explicitly no TCP tunnelling because TCP-over-TCP performs badly.
  https://www.wireguard.com/known-limitations/
- Metrics: StatsD sends over UDP by default so the app never blocks on the metrics server.
- Voice deadline: ITU-T G.114 — under 150 ms one-way is "essentially transparent" for most
  apps; 400 ms is the planning ceiling. https://www.itu.int/rec/T-REC-G.114

## Sourced incidents

- **GitHub, 28 Feb 2018, memcached amplification** (GitHub incident report, 1 March 2018): 17:21
  UTC anomaly; GitHub fully unavailable 17:21–17:26, intermittent until 17:30 while BGP moved
  traffic to Akamai. Peak 1.35 Tbps, 126.9 Mpps, amplification up to 51,000×, UDP port 11211,
  over a thousand ASNs. Second 400 Gbps spike after 18:00. Root lesson: UDP has no handshake, so
  a spoofed source address gets the (huge) reply. https://github.blog/news-insights/company-news/ddos-incident-report/
  (original URL github.blog/2018-03-01-ddos-incident-report/).
- **Linux conntrack race → 5 s DNS timeouts in Kubernetes** (2017–2019): glibc sends A and AAAA
  in parallel from the same UDP socket; a conntrack/DNAT race drops one; the client waits the
  resolv.conf default timeout of 5 s. Kernel fixes in 4.19 and 5.0; workarounds
  `single-request-reopen`, NodeLocal DNSCache. kubernetes/kubernetes#56903; Canonical kernel
  patch thread https://lists.snapcraft.io/archives/kernel-team/2019-July/102291.html; Kubernetes
  NodeLocal DNSCache docs. (The original Weaveworks post's domain now redirects elsewhere; do
  not link it.)
- **SACK Panic, CVE-2019-11477** (June 2019), found by Jonathan Looney at Netflix: crafted SACKs
  with MSS 48 overflow a counter and panic Linux kernels from 2.6.29. Fixed in 4.4.182, 4.9.182,
  4.14.127, 4.19.52, 5.1.11. Mitigation: disable SACK or drop low-MSS connections.
  https://access.redhat.com/security/vulnerabilities/tcpsack https://ubuntu.com/security/vulnerabilities/sack-panic
- **Ephemeral port exhaustion at Cloudflare** (Marek Majkowski, 2 Feb 2022): WebSocket growth
  pushed concurrent outbound connections to the limit of the ephemeral port range; symptoms were
  odd errors (SSH to localhost refused, DNS query "address in use"). Fix: careful
  bind-before-connect with IP_BIND_ADDRESS_NO_PORT and more source IPs.
  https://blog.cloudflare.com/how-to-stop-running-out-of-ephemeral-ports-and-start-to-love-long-lived-connections/

## Misconceptions and confusing points

- "UDP is faster." Same wire speed; UDP saves the handshake and never waits for retransmits. Under
  no loss, a warm TCP connection is as fast. The real difference is behaviour under loss.
- "TCP guarantees delivery." It guarantees in-order delivery *or an error*. `send()` returning
  means the bytes are in the local kernel buffer, nothing more. A crash after send loses data;
  apps need their own acknowledgements (idempotency keys, etc.).
- "One send = one receive" on TCP. Wrong: byte stream; messages merge and split. Need framing.
- "UDP is connectionless so there is no state." NATs, firewalls and conntrack keep UDP state,
  with timeouts, which is why keep-alives exist.
- "UDP has no congestion control so I can blast." RFC 8085 says you must limit your rate.
- "TCP is slow because of the handshake." Pay it once, reuse connections (pools, keep-alive).
- Port numbers: TCP port 53 and UDP port 53 are different sockets.
- QUIC is not "UDP instead of TCP"; it is TCP-like reliability rebuilt in user space on UDP.

## How popular explainers structure it, and what they leave out

1. **Comparison-table explainers (Cloudflare Learning, many blogs and videos):** reliable vs
   unreliable, connection vs connectionless, "slow vs fast", list of uses. Leave out: byte stream
   framing bug, head-of-line blocking, what happens under loss in numbers, NAT state, RFC 8085
   duties, QUIC.
2. **High Performance Browser Networking (Grigorik, 2013), TCP and UDP chapters:** excellent on
   handshake cost, slow start, BDP, HOL blocking, NAT traversal. Dated on congestion control (no
   BBR), TFO optimism, no QUIC.
3. **Gaffer on Games "UDP vs TCP" (2008):** game-specific: stale data and retransmit stalls. Light on
   congestion control and NAT; predates QUIC.

Our angle: show behaviour under loss with a sim (TCP stalls vs UDP gaps vs QUIC streams), the
byte-stream framing bug every beginner writes, the real duties you take on with UDP (RFC 8085),
and QUIC as the modern answer; plus production gotchas (Nagle 40 ms, TIME_WAIT, CLOSE_WAIT, NAT
timeouts, lost SYN = 1 s).

## Our own measurements (to fill from examples, Oct 2026)

- Loopback framing demo, UDP drop on loopback with a slow receiver, reliable-UDP over a lossy relay,
  Nagle + delayed ACK on WSL loopback, DNS over UDP vs TCP to 1.1.1.1.

## Sources for Further reading

Specs: RFC 768, RFC 9868, RFC 9293, RFC 6298, RFC 5681, RFC 2018, RFC 8985, RFC 7323, RFC 9438,
RFC 9000, RFC 9002, RFC 8085, RFC 4787, RFC 7413, RFC 896, ITU-T G.114, Linux ip-sysctl docs,
Node http/net docs, Kubernetes NodeLocal DNSCache, WireGuard known limitations.
Engineering: GitHub DDoS report 2018, Cloudflare ephemeral ports 2022, Netflix/Red Hat SACK Panic,
Uber QUIC 2019, Google QUIC SIGCOMM 2017, BBR ACM Queue 2016, Discord voice 2018.
Explainers: HPBN TCP and UDP chapters, Gaffer on Games UDP vs TCP.

## Re-check, 2026-10-21 (page trimmed to the reading budget)

- BBR: still an Internet-Draft; latest is draft-ietf-ccwg-bbr-06 (July 2026), Experimental track.
  https://datatracker.ietf.org/doc/draft-ietf-ccwg-bbr/
- AWS NLB: TCP idle timeout default 350 s (60–6,000 configurable), UDP 120 s; unchanged.
  https://aws.amazon.com/blogs/networking-and-content-delivery/introducing-nlb-tcp-configurable-idle-timeout/

## Rewrite to the owner's standard, 2026-10-22

Angle for the rewrite: every TCP guarantee is enforced by making someone wait (a round trip, a
timer, a gap), and every one of those waits has a number. UDP has none of the waits and none of
the guarantees; the page is about locating each wait, and what you rebuild if you leave TCP.
Readers already know "TCP reliable, UDP not", the three-way handshake and what a port is.

New facts, with sources:

- Mathis, Semke, Mahdavi, Ott, "The Macroscopic Behavior of the TCP Congestion Avoidance
  Algorithm", ACM CCR, July 1997: steady-state rate ≈ (MSS/RTT) × C/√p, C ≈ 1.22 (√(3/2)) with
  every packet acked. 1% loss, 100 ms, MSS 1460: ≈ 1.4 Mbit/s whatever the link. Less accurate
  above ~2% loss, where timeouts dominate (Padhye et al.).
  https://courses.cs.duke.edu/fall24/compsci514/readings/mathis-tcpmodel-ccr97.pdf
- Linux `tcp_slow_start_after_idle` (RFC 2861 congestion window validation): on by default since
  2006; idle longer than one RTO shrinks cwnd (halved per RTO idle, down to the restart window).
  Local check on kernel 6.18: value 1. Kernel docs: https://docs.kernel.org/networking/ip-sysctl.html
  RFC 2861: https://www.rfc-editor.org/rfc/rfc2861
- Linux CUBIC uses HyStart by default to leave slow start before the first loss; it can exit too
  early on paths with delay jitter; HyStart++ is RFC 9406 (netdev 0x1A, 2026).
  https://netdevconf.info/0x1A/sessions/talk/validation-and-evaluation-of-hystart-for-linux.html
  https://www.rfc-editor.org/rfc/rfc9406
- `tcp_syn_linear_timeouts` (default 4), commit ccce324dabfe by David Morley (Google), merged in
  the net-next tree in May–June 2023, so Linux 6.5: the first 4 SYN retransmissions wait 1 s each
  (1, 1, 1, 1, 1, 2, 4 s…) instead of doubling. Local check on kernel 6.18: 4. Older kernels: 1,
  2, 4, 8 s. (Version 6.5 inferred from the merge date: double-check.)
  https://code.amethyst.name/public-mirrors/linux/commit/ccce324dabfe
- `tcp_tw_reuse`: 0 off, 1 on, 2 loopback only (default). Lets a new *outgoing* connection take a
  port still in TIME_WAIT, relying on TCP timestamps to reject old duplicates.
  `tcp_tw_recycle` was removed in Linux 4.12 (2017) because it broke clients behind NAT.
- Middlebox idle timeouts, as of October 2026:
  - AWS NAT gateway: drops connections idle 350 s; the next packet gets an RST.
    https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html
  - AWS NLB: TCP 350 s default (60–6,000), UDP 120 s (already noted).
  - Azure Load Balancer: 4 minutes default (configurable to 100/120); silent drop unless
    "TCP reset on idle" is enabled. https://learn.microsoft.com/azure/load-balancer/load-balancer-tcp-reset
  - Google Cloud NAT: UDP mapping idle 30 s, TCP established 1,200 s (20 min).
    https://cloud.google.com/nat/docs/tune-nat-configuration
  - Linux conntrack: `nf_conntrack_tcp_timeout_established` 432,000 s (5 days);
    `nf_conntrack_udp_timeout` 30 s, `_stream` 120 s.
    https://docs.kernel.org/networking/nf_conntrack-sysctl.html
- QUIC CPU cost: secondary surveys cite the SIGCOMM 2017 paper as ~3.5× the CPU of TLS/TCP for
  the same traffic at the time. Could not read the primary PDF here: double-check before quoting
  other figures. Later independent studies (2022) measured about 2× for downloads.
  https://arxiv.org/pdf/1810.03884 (survey)

Our own runs for the rewrite (Linux 6.18 container, Python 3.13.16, Node 22.22.0, 2026-10-22):

- naive framing: 6 sends → 4 reads, none parse; framing fix parses all 6.
- UDP loss on loopback: 98% lost at full speed (Python), 94% (Node); 0% paced to 3,000/s.
- reliable UDP: plain 91/100; stop-and-wait 6.71 s; window of 16 0.89 s (Node 0.57 s).
- Nagle: two writes 44.01 ms median; TCP_NODELAY 0.06 ms; one write 0.06 ms (Node the same).
- TIME_WAIT demo (new): client closes first → 500 client-side TIME_WAIT sockets; server closes
  first → 500 server-side; one reused connection → 1. Port range 32768–60999 = 28,232 → ~470
  new connections/s per destination.
- DNS UDP vs TCP to 1.1.1.1: cannot run here (outbound port 53 times out); dropped from the page.

Sim checks (seed 42, headless):

- HOL compare, defaults (4% loss, 100 ms, 50 msg/s, 4 streams), long run: TCP 17% late, QUIC 6%,
  UDP 4% lost. 1 QUIC stream: 17% (same as TCP). 2 streams 12%, 8 streams 5%. RTT 200: TCP 42%.
- Congestion window model (CUBIC-like, IW10, BDP-sized queue), 1 MB at 100 ms / 50 Mbit/s: cold
  713 ms in 7 RTTs (10, 20, 40, 80, 160, 320, 55), warm 260 ms (= the link's ideal). 1 Gbit/s:
  cold 701 ms. Idle gap 1,000 ms (> RTO 300 ms): warm drops to 80 segments, 429 ms. 5 MB at 1%
  loss: about 1.6 Mbit/s on the 50 Mbit/s link; 0.1% loss about 21 Mbit/s.
