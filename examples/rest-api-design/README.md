# REST API design: runnable examples

The code behind the snippets on the
[REST API Design](https://seniordevnotes.netlify.app/networking/rest-api-design/) page. Python 3.11+
and Node 22+, standard library only, nothing to install. Everything runs on `127.0.0.1`.

| File | What it shows |
|---|---|
| `python/products_api.py` / `js/products-api.mjs` | A products and payments API with ETags, `If-Match` (412 on a stale version), JSON Merge Patch, an `Idempotency-Key` on `POST /payments`, and Problem Details errors, plus a client that walks through four scenarios: a lost update with blind PUT, the same edits with `If-Match`, merge PATCH, and a retried payment with and without a key |

## Run

```bash
python python/products_api.py   # port 8091
node js/products-api.mjs        # port 8092
```

Both print the same lines. Payment IDs are a counter, so the output is the same on every run.

Tested on 2026-10-23 with Python 3.13 and Node 22.22 on Linux.
