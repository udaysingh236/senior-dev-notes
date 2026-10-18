# Research notes: TLS and encryption in transit

Track: `networking` · Slug: `tls` · Order: 3 · Post #: 49, 51 · Researched: 2026-10-18

Notes for understanding, not for pasting. Quotes kept under 15 words.

Already covered elsewhere on the site, so link instead of retelling:

- `how-the-web-works`: a 5-step TLS 1.3 handshake step-through (ClientHello, ServerHello, cert +
  Finished, check cert, Finished + GET), SNI, ECH (RFC 9849), CA/B Forum lifetime schedule,
  Let's Encrypt 90-day / 6-day / 45-day plan, HSTS and preload, RoundTripSim (TLS 1.2 vs 1.3 vs
  QUIC), DST Root CA X3 expiry (30 Sep 2021), wrong device clock, wildcard rules, PQ key agreement
  29% → 52% of Cloudflare human traffic during 2025, RFC 9846 (July 2026) as current TLS 1.3 text.
- `tcp-vs-udp`: TCP is not secure, checksums are not integrity, QUIC always uses TLS 1.3, setup
  round trips table (TCP + TLS 1.3 = 2 RTT, TLS 1.2 = 3).
- `dns`: CAA records, DoT/DoH, DNSSEC vs DoH.

So this page goes deeper: the three properties and the primitives behind them, why each naive
construction fails, certificates and chains, the handshake in detail, resumption and 0-RTT,
versions and attacks, mTLS, where TLS terminates inside a system, and operating certificates.

## Key facts, with sources

### Specs and versions

- RFC 9846, TLS 1.3 (July 2026, Rescorla). Obsoletes RFC 8446 (TLS 1.3), RFC 5246 (TLS 1.2),
  RFC 5077, 6961, 7627, 8422; adds requirements for TLS 1.2 implementations (Appendix D).
  Full handshake order: ClientHello → ServerHello → EncryptedExtensions → [CertificateRequest] →
  Certificate → CertificateVerify → Finished; client [Certificate, CertificateVerify] Finished.
  Everything after ServerHello encrypted. https://www.rfc-editor.org/rfc/rfc9846.html
- Record layer: plaintext chunks ≤ 2^14 = 16,384 bytes; AEAD expansion ≤ 255 bytes; ciphertext
  cap 2^14 + 256. Ticket lifetime max 604,800 s (7 days). (RFC 9846 §5.1, §5.2, §4.7.1)
- HelloRetryRequest: when the ClientHello lacks an acceptable key share; costs an extra round trip.
- Downgrade protection: a TLS 1.3 server negotiating ≤ 1.2 puts a sentinel in the last 8 bytes
  of ServerHello.random; client aborts if it sees it unexpectedly.
- 0-RTT: "no guarantees of non-replay between connections" (RFC 9846). No forward secrecy for
  early data. Server-side anti-replay in §8 (single-use tickets, ClientHello recording,
  freshness window).
- TLS 1.3 cipher suites (5): TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384,
  TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_CCM_SHA256, TLS_AES_128_CCM_8_SHA256. The suite names
  only the AEAD + hash; key exchange and signature are negotiated separately (supported_groups,
  key_share, signature_algorithms).
- RFC 8996 (March 2021, BCP 195): TLS 1.0, 1.1 (and DTLS 1.0) moved to Historic. Reasons: SHA-1
  in handshake and signatures, no AEAD, old suites (3DES), attack surface.
  https://www.rfc-editor.org/rfc/rfc8996.html
- TLS 1.3 pretends to be TLS 1.2 on the wire (legacy_version 0x0303, real version in the
  supported_versions extension, dummy ChangeCipherSpec, session_id echo) because middleboxes broke
  on unknown versions. Cloudflare 2017: about 3% of connections failed with early TLS 1.3 drafts,
  mostly non-compliant middleboxes. https://blog.cloudflare.com/why-tls-1-3-isnt-in-browsers-yet/
  Illustrated walk-through of the bytes: https://tls13.xargs.org/

### Primitives

- Symmetric AEAD (AES-GCM, ChaCha20-Poly1305): one key encrypts and authenticates; 16-byte tag;
  per-record nonce derived from the record sequence number (so a reordered/replayed/dropped record
  fails to decrypt).
- Key exchange (EC)DHE: ephemeral X25519 (32-byte shares). Ephemeral keys → forward secrecy: a
  later theft of the server's long-term key does not decrypt recorded sessions. TLS 1.2 static RSA
  key exchange had no forward secrecy; TLS 1.3 removed it.
