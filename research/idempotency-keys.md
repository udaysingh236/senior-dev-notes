# Idempotency keys — research notes

Track: messaging · slug: `idempotency-keys` · researched 2026-11-06. The web-fetch tool could not
resolve vendor hosts from the container, so pages were downloaded with curl through the proxy and
read as text. Versions as of November 2026.

## Already covered elsewhere (link, don't repeat)

- Safe vs idempotent methods (RFC 9110), the three outcomes of a timed-out POST, the basic key
  flow (client UUID per intent, server stores outcome, same-transaction rule, 422 on a reused key
  with a different body, 409 for a concurrent repeat), Stripe's 24 h pruning, EC2 `ClientToken`,
  the IETF draft's existence, and a sim of three clients (never retry / retry no key / retry with
  key): `networking/rest-api-design`. That page says "the storage design (expiry, crash recovery,
  multi-step operations) is the subject of the idempotency keys page".
- Request ID with a unique constraint on the bookings table, idempotent payment callback keyed by
  payment ID, reconciliation job: `case-studies/irctc-tatkal-booking`.
- Which failures to retry, budgets, hedging needs idempotent requests: `resilience/retries-and-backoff`.
- A timed-out request keeps running on the server: `resilience/timeouts`.

So this page owns: the key record as a lock plus an outcome log, the check-then-act race, how a
unique index serialises two inserts, 409 vs waiting, leases and takeover of a crashed attempt,
fencing a zombie attempt, local work in one transaction, remote side effects with recovery points
and a downstream key, what to store and replay (exact bytes vs semantic equivalence vs
re-execution), key generation and scope, retention vs retry windows, and the same idea for
message consumers (inbox table), producer-side dedup (SQS FIFO, Kafka).

## Key facts, with sources

### IETF draft-ietf-httpapi-idempotency-key-header-08 (22 October 2026, expires 25 April 2027)
https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- Still an Internet-Draft (work in progress), Standards Track intended. Authors Jena, Dalal, Tishkin.
- `Idempotency-Key` is an Item Structured Header (RFC 9651); value MUST be a String, i.e. quoted:
  `Idempotency-Key: "8e03978e-..."`. UUID (RFC 9562) RECOMMENDED.
- Key MUST NOT be reused with a different payload. Uniqueness defined by the resource owner.
- Resource MAY expire keys; SHOULD publish the expiry policy. MUST publish an idempotency spec.
- Fingerprint MAY be used: checksum of the whole payload, of selected fields, field match, digest.
- Enforcement: first request → process; duplicate after completion → respond consistently with
  the completed request; duplicate before completion ("concurrent request") → conflict.
- Errors: missing key on a documented operation → 400; same key different payload → 422; retried
  while the original is still processing → 409. Problem Details (RFC 9457) examples.
- Implementations listed: Stripe, Adyen, Dwolla, Interledger, WorldPay, Yandex, http4s, Finastra,
  Datatrans; similar concept with other names: PayPal-Request-Id, Chargebee, Twilio
  (I-Twilio-Idempotency-Token on webhooks), RazorPay X-Payout-Idempotency, Open Banking
  x-idempotency-key, Square idempotency_key in body, Google Standard Payments requestId.

### Stripe API v1 (docs.stripe.com/api/idempotent_requests, docs.stripe.com/error-low-level), Nov 2026
- Saves status code and body of the first request with a key after endpoint execution begins;
  retries return it, including 500s.
- Keys up to 255 characters. V4 UUID or enough entropy. No sensitive data in keys.
- Keys can be pruned once at least 24 h old; reuse after pruning = new request.
- Compares incoming parameters with the original; errors if different.
- Not saved: requests failing validation, or conflicting with a concurrently executing request
  ("no API endpoint initiates the execution"); also invalid API key, rate limiting. Those can be
  retried.
- 409: another request with the same key is still executing → wait and retry same key and params.
  "A new key can start a second operation."
- Treat a 500 as indeterminate; don't retry with a new key until resolved; reconcile via
  retrieve, Dashboard, webhooks. During incident recovery Stripe reconciles failed operations and
  sends webhooks, but the cached response doesn't change.
- Retry an unresolved operation only within 24 h with same key and params; after that, reconcile.
- If your app retries across process restarts, generate and persist a key for the operation.
- Two key strategies: random UUID v4, or derive from a user-attached object such as a cart ID.
- Replayed response carries `Idempotent-Replayed: true`. `Stripe-Should-Retry` header.
- All v1 POSTs accept keys; GET and DELETE don't need them.

