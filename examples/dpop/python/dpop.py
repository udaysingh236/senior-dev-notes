"""DPoP (RFC 9449) from scratch: a client that signs proofs and a resource server that checks them.

Run: python3 dpop.py   (needs the `cryptography` package for P-256 signatures: see requirements.txt)

Time is passed in explicitly (`now`) so the experiments can jump the clock without sleeping.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from dataclasses import dataclass, field

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sha256_b64(text: str) -> str:
    return b64url(hashlib.sha256(text.encode("ascii")).digest())


# ---------------------------------------------------------------- keys and thumbprints

REQUIRED_MEMBERS = {"EC": ("crv", "kty", "x", "y"), "RSA": ("e", "kty", "n"), "OKP": ("crv", "kty", "x")}


def jwk_thumbprint(jwk: dict) -> str:
    """RFC 7638: required members only, sorted, no whitespace, SHA-256, base64url."""
    members = {k: jwk[k] for k in REQUIRED_MEMBERS[jwk["kty"]]}
    canonical = json.dumps(members, separators=(",", ":"), sort_keys=True)
    return b64url(hashlib.sha256(canonical.encode()).digest())


def public_jwk(key: ec.EllipticCurvePrivateKey) -> dict:
    nums = key.public_key().public_numbers()
    return {"kty": "EC", "crv": "P-256", "x": b64url(nums.x.to_bytes(32, "big")), "y": b64url(nums.y.to_bytes(32, "big"))}


def key_from_jwk(jwk: dict) -> ec.EllipticCurvePublicKey:
    x = int.from_bytes(b64url_decode(jwk["x"]), "big")
    y = int.from_bytes(b64url_decode(jwk["y"]), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


# ---------------------------------------------------------------- the client side


def make_proof(key, htm: str, htu: str, *, now: float, access_token: str | None = None,
               nonce: str | None = None, iat: float | None = None) -> str:
    """One DPoP proof: a JWT signed with the client's private key, valid for one request."""
    header = {"typ": "dpop+jwt", "alg": "ES256", "jwk": public_jwk(key)}
    claims = {"jti": str(uuid.uuid4()), "htm": htm, "htu": htu, "iat": int(iat if iat is not None else now)}
    if access_token:
        claims["ath"] = sha256_b64(access_token)  # ties this proof to this one token
    if nonce:
        claims["nonce"] = nonce  # proves the proof was made after the server said this
    compact = {"separators": (",", ":")}
    signing_input = f"{b64url(json.dumps(header, **compact).encode())}.{b64url(json.dumps(claims, **compact).encode())}"
    r, s = decode_dss_signature(key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    return f"{signing_input}.{b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


# ---------------------------------------------------------------- the server side


class Rejected(Exception):
    pass


class JtiStore:
    """Remembers proofs seen in the last `ttl` seconds. Share one across nodes (Redis SET NX EX)."""

    def __init__(self) -> None:
        self.seen: dict[str, float] = {}

    def first_use(self, htu: str, jti: str, now: float, ttl: float) -> bool:
        if len(jti) > 64:
            raise Rejected("jti too long")  # the spec warns about memory exhaustion
        if len(self.seen) > 10_000:  # Redis expires keys itself (SET ... NX EX ttl)
            self.seen = {k: exp for k, exp in self.seen.items() if exp > now}
        key = hashlib.sha256(f"{htu} {jti}".encode()).hexdigest()
        if self.seen.get(key, 0) > now:
            return False
        self.seen[key] = now + ttl
        return True


@dataclass
class NonceIssuer:
    """Stateless nonces: a time bucket plus an HMAC. Nothing to store, and it carries server time."""

    every: float = 60.0
    secret: bytes = field(default_factory=lambda: secrets.token_bytes(32))

    def _make(self, bucket: int) -> str:
        raw = bucket.to_bytes(8, "big")
        return b64url(raw + hmac.new(self.secret, raw, "sha256").digest()[:16])

    def current(self, now: float) -> str:
        return self._make(int(now // self.every))

    def valid(self, nonce: str, now: float) -> bool:
        bucket = int(now // self.every)
        return isinstance(nonce, str) and any(hmac.compare_digest(nonce.encode(), self._make(b).encode())
                                              for b in (bucket, bucket - 1))


MAX_AGE, MAX_FUTURE = 60, 5  # seconds a proof stays acceptable; allowance for client clocks ahead


def check_proof(proof: str, *, method: str, url: str, now: float, jti_store: JtiStore,
                access_token: str | None = None, bound_jkt: str | None = None,
                nonces: NonceIssuer | None = None) -> dict:
    """The checks of RFC 9449 section 4.3. Returns the claims, or raises Rejected."""
    try:
        h64, c64, s64 = proof.split(".")
        header, claims = json.loads(b64url_decode(h64)), json.loads(b64url_decode(c64))
    except ValueError:
        raise Rejected("not a JWT")
    if header.get("typ") != "dpop+jwt":
        raise Rejected("typ is not dpop+jwt")  # stops other JWTs being passed off as proofs
    if header.get("alg") != "ES256":
        raise Rejected("alg not allowed")  # never 'none', never HS256
    jwk = header.get("jwk", {})
    if "d" in jwk:
        raise Rejected("jwk contains a private key")
    sig = b64url_decode(s64)
    try:
        key_from_jwk(jwk).verify(encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")),
                                 f"{h64}.{c64}".encode(), ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, KeyError, ValueError):
        raise Rejected("bad signature")
    if not {"jti", "htm", "htu", "iat"} <= claims.keys():
        raise Rejected("missing claim")
    if claims["htm"] != method:
        raise Rejected(f"htm is {claims['htm']}, request is {method}")
    if claims["htu"] != url.split("?")[0].split("#")[0]:
        raise Rejected(f"htu is {claims['htu']}, request is {url}")
    if nonces and not nonces.valid(claims.get("nonce", ""), now):
        raise Rejected("use_dpop_nonce")  # the caller sends a fresh DPoP-Nonce header with this
    if not now - MAX_AGE <= claims["iat"] <= now + MAX_FUTURE:
        raise Rejected("iat outside the window")
    if access_token is not None:
        if claims.get("ath") != sha256_b64(access_token):
            raise Rejected("ath does not match the access token")
        if jwk_thumbprint(jwk) != bound_jkt:
            raise Rejected("proof key does not match the token's cnf.jkt")
    if not jti_store.first_use(claims["htu"], claims["jti"], now, ttl=MAX_AGE + MAX_FUTURE):
        raise Rejected("jti already used")  # last, so failed proofs don't fill the store
    return claims


# ---------------------------------------------------------------- a toy resource server

# What the authorization server issued. A JWT access token would carry these as claims;
# here the token is opaque and the server looks it up, as with token introspection.
TOKENS: dict[str, dict] = {}


def authorize(headers: dict, method: str, url: str, now: float, *, jti_store: JtiStore,
              nonces: NonceIssuer | None = None, legacy_bearer_only: bool = False) -> str:
    scheme, _, token = headers.get("Authorization", "").partition(" ")
    info = TOKENS.get(token)
    if info is None or now >= info["exp"]:
        raise Rejected("invalid_token")
    if legacy_bearer_only:  # a server written before DPoP: it never looks at cnf
        return "200 OK"
    jkt = info.get("cnf", {}).get("jkt")
    if jkt and scheme != "DPoP":
        raise Rejected("DPoP-bound token sent as Bearer")  # the downgrade check
    if scheme == "DPoP":
        if "DPoP" not in headers:
            raise Rejected("no DPoP proof")
        check_proof(headers["DPoP"], method=method, url=url, now=now, jti_store=jti_store,
                    access_token=token, bound_jkt=jkt, nonces=nonces)
    return "200 OK"


def attempt(label: str, *args, **kwargs) -> None:
    try:
        print(f"   {label:<46} {authorize(*args, **kwargs)}")
    except Rejected as err:
        print(f"   {label:<46} rejected: {err}")


def main() -> None:
    print("0. RFC example values, recomputed")
    rfc_ec = {"kty": "EC", "x": "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
              "y": "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA", "crv": "P-256"}
    rfc_rsa = {"kty": "RSA", "e": "AQAB", "n": (
        "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMs"
        "tn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajr"
        "n1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw")}
    print(f"   jkt of the RFC 9449 example key   {jwk_thumbprint(rfc_ec)}")
    print(f"   jkt of the RFC 7638 example key   {jwk_thumbprint(rfc_rsa)}")
    print(f"   ath of the RFC 9449 example token {sha256_b64('Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU')}")

    t0 = 1_800_000_000.0
    api = "https://api.example.com/orders"
    client_key = ec.generate_private_key(ec.SECP256R1())
    thief_key = ec.generate_private_key(ec.SECP256R1())

    print("\n1. A token copied from a log file, used from another machine")
    TOKENS["bearer-tok"] = {"exp": t0 + 600}
    TOKENS["dpop-tok"] = {"exp": t0 + 600, "cnf": {"jkt": jwk_thumbprint(public_jwk(client_key))}}
    store = JtiStore()
    attempt("bearer token, no proof", {"Authorization": "Bearer bearer-tok"}, "GET", api, t0, jti_store=store)
    attempt("DPoP token, no proof", {"Authorization": "DPoP dpop-tok"}, "GET", api, t0, jti_store=store)
    own = make_proof(thief_key, "GET", api, now=t0, access_token="dpop-tok")
    attempt("DPoP token, proof signed with thief's key",
            {"Authorization": "DPoP dpop-tok", "DPoP": own}, "GET", api, t0, jti_store=store)
    attempt("DPoP token sent as Bearer", {"Authorization": "Bearer dpop-tok"}, "GET", api, t0, jti_store=store)
    attempt("same, to a server that predates DPoP", {"Authorization": "Bearer dpop-tok"}, "GET", api, t0,
            jti_store=store, legacy_bearer_only=True)

    print("\n2. One real request captured with its proof, then replayed")
    proof = make_proof(client_key, "GET", api, now=t0, access_token="dpop-tok")
    req = {"Authorization": "DPoP dpop-tok", "DPoP": proof}
    attempt("the real request", req, "GET", api, t0, jti_store=store)
    attempt("replayed 2 s later", req, "GET", api, t0 + 2, jti_store=store)
    attempt("replayed as DELETE /orders/7", req, "DELETE", api + "/7", t0 + 2, jti_store=store)
    nodes = [JtiStore() for _ in range(4)]  # four servers, each with its own memory
    authorize(req, "GET", api, t0, jti_store=nodes[0])  # the real request reached node 0
    accepted = 0
    for i, node in enumerate(nodes):  # the balancer spreads the replays over all four
        try:
            authorize(req, "GET", api, t0 + 3 + i, jti_store=node)
            accepted += 1
        except Rejected:
            pass
    print(f"   {'replayed to 4 nodes, each with its own cache':<46} {accepted} of 4 accepted")
    attempt("replayed 61 s later", req, "GET", api, t0 + 61, jti_store=JtiStore())

    print("\n3. Script injected into the page signs 20 proofs for the next 10 minutes, then leaves")
    TOKENS["dpop-tok"]["exp"] = t0 + 300  # a 5-minute access token
    for label, nonces in (("no server nonce", None), ("nonce, rotated every 60 s", NonceIssuer(every=60))):
        nonce = nonces.current(t0) if nonces else None
        stash = [make_proof(client_key, "GET", api, now=t0, access_token="dpop-tok", nonce=nonce, iat=t0 + 30 * k)
                 for k in range(20)]
        store, ok, last = JtiStore(), 0, None
        for k, p in enumerate(stash):  # the attacker uses each proof when its iat comes round
            try:
                authorize({"Authorization": "DPoP dpop-tok", "DPoP": p}, "GET", api, t0 + 30 * k,
                          jti_store=store, nonces=nonces)
                ok, last = ok + 1, 30 * k
            except Rejected:
                pass
        until = f", the last at t+{last} s" if ok else ""
        print(f"   {label:<46} {ok} of 20 accepted{until}")

    print("\n4. TLS ends at the load balancer; the app rebuilds the URL from what it sees")
    store = JtiStore()
    proof = make_proof(client_key, "GET", api, now=t0, access_token="dpop-tok")
    seen_by_app = "http://10.0.3.7:8080/orders"
    attempt("URL from the socket", {"Authorization": "DPoP dpop-tok", "DPoP": proof}, "GET", seen_by_app, t0,
            jti_store=store)
    external = "https://api.example.com" + seen_by_app.split(":8080")[1]  # from configured public origin
    attempt("URL from the configured public origin", {"Authorization": "DPoP dpop-tok", "DPoP": proof}, "GET",
            external, t0, jti_store=store)

    print("\n5. What it costs")
    n = 2000
    start = time.perf_counter()
    proofs = [make_proof(client_key, "GET", api, now=t0, access_token="dpop-tok") for _ in range(n)]
    sign_us = (time.perf_counter() - start) / n * 1e6
    store = JtiStore()
    start = time.perf_counter()
    for p in proofs:
        check_proof(p, method="GET", url=api, now=t0, jti_store=store)
    verify_us = (time.perf_counter() - start) / n * 1e6
    print(f"   make a proof {sign_us:.0f} µs, check one {verify_us:.0f} µs, {len(proofs[0])} bytes in the DPoP header")


if __name__ == "__main__":
    main()
