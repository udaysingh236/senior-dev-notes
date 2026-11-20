# Research: Message queues

Slug: `message-queues` · Track: `messaging` · Researched November 2026.

## Key facts (with sources)

### Amazon SQS (docs, living, checked November 2026)

- Standard queues give at-least-once delivery: more than one copy of a message may be delivered,
  and order is best effort. A message is stored in several availability zones before `SendMessage`
  returns. https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html
- Receiving a message does not remove it: it stays in the queue but is hidden from other consumers
  for the visibility timeout. Default 30 s, min 0, max 12 h (the 12 h counts from the first receive,
  extending does not reset it). If not deleted in time it becomes visible again and another consumer
  can take it. `ChangeMessageVisibility` extends it. Even within the timeout, duplicates are not
  ruled out. https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
- In-flight (received, not deleted) limit: about 120,000 for standard queues, 120,000 for FIFO.
- Message size 1 byte to 1 MiB (1,048,576 bytes); bigger payloads go to S3 through the extended client.
- Retention: default 4 days, min 60 s, max 14 days (1,209,600 s). Delay: 0 to 15 min.
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
- Long polling: `WaitTimeSeconds` up to 20 s; `ReceiveMessage` returns 1–10 messages (default 1).
  Short polling queries a subset of servers and can return empty even when messages exist.
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html
- Dead-letter queues: redrive policy with `maxReceiveCount`; a message received more than that many
  times without being deleted moves to the DLQ. AWS: set it high enough for sufficient retries.
  For standard queues, a message's expiry is based on its original enqueue time, so a DLQ's
  retention should be longer than the source queue's. DLQs and FIFO ordering do not mix well.
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
- FIFO: messages in one message group are delivered one at a time, in order. Deduplication ID:
  duplicates sent within a 5-minute interval are delivered once. Without high-throughput mode:
  300 API calls/s per action, 3,000 messages/s with batches of 10.
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fifo-queue-message-identifiers.html
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html

### RabbitMQ (docs on GitHub, rabbitmq-website main, checked November 2026)

- Automatic ack mode: a message counts as delivered as soon as it is sent; the docs call it unsafe
  (at-most-once). Manual ack: the consumer acks after processing.
- Unacked deliveries are requeued automatically when the channel or connection closes (crash,
  TCP loss); requeued deliveries carry the `redelivered` flag.
- Prefetch (`basic.qos`): max unacknowledged deliveries per channel; 0 = unlimited. Quorum queues
  cap prefetch at 2,000; docs: 2,000 is not meaningfully faster than 300.
- Requeue loops: if every consumer requeues, messages loop; quorum queues count `basic.reject`
  requeues toward the delivery limit.
  https://github.com/rabbitmq/rabbitmq-website/blob/main/docs/confirms.md
- Quorum queue delivery limit: default 20 since RabbitMQ 4.0 (2024), unlimited in 3.x; after it the
  message is dropped or dead-lettered. Consumer ack timeout (`consumer_timeout`) default 30 min.
  https://www.rabbitmq.com/docs/limits , https://www.rabbitmq.com/blog/2024/08/28/quorum-queues-in-4.0

### Postgres as a queue (docs, version 18 current, November 2026)

- `SELECT ... FOR UPDATE SKIP LOCKED`: rows that cannot be locked at once are skipped; the docs say
  it is not for general use but avoids lock contention for multiple consumers of a queue-like table.
  https://www.postgresql.org/docs/current/sql-select.html

### Task queue libraries

- Celery `task_acks_late`: default off, meaning the task message is acked before the task runs.
  The docs warn that RabbitMQ 4.0+ quorum queues drop or dead-letter after 20 redeliveries, so a task
  that keeps crashing its worker can vanish without a log line.
  https://docs.celeryq.dev/en/stable/userguide/configuration.html
- BullMQ: a worker holds a lock on a job and renews it; if the lock is not renewed (CPU-bound
  worker), the job is marked stalled and moved back to waiting, or to failed after the maximum
  number of stalls. https://docs.bullmq.io/guide/workers/stalled-jobs

### Kafka

