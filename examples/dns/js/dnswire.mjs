// DNS messages in wire format (RFC 1035), Node standard library only.
// Enough to build questions, parse answers from real servers, and build answers for the toy server.
// Every other file in this folder imports it.
import dgram from 'node:dgram';
import net from 'node:net';
import { randomInt } from 'node:crypto';

export const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, CAA: 257, HTTPS: 65 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
const RCODES = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
const CLASS_IN = 1;

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

// ---------- building ----------

export function encodeName(name) {
  const parts = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    if (!label) continue;
    const raw = Buffer.from(label, 'ascii');
    if (raw.length > 63) throw new Error(`label too long: ${label}`); // RFC 1035: at most 63 bytes
    parts.push(Buffer.from([raw.length]), raw);
  }
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** EDNS(0) pseudo-record: "I can receive UDP answers up to udpSize bytes" (RFC 6891). */
const optRecord = (udpSize) => Buffer.concat([Buffer.from([0]), u16(TYPES.OPT), u16(udpSize), u32(0), u16(0)]);

export function buildQuery(name, qtype = 'A', { id = randomInt(0, 0x10000), recursion = true, edns = 1232 } = {}) {
  const header = Buffer.concat([u16(id), u16(recursion ? 0x0100 : 0), u16(1), u16(0), u16(0), u16(edns ? 1 : 0)]);
  const question = Buffer.concat([encodeName(name), u16(TYPES[qtype]), u16(CLASS_IN)]);
  return { id, query: Buffer.concat([header, question, edns ? optRecord(edns) : Buffer.alloc(0)]) };
}

export const rr = (name, type, ttl, rdata) =>
  Buffer.concat([encodeName(name), u16(TYPES[type]), u16(CLASS_IN), u32(ttl), u16(rdata.length), rdata]);

/** IPv4 only: the toy server never serves AAAA records. */
export const rdataA = (ip) => Buffer.from(ip.split('.').map(Number));

export function rdataTxt(text) {
  const raw = Buffer.from(text);
  const chunks = [];
  for (let i = 0; i < raw.length; i += 255) chunks.push(raw.subarray(i, i + 255)); // strings are at most 255 bytes
  if (!chunks.length) chunks.push(Buffer.alloc(0));
  return Buffer.concat(chunks.flatMap((c) => [Buffer.from([c.length]), c]));
}

export const rdataSoa = (mname, rname, serial, refresh, retry, expire, minimum) =>
  Buffer.concat([encodeName(mname), encodeName(rname), ...[serial, refresh, retry, expire, minimum].map(u32)]);

/**
 * Answer `query`. If the answer is bigger than maxSize, send only the header and question with
 * the TC bit set, which tells the client to ask again over TCP.
 */
export function buildResponse(query, { answer = [], authority = [], rcode = 0, aa = true, maxSize = 512 } = {}) {
  const id = query.readUInt16BE(0);
  const rd = query.readUInt16BE(2) & 0x0100;
  const question = query.subarray(12, 12 + skipName(query, 12) + 4);
  const base = 0x8000 | rd | (aa ? 0x0400 : 0) | rcode;
  const full = Buffer.concat([u16(id), u16(base), u16(1), u16(answer.length), u16(authority.length), u16(0), question, ...answer, ...authority]);
  if (full.length <= maxSize) return full;
  return Buffer.concat([u16(id), u16(base | 0x0200), u16(1), u16(0), u16(0), u16(0), question]); // 0x0200 = TC
}

// ---------- parsing ----------

function skipName(data, offset) {
  const start = offset;
  for (;;) {
    const len = data[offset];
    if (len === 0) return offset + 1 - start;
    if ((len & 0xc0) === 0xc0) return offset + 2 - start; // compression pointer ends the name
    offset += 1 + len;
  }
}

/** Returns [name, offset after the name]. Follows compression pointers (RFC 1035 4.1.4). */
export function decodeName(data, offset) {
  const labels = [];
  let jumped = false;
  let end = offset;
  for (let hops = 0; ; ) {
    const len = data[offset];
    if ((len & 0xc0) === 0xc0) {
      if (++hops > 50) throw new Error('compression loop');
      if (!jumped) end = offset + 2;
      offset = ((len & 0x3f) << 8) | data[offset + 1];
      jumped = true;
      continue;
    }
    if (len === 0) return [labels.join('.') + '.', jumped ? end : offset + 1];
    labels.push(data.subarray(offset + 1, offset + 1 + len).toString('latin1'));
    offset += 1 + len;
  }
}

const ipText = (b) => (b.length === 4 ? [...b].join('.') : formatV6(b));

