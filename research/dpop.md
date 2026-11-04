# DPoP (Demonstrating Proof of Possession): research notes

Not published. Notes for `src/content/docs/security/dpop.mdx`. Researched October 2026.

Network note: rfc-editor.org, datatracker, okta.com, auth0.com, keycloak.org and docs.spring.io were
blocked in this session. The spec was read from the authors' source (`danielfett/draft-dpop`,
draft-16 markdown, the text that became RFC 9449); the RFC's own example values (thumbprints, `ath`)
were recomputed by our examples and match. Vendor docs were read from their GitHub sources.

## Key facts (with sources)

### The spec: RFC 9449, September 2023 (Proposed Standard)
Source: RFC 9449 https://www.rfc-editor.org/rfc/rfc9449 (draft source: https://github.com/danielfett/draft-dpop)

- Purpose: sender-constrain OAuth access and refresh tokens at the application layer. Bearer = anyone
  holding it can use it. DPoP-bound = also need the private key.
- Motivation named in the spec: mTLS (RFC 8705) has poor UX in browsers; token binding never got
  browser support. SPAs and native apps are the target. Not a client authentication method.
- DPoP must be used with HTTPS. It does not provide message integrity; TLS does.
- Proof = a JWT in the `DPoP` request header.
  - JOSE header: `typ` = `dpop+jwt`; `alg` asymmetric, never `none` or a MAC; `jwk` = public key,
    must not contain a private key.
  - Claims: `jti` (≥96 bits random or UUIDv4), `htm` (method), `htu` (target URI without query and
    fragment), `iat`. Plus `ath` (base64url SHA-256 of the access token) when sent with an access
    token; plus `nonce` when the server has provided one.
  - Only method and URI of the request are signed. Deliberate: normalising HTTP messages is hard.
- Checks (section 4.3): one DPoP header; one well-formed JWT; required claims; typ; alg allowed;
  signature verifies with `jwk`; `jwk` not private; htm matches; htu matches ignoring query and
  fragment; nonce matches if provided; iat (or nonce-carried time) within window; with an access
  token: `ath` equals hash of the token, and the token's bound key equals the proof's key. Servers
  SHOULD apply RFC 3986 syntax- and scheme-based normalisation before comparing htu.
- Token endpoint: AS binds the token to the key; response `token_type` = `DPoP`. If the response
  says `Bearer`, the protection is absent; client MUST discard if protection is important.
- Binding representation: JWT access tokens carry `cnf: { jkt: <base64url SHA-256 JWK thumbprint> }`
  (RFC 7638 thumbprint). Introspection returns the same `cnf.jkt`. The RS does the binding check
  itself; the AS does not check proofs at introspection.
