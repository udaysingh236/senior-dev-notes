// What an on-path observer learns from TLS traffic it cannot decrypt.
//
// A relay sits between a client and a TLS server, the way a Wi-Fi hotspot or any router does. It has
// no keys. It forwards every byte unchanged and reads only what TLS leaves in the clear: the record
// headers, the ClientHello, and, in TLS 1.2, the certificate. The client fetches two pages of
// different sizes over TLS 1.3 and over TLS 1.2. Run ../make-certs.sh first. Standard library only.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const certs = new URL('../certs/', import.meta.url);
const read = (name) => readFileSync(new URL(name, certs));
const PAGES = { '/dental': 1200, '/hiv-test': 5400 }; // response body sizes in bytes

/** Split raw TLS bytes into [content type, length] using only the 5-byte plain headers. */
function records(stream) {
  const out = [];
  for (let i = 0; i + 5 <= stream.length; i += 5 + stream.readUInt16BE(i + 3)) {
    out.push([stream[i], stream.readUInt16BE(i + 3)]);
  }
  return out;
}

/** Walk the plaintext ClientHello to the server_name extension (type 0). */
function serverName(hello) {
  let i = 5 + 4 + 2 + 32; // record header, handshake header, version, random
  i += 1 + hello[i]; // session id
  i += 2 + hello.readUInt16BE(i); // cipher suites
  i += 1 + hello[i]; // compression methods
  const end = i + 2 + hello.readUInt16BE(i);
  for (i += 2; i < end; i += 4 + hello.readUInt16BE(i + 2)) {
    if (hello.readUInt16BE(i) === 0) { // list length (2), name type (1), name length (2), name
      return hello.subarray(i + 9, i + 9 + hello.readUInt16BE(i + 7)).toString();
    }
  }
  return '(none)';
}

const server = tls.createServer({ cert: read('server-fullchain.pem'), key: read('server.key') }, (socket) => {
  socket.once('data', (request) => socket.write('x'.repeat(PAGES[request.toString().split(' ')[1]])));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

/** Relay one connection through a keyless observer; resolve to the raw bytes seen each way. */
function observe(maxVersion, path) {
  return new Promise((resolve) => {
    const seen = { up: [], down: [] };
    const relay = net.createServer((client) => {
      const upstream = net.connect(server.address().port, '127.0.0.1');
      client.on('data', (d) => { seen.up.push(d); upstream.write(d); });
      upstream.on('data', (d) => { seen.down.push(d); client.write(d); });
      client.on('close', () => { upstream.destroy(); relay.close(); });
    });
    relay.listen(0, '127.0.0.1', () => {
      const socket = tls.connect({
        port: relay.address().port, host: '127.0.0.1', servername: 'clinic.example.in', ca: read('root.pem'), maxVersion,
      }, () => socket.write(`GET ${path} HTTP/1.1\r\n\r\n`));
      let got = 0;
      socket.on('data', (d) => {
        got += d.length;
        if (got >= PAGES[path]) socket.destroy();
      });
      relay.on('close', () => resolve({ up: Buffer.concat(seen.up), down: Buffer.concat(seen.down) }));
    });
  });
}

for (const [label, version] of [['TLS 1.3', 'TLSv1.3'], ['TLS 1.2', 'TLSv1.2']]) {
  for (const path of Object.keys(PAGES)) {
    const seen = await observe(version, path);
    const [up, down] = [records(seen.up), records(seen.down)];
    console.log(`${label}  GET ${path}`);
    console.log(`  server name (SNI), in the clear:  ${serverName(seen.up)}`);
    console.log(`  CA name readable on the wire:     ${seen.down.includes('SDN Test Issuing CA 1')}`);
    console.log(`  request record:                   ${up.at(-1)[1].toLocaleString('en')} bytes`);
    console.log(`  response record:                  ${down.at(-1)[1].toLocaleString('en')} bytes, for a ${PAGES[path].toLocaleString('en')}-byte page`);
  }
}
server.close();
