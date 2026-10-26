# Research: REST API design

Slug: `networking/rest-api-design` · single topic · researched 2026-10-23.
Fetching pages directly was unavailable; facts were checked through search results that quote the
sources. Every source is 2020 or later, or a standard still in force (marked "standard").

## Angle

Explainers spend their time on URL naming, nouns vs verbs, and a status-code list. They rarely cover
what actually breaks in production: what a client may do after a timeout (method semantics),
lost updates between two editors (conditional requests), partial updates (PATCH formats),
errors a program can act on, and evolving a response without breaking old clients. That is our
page. Pagination, versioning and idempotency keys have their own pages; here they get a section
each that links forward.

## Key facts

- Safe and idempotent methods. GET, HEAD, OPTIONS, TRACE are safe; PUT and DELETE are idempotent
  but not safe; POST and PATCH are neither by default. Idempotent = the intended effect of N
  identical requests equals the effect of one; that is why they can be retried automatically
  after a connection failure. RFC 9110 §9.2.1–9.2.2 (2022, standard).
  https://www.rfc-editor.org/rfc/rfc9110#section-9.2
- A client should not retry a non-idempotent request automatically unless it knows the semantics
  allow it or can detect the original was never applied. RFC 9110 §9.2.2.
- Conditional requests: ETag, If-Match, If-None-Match, 412 Precondition Failed. RFC 9110 §8.8.3,
  §13 (2022, standard). 428 Precondition Required, defined to make clients send conditions and
  avoid lost updates: RFC 6585 §3 (2012, standard in force).
  https://www.rfc-editor.org/rfc/rfc9110#section-13 · https://www.rfc-editor.org/rfc/rfc6585
- Google AIP-154 (living, checked 2026): `etag` field; mismatch fails with ABORTED (HTTP 409);
  missing etag normally allowed. https://google.aip.dev/154
- Kubernetes: `resourceVersion` is an opaque optimistic-concurrency token; a stale update gets
  409 Conflict; server-side apply tracks field ownership per manager.
  https://kubernetes.io/docs/reference/using-api/api-concepts/ ·
  https://kubernetes.io/docs/reference/using-api/server-side-apply/
- JSON Merge Patch, RFC 7396 (2014, standard in force): null means "remove"; you cannot set a
  member to null; arrays are replaced whole. JSON Patch, RFC 6902 (2013, standard in force): ops
  add, remove, replace, move, copy, test. https://www.rfc-editor.org/rfc/rfc7396 ·
  https://www.rfc-editor.org/rfc/rfc6902
- Problem Details, RFC 9457 (July 2023) obsoletes RFC 7807; `application/problem+json`; members
  type, title, status, detail, instance, plus extensions. https://www.rfc-editor.org/rfc/rfc9457
- Idempotency-Key header: IETF draft draft-ietf-httpapi-idempotency-key-header, version -07
  dated 15 Oct 2025 (still a draft as far as found, Oct 2026).
  https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- Stripe idempotent requests (docs, checked Oct 2026): first result (status + body) saved per key
  and replayed, including 500s; parameters compared and mismatch errors; keys may be pruned after
  at least 24 hours; not saved if validation fails or a concurrent request with the same key is
  running. https://docs.stripe.com/api/idempotent_requests
- AWS Builders' Library, "Making retries safe with idempotent APIs" (Jan 2021): caller-provided
  client request identifier (EC2 ClientToken).
  https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-apis/
- GitHub REST: calendar versions via `X-GitHub-Api-Version`, default 2022-11-28, previous version
  supported at least 24 months; additive changes (new optional params, new response fields) go
  to all versions; removing/renaming fields or adding required params are breaking.
  https://docs.github.com/en/rest/about-the-rest-api/api-versions ·
  https://docs.github.com/en/rest/about-the-rest-api/breaking-changes ·
  https://github.blog/developer-skills/github/to-infinity-and-beyond-enabling-the-future-of-githubs-rest-api-with-api-versioning/ (Nov 2022)
- GitHub: a conditional request answered 304 does not count against the primary rate limit when
  properly authorized. https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- Stripe versioning: monthly backward-compatible releases, two major releases a year with breaking
  changes; compatible = new resources, new optional params, new response properties, reordering,
  ID format/length changes. https://docs.stripe.com/api-versions · https://docs.stripe.com/upgrades
- Azure/Microsoft API guidelines (GitHub, living): adding a value to a fixed enum is breaking for
  output; extensible enums are not; LRO = operation that can't finish within about 1 s.
  https://github.com/microsoft/api-guidelines
- Zalando RESTful API guidelines (living): clients must tolerate unknown fields and be prepared
  for new values of extensible enums. https://opensource.zalando.com/restful-api-guidelines/
- Google AIP-151 long-running operations: return an Operation with name, metadata, done, then
  error or response; poll with get. https://google.aip.dev/151
- Deprecation header, RFC 9745 (March 2025). https://www.rfc-editor.org/rfc/rfc9745

## Misconceptions

- "PUT is idempotent, so retrying PUT is always safe." Only if the server implements it that way;
  a PUT that also appends an audit row or sends an email is not.
- "200 with an error body is fine." Clients, proxies and monitors act on status codes.
- "Adding a field is never breaking." Strict deserializers and closed enums break.
- "ETags are for caching." They are also the standard optimistic-concurrency token.
- "PATCH means partial update, done." The format matters: merge patch can't express null or array
  element edits.

## Sources (year)

RFC 9110 (2022), RFC 9111 (2022), RFC 6585 (2012, standard in force), RFC 7396 (2014, standard),
RFC 6902 (2013, standard), RFC 9457 (2023), RFC 9745 (2025), IETF Idempotency-Key draft -07
(2025), Google AIP-154/151 (living, 2026), Kubernetes API concepts and server-side apply docs
(living, 2026), Stripe idempotency and versioning docs (living, 2026), AWS Builders' Library
(2021), GitHub API versions / breaking changes / best practices docs (living, 2026), GitHub blog
(2022), Microsoft API guidelines (living), Zalando guidelines (living).