- Post-quantum hybrid X25519MLKEM768: client share 1,216 bytes (1,184 ML-KEM + 32 X25519), server
  share 1,120 bytes (RFC 10024, August 2026, Proposed Standard, defines X25519MLKEM768,
  SecP256r1MLKEM768, SecP384r1MLKEM1024: https://datatracker.ietf.org/doc/rfc10024/ ; also
  netmeister.org/blog/tls-hybrid-kex.html). Pushes the
  ClientHello past one ~1,500-byte packet. Chrome 124 shipped Kyber draft (Apr 2024), Chrome 131
  switched to X25519MLKEM768 (Nov 2024). Cloudflare Radar: client PQ support > 60% in February
  2026 (from < 3% at start of 2024); about 10% of origins support it.
  https://blog.cloudflare.com/radar-origin-pq-key-transparency-aspa/
  Threat it addresses: "harvest now, decrypt later".
- Signatures (ECDSA, RSA-PSS, Ed25519) prove possession of the private key (CertificateVerify signs
  the handshake transcript).
- Cost: Google 2010 (Langley, Modadugu, Chang), Gmail on HTTPS: < 1% CPU, < 10 KB memory per
  connection, < 2% network overhead, no extra machines.
  https://www.imperialviolet.org/2010/06/25/overclocking-ssl.html

### Certificates, chains, trust stores

- X.509 cert: subject, Subject Alternative Names (what browsers check), issuer, validity
  notBefore/notAfter, public key, extensions (basicConstraints CA:FALSE, keyUsage, EKU serverAuth),
  CA signature. Chain: leaf → intermediate(s) → root in the client's trust store. Server must send
  the intermediates (missing intermediate = classic "works in Chrome, fails in curl/Python" bug,
  because browsers cache/fetch intermediates via AIA, other clients don't).
- Mozilla root store, measured via curl's extract (https://curl.se/ca/cacert.pem), "as of Fri Sep 25
  2026": 121 roots trusted for TLS. Any of them can issue for any name → Certificate Transparency.
- Certificate Transparency (RFC 6962; v2 RFC 9162): public append-only logs; CA gets SCTs. Chrome
  policy: embedded SCTs from ≥ 2 distinct logs for ≤ 180-day certs, ≥ 3 for longer; ≥ 2 distinct
  operators. https://googlechrome.github.io/CertificateTransparency/ct_policy.html
  Search logs at https://crt.sh.
- DigiNotar (2011): rogue *.google.com cert, revoked 29 Aug 2011; Fox-IT interim report found about
  300,000 unique IPs requesting google.com with it, > 99% from Iran; 531 rogue certs; DigiNotar went
  bankrupt. https://www.sec.gov/Archives/edgar/data/1044777/000119312511241796/dex992.htm
  (Fox-IT interim report as filed). This is the motivating story for CT.
- Revocation: CRLs and OCSP. OCSP leaks browsing to the CA and soft-fails. Let's Encrypt ended OCSP:
  URLs removed from certs 7 May 2025, responders off 6 Aug 2025; CRLs only.
  https://letsencrypt.org/2024/12/05/ending-ocsp/ (ISRG post: https://isrg.org/post/ending-ocsp/)
  Chrome 148 stopped accepting SCTs in stapled OCSP responses (CT policy page).
- Let's Encrypt March 2020: CAA rechecking bug, 3,048,289 certs to revoke with ~5 days notice; 1.7M+
  replaced in time; rest left to expire rather than break sites.
  https://community.letsencrypt.org/t/revoking-certain-certificates-on-march-4/114864

### Lifetimes and automation

- CA/B Forum SC-081v3 (passed April 2025): max validity 398 → 200 days (15 Mar 2026) → 100 days
  (15 Mar 2027) → 47 days (15 Mar 2029). SAN validation data reuse ends at 10 days by 2029.
  https://cabforum.org/2025/04/11/ballot-sc081v3-introduce-schedule-of-reducing-validity-and-data-reuse-periods/
- Let's Encrypt (docs updated 22 Jul 2026): 90-day default; optional 6-day `shortlived`; `tlsserver`
  45-day opt-in from 13 May 2026; `classic` → 64 days on 10 Feb 2027 (10-day authz reuse) → 45 days
  on 16 Feb 2028 (7-hour authz reuse). Recommends ARI (ACME Renewal Information) and renewing at
  about two-thirds of lifetime; warns hardcoded 60-day renewal intervals break.
  https://letsencrypt.org/docs/cert-lifetimes/ https://letsencrypt.org/2025/12/02/from-90-to-45
- Let's Encrypt stopped expiration emails 4 June 2025.
  https://letsencrypt.org/2025/06/26/expiration-notification-service-has-ended/
- Let's Encrypt scale: "frequently issuing ten million certificates per day" (late 2025, 10-year
  retrospective).