- Kafka is a log, not a queue: messages stay after reading; consumers in a group own partitions.
  Queue-style "share groups" (KIP-932) were early access in Kafka 4.0 (March 2025) and generally
  available in Kafka 4.2 (2026). https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/
  https://www.confluent.io/blog/kafka-queue-semantics-share-consumer-ga/
  (double-check: the 4.2 GA date came from Confluent's post and a third-party summary.)

### Google Cloud Pub/Sub

- Ack deadline: default 10 s, min 10 s, max 600 s; client libraries extend it up to an hour by
  default. At-least-once unless exactly-once delivery is enabled.
  https://cloud.google.com/pubsub/docs/subscription-properties , https://cloud.google.com/pubsub/docs/lease-management

## Real numbers used on the page

- SQS visibility timeout 30 s default, retention 4 days / 14 days, 1 MiB, 120,000 in flight,
  20 s long poll, 10 per receive, FIFO dedup 5 min, FIFO 300 calls/s.
- RabbitMQ delivery limit 20 (4.0+), consumer timeout 30 min, prefetch cap 2,000 on quorum queues.
- Pub/Sub ack deadline 10 s default.
- Running example numbers are illustrative (checkout, 300 orders/s sale, 100 emails/s capacity).

## Misconceptions and confusing points

- "The queue removes the message when I read it": in SQS/RabbitMQ manual ack, receiving only hides it.
- "Exactly once": the broker can only give at-least-once to a consumer with side effects; the
  consumer makes it effectively once by being idempotent.
- "FIFO queue = my handlers run in order": only within a group and only one at a time per group.
- "A queue adds capacity": it only moves the waiting; if arrivals > processing for long, the
  backlog grows without end.
- Queue vs pub/sub vs log: one consumer per message vs a copy per subscriber vs a stored log
  that readers replay.
- Visibility timeout shorter than processing time causes duplicates even with no crash.
- DLQ retention counts from the original enqueue time in SQS standard queues.

## Incidents

- Buttondown, Incident #0016, public postmortem (27 March 2025): one self-hosted email server's
  pending-message database broke under too many worker connections; about 70,000 messages stuck
  with untrustworthy state; about 13,000 subscribers across 40 authors saw multi-hour delays,
  missing emails and duplicates. Fix: fewer workers, isolate, drain, resend only what was surely
  unsent; better per-server alerting. https://buttondown.com/blog/incident-0016

## How explainers structure it, and what they leave out

- Cloud vendor "what is a message queue" pages: decoupling, async, scaling, a producer/broker/consumer
  diagram, a list of benefits. They skip what happens when a worker dies mid-message, and never
  do the backlog arithmetic.
- Typical blog posts: "queue vs pub/sub vs Kafka" feature tables. They rarely explain leases, why
  duplicates are normal, or poison messages.
- Our angle: follow one order-confirmation email through every failure: worker crash, slow work,
  poison message, a sale spike; show the lease mechanism and the drain-time arithmetic.

## Sources for Further reading

- AWS SQS Developer Guide pages above (living docs, checked November 2026)
- RabbitMQ consumer acknowledgements docs (living, checked November 2026); RabbitMQ blog, Quorum queues in 4.0 (2024); RabbitMQ limits (living)
- PostgreSQL SELECT docs (version 18, 2025)
- Celery configuration docs (5.x, checked November 2026); BullMQ stalled jobs (living)
- Google Cloud Pub/Sub subscription properties and lease management (living)
- Apache Kafka 4.0 announcement (2025); Confluent, share consumer GA (2026)
- Buttondown Incident #0016 (2025)
- AWS Builders' Library, Avoiding insurmountable queue backlogs (2019, kept as history: the
  bimodal "fast mode / backlog mode" idea only)

## Fresher read

Read on 2026-11-20, top to bottom, as a final-year student. Items found and fixed:

- "background thread" in the first shortcut: unexplained. Added a plain gloss.
- `FOR UPDATE` in the second shortcut: "lock" unexplained. Added the lock in plain words.
- "transaction" first used at the dual-write problem: added a one-line definition.
- "Redis", RabbitMQ "channel", Kafka "partition", "CPU-bound", "failover": glossed or reworded.
- "takes 43 minutes to clear" in Going deeper was wrong (clearing takes 33 min; empty at 43 min
  after the sale began). Reworded.
- Outage arithmetic for the dead-letter queue (3-minute and 4-minute outages, the 10-minute
  gotcha): the first draft said "first half-minute" and "first 90 seconds"; worked out properly
  (fifth attempt 120 s after the first) and every step written out.
- Fig. 1 labels "take from front" and "done: delete" overlapped at 360px; Fig. 4 "+200/s" sat on
  the line. Moved.

Open items: none.