### Stripe API v2 (docs.stripe.com/api-v2-overview), Nov 2026
- Replay = same key, same API, same account/sandbox, within 30 days.
- First succeeded → skip changes, return an updated response. First failed or partially failed →
  re-execute the failed work without side effects, return the new response. If replay can no
  longer succeed → error explaining why.
- POST and DELETE accept keys. If no key is given, Stripe generates a UUID.

### AWS Builders' Library: "Making retries safe with idempotent APIs" (Malcolm Featonby, 15 Jan 2021)
https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-apis/
- Prefer a caller-provided client request identifier over hashing parameters: two identical
  RunInstances calls may be intended (two identical instances), so payload hashing infers wrongly.
- Recording the token and all mutating operations must be one ACID operation.
- Returning `ResourceAlreadyExists` on a retry has no server side effect but a client-side one;
  instead return a semantically equivalent response (same meaning, current state: pending →
  running → terminated).
- SDK/CLI generate a ClientToken when the caller doesn't, reuse it on retries.
- Late-arriving retry after the resource was deleted: EC2 still returns the equivalent response
  (instance now terminated) — principle of least astonishment.
- Retention: for EC2 instances, the lifetime of the resource plus an interval after which late
  requests would have arrived or be invalid. Indefinite retention impractical, and risks collisions.
- Same token with different parameters → validation error (parameter mismatch); parameters stored
  with the token.
- Cost and complexity are real; not right for every API.

### EC2 idempotency docs (docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html)
- Client token: unique, case-sensitive, up to 64 ASCII characters.
- Same token + same params → retry succeeds with no further action. Different params (other than
  Region/AZ) → `IdempotentParameterMismatch`.
- RunInstances: regional idempotency; with an explicit AZ, zonal; a token can be reused in a
  different Region.
- Some actions are idempotent by nature (TerminateInstances, AssociateAddress...).

### Powertools for AWS Lambda (Python) idempotency utility (docs.powertools.aws.dev), Nov 2026
- Record states INPROGRESS, COMPLETED, EXPIRED (internal).
- Key by default: function name + qualified function name + hash of the payload (or selected
  part via JMESPath). Primary key `{fn}.{module}.{qualname}#{hash}`.
- Conditional PutItem "locks" a new record; if it fails, a record exists (saves a GetItem).
- Default `expires_after_seconds` = 3600 (1 h); no upper limit.
- `in_progress_expiration` from Lambda remaining time (register the Lambda context): an
  INPROGRESS record past that timestamp is treated as expired and re-run.
- Concurrent duplicate → `IdempotencyAlreadyInProgressError`, safe to retry.
- Unhandled exception in the function → record deleted, exception propagated, so the next
  invocation re-runs. Persistence errors → `IdempotencyPersistenceLayerError`.
- `payload_validation_jmespath` (e.g. "amount") raises if the same key comes with a different
  value. `raise_on_no_idempotency_key`. Optional local cache (256 items).
- Expiry evaluated by the utility, not by DynamoDB TTL (TTL deletion is eventual).

