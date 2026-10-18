// Length-prefixed framing: the fix for "one 'data' event = one message".
//
// Every message goes out as a 4-byte big-endian length followed by that many bytes of JSON. The
// reader appends each chunk to a buffer and takes out whole messages whenever enough bytes are
// there, however TCP chunked them. Same traffic as naive-framing.mjs.
//
// Run: node framing.mjs
import net from 'node:net';

const MAX_MESSAGE = 1 << 20; // refuse anything over 1 MB: a bad length must not make us buffer 4 GB

function encode(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]); // one buffer: header and body leave together
}

/** Turns a stream of chunks into whole messages. Call push() with each chunk. */
class MessageReader {
  buffer = Buffer.alloc(0);

  constructor(onMessage) {
    this.onMessage = onMessage;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_MESSAGE) throw new Error(`message of ${length} bytes is over the ${MAX_MESSAGE}-byte limit`);
      if (this.buffer.length < 4 + length) return; // not all here yet: wait for more chunks
      this.onMessage(JSON.parse(this.buffer.subarray(4, 4 + length)));
      this.buffer = this.buffer.subarray(4 + length);
    }
  }

  end() {
    if (this.buffer.length) throw new Error('peer closed mid-message');
  }
}

const messages = [1, 2, 3, 4, 5].map((i) => ({ type: 'score', player: `p${i}`, points: 10 * i }));
messages.push({ type: 'leaderboard', rows: Array.from({ length: 6000 }, (_, i) => ({ player: `p${i}`, points: i })) });

let count = 0;
const server = net.createServer((socket) => {
  socket.pause(); // busy for 50 ms, exactly as before
  setTimeout(() => socket.resume(), 50);
  const reader = new MessageReader((message) => {
    count++;
    const size = JSON.stringify(message).length;
    console.log(`  message #${count}: ${String(size).padStart(6)} bytes -> parsed ${message.type}`);
  });
  socket.on('data', (chunk) => reader.push(chunk));
  socket.on('end', () => {
    reader.end();
    console.log(`\n${messages.length} messages sent, every one parsed, whatever the chunks looked like.`);
    server.close();
  });
});

server.listen(0, '127.0.0.1', () => {
  const client = net.connect(server.address().port, '127.0.0.1', () => {
    for (const m of messages) client.write(encode(m));
    client.end();
  });
});
