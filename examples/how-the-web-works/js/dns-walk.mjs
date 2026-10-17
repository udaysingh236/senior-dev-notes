// Resolve a name the way a recursive resolver does: start at a root server and follow referrals.
//
// Node 20+, no dependencies. Run:  node dns-walk.mjs [name]   (default: example.com)
//
// Your laptop never does this. It asks one recursive resolver (your ISP's, your office's, 1.1.1.1
// or 8.8.8.8), and that resolver does the walk below, then caches every answer for its TTL.
// This script builds raw DNS packets (RFC 1035) and sends them over UDP port 53, so you can see
// each hop: root -> top-level domain -> the domain's own name servers.
import dgram from 'node:dgram';

const ROOT = ['a.root-servers.net', '198.41.0.4']; // one of the 13 root server identities, A to M
const TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 28: 'AAAA' };

function buildQuery(name, qtype = 1) {
  const id = Math.floor(Math.random() * 0x10000);
  // Header: id, flags = 0 (a plain query; "recursion desired" off, because WE do the walk),
  // then one question and no answer, authority or additional records.
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4);
  const labels = name.replace(/\.$/, '').split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2); // class 1 = IN (internet)
  return { id, packet: Buffer.concat([header, ...labels, Buffer.from([0]), tail]) };
}

/** Names are length-prefixed labels; a byte starting 0b11 points back to an earlier name. */
function readName(msg, pos) {
  const labels = [];
  let end = null;
  for (let len; (len = msg[pos]) !== 0; ) {
    if (len >= 0xc0) {
      end ??= pos + 2;
      pos = msg.readUInt16BE(pos) & 0x3fff;
      continue;
    }
    labels.push(msg.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join('.') + '.', end ?? pos + 1];
}

function ipv6(data) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(data.readUInt16BE(i).toString(16));
  return groups.join(':'); // uncompressed form, e.g. 2606:4700:0:0:0:0:6810:85e5
}

function parse(msg) {
  const counts = [4, 6, 8, 10].map((o) => msg.readUInt16BE(o));
  let pos = 12;
  for (let i = 0; i < counts[0]; i++) pos = readName(msg, pos)[1] + 4; // skip the question we sent
  const sections = { answer: [], authority: [], additional: [] };
  Object.keys(sections).forEach((section, s) => {
    for (let i = 0; i < counts[s + 1]; i++) {
      let name;
      [name, pos] = readName(msg, pos);
      const [rtype, ttl, size] = [msg.readUInt16BE(pos), msg.readUInt32BE(pos + 4), msg.readUInt16BE(pos + 8)];
      pos += 10;
      const data = msg.subarray(pos, pos + size);
      const value = rtype === 1 ? [...data].join('.')
        : rtype === 28 ? ipv6(data)
        : rtype === 2 || rtype === 5 ? readName(msg, pos)[0]
        : `(${size} bytes)`;
      sections[section].push([name, TYPES[rtype] ?? String(rtype), ttl, value]);
      pos += size;
    }
  });
  return sections;
}

function ask(serverIp, name) {
  const { id, packet } = buildQuery(name);
  const sock = dgram.createSocket('udp4');
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (sock.close(), reject(new Error(`${serverIp} did not answer`))), 3000);
    sock.on('message', (reply) => {
      clearTimeout(timer);
      sock.close();
      if (reply.readUInt16BE(0) !== id) return reject(new Error('reply does not match our question'));
      resolve([parse(reply), performance.now() - started]);
    });
    sock.send(packet, 53, serverIp);
  });
}

async function walk(name, depth = 0) {
  let [serverName, serverIp] = ROOT;
  const indent = '    '.repeat(depth);
  for (let hop = 1; hop < 10; hop++) {
    const [reply, rtt] = await ask(serverIp, name);
    console.log(`${indent}${hop}. asked ${serverName} (${serverIp}) about ${name}: ${rtt.toFixed(0)} ms`);
    for (const [owner, rtype, ttl, value] of reply.answer) {
      console.log(`${indent}   answer: ${owner} ${rtype} ${value}  (cache for ${ttl} s)`);
      if (rtype === 'A') return value;
      if (rtype === 'CNAME') return walk(value, depth); // an alias: start again for the real name
    }
    const referral = reply.authority.filter((r) => r[1] === 'NS');
    if (!referral.length) throw new Error(`${name}: no answer and no referral`);
    const [zone, , ttl] = referral[0];
    const names = referral.map((r) => r[3]);
    console.log(`${indent}   referral: ask the ${zone} servers, e.g. ${names.slice(0, 2).join(', ')}  (cache for ${ttl} s)`);
    const glue = Object.fromEntries(reply.additional.filter((r) => r[1] === 'A').map((r) => [r[0], r[3]]));
    serverName = names.find((n) => n in glue) ?? names[0];
    // "Glue" is the address of a name server, sent along so we don't have to look it up.
    // Without it, we must resolve the name server's own name first.
    serverIp = glue[serverName] ?? (await walk(serverName, depth + 1));
  }
  throw new Error('too many hops');
}

const target = process.argv[2] ?? 'example.com';
const started = performance.now();
const address = await walk(target);
console.log(`\n${target} is at ${address}, found in ${(performance.now() - started).toFixed(0)} ms from a cold start`);
