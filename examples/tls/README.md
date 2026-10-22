# TLS and encryption in transit: runnable examples

The code behind every snippet on the [TLS and Encryption in Transit](https://seniordevnotes.netlify.app/networking/tls/)
page. Python 3.11+ and Node 20+, standard library only, nothing to install, no internet needed.
`make-certs.sh` needs the `openssl` command line tool (it ships with Git for Windows, macOS and every
Linux distribution).

| File (Python / JavaScript) | What it shows |
|---|---|
| `make-certs.sh` | A private PKI in `./certs`: root CA, intermediate, good / expired / wrong-name server certificates, an impostor CA, and two client certificates for mTLS |
| `mitm_dh.py` / `mitm-dh.mjs` | Diffie-Hellman (2048-bit, RFC 3526 group 14) with a man in the middle: every message encrypted and tagged, all of it read and rewritten, because nothing authenticated the key shares |
| `observer.py` / `observer.mjs` | A relay with no keys between a TLS client and server: it reads the server name from the ClientHello, sees the certificate only in TLS 1.2, and sees every record's length, which tracks the page size |
| `tls_checks.py` / `tls-checks.mjs` | A real TLS client against a missing intermediate, an expired cert, a wrong name and an impostor, with checks on and then with `verify=False` |
| `mtls.py` / `mtls.mjs` | Mutual TLS: the server requires a client certificate, reads the caller's SPIFFE ID and authorizes by it |

## Run

```bash
bash make-certs.sh          # once; creates ./certs (git-ignored). Test keys only.

# Python
cd python
python mitm_dh.py
python observer.py
python tls_checks.py
python mtls.py

# JavaScript
cd js
node mitm-dh.mjs
node observer.mjs
node tls-checks.mjs
node mtls.mjs
```

## What to expect

- **MITM.** Keys are random, so the fingerprints differ on every run; the outcome never does. The
  toy cipher is SHA-256 in counter mode so the example needs no libraries. Never use it for anything
  real.
- **Observer.** Over TLS 1.3 with AES-GCM each response record is the page plus 17 bytes (content
  type and tag); over TLS 1.2 it is the page plus 24 (explicit nonce and tag). The request record
  is two bytes longer for `/hiv-test` than for `/dental`: the path length leaks. The server name is
  readable in both versions; the CA's name only in TLS 1.2.
- **TLS checks.** Python reports "unable to get local issuer certificate" for both the missing
  intermediate and the impostor; Node reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE` for both. From the
  client's side the two look the same.
- **mTLS.** The client without a certificate only sees the refusal when it reads, because in TLS 1.3
  the client finishes its side of the handshake before the server checks its certificate. The Python
  server drains the client's bytes before closing; without that, Windows turns the close into a TCP
  reset and the client sees "connection reset" instead of the TLS alert. The client certificates
  from `make-certs.sh` live 1 day, like a mesh's workload certificates, so rerun the script if
  `mtls` starts failing.

Tested on 2026-10-22 with Python 3.13.16 and Node 22.22.0 on Linux (OpenSSL 3.0.13). Earlier
versions of these files were also tested on 2026-10-18 with Python 3.14.7 and Node 24.19.0 on
Windows 11 (OpenSSL 3.5.7).
