// Load a web page one step at a time, the way a browser does, and time every step.
//
// Node 20+, no dependencies. Run:  node by-hand.mjs [host]   (default: example.com)
//
// Each step is done by hand instead of inside one fetch() call, so you can see where the time
// goes: DNS lookup, TCP connect, TLS handshake, sending the request, waiting for the first byte,
// and reading the rest. Then it sends a second request on the same connection to show what
// connection reuse saves.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';

const ms = (n) => `${n.toFixed(1).padStart(6)} ms`;
const now = () => performance.now();

/** Buffers bytes from the socket, so leftovers from one response are kept for the next. */
class Reader {
  buf = Buffer.alloc(0);
  firstByteAt = 0;
  #waiting = null;

  constructor(socket) {
    socket.on('data', (chunk) => {
      this.firstByteAt ||= now();
      this.buf = Buffer.concat([this.buf, chunk]);
      this.#waiting?.();
    });
    socket.on('end', () => this.#waiting?.(new Error('server closed the connection mid-response')));
  }

  async #more() {
    const err = await new Promise((resolve) => (this.#waiting = resolve));
    this.#waiting = null;
    if (err) throw err;
  }

  async until(marker) {
    let i;
    while ((i = this.buf.indexOf(marker)) === -1) await this.#more();
    const data = this.buf.subarray(0, i);
    this.buf = this.buf.subarray(i + marker.length);
    return data;
  }

  async exactly(n) {
    while (this.buf.length < n) await this.#more();
    const data = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return data;
  }
}

/** Read one HTTP/1.1 response: status line, headers, time to first byte, body size. */
async function readResponse(reader, started) {
  reader.firstByteAt = 0;
  const [status, ...lines] = (await reader.until('\r\n\r\n')).toString('latin1').split('\r\n');
  const headers = Object.fromEntries(
    lines.map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
  );
  let size = 0;
  if (headers['transfer-encoding'] === 'chunked') {
    // The body arrives in pieces, each prefixed by its size in hex; a 0-size piece ends it.
    for (let n; (n = parseInt((await reader.until('\r\n')).toString(), 16)) > 0; ) {
      size += (await reader.exactly(n)).length;
      await reader.until('\r\n');
    }
    await reader.until('\r\n');
  } else {
    size = (await reader.exactly(Number(headers['content-length'] ?? 0))).length;
  }
  return { status, headers, ttfb: reader.firstByteAt - started, size };
}

async function load(host, path = '/') {
  console.log(`Loading https://${host}${path}\n`);

  // 1. DNS: turn the name into addresses. lookup() asks the operating system, which asks
  //    its configured resolver (and may answer from its own cache).
  let t = now();
  const addresses = await lookup(host, { all: true, order: 'ipv6first' });
  const dns = now() - t;
  console.log(`1. DNS lookup    ${ms(dns)}   ${host} -> ${addresses.slice(0, 3).map((a) => a.address).join(', ')}`);

  // 2. TCP: one round trip (SYN, SYN-ACK; our ACK rides along with the next packet).
  const { address } = addresses[0];
  t = now();
  const raw = net.connect({ host: address, port: 443, timeout: 5000 }); // never wait for ever
  raw.on('timeout', () => raw.destroy(new Error('connect timed out')));
  await once(raw, 'connect');
  const tcp = now() - t;
  console.log(`2. TCP connect   ${ms(tcp)}   to ${address} port 443 (about one round trip)`);

  // 3. TLS: agree on keys, check the certificate, and pick HTTP/1.1 via ALPN.
  t = now();
  const sock = tls.connect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'] }); // servername = SNI
  await once(sock, 'secureConnect');
  const handshake = now() - t;
  const cert = sock.getPeerCertificate();
  console.log(`3. TLS handshake ${ms(handshake)}   ${sock.getProtocol()}, ${sock.getCipher().name}, ALPN=${sock.alpnProtocol}`);
  console.log(`                             certificate issued by ${cert.issuer.O}, valid until ${cert.valid_to}`);

  // 4. HTTP: the request is plain text inside the encrypted tunnel.
  const request = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: by-hand/1.0\r\nConnection: keep-alive\r\n\r\n`;
  const reader = new Reader(sock);
  t = now();
  sock.write(request);
  const first = await readResponse(reader, t);
  const total = now() - t;
  console.log(`4. First byte    ${ms(first.ttfb)}   after sending the request: ${first.status}`);
  console.log(`5. Whole body    ${ms(total)}   ${first.size} bytes, Content-Type: ${first.headers['content-type']}`);
  for (const name of ['transfer-encoding', 'cache-control', 'age', 'server', 'cf-ray', 'alt-svc']) {
    if (first.headers[name]) console.log(`                             ${name}: ${first.headers[name]}`);
  }
  console.log(`\nFirst request, everything included: ${ms(dns + tcp + handshake + total)}`);

  // 6. Reuse: a second request on the same connection skips DNS, TCP and TLS.
  t = now();
  sock.write(request);
  const second = await readResponse(reader, t);
  console.log(`Second request, same connection:    ${ms(now() - t)}   (${second.status})`);
  sock.end();
}

await load(process.argv[2] ?? 'example.com');
