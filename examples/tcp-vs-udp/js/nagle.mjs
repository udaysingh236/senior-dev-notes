// Nagle's algorithm meets delayed ACKs: the mysterious 40 ms.
//
// The client sends each request in two writes, a 4-byte length header and then the body, and then
// waits for the reply (write-write-read). With Nagle's algorithm on (the default for net.Socket),
// the second small write is held back until the first is acknowledged. The server has nothing to
// say until it has the whole request, so it delays its ACK. Each side waits for the other until
// the delayed-ACK timer fires.
//
// Run: node nagle.mjs      (the effect is clearest on Linux; see the README)
import net from 'node:net';

const REQUESTS = 50;

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      buffer = buffer.subarray(4 + buffer.readUInt32BE(0)); // cannot answer until the whole request is here
      socket.write('OK');
    }
  });
});

function client(port, noDelay, oneWrite) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(noDelay); // false is the default for a new net.Socket: Nagle on
    const body = Buffer.from('{"op": "get", "key": "user:42"}');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const timings = [];
    let start;
    const send = () => {
      start = performance.now();
      if (oneWrite) socket.write(Buffer.concat([header, body]));
      else {
        socket.write(header); // write...
        socket.write(body); // ...write...
      }
    };
    socket.on('data', () => { // ...read (the reply is 2 bytes, so one 'data' event is one reply here)
      timings.push(performance.now() - start);
      if (timings.length < REQUESTS) send();
      else {
        socket.end();
        resolve(timings.slice(10)); // skip the first few: Linux ACKs at once early in a connection
      }
    });
    socket.on('connect', send);
  });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  for (const [label, noDelay, oneWrite] of [
    ['nagle on, two writes', false, false],
    ['setNoDelay, two writes', true, false],
    ['nagle on, one write', false, true],
  ]) {
    const t = await client(port, noDelay, oneWrite);
    console.log(`${label.padEnd(24)} median ${median(t).toFixed(2).padStart(6)} ms   worst ${Math.max(...t).toFixed(2).padStart(6)} ms`);
  }
  server.close();
});
