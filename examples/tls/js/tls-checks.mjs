// What a TLS client checks, and what happens when you turn the checks off.
//
// A local TLS server presents a different certificate in each case. The client trusts only our test
// root CA (run ../make-certs.sh first). Standard library only.
import { readFileSync } from 'node:fs';
import tls from 'node:tls';

const certs = new URL('../certs/', import.meta.url);
const read = (name) => readFileSync(new URL(name, certs));

const CASES = [ // [label, certificate chain the server sends, its key]
  ['good: leaf + intermediate', 'server-fullchain.pem', 'server.key'],
  ['missing intermediate', 'server.pem', 'server.key'],
  ['expired', 'expired-fullchain.pem', 'server.key'],
  ['wrong name', 'wrongname-fullchain.pem', 'server.key'],
  ["impostor's own CA", 'rogue.pem', 'rogue.key'],
];

/** Start a TLS server that answers one connection with a line of text. Resolves to its port. */
function serveOnce(chain, key) {
  const server = tls.createServer({ cert: read(chain), key: read(key) }, (socket) => {
    socket.once('data', (secret) => socket.end(Buffer.concat([Buffer.from('server got: '), secret])));
  });
  server.on('tlsClientError', () => {}); // the client hung up during the handshake: the point of most cases
  server.on('connection', () => server.close()); // one connection, then stop listening
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function connect(port, options) {
  return new Promise((resolve) => {
    // servername turns on two things: SNI, and checking the name in the certificate
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ...options }, () => {
      socket.write('password=hunter2');
    });
    socket.once('data', (reply) => {
      resolve(`OK  ${socket.getProtocol()} ${socket.getCipher().standardName} -> '${reply}'`);
      socket.end();
    });
    socket.once('error', (err) => resolve(`REFUSED  ${err.code}`));
  });
}

// The right client: checks on (the default), trusting only the CA we chose.
console.log('Client with verification on (the default):');
for (const [label, chain, key] of CASES) {
  console.log(`  ${label.padEnd(27)} ${await connect(await serveOnce(chain, key), { ca: read('root.pem') })}`);
}

// The "fix" people paste from the internet when they see UNABLE_TO_VERIFY_LEAF_SIGNATURE.
console.log('\nClient with rejectUnauthorized: false:');
for (const [label, chain, key] of CASES) {
  console.log(`  ${label.padEnd(27)} ${await connect(await serveOnce(chain, key), { rejectUnauthorized: false })}`);
}