- ACME RFC 8555 (March 2019). http-01 (file at /.well-known/acme-challenge/<token> on port 80),
  dns-01 (TXT at _acme-challenge.<name>; required for wildcards), tls-alpn-01 (RFC 8737).
  DNS-PERSIST-01 expected 2026.
- cert-manager: default renewBefore is 2/3 of duration for short certs (docs FAQ).

### mTLS and service meshes

- Server sends CertificateRequest; client sends Certificate + CertificateVerify. The server now
  knows *which service* is calling: identity for authorization.
- Istio: istiod CA signs workload certs from CSRs generated by the agent (key never leaves the
  pod); SDS to Envoy; modes PERMISSIVE (default mesh-wide when unset), STRICT, DISABLE.
  https://istio.io/latest/docs/concepts/security/  Default workload cert TTL 24 h
  (DEFAULT_WORKLOAD_CERT_TTL), rotated well before expiry. Identities are SPIFFE IDs like
  spiffe://cluster.local/ns/default/sa/payments.

### Where TLS terminates

- Cloudflare SSL modes: Off; Flexible (HTTPS to visitor, *plain HTTP to origin*); Full (HTTPS to
  origin, no cert validation); Full (strict) (validated); Strict SSL-only origin pull.
  https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/
  Flexible + an origin that redirects HTTP→HTTPS = classic infinite redirect loop.
- AWS ALB: console default policy ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09 (as of Oct 2026); CLI /
  CloudFormation default is still ELBSecurityPolicy-2016-08. Backend policy not selectable.
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html
- AWS EC2 data protection: inter-AZ and inter-region traffic encrypted at physical layer; some
  Nitro instance types encrypt instance-to-instance traffic automatically (AEAD, 256-bit) only when
  same region, same/peered VPC, and not through a load balancer or transit gateway. Customer is
  still responsible for TLS between clients and instances.
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/data-protection.html
- Google MUSCULAR (Oct 2013, Washington Post via Snowden documents): NSA slide "SSL added and
  removed here" showing traffic unencrypted inside Google's private links; Google announced
  encrypting inter-datacentre traffic in early Nov 2013. https://en.wikipedia.org/wiki/MUSCULAR
  (use the Wikipedia article as an index; the original WaPo article is behind a paywall).

### Configuration baselines