### Adyen (docs.adyen.com/development-resources/api-idempotency), Nov 2026
- `idempotency-key` header on POST, max 64 characters, UUID v4 recommended.
- Scoped to the company account; valid 7 to 14 days after first submission.
- Not checked across regions when targeting multiple regional endpoints.
- Duplicate before the first completes → 422 or 409, error code 704 ("request already processed
  or in progress").
- Store unavailable → 503 code 703; `transient-error: true` header = safe to retry with same key.
- Adyen notes that a different credential using the same key could read the response; generate
  random keys.

### Shopify: "10 Tips for Building Resilient Payment Systems" (Bart de Water, 28 Jul 2022)
https://shopify.engineering/building-resilient-payment-systems
- Idempotency key looks up which steps an attempt completed and makes sure only a single request
  goes to financial partners; on a retry, recovery steps recreate state before continuing.
- Key unique for the time a request should be retryable, typically 24 h or less.
- ULID (48-bit timestamp + 80 random bits) over UUIDv4 for keys: sortable, B-tree friendly; one
  high-throughput system saw INSERT duration fall 50%.
- Queues start growing around 70–80% utilisation (same post; not needed here).
- (The detailed recovery-point post is from 2019: not used as a source.)

### PostgreSQL 18 docs (current; PG 19 RC1 released Oct 2026)
- index-unique-checks: if a conflicting row was inserted by an uncommitted transaction, the
  inserter waits for that transaction to commit or abort, then rechecks. Roll back → no conflict.
- transaction-iso: in Read Committed, `ON CONFLICT DO NOTHING` may skip an insert because of
  another transaction whose effects are not visible to its snapshot. `ON CONFLICT DO UPDATE`
  guarantees insert or update.
- sql-insert: ON CONFLICT is the alternative to a unique violation error.

### Google AIP-155 Request identification (created 2019-05-06, changelog 2023-10-02, 2024-01-08)
- Optional `request_id` field, UUID4 format, ≤ 36 ASCII chars; duplicate → return the response of
  the previous successful request; any reasonable timeframe; may return the current state of the
  resource instead of the historical response.

### Messaging
- SQS FIFO `MessageDeduplicationId`: 5-minute deduplication window; duplicate accepted but not
  delivered; tracking continues after the message is deleted.
  (docs.aws.amazon.com/AWSSimpleQueueService/.../using-messagededuplicationid-property.html)
- Kafka: idempotent producer — broker assigns a producer ID and dedupes by a per-message sequence
  number (design docs, apache/kafka docs/design/design.md). KIP-679 (2020): `enable.idempotence`
  default false → true in 3.0 (2021). Covers producer → broker resends only, not consumer effects.

### HTTP
- RFC 9110 (2022): idempotent methods; clients may automatically retry idempotent requests.
- RFC 9651 (2024) Structured Field Values; RFC 9457 Problem Details; RFC 9562 UUIDs (2024).

## Numbers worked out for the page

- Lognormal processing time, median 0.8 s, σ 0.6: P(W > 2 s) ≈ 6%, P(W > 2.5 s) ≈ 3%. With a 2 s
  client timeout, ~6% of payments have a retry while the first attempt still runs.
- Retention windows: SQS 5 min, Powertools 1 h, Stripe v1 ≥ 24 h, Adyen 7–14 d, Stripe v2 30 d.
- Key sizes: Stripe 255 chars, Adyen 64, EC2 64 ASCII, AIP-155 36.
- Storage sizing (illustrative): 1,000 payments/s × 86,400 s = 86.4 M rows/day for a 24 h window.

## Common misconceptions

- "A unique constraint on the key solves it": it does for local writes in the same transaction;
  not when the side effect (bank call, email) happens outside the transaction.
- "Check whether the key exists, then do the work": time-of-check to time-of-use race.
- "Store the key in Redis": a second store cannot commit atomically with the database.
- "Hash the payload instead of a key": two identical intended operations collapse into one (AWS).
- "Return 409 forever for an in-progress key": a crashed attempt leaves it in progress forever
  without a lease.
- "Exactly-once delivery": queues give at-least-once; consumers dedupe.
- "Generate a new key per retry": defeats the purpose; generate per intent, persist before sending.
- "Cache any response": caching a transient error before work began blocks the retry that would
  have succeeded (Stripe and Powertools both avoid it).

## How explainers usually teach it, and what they leave out

- Typical explainers (Stripe's old blog post, ByteByteGo-style summaries, Medium posts) show:
  client sends UUID → server stores key → retry returns cached response. Some add Redis SETNX.
- Left out: the race between two in-flight attempts, what holds the lock and for how long, what
  happens to a lock whose owner crashed, a remote call that cannot join the transaction,
  which errors to cache, retention vs retry windows, scope (per account), and consumers.
- Our angle: the key record is a lock with a lease plus a progress log; every remote step needs
  its own idempotency downstream; mechanisms shown with a race sim.

## Sources (year)

1. IETF draft-ietf-httpapi-idempotency-key-header-08 (2026)
2. RFC 9110 HTTP Semantics (2022)
3. Stripe API v1 idempotent requests (docs, 2026)
4. Stripe low-level error handling (docs, 2026)
5. Stripe API v2 overview, idempotency (docs, 2026)
6. AWS Builders' Library, Making retries safe with idempotent APIs (2021)
7. Amazon EC2 API idempotency (docs, 2026)
8. Powertools for AWS Lambda (Python), Idempotency (docs, 2026)
9. Adyen API idempotency (docs, 2026)
10. Shopify Engineering, 10 Tips for Building Resilient Payment Systems (2022)
11. PostgreSQL 18 docs: INSERT, index uniqueness checks, transaction isolation (2025)
12. Google AIP-155 Request identification (updated 2024)
13. Amazon SQS message deduplication ID (docs, 2026)
14. Apache Kafka KIP-679 (2020) and design docs (2026)
