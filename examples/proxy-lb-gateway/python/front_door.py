"""One front door, three roles: reverse proxy, load balancer, API gateway.

The roles are cumulative, the way real products are: the load balancer is a reverse proxy that
spreads requests over a pool, and the gateway is a load balancer that also checks who you are,
limits how often you call, and routes by path to different services.

Run:  python front_door.py              (starts three tiny backends on 127.0.0.1, then the demo)
      python front_door.py --backends   (only the backends, for the nginx example)
"""

import http.client
import sys
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Path prefix -> pool of backend addresses. The proxy and load balancer only use "/orders".
ROUTES = {"/orders": ["127.0.0.1:9001", "127.0.0.1:9002"], "/users": ["127.0.0.1:9003"]}
API_KEYS = {"key-asha": "asha", "key-ravi": "ravi"}  # demo keys, never real ones
LIMIT, WINDOW_S = 3, 10.0  # gateway: 3 requests per key per 10-second window
DOWN_FOR_S = 10.0  # like nginx's fail_timeout: skip a failed backend for 10 s


class FrontDoor(BaseHTTPRequestHandler):
    role = "proxy"  # "proxy" | "lb" | "gateway", set per server below
    next_index = 0  # round-robin position, shared by all requests
    down_until: dict[str, float] = {}
    windows: dict[str, tuple[float, int]] = {}  # api key -> (window start, count)
    lock = threading.Lock()

    def do_GET(self) -> None:
        # Reverse proxy: forward to a backend, and say who the real client was. We overwrite any
        # X-Forwarded-For the client sent: this box is the trust boundary.
        headers = {"X-Forwarded-For": self.client_address[0]}
        pool = ROUTES["/orders"]

        if self.role == "gateway":
            user = API_KEYS.get(self.headers.get("X-Api-Key", ""))
            if user is None:
                return self.reply(401, {"error": "missing or unknown API key"})
            if not self.allow(user):
                return self.reply(429, {"error": f"limit is {LIMIT} per {WINDOW_S:.0f} s"})
            headers["X-User"] = user  # services trust this header, not the key
            prefix = next((p for p in ROUTES if self.path.startswith(p)), None)
            if prefix is None:
                return self.reply(404, {"error": f"no route for {self.path}"})
            pool = ROUTES[prefix]

        if self.role == "proxy":
            pool = pool[:1]  # a plain reverse proxy has one upstream

        # Load balancer: try each backend once, in round-robin order, skipping ones marked down.
        for _ in range(len(pool)):
            with self.lock:
                backend = pool[type(self).next_index % len(pool)]
                type(self).next_index += 1
            if self.down_until.get(backend, 0) > time.monotonic():
                continue
            try:
                return self.forward(backend, headers)
            except OSError:
                self.down_until[backend] = time.monotonic() + DOWN_FOR_S
                self.log(f"{backend} failed, marked down for {DOWN_FOR_S:.0f} s")
        self.reply(502, {"error": "no healthy backend"})

    def allow(self, key: str) -> bool:
        """Fixed-window counter per API key (the rate limiting page covers better ones)."""
        now = time.monotonic()
        with self.lock:
            start, count = self.windows.get(key, (now, 0))
            if now - start >= WINDOW_S:
                start, count = now, 0
            self.windows[key] = (start, count + 1)
            return count < LIMIT

    def forward(self, backend: str, headers: dict[str, str]) -> None:
        conn = http.client.HTTPConnection(backend, timeout=2)
        conn.request("GET", self.path, headers=headers)
        resp = conn.getresponse()
        body = resp.read()
        self.send_response(resp.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        conn.close()

    def reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log(self, message: str) -> None:
        print(f"    [{self.role}] {message}")

    def log_message(self, *args) -> None:  # silence the default access log
        pass


class Backend(BaseHTTPRequestHandler):
    """A tiny service that reports its name and what the front door told it."""

    def do_GET(self) -> None:
        body = json.dumps({
            "served_by": self.server.name,
            "path": self.path,
            "x_forwarded_for": self.headers.get("X-Forwarded-For"),
            "x_user": self.headers.get("X-User"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def start(server: ThreadingHTTPServer) -> ThreadingHTTPServer:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def get(port: int, path: str, headers: dict[str, str] | None = None) -> None:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers=headers or {})
    resp = conn.getresponse()
    data = json.loads(resp.read())
    conn.close()
    shown = {k: v for k, v in data.items() if v is not None and k != "path"}
    sent = f"  (sent {headers})" if headers else ""
    print(f"  GET {path:<12} {resp.status}  {shown}{sent}")


def front_door(role: str, port: int) -> ThreadingHTTPServer:
    handler = type(f"FrontDoor_{role}", (FrontDoor,), {"role": role, "next_index": 0,
                                                        "down_until": {}, "windows": {}})
    return start(ThreadingHTTPServer(("127.0.0.1", port), handler))


def main() -> None:
    backends = {}
    for name, port in [("orders-1", 9001), ("orders-2", 9002), ("users-1", 9003)]:
        server = ThreadingHTTPServer(("127.0.0.1", port), Backend)
        server.name = name
        backends[name] = start(server)
    if "--backends" in sys.argv:
        print("backends on 127.0.0.1:9001-9003, Ctrl+C to stop", flush=True)
        threading.Event().wait()

    print("1. Reverse proxy: one upstream; the client's own X-Forwarded-For is replaced")
    front_door("proxy", 8081)
    get(8081, "/orders/42", {"X-Forwarded-For": "6.6.6.6"})
    get(8081, "/orders/43")

    print("\n2. Load balancer: round robin over two copies, then orders-2 dies")
    front_door("lb", 8082)
    for i in range(4):
        get(8082, f"/orders/{i}")
    backends["orders-2"].shutdown()
    backends["orders-2"].server_close()
    for i in range(4, 7):
        get(8082, f"/orders/{i}")

    print("\n3. API gateway: identity, a per-key limit, and routing by path")
    server = ThreadingHTTPServer(("127.0.0.1", 9002), Backend)  # orders-2 is back
    server.name = "orders-2"
    start(server)
    front_door("gateway", 8083)
    get(8083, "/orders/1")
    for i in range(4):
        get(8083, f"/orders/{i}", {"X-Api-Key": "key-asha"})
    get(8083, "/users/ravi", {"X-Api-Key": "key-ravi"})
    get(8083, "/admin", {"X-Api-Key": "key-ravi"})


if __name__ == "__main__":
    main()
