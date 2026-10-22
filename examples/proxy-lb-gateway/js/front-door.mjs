// One front door, three roles: reverse proxy, load balancer, API gateway.
//
// The roles are cumulative, the way real products are: the load balancer is a reverse proxy that
// spreads requests over a pool, and the gateway is a load balancer that also checks who you are,
// limits how often you call, and routes by path to different services.
//
// Run:  node front-door.mjs      (starts three tiny backends on 127.0.0.1, then the demo)

import http from 'node:http';

// Path prefix -> pool of backend ports. The proxy and load balancer only use '/orders'.
const ROUTES = { '/orders': [9001, 9002], '/users': [9003] };
const API_KEYS = { 'key-asha': 'asha', 'key-ravi': 'ravi' }; // demo keys, never real ones
const LIMIT = 3; // gateway: 3 requests per key per 10-second window
const WINDOW_MS = 10_000;
const DOWN_FOR_MS = 10_000; // like nginx's fail_timeout: skip a failed backend for 10 s

/** @param {'proxy' | 'lb' | 'gateway'} role */
function frontDoor(role) {
  let nextIndex = 0; // round-robin position, shared by all requests
  const downUntil = new Map();
  const windows = new Map(); // api key -> { start, count }

  return http.createServer(async (req, res) => {
    // Reverse proxy: forward to a backend, and say who the real client was. We overwrite any
    // X-Forwarded-For the client sent: this box is the trust boundary.
    const headers = { 'x-forwarded-for': req.socket.remoteAddress.replace('::ffff:', '') };
    let pool = ROUTES['/orders'];

    if (role === 'gateway') {
      const user = API_KEYS[req.headers['x-api-key'] ?? ''];
      if (!user) return reply(res, 401, { error: 'missing or unknown API key' });
      if (!allow(windows, user)) return reply(res, 429, { error: `limit is ${LIMIT} per 10 s` });
      headers['x-user'] = user; // services trust this header, not the key
      const prefix = Object.keys(ROUTES).find((p) => req.url.startsWith(p));
      if (!prefix) return reply(res, 404, { error: `no route for ${req.url}` });
      pool = ROUTES[prefix];
    }

    if (role === 'proxy') pool = pool.slice(0, 1); // a plain reverse proxy has one upstream

    // Load balancer: try each backend once, in round-robin order, skipping ones marked down.
    for (let i = 0; i < pool.length; i++) {
      const port = pool[nextIndex++ % pool.length];
      if ((downUntil.get(port) ?? 0) > Date.now()) continue;
      try {
        return await forward(port, req.url, headers, res);
      } catch {
        downUntil.set(port, Date.now() + DOWN_FOR_MS);
        console.log(`    [${role}] 127.0.0.1:${port} failed, marked down for 10 s`);
      }
    }
    reply(res, 502, { error: 'no healthy backend' });
  });
}

/** Fixed-window counter per API key (the rate limiting page covers better ones). */
function allow(windows, key) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) w = { start: now, count: 0 };
  w.count++;
  windows.set(key, w);
  return w.count <= LIMIT;
}

/** Forward one GET and copy the answer back. Rejects if the backend cannot be reached. */
function forward(port, path, headers, res) {
  return new Promise((resolve, reject) => {
    const upstream = http.get({ host: '127.0.0.1', port, path, headers, timeout: 2000 }, (r) => {
      res.writeHead(r.statusCode, { 'content-type': 'application/json' });
      r.pipe(res).on('finish', resolve);
    });
    upstream.on('error', reject);
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  });
}

function reply(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

/** A tiny service that reports its name and what the front door told it. */
function backend(name) {
  return http.createServer((req, res) => {
    reply(res, 200, {
      served_by: name,
      x_forwarded_for: req.headers['x-forwarded-for'],
      x_user: req.headers['x-user'],
    });
  });
}

const listen = (server, port) => new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));

async function get(port, path, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const shown = JSON.stringify(await r.json());
  const sent = Object.keys(headers).length ? `  (sent ${JSON.stringify(headers)})` : '';
  console.log(`  GET ${path.padEnd(12)} ${r.status}  ${shown}${sent}`);
}

const backends = {};
for (const [name, port] of [['orders-1', 9001], ['orders-2', 9002], ['users-1', 9003]]) {
  backends[name] = await listen(backend(name), port);
}

console.log("1. Reverse proxy: one upstream; the client's own X-Forwarded-For is replaced");
const proxy = await listen(frontDoor('proxy'), 8081);
await get(8081, '/orders/42', { 'X-Forwarded-For': '6.6.6.6' });
await get(8081, '/orders/43');

console.log('\n2. Load balancer: round robin over two copies, then orders-2 dies');
const lb = await listen(frontDoor('lb'), 8082);
for (let i = 0; i < 4; i++) await get(8082, `/orders/${i}`);
backends['orders-2'].closeAllConnections();
await new Promise((ok) => backends['orders-2'].close(ok));
for (let i = 4; i < 7; i++) await get(8082, `/orders/${i}`);

console.log('\n3. API gateway: identity, a per-key limit, and routing by path');
backends['orders-2'] = await listen(backend('orders-2'), 9002); // orders-2 is back
const gateway = await listen(frontDoor('gateway'), 8083);
await get(8083, '/orders/1');
for (let i = 0; i < 4; i++) await get(8083, `/orders/${i}`, { 'X-Api-Key': 'key-asha' });
await get(8083, '/users/ravi', { 'X-Api-Key': 'key-ravi' });
await get(8083, '/admin', { 'X-Api-Key': 'key-ravi' });

for (const s of [proxy, lb, gateway, ...Object.values(backends)]) s.closeAllConnections(), s.close();
