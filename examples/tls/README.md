# TLS and encryption in transit: runnable examples

The code behind every snippet on the [TLS and Encryption in Transit](https://seniordevnotes.netlify.app/networking/tls/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install. `make-certs.sh` needs
the `openssl` command line tool (it ships with Git for Windows, macOS and every Linux distribution).

| File (Python / JavaScript) | What it shows |
|---|---|
| `make-certs.sh` | A private PKI in `./certs`: root CA, intermediate, good / expired / wrong-name server certificates, an impostor CA, and two client certificates for mTLS |
| `bit_flip.py` / `bit-flip.mjs` | Encryption without integrity: changing ₹100 into ₹900 without the key, and an integrity tag catching it |
| `mitm_dh.py` / `mitm-dh.mjs` | Diffie-Hellman (2048-bit, RFC 3526 group 14) with a man in the middle: every message encrypted and tagged, all of it read and rewritten |
| `tls_checks.py` / `tls-checks.mjs` | A real TLS client against a missing intermediate, an expired cert, a wrong name and an impostor, with checks on and then with `verify=False` |
| `mtls.py` / `mtls.mjs` | Mutual TLS: the server requires a client certificate, reads the caller's SPIFFE ID and authorizes by it |
| `cert_expiry.py` / `cert-expiry.mjs` | A certificate monitor that alerts when renewal is overdue (past two-thirds of the lifetime), with exit codes for cron or monitoring |
| `handshake.py` / `handshake.mjs` | TLS 1.2 vs TLS 1.3 vs a resumed TLS 1.3 handshake against www.cloudflare.com, in round trips |

## Run

```bash
bash make-certs.sh          # once; creates ./certs (git-ignored). Test keys only.

# Python
cd python
python bit_flip.py
python mitm_dh.py
python tls_checks.py
python mtls.py
python cert_expiry.py       # needs the internet; exits 2 because of the badssl.com test hosts
python handshake.py         # needs the internet

# JavaScript
cd js
node bit-flip.mjs
node mitm-dh.mjs
node tls-checks.mjs
node mtls.mjs
node cert-expiry.mjs
node handshake.mjs
```

## What to expect

- **Bit flip and MITM.** Keys are random, so the hex and fingerprints differ on every run; the
  outcome never does. The toy cipher in `bit_flip` is SHA-256 in counter mode so the example needs no
  libraries. Never use it for anything real.
- **TLS checks.** Python reports "unable to get local issuer certificate" for both the missing
  intermediate and the impostor; Node reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE` for both. From the
  client's side the two look the same.
- **mTLS.** The client without a certificate only sees the refusal when it reads, because in TLS 1.3
  the client finishes its side of the handshake before the server checks its certificate. The Python
  server drains the client's bytes before closing; without that, Windows turns the close into a TCP
  reset and the client sees "connection reset" instead of the TLS alert.
- **Certificate monitor.** The client certificates from `make-certs.sh` live 1 day, like a mesh's
  workload certificates, so rerun the script if `mtls` starts failing. The day-count numbers for real
  sites change daily, of course.
- **Handshake.** From a network in India, about 13–15 ms from Cloudflare, we saw TLS 1.2 at 2.0–2.8
  round trips, TLS 1.3 at 1.3–1.7 and resumed TLS 1.3 at 0.8–1.2. Only Node prints the key exchange
  group (`X25519MLKEM768` for TLS 1.3 with OpenSSL 3.5); Python's `ssl` module has no API for it.

Tested on 2026-10-18 with Python 3.14.7 and Node 24.19.0 on Windows 11 (both with OpenSSL 3.5.7),
and Python 3.12.3 (OpenSSL 3.0.13) and Node 24.19.0 on Ubuntu 24.04 in WSL 2.