- Mozilla server-side TLS guidelines v6.0 (https://ssl-config.mozilla.org/guidelines/latest.json):
  modern = TLS 1.3 only, ECDSA certs, oldest clients Firefox 63 / Chrome 70 / Android 10 / Safari
  12.1 / OpenSSL 1.1.1; intermediate = TLS 1.2 + 1.3, ECDHE + AEAD suites only, oldest Android
  4.4.2, IE 11 on Windows 10, Java 8u161. HSTS 2 years (63072000 s).
- Cloudflare 0-RTT: off by default; only GET, HEAD, OPTIONS; adds `Early-Data: 1` to origin.
  https://developers.cloudflare.com/speed/optimization/protocol/0-rtt-connection-resumption/
- RFC 8470 (Using Early Data in HTTP): `Early-Data: 1` header, `425 Too Early` status.

## Real numbers

- Record ≤ 16 KB; tag 16 bytes; X25519 share 32 bytes; X25519MLKEM768 share 1,216 / 1,120 bytes.
- Ticket lifetime ≤ 7 days.
- Handshake: TLS 1.3 = 1 RTT (0 with early data), TLS 1.2 = 2 RTT.
- Lifetimes: 398 → 200 (Mar 2026) → 100 (Mar 2027) → 47 days (Mar 2029). Istio workload 24 h.
- 121 Mozilla TLS roots (Sep 2026).

## Common misconceptions

- "HTTPS / padlock means the site is safe" — it means the connection is private and the name is
  verified; phishing sites have valid certificates too.
- "Encryption is enough" — without integrity, ciphertext can be edited (malleability); without
  authentication, you may be encrypting to the attacker (MITM).
- "The certificate is secret" — it is public; the private key is the secret. Anyone can download
  and present your cert; only the key holder can produce CertificateVerify.
- "TLS hides everything" — metadata leaks: IPs, SNI (unless ECH), timing, sizes.
- "Internal traffic doesn't need TLS" — MUSCULAR; lateral movement; compliance (PCI DSS).
- "`verify=False` is fine for internal calls" — it turns TLS into encryption to whoever answers.
- "TLS is slow" — 2010 numbers; TLS 1.3 is 1 RTT; AES-NI.
- "Revocation works" — mostly soft-fail; short lifetimes are the real answer.
- SSL vs TLS naming; "SSL certificate" is a TLS certificate.
- Encryption in transit vs at rest: different threat, different page.

## Sourced incidents

- Equifax 2017 (GAO-18-559, Aug 2018): inspection device's certificate expired about 10 months
  before the breach, so encrypted traffic was not inspected; attackers active about 76 days; noticed
  only after the certificate was replaced (29 July 2017); 145.5 million US consumers.
  https://www.gao.gov/products/gao-18-559
- Ericsson / O2, 6 Dec 2018: expired certificate in two SGSN-MME software versions; O2 UK data down
  most of the day (up to ~32 M UK users incl. MVNOs; SoftBank Japan also hit).
  https://www.ericsson.com/en/press-releases/2018/12/update-on-software-issue-impacting-certain-customers
- Windows Azure storage, 22 Feb 2013: HTTPS certificates expired in all regions; updated certs were
  in the secret store but the release wasn't flagged as containing cert updates and was delayed;
  alerting stopped because the store had the new cert. 12:29 PST 22 Feb → 00:09 PST 23 Feb,
  about 11.5 h. Microsoft's post-mortem (old MSDN URL now dead) summarised by InfoQ:
  https://www.infoq.com/news/2013/03/feb22_azure_outage
- Microsoft Teams, 3 Feb 2020: expired authentication certificate, about 3 hours (press reports).
- Starlink, April 2023: expired ground-station certificate (Musk's post; secondary sources only).
- DigiNotar 2011 (above). Heartbleed 2014 (CVE-2014-0160): OpenSSL 1.0.1–1.0.1f heartbeat read up to
  64 KB of server memory, including private keys; ~17% of trusted HTTPS servers (Netcraft).
  https://heartbleed.com/
- Firesheep (Oct 2010): one-click session hijacking on open Wi-Fi because sites used HTTPS only for
  login. Comcast Xfinity hotspots injecting JavaScript into HTTP pages (2014).

## How explainers structure it, and what they leave out

- Cloudflare Learning "What is TLS": benefits, handshake overview, certificates. Short; no failure
  modes, nothing on operating certs.
- HPBN ch. 4 (Grigorik, 2013): performance view (RTTs, session resumption, OCSP stapling, record
  size). Predates TLS 1.3.
- The Illustrated TLS 1.3 Connection: every byte. Superb reference, assumes you already know why.
- Typical blog posts: "symmetric vs asymmetric, then handshake diagram, then padlock". They rarely
  show *why* encryption without integrity or without authentication fails, rarely cover where TLS
  terminates in real architectures, mTLS identity, verify=False, missing intermediates, and
  certificate operations — which is where production outages actually come from. That is our angle:
  build the three properties up from broken versions, then run it in production.

## Source list for Further reading

Specs: RFC 9846, RFC 8996, RFC 8555, RFC 8737, RFC 6962/9162, RFC 8470, RFC 6797 (HSTS),
RFC 9849 (ECH), CA/B SC-081v3, Chrome CT policy, Mozilla server-side TLS v6.0, Istio security
concepts, Cloudflare SSL modes and 0-RTT docs, AWS EC2 data protection, AWS ALB policies, Let's
Encrypt lifetimes / 45-day plan / ending OCSP / ending emails.

Engineering: Langley "Overclocking SSL", Cloudflare "Why TLS 1.3 isn't in browsers yet", Cloudflare
Radar PQ post, GAO-18-559, Ericsson press release, Azure Feb 2013 post-mortem, Fox-IT DigiNotar
interim report, Let's Encrypt 2020 revocation thread, heartbleed.com, netmeister hybrid kex.

Explainers: The Illustrated TLS 1.3 Connection, HPBN ch. 4, Cloudflare Learning.
