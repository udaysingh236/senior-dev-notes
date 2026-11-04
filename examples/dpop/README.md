# DPoP: runnable examples

The code behind the snippets and results on the
[DPoP](https://seniordevnotes.netlify.app/security/dpop/) page.

| File | What it shows |
|---|---|
| `python/dpop.py` / `js/dpop.mjs` | A client that signs DPoP proofs (ES256), and a resource server that runs the RFC 9449 checks, with a `jti` replay store and stateless server nonces. Then five experiments: a stolen token with and without DPoP, a captured proof replayed (same URL, other method, four nodes with their own caches, after the window), proofs signed in advance by injected script with and without a nonce, the `htu` mismatch behind a TLS-terminating load balancer, and the cost of signing and checking |
| `expected-output.txt` | Our run. Both languages print the same lines apart from the timings in section 5 |

## Run

```bash
python3 -m pip install -r python/requirements.txt   # the `cryptography` package, for P-256 signatures
python3 python/dpop.py
node js/dpop.mjs                                     # Node 20+, standard library only
```

Section 0 recomputes three values printed in RFC 9449 and RFC 7638 (two key thumbprints and one
`ath`), as a check that the thumbprint and hash code is right. The clock is passed in as a number,
so the experiments jump minutes ahead without sleeping. Timings in section 5 vary by machine and run; ours
were 65–120 µs to make a proof and 160–200 µs to check one, on one core.
