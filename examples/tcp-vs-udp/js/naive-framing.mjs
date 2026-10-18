// The bug almost everyone writes first: treating each 'data' event on a TCP socket as one message.
//
// A quiz server receives score updates as JSON over TCP. The client sends five small messages and
// one big one. The server, busy for a moment, then parses each chunk it gets as a message. TCP is
// a byte stream, so chunks and messages do not line up.
//
// Run: node naive-framing.mjs
import net from 'node:net';

const messages = [1, 2, 3, 4, 5].map((i) => ({ type: 'score', player: `p${i}`, points: 10 * i }));
messages.push({ type: 'leaderboard', rows: Array.from({ length: 6000 }, (_, i) => ({ player: `p${i}`, points: i })) });

let reads = 0;
const server = net.createServer((socket) => {
  socket.pause(); // the server was busy for 50 ms; bytes piled up in the kernel buffer
  setTimeout(() => socket.resume(), 50);
  socket.on('data', (chunk) => {
    // "one 'data' event = one message" -- the naive assumption
    reads++;
    const start = `'${chunk.subarray(0, 24)}'`;
    try {
      const message = JSON.parse(chunk);
      console.log(`  data #${reads}: ${String(chunk.length).padStart(6)} bytes, starts ${start} -> parsed ${message.type}`);
    } catch (err) {
      console.log(`  data #${reads}: ${String(chunk.length).padStart(6)} bytes, starts ${start} -> ${err.message.split(/ at position|, "/)[0]}`);
    }
  });
  socket.on('end', () => {
    const sizes = messages.map((m) => JSON.stringify(m).length);
    console.log(`\nclient: ${messages.length} write() calls of [${sizes.join(', ')}] bytes`);
    console.log("server: the 'data' events above. Message boundaries did not survive the trip.");
    server.close();
  });
});

server.listen(0, '127.0.0.1', () => {
  const client = net.connect(server.address().port, '127.0.0.1', () => {
    for (const m of messages) client.write(JSON.stringify(m)); // six separate writes...
    client.end();
  });
});
