"""A small products and payments API that gets the failure cases right, plus a demo client.

- GET returns an ETag, the product's version.
- PUT with If-Match only writes if the version is unchanged (412 if not). PUT without If-Match is
  allowed here so the demo can show the lost update it causes.
- PATCH takes a JSON Merge Patch (RFC 7396): only the fields sent change.
- POST /payments honours an Idempotency-Key: the first result is stored and replayed.
- Errors are Problem Details (RFC 9457).

Run: python products_api.py
"""

import http.client
import json
import threading
import itertools
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8091
products = {"42": {"name": "Kettle", "price": 1499, "stock": 10}}
versions = {"42": 1}
payments: dict[str, dict] = {}  # payment id -> payment
idempotency: dict[str, tuple[str, int, dict]] = {}  # key -> (request fingerprint, status, body)
lock = threading.Lock()  # one lock: the check and the write must be one step
payment_ids = itertools.count(1)


class Api(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        pid = self.path.removeprefix("/products/")
        with lock:
            if pid not in products:
                return self.problem(404, "not-found", "No such product")
            self.reply(200, products[pid], etag=f'"v{versions[pid]}"')

    def do_PUT(self) -> None:
        pid = self.path.removeprefix("/products/")
        body = self.read_json()
        with lock:  # check the version and write it in one step
            current = f'"v{versions[pid]}"'
            sent = self.headers.get("If-Match")
            if sent is not None and sent != current:
                return self.problem(412, "stale-version", "The product changed since you read it",
                                    detail=f"You sent If-Match {sent}; the current ETag is {current}.")
            products[pid] = body
            versions[pid] += 1
            self.reply(200, body, etag=f'"v{versions[pid]}"')

    def do_PATCH(self) -> None:
        pid = self.path.removeprefix("/products/")
        if self.headers.get("Content-Type") != "application/merge-patch+json":
            return self.problem(415, "unsupported-patch", "Send application/merge-patch+json")
        patch = self.read_json()
        with lock:
            for field, value in patch.items():
                if value is None:
                    products[pid].pop(field, None)  # merge patch: null means remove
                else:
                    products[pid][field] = value
            versions[pid] += 1
            self.reply(200, products[pid], etag=f'"v{versions[pid]}"')

    def do_POST(self) -> None:
        body = self.read_json()
        key = self.headers.get("Idempotency-Key")
        fingerprint = json.dumps(body, sort_keys=True)
        with lock:
            if key in idempotency:
                seen, status, stored = idempotency[key]
                if seen != fingerprint:  # same key, different request: a client bug
                    return self.problem(422, "key-reused", "Idempotency-Key reused with a different body")
                return self.reply(status, stored, replayed=True)  # same answer, no second charge
            payment = {"id": f"pay_{next(payment_ids):04d}", "amount": body["amount"], "status": "charged"}
            payments[payment["id"]] = payment
            if key:
                idempotency[key] = (fingerprint, 201, payment)
            self.reply(201, payment)

    # helpers
    def read_json(self) -> dict:
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def reply(self, status: int, body: dict, etag: str | None = None, replayed: bool = False) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if etag:
            self.send_header("ETag", etag)
        if replayed:
            self.send_header("Idempotent-Replayed", "true")
        self.end_headers()
        self.wfile.write(data)

    def problem(self, status: int, kind: str, title: str, detail: str | None = None) -> None:
        body = {"type": f"https://api.example.in/problems/{kind}", "title": title, "status": status}
        if detail:
            body["detail"] = detail
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/problem+json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:
        pass


def call(method: str, path: str, body: dict | None = None, **headers: str) -> tuple[int, dict, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    data = json.dumps(body).encode() if body is not None else None
    sent = {k.replace("_", "-"): v for k, v in headers.items()}  # If_Match -> If-Match
    if data is not None:
        sent.setdefault("Content-Type", "application/json")
    conn.request(method, path, body=data, headers=sent)
    resp = conn.getresponse()
    payload = json.loads(resp.read() or b"{}")
    out = (resp.status, dict(resp.getheaders()), payload)
    conn.close()
    return out


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Api)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print("1. Lost update: two editors, blind PUT")
    _, h, asha = call("GET", "/products/42")
    _, _, ravi = call("GET", "/products/42")
    s1, _, _ = call("PUT", "/products/42", {**asha, "price": 1299})
    s2, _, _ = call("PUT", "/products/42", {**ravi, "stock": 9})
    print(f"   Asha PUT price=1299 -> {s1}, Ravi PUT stock=9 -> {s2}")
    print(f"   product now: {json.dumps(call('GET', '/products/42')[2], separators=(",", ":"))}   <- Asha's price is gone")

    print("2. The same edits with If-Match")
    _, h, asha = call("GET", "/products/42")
    asha_etag = h["ETag"]
    _, h, ravi = call("GET", "/products/42")
    ravi_etag = h["ETag"]
    s1, _, _ = call("PUT", "/products/42", {**asha, "price": 1299}, If_Match=asha_etag)
    s2, h2, problem = call("PUT", "/products/42", {**ravi, "stock": 9}, If_Match=ravi_etag)
    print(f"   Asha PUT If-Match {asha_etag} -> {s1}; Ravi PUT If-Match {ravi_etag} -> {s2} {h2['Content-Type']}")
    print(f"   {problem['title']}: {problem['detail']}")
    _, h, fresh = call("GET", "/products/42")
    s3, _, _ = call("PUT", "/products/42", {**fresh, "stock": 9}, If_Match=h["ETag"])
    print(f"   Ravi re-reads and retries -> {s3}; product now: {json.dumps(call('GET', '/products/42')[2], separators=(",", ":"))}")

    print("3. Merge PATCH: each editor sends only its field")
    call("PATCH", "/products/42", {"price": 1199}, Content_Type="application/merge-patch+json")
    call("PATCH", "/products/42", {"stock": 8}, Content_Type="application/merge-patch+json")
    print(f"   product now: {json.dumps(call('GET', '/products/42')[2], separators=(",", ":"))}   <- both kept")

    print("4. POST /payments, the response is lost and the client retries")
    first = call("POST", "/payments", {"amount": 1199})[2]  # pretend this response never arrived
    second = call("POST", "/payments", {"amount": 1199})[2]
    print(f"   no key:   {first['id']} and {second['id']} -> charged twice")
    key = str(uuid.uuid4())
    a = call("POST", "/payments", {"amount": 1199}, Idempotency_Key=key)
    b = call("POST", "/payments", {"amount": 1199}, Idempotency_Key=key)
    print(f"   with key: {a[2]['id']} and {b[2]['id']} (replayed: {b[1].get('Idempotent-Replayed')}) -> charged once")
    c = call("POST", "/payments", {"amount": 9999}, Idempotency_Key=key)
    print(f"   same key, different amount -> {c[0]} {c[2]['title']}")
    server.shutdown()


if __name__ == "__main__":
    main()
