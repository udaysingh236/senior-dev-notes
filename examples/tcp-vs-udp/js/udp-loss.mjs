// UDP loses datagrams even on your own machine, and nobody tells you.
//
// A sender fires 5,000 numbered datagrams of 1,000 bytes as fast as it can. The receiver, in its
// own worker thread, does 0.2 ms of work per datagram, so it falls behind. When its socket's
// receive buffer is full, the kernel drops new datagrams on the floor. No error reaches either
// side. The sequence numbers we added are the only way to notice. A second run paces the sender
// below the receiver's speed.
//
// Run: node udp-loss.mjs
import dgram from 'node:dgram';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const HOST = '127.0.0.1';
const COUNT = 5000;
const SIZE = 1000;

function busy(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

if (!isMainThread) {
  // ----- the receiver -----
  const sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 64 * 1024 }); // small, but real
  let expected = 0, received = 0, gaps = 0, reordered = 0, last = 0;
  const check = setInterval(() => {
    if (!last || performance.now() - last < 1000) return; // a second of silence: the sender has finished
    clearInterval(check);
    parentPort.postMessage({ received, gaps, reordered });
    sock.close();
  }, 100);
  sock.on('message', (data) => {
    const seq = data.readUInt32BE(0);
    received++;
    if (seq > expected) gaps++; // one or more datagrams before this one never arrived (yet)
    else if (seq < expected) reordered++;
    expected = Math.max(expected, seq + 1);
    busy(0.2); // 0.2 ms of "work" per datagram: at most 5,000 per second
    last = performance.now();
  });
  sock.bind(0, HOST, () => parentPort.postMessage({ port: sock.address().port }));
} else {
  // ----- the sender -----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run(rate) {
    const worker = new Worker(new URL(import.meta.url));
    const port = await new Promise((r) => worker.once('message', (m) => r(m.port)));
    const result = new Promise((r) => worker.once('message', r));
    const tx = dgram.createSocket('udp4');
    let errors = 0;
    const start = performance.now();
    for (let seq = 0; seq < COUNT; seq++) {
      const packet = Buffer.alloc(SIZE);
      packet.writeUInt32BE(seq);
      tx.send(packet, port, HOST, (err) => err && errors++); // queued at once, never waits for the receiver
      if (rate && seq % 40 === 39) await sleep(Math.max(0, start + ((seq + 1) / rate) * 1000 - performance.now()));
      else if (seq % 500 === 499) await sleep(0); // let queued sends go out
    }
    await sleep(0);
    const elapsed = performance.now() - start;
    const { received, gaps, reordered } = await result;
    tx.close();
    const lost = COUNT - received;
    console.log(rate ? `paced to ${rate.toLocaleString('en')} per second:` : 'full speed:');
    console.log(`sender:   ${COUNT} datagrams sent in ${elapsed.toFixed(0)} ms, ${errors} send errors`);
    console.log(`receiver: ${received} received, ${lost} lost (${Math.round((lost / COUNT) * 100)}%), ${gaps} gaps, ${reordered} out of order`);
  }

  await run(null);
  console.log();
  await run(3000); // well below the receiver's 5,000 per second
  console.log('\nNobody got an error about lost datagrams. Only the sequence numbers show the gaps,');
  console.log('and only the sender slowing down prevented them. UDP will not slow down for you.');
}
