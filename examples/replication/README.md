# Replication examples

Code behind the snippets on the [Replication](https://seniordevnotes.in/databases/replication/) page.

| Folder | What it shows | Run |
|---|---|---|
| `python/replication_demo.py` | dual writes drifting apart; async vs sync replication when the leader crashes; read-your-writes by log position (simulated clock) | `python3 python/replication_demo.py` |
| `js/replication-demo.mjs` | the same, in JavaScript | `node js/replication-demo.mjs` |
| `sql/demo.sh` | a real PostgreSQL leader and follower: stale reads, `remote_apply`, a slow follower, a commit with no follower, and committed rows lost on failover | `./sql/demo.sh` (needs PostgreSQL 16+ server binaries and `dblink`; run as a non-root user) |

Python 3.11+ and Node 20+, standard library only. Simulated times in the Python and JavaScript
demos are illustrative; the numbers from `sql/demo.sh` are real measurements on one laptop and
will differ a little on yours.

Output of `sql/demo.sh` on PostgreSQL 16.15 (November 2026):

```
1. Asynchronous (the default): 1000 commits on the leader, each read at once on the follower
   reads that missed the row just committed: 988 of 1000, average commit 0.33 ms
2. Synchronous, remote_apply: each commit waits until the follower has applied it
   reads that missed: 0 of 1000, average commit 0.98 ms
3. Same, but the follower applies every change 200 ms late
   reads that missed: 0 of 20, average commit 201.65 ms
4. Synchronous, and the follower is stopped
   WARNING:  canceling wait for synchronous replication due to user request
   DETAIL:  The transaction has already committed locally, but might not have been replicated to the standby.
5. Asynchronous; the follower is cut off, the leader commits 500 orders and crashes
   committed orders the new leader never received: 500
```