function formatV6(b) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  // Collapse the longest run of zero groups to "::", as the standard text form does (RFC 5952).
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best[1] && j - i > 1) best = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  if (best[0] < 0) return groups.join(':');
  return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`;
}

function svcParams(r) {
  const keys = { 1: 'alpn', 3: 'port', 4: 'ipv4hint', 5: 'ech', 6: 'ipv6hint' };
  const parts = [];
  for (let i = 0; i + 4 <= r.length; ) {
    const key = r.readUInt16BE(i);
    const len = r.readUInt16BE(i + 2);
    const v = r.subarray(i + 4, i + 4 + len);
    i += 4 + len;
    if (key === 1) {
      const ids = [];
      for (let j = 0; j < v.length; j += 1 + v[j]) ids.push(v.subarray(j + 1, j + 1 + v[j]).toString());
      parts.push(`alpn=${ids.join(',')}`);
    } else if (key === 3) parts.push(`port=${v.readUInt16BE(0)}`);
    else if (key === 4 || key === 6) {
      const size = key === 4 ? 4 : 16;
      const ips = [];
      for (let j = 0; j < v.length; j += size) ips.push(ipText(v.subarray(j, j + size)));
      parts.push(`${keys[key]}=${ips.join(',')}`);
    } else parts.push(`${keys[key] ?? `key${key}`}=<${len} bytes>`);
  }
  return parts.join(' ');
}

function value(data, type, start, length) {
  const r = data.subarray(start, start + length);
  const name = TYPE_NAMES[type] ?? String(type);
  if (name === 'A' || name === 'AAAA') return [ipText(r)];
  if (name === 'NS' || name === 'CNAME' || name === 'PTR') return [decodeName(data, start)[0]];
  if (name === 'MX') return [`${r.readUInt16BE(0)} ${decodeName(data, start + 2)[0]}`];
  if (name === 'TXT') {
    const texts = [];
    for (let i = 0; i < r.length; i += 1 + r[i]) texts.push(r.subarray(i + 1, i + 1 + r[i]).toString());
    return [texts.join(''), texts];
  }
  if (name === 'SOA') {
    const [mname, o1] = decodeName(data, start);
    const [rname, o2] = decodeName(data, o1);
    const [serial, refresh, retry, expire, minimum] = [0, 4, 8, 12, 16].map((k) => data.readUInt32BE(o2 + k));
    return [`${mname} ${rname} serial=${serial} minimum=${minimum}`, { mname, rname, serial, refresh, retry, expire, minimum }];
  }
  if (name === 'CAA') {
    const tagLen = r[1];
    return [`${r[0]} ${r.subarray(2, 2 + tagLen)} "${r.subarray(2 + tagLen)}"`];
  }
  if (name === 'HTTPS') {
    const [target, off] = decodeName(data, start + 2);
    return [`${r.readUInt16BE(0)} ${target} ${svcParams(data.subarray(off, start + length))}`.trim()];
  }
  return [r.toString('hex')];
}

export function parseMessage(data) {
  const flags = data.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((k) => data.readUInt16BE(k));
  const msg = {
    id: data.readUInt16BE(0), qr: !!(flags & 0x8000), aa: !!(flags & 0x0400), tc: !!(flags & 0x0200),
    rd: !!(flags & 0x0100), ra: !!(flags & 0x0080), rcode: RCODES[flags & 0xf] ?? String(flags & 0xf),
    question: [], answer: [], authority: [], additional: [], size: data.length,
  };
  let offset = 12;
  for (let i = 0; i < counts[0]; i++) {
    const [name, o] = decodeName(data, offset);
    msg.question.push([name, TYPE_NAMES[data.readUInt16BE(o)] ?? String(data.readUInt16BE(o))]);
    offset = o + 4;
  }
  for (const [section, count] of [[msg.answer, counts[1]], [msg.authority, counts[2]], [msg.additional, counts[3]]]) {
    for (let i = 0; i < count; i++) {
      const [name, o] = decodeName(data, offset);
      const type = data.readUInt16BE(o);
      const ttl = data.readUInt32BE(o + 4);
      const length = data.readUInt16BE(o + 8);
      offset = o + 10;
      if (type !== TYPES.OPT) {
        const [text, parsed] = value(data, type, offset, length);
        section.push({ name, type: TYPE_NAMES[type] ?? String(type), ttl, value: text, data: parsed });
      }
      offset += length;
    }
  }
  return msg;
}

/** For servers: [name, type, udp size the client can receive] from an incoming query. */
export function queryName(query) {
  const [name, offset] = decodeName(query, 12);
  const qtype = TYPE_NAMES[query.readUInt16BE(offset)] ?? '?';
  let udpSize = 512; // no EDNS: the 1987 limit
  const opt = offset + 4;
  if (query.readUInt16BE(10) && query[opt] === 0 && query.readUInt16BE(opt + 1) === TYPES.OPT) {
    udpSize = Math.max(512, query.readUInt16BE(opt + 3));
  }
  return [name.toLowerCase(), qtype, udpSize];
}

// ---------- sending ----------

/** One question, one UDP packet, one answer. Checks the ID so a stray packet is not believed. */
export function askUdp(server, port, query, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
    const timer = setTimeout(() => { sock.close(); reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); }, timeout);
    sock.on('message', (data) => {
      if (data.readUInt16BE(0) !== query.readUInt16BE(0)) return;
      clearTimeout(timer);
      sock.close();
      resolve(data);
    });
    sock.on('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
    sock.send(query, port, server);
  });
}

/** Over TCP every message is preceded by its length in two bytes (RFC 1035 4.2.2). */
export function askTcp(server, port, query, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server, port });
    let buf = Buffer.alloc(0);
    sock.setTimeout(timeout, () => sock.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    sock.on('connect', () => sock.write(Buffer.concat([u16(query.length), query])));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        sock.end();
        resolve(buf.subarray(2, 2 + buf.readUInt16BE(0)));
      }
    });
    sock.on('error', reject);
  });
}
