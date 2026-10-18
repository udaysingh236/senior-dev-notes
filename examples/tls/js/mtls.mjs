// Mutual TLS: the server checks the client's certificate too, then authorizes by identity.
//
// A payments service accepts connections only from services holding a certificate from our CA, reads
// the caller's SPIFFE ID from the certificate, and decides what that caller may do. Run
// ../make-certs.sh first. Standard library only.
import { readFileSync } from 'node:fs';
import tls from 'node:tls';

const certs = new URL('../certs/', import.meta.url);
const read = (name) => readFileSync(new URL(name, certs));

// Authorization: which identity may call which operation. Authentication (the certificate) says
// who is calling; this table says what they are allowed to do.
const ALLOWED = {
  'spiffe://shop.internal/orders': new Set(['POST /charge']),
  'spiffe://shop.internal/reports': new Set(['GET /summary']),
};

/** The URI in the certificate's Subject Alternative Name, e.g. spiffe://shop.internal/orders. */
const callerIdentity = (cert) =>
  (cert.subjectaltname ?? '').split(', ').find((s) => s.startsWith('URI:'))?.slice(4) ?? null;

const server = tls.createServer({
  cert: read('server-fullchain.pem'),
  key: read('server.key'),
  requestCert: true, // ask for a client certificate...
  rejectUnauthorized: true, // ...and refuse the handshake without a valid one: *mutual* TLS
  ca: read('root.pem'), // client certs must chain to our root
}, (socket) => {
  const who = callerIdentity(socket.getPeerCertificate());
  socket.once('data', (data) => {
    const allowed = ALLOWED[who]?.has(data.toString().trim());
    socket.end(`${allowed ? '200 OK' : '403 Forbidden'} for ${who}`);
  });
});
server.on('tlsClientError', () => {}); // no certificate, or one we do not trust
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

function call(clientCert, operation) {
  const options = { host: '127.0.0.1', port, servername: 'localhost', ca: read('root.pem') };
  if (clientCert) Object.assign(options, { cert: read(`${clientCert}-fullchain.pem`), key: read(`${clientCert}.key`) });
  return new Promise((resolve) => {
    const socket = tls.connect(options, () => socket.write(operation));
    socket.once('data', (reply) => resolve(reply.toString()));
    // In TLS 1.3 the client finishes its side of the handshake first, so the server's rejection
    // arrives as an alert after we have already sent the request.
    socket.once('error', (err) => resolve(`refused: ${err.code}`));
  });
}

for (const [cert, operation] of [
  [null, 'POST /charge'],
  ['orders', 'POST /charge'],
  ['reports', 'GET /summary'],
  ['reports', 'POST /charge'],
]) {
  console.log(`  ${(cert ?? 'no cert').padEnd(8)} ${operation.padEnd(13)} -> ${await call(cert, operation)}`);
}
server.close();
