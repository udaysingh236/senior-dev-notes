// TIME-WAIT lands on whichever side closes first, and connection reuse makes it disappear.
//
// A tiny server on 127.0.0.1 answers each 4-byte request with "OK\n". We make 500 requests three
// ways and then count the sockets left in TIME_WAIT for that server's port, by reading
// /proc/net/tcp (Linux only; on Windows or macOS run it in WSL or a container).
//
// Run: node time-wait.mjs
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';

const REQUESTS = 500;
const TIME_WAIT = '06'; // the state code in /proc/net/tcp

/** Count TIME_WAIT sockets for one server port, split by which side holds them. */
function timeWaitSockets(serverPort) {
  const counts = { 'client side': 0, 'server side': 0 };
  for (const line of readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== TIME_WAIT) continue;
    const localPort = parseInt(fields[1].split(':')[1], 16);
    const remotePort = parseInt(fields[2].split(':')[1], 16);
    if (localPort === serverPort) counts['server side']++;
    else if (remotePort === serverPort) counts['client side']++;
  }
  return counts;
}

async function startServer(serverClosesFirst) {
  const server = net.createServer((conn) => {
    // Requests are 4 bytes and the client waits for each answer, so one 'data' is one request.
    conn.on('data', () => {
      if (serverClosesFirst) conn.end('OK\n'); // answer, then close: the HTTP/1.0 way
      else conn.write('OK\n');
    });
    conn.on('end', () => conn.end()); // the client closed first, and we close second
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

/** Sends one request and resolves when its 3-byte answer is in. */
function request(socket) {
  socket.write('GET\n');
  return once(socket, 'data');
}

async function requestPerConnection(port, serverClosesFirst) {
  for (let i = 0; i < REQUESTS; i++) {
    const socket = net.connect(port, '127.0.0.1');
    await request(socket);
    if (serverClosesFirst) await once(socket, 'end'); // the server's FIN; Node then closes our side
    else socket.end();
    await once(socket, 'close');
  }
}

async function oneConnectionForAll(port) {
  const socket = net.connect(port, '127.0.0.1');
  for (let i = 0; i < REQUESTS; i++) await request(socket);
  socket.end();
  await once(socket, 'close');
}

async function run(label, serverClosesFirst, client) {
  const server = await startServer(serverClosesFirst);
  const { port } = server.address();
  await client(port, serverClosesFirst);
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the last close finish
  console.log(`${label.padEnd(40)} TIME_WAIT ${JSON.stringify(timeWaitSockets(port))}`);
  server.close();
}

await run('client closes first, 500 connections', false, requestPerConnection);
await run('server closes first, 500 connections', true, requestPerConnection);
await run('one connection reused for 500 requests', false, oneConnectionForAll);

const [low, high] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
const ports = high - low + 1;
console.log(`\nephemeral ports ${low}-${high}: ${ports}. Linux keeps TIME_WAIT for 60 s, so one client`);
console.log(`can open at most about ${Math.floor(ports / 60)} new connections a second to one server address and port.`);
