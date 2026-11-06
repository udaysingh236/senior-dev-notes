# How Google Authenticator works (TOTP): runnable examples

The code behind the snippets and results on the
[How Google Authenticator Works](https://seniordevnotes.in/case-studies/google-authenticator/) page.

| File | What it shows |
|---|---|
| `python/totp.py` / `js/totp.mjs` | HOTP and TOTP from scratch, checked against the RFC 4226 and RFC 6238 test vectors. Then dynamic truncation byte by byte, the clock-to-counter step, a naive verifier failing on a code typed across a 30 s boundary, a replay guard, clock drift over 90 days with and without drift tracking, and guessing odds per window size |
| `expected-output.txt` | Our run. Both languages print exactly the same lines |

## Run

```bash
python3 python/totp.py   # Python 3.11+, standard library only
node js/totp.mjs         # Node 20+, standard library only
```

The clock is passed in as a number, so the experiments jump days ahead without sleeping. The
Base32 secret in section 2 is a demo value: never use it for a real account.