- Refresh tokens: for public clients, MUST be bound to the DPoP key; every refresh needs a proof
  with the same key. For confidential clients, NOT bound to the DPoP key (already bound to the
  client's credentials, and rebinding would block client credential rotation).
- AS may issue a `Bearer` access token while binding the refresh token (binds refresh only).
- RS: `Authorization: DPoP <token>` + `DPoP: <proof>`. 401 with `WWW-Authenticate: DPoP` and
  `algs="ES256 PS256"`; error codes `invalid_dpop_proof`, `use_dpop_nonce`, `invalid_token`.
- Downgrade: an RS supporting both schemes MUST reject a DPoP-bound token presented as Bearer. An
  RS unaware of DPoP will most likely accept a DPoP-bound token as a bearer token (JWT says ignore
  unknown claims). So a client can still use bound tokens at legacy RSs; and so can a thief.
- CORS: browser clients need `WWW-Authenticate` and `DPoP-Nonce` in `Access-Control-Expose-Headers`.
- Retries: requests with DPoP may not be idempotent anymore; clients should make a new proof even
  when retrying.
- Server nonce (sections 8, 9): AS replies `400 {"error":"use_dpop_nonce"}` with `DPoP-Nonce`
  header; RS replies `401 WWW-Authenticate: DPoP error="use_dpop_nonce"`. Nonces must be
  unpredictable. Server can push the next nonce on a 200 response (saves the round trip). Responses
  with DPoP-Nonce should be `no-store`. AS and RS nonces are separate; don't confuse with OIDC nonce.
  Client keeps one nonce; server keeps a window of recent ones.
- `dpop_jkt` (section 10): authorization request parameter = thumbprint; binds the authorization
  code to the key, so a stolen code (logs, XSS) cannot be redeemed with another key. Only works if a
  unique key per authorization request. With PAR, a DPoP header on the PAR request has the same effect.
- AS metadata `dpop_signing_alg_values_supported`; client metadata `dpop_bound_access_tokens`.
- Security considerations:
  - Replay of a captured proof at the same endpoint: limit acceptance window (seconds or minutes);
    store `jti` per target URI for the window; may not be feasible across servers without shared
    state; cap `jti` size or store a hash (memory exhaustion).
  - Clock skew: may accept iat slightly in future; nonce carrying server time avoids skew entirely.
  - Same nonce reused many times is fine as long as jti is tracked for the nonce's lifetime.
  - Pre-generation: someone in control of the client (including the legitimate user) can sign proofs
    with future `iat` and carry them away. Without a nonce, only possession of a proof is shown.
    `ath` limits pre-generated proofs to the life of the current access token; deployments without
    nonces SHOULD NOT issue long-lived DPoP access tokens.
  - Nonce downgrade: once a nonce is provided, MUST NOT accept proofs without one.
  - Untrusted code (XSS): with a non-extractable key, attacker cannot steal the key, but can sign
    proofs while the page is open; can pre-compute future proofs; can run a silent authorization in
    an iframe and bind fresh tokens to their own key. "Protecting clients against untrusted code is
    extremely important even if DPoP is used."
  - typ check stops JWT swapping (using another JWT as a proof).
  - No body or header integrity.
  - Single hash (SHA-256), deliberately no agility.
  - Example values: EC P-256 key thumbprint `0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I`;
    access token `Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU` → ath
    `fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo`; RFC 7638 RSA example thumbprint
    `NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs`. Our examples recompute all three.

### RFC 7638 (2015, in force): JWK thumbprint
- Canonical JSON with only the required members, lexicographic order, no whitespace; SHA-256;
  base64url. EC: `crv`, `kty`, `x`, `y`. RSA: `e`, `kty`, `n`. Cited only for the algorithm.

### RFC 9700, OAuth 2.0 Security BCP (January 2025)
Source: https://www.rfc-editor.org/rfc/rfc9700
- Refresh tokens for public clients must be sender-constrained (RFC 8705 or RFC 9449) or rotated
  with replay detection (section 4.14.2).
- Recommends sender-constrained access tokens (mTLS or DPoP).

### RFC 8705, OAuth mTLS (February 2020)
- Binds tokens to the client's TLS certificate (`cnf.x5t#S256`). Needs client certificates, which
  browsers handle badly, and TLS terminating proxies must forward the certificate.

### RFC 9421, HTTP Message Signatures (February 2024)
- Signs chosen components (method, path, headers, content digest). Covers the body via
  Content-Digest. Heavier, needs canonicalisation; DPoP deliberately signs only method + URI.

### FAPI 2.0 Security Profile (final, February 2025)
Source: https://openid.net/specs/fapi-security-profile-2_0.html ;
Duende summary https://docs.duendesoftware.com/identityserver/tokens/fapi-2-0-specification/ (2025)
- Only sender-constrained access tokens, mTLS or DPoP. With DPoP: server-provided nonces should be
  used; authorization code binding to the DPoP key must be supported; codes ≤ 60 s.

### Bluesky / AT Protocol OAuth profile (living spec, read October 2026)
Source: https://atproto.com/specs/oauth (GitHub source: bluesky-social/atproto-website)
- DPoP mandatory for every client, at the AS and the PDS (resource server).
- Server nonces mandatory; servers must rotate them with a maximum lifetime of 5 minutes; may share
  one nonce across all sessions; should accept recently stale nonces.
- Client must make a new DPoP key per session/device, starting with the PAR request.
- Servers should track `jti` and may limit the history to the current nonce's lifetime.
- ES256 required. `dpop_bound_access_tokens` must be true.
- Access tokens < 30 min, ≤ 15 min if not revocable, 5 min recommended. Public clients: session and
  refresh token ≤ 2 weeks. Confidential: refresh token ≤ 180 days. Refresh tokens single-use.

### Okta (developer docs, read October 2026)
Source: https://developer.okta.com/docs/guides/dpop/main/ (GitHub source okta/okta-developer-docs)
- First /token request with a DPoP proof gets `400 use_dpop_nonce` and a `dpop-nonce` header;
  retry with the nonce. Okta renews the nonce every 24 hours; an old one keeps working for three
  days. RSs must track `jti` and reject repeats.

### Auth0 (docs, read October 2026)
Source: https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop
- DPoP listed as Early Access (search results). Treat as such; don't claim GA.

### Keycloak 26.4 (September 2025)
Source: https://www.keycloak.org/2025/10/dpop-support-26-4 (2025),
https://www.keycloak.org/2025/09/keycloak-2640-released (2025)
- DPoP preview since Keycloak 23, fully supported in 26.4. Can bind only refresh tokens of a public
  client. Option to require `dpop_jkt`. FAPI 2 DPoP client profiles.

### Spring Security (source, read October 2026)
Source: spring-projects/spring-security `DPoPProofJwtDecoderFactory`, `DPoPProofReplayValidator`
- Resource server DPoP support since 6.5 (2025). Validates htm, htu (exact `equals`), iat, jkt,
  ath; replay validator since 6.5.12.
- Default replay cache is in-memory (per instance), clock skew 30 s, max 100,000 entries, 1,000
  requests per key; a jti is kept until iat + 30 s. In a cluster, each node has its own cache.
- htu compared with `equals` against the target URI the server reconstructs: behind a proxy the
  reconstruction must use the external URL.

### Browser keys: Web Crypto
Source: MDN CryptoKey.extractable (living docs, read October 2026)
- `generateKey(..., extractable: false, ...)` → `exportKey` / `wrapKey` throw. CryptoKey objects can
  be stored in IndexedDB (structured clone) and reused across page loads without being exportable.
- Non-extractable ≠ unusable: script on the origin can still call `sign()`.

### Chrome DBSC (Device Bound Session Credentials)
Sources: The Hacker News, April 2026 https://thehackernews.com/2026/04/google-rolls-out-dbsc-in-chrome-146-to.html
- Same idea for cookies: session bound to a TPM-held key. GA on Windows in Chrome 146 (April 2026).
  A neighbour, not a replacement: DBSC is for browser sessions with the site's own cookies.

## Real numbers
- Proof size: header with P-256 JWK + claims → ~ 400–600 bytes base64url per request (measure).
- ES256 sign/verify cost: measure in examples (Node and Python `cryptography`).
- Windows: Spring 30 s; Okta nonce 24 h (old valid 3 days); Bluesky nonce ≤ 5 min.
- jti store: one entry per request in the window. 1,000 req/s × 60 s window = 60,000 entries;
  with a 32-byte hash + TTL overhead in Redis, a few MB (illustrative arithmetic, say so).

## Misconceptions and confusing points
- "DPoP stops XSS." No. It stops exfiltrated tokens from working elsewhere; XSS on the page can use
  the key in place.
- "DPoP encrypts or signs my request body." No: only method + URI (+ ath, nonce).
- "jti tracking is optional, iat window is enough." The window alone lets a captured proof be replayed
  for its whole width at the same URL.
- "Every refresh token is DPoP-bound." Only for public clients; confidential client refresh tokens
  are bound to the client authentication.
- "DPoP authenticates the client." No: anyone can make a key. It proves continuity: the same key
  that got the token is using it.
- "The JWK in the proof is trusted." It is self-asserted; trust comes only from matching the token's
  `cnf.jkt`, which the AS recorded when issuing.
- htu mismatch behind TLS-terminating proxies (http vs https, internal host/port).
- Nonce: server nonces stop pre-generated proofs; client-chosen jti/iat cannot.

## Incidents (sourced; bearer-token theft, not DPoP failures)
- GitHub, April 2022: OAuth user tokens issued to Heroku and Travis CI stolen from those
  integrators, used to list and clone private repos of dozens of orgs including npm.
  https://github.blog/news-insights/company-news/security-alert-stolen-oauth-user-tokens/ (2022)
- Salesloft Drift, August 2025: OAuth access and refresh tokens for Drift's Salesforce integration
  stolen from Drift's environment; used 8–18 August 2025 to export data from customer Salesforce
  instances; GTIG aware of 700+ potentially impacted orgs; Salesloft revoked all tokens 20 August.
  https://cloud.google.com/blog/topics/threat-intelligence/data-theft-salesforce-instances-via-salesloft-drift (2025)
- Lesson: these were confidential server-side clients; a DPoP key stored next to the tokens would
  have been stolen with them. DPoP helps a server-side client only if the key lives elsewhere (KMS,
  HSM) so that signing needs a call the attacker must also control.

## How explainers structure it (what they leave out)
(From search summaries; the full pages were not reachable from this session.)
- WorkOS "DPoP RFC 9449 explained" (2024/2025): flow diagram, claims list, code. Light on replay
  windows and distributed jti, nothing on pre-generation.
- Vendor docs (Okta, Auth0, Keycloak): configuration steps. Nothing on why nonces exist or on the
  downgrade to Bearer.
- http.dev header reference: header syntax only.
- Our angle: what each claim stops, as an attack table; the server's state (jti store, nonce) as the
  real cost; the XSS boundary stated honestly; production gotchas (htu behind proxies, per-node
  caches, legacy RSs accepting bound tokens as Bearer, retries).

## Further reading (with years)
Specs: RFC 9449 (2023), RFC 7638 (2015, in force), RFC 9700 (2025), RFC 8705 (2020), RFC 9421 (2024),
FAPI 2.0 Security Profile (2025), AT Protocol OAuth spec (living, read 2026-10).
Docs: Okta DPoP guide (living), Keycloak DPoP 26.4 post (2025), Spring Security DPoP (living, 6.5+),
MDN CryptoKey.extractable (living).
Incidents: GitHub (2022), Google GTIG Salesloft Drift (2025).
Explainers: WorkOS DPoP explained (2025), Duende FAPI 2.0 page (2025), The Hacker News DBSC (2026).
