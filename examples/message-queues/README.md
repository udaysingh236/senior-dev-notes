# Message queues: runnable examples

The code behind the snippets and numbers on the
[Message Queues](https://seniordevnotes.in/messaging/message-queues/) page.

| File | What it shows |
|---|---|
| `python/queue_demo.py`, `js/queue-demo.mjs` | An in-memory queue with leases (visibility timeout), acks, a receive count and a dead-letter queue. Six runs: ack-before-work loses an email; ack-after-work sends it twice after a crash; an idempotent consumer sends it once; slow work outlives its lease (and a heartbeat fixes it); a poison message ends in the dead-letter queue; the backlog arithmetic of a 10-minute sale |
| `sql/queue.sql`, `sql/demo.sh` | The same queue as one Postgres table: claiming with `FOR UPDATE SKIP LOCKED`, a lease column, an ack that is refused after the lease ran out, and a dead-letter table |

## Run

```bash
cd python && python3 queue_demo.py
cd js && node queue-demo.mjs
cd sql && PGDATABASE=queue_demo ./demo.sh   # needs a local Postgres and psql
```

Python 3.11+ or Node 20+, nothing else. Time is simulated, so both files run instantly and print
identical output. The SQL demo needs PostgreSQL 9.5 or later (for `SKIP LOCKED`) and a database you
may create tables in; it drops and recreates `jobs`, `dead_jobs` and `claimed`.

## Expected output

```text
1. Ack on receive, worker crashes before sending
    emails sent: 0, left in queue: 0, dead letters: 0
2. Ack after sending, worker A crashes between send and ack
    t=    1s confirmation for order 1042
    t=   32s confirmation for order 1042
    emails sent: 2, left in queue: 0, dead letters: 0
3. Same crash, idempotent consumer
    t=    1s confirmation for order 1042
    emails sent: 1, left in queue: 0, dead letters: 0
4. Work takes 45 s, lease is 30 s (worker A's ack accepted: False)
    t=   40s confirmation for order 1042
    t=   45s confirmation for order 1042
    emails sent: 2, left in queue: 0, dead letters: 0
   Same slow send, worker extends its lease every 10 s
    t=   45s confirmation for order 1042
    emails sent: 1, left in queue: 0, dead letters: 0
5. Poison message, lease 30 s, max 5 receives
    t=   0s attempt 1: handler crashes, no ack
    t=  30s attempt 2: handler crashes, no ack
    t=  60s attempt 3: handler crashes, no ack
    t=  90s attempt 4: handler crashes, no ack
    t= 120s attempt 5: handler crashes, no ack
    t= 150s next receive moves order 10x42 to the dead-letter queue
6. Backlog: 300 orders/s for 600 s, then 40/s; workers send 100 emails/s
    peak backlog 120,000 messages at t=600 s
    backlog empty again at t=2600 s (43 min 20 s)
    an order placed at t=600 s waits 1200 s for its email
```

```text
1. Four workers claim 200 jobs at the same time
   claims: 200, different jobs: 200, claimed twice: 0
2. A lease runs out and a late ack is refused
   worker B claims job 1, receive number 2
   worker A acks with receive number 1: rows deleted 0
   worker B acks with receive number 2: rows deleted 1
3. A job that used up 5 receives moves to dead_jobs
   jobs left: 0, dead jobs: 1 (order 10x42)
```

Tested on 2026-11-20 with Python 3.13, Node 22.22 and PostgreSQL 16.15 on Linux.
