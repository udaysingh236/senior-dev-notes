// A tiny authoritative DNS server for the zone shop.example.test, on 127.0.0.1:8053.
//
// It answers over UDP and TCP, sends NXDOMAIN and NODATA with the zone's SOA (so resolvers can
// cache "no"), sets the TC bit when an answer does not fit in UDP, and lets the demos change
// records or "go down" while it runs. .test is reserved for testing (RFC 6761), so this can never
// clash with a real name.
//
// Run it on its own and query it:
//   node toy-server.mjs
//   nslookup -port=8053 api.shop.example.test 127.0.0.1
import dgram from 'node:dgram';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import * as w from './dnswire.mjs';

export const ZONE = 'shop.example.test.';
const SOA_MINIMUM = 5; // seconds: how long others may cache "no such name" (RFC 2308). Real zones: 300-3600.

export class Zone {
  constructor({ apiTtl = 2 } = {}) {
    this.down = false; // true: drop every query, as if the server were unreachable
    this.queries = 0;
    // name -> type -> [ttl, values]
    this.records = new Map([
      [ZONE, { NS: [86400, [`ns1.${ZONE}`]] }],
      [`ns1.${ZONE}`, { A: [86400, ['127.0.0.1']] }],
      [`api.${ZONE}`, { A: [apiTtl, ['203.0.113.10']] }],
      [`www.${ZONE}`, { CNAME: [3600, [`api.${ZONE}`]] }],
      // 12 long strings, about 2.4 KB: too big for one UDP answer, so it forces TCP.
      [`big.${ZONE}`, { TXT: [60, Array.from({ length: 12 }, (_, i) => `chunk ${String(i).padStart(2, '0')} ` + 'x'.repeat(190))] }],
    ]);
  }

  set(name, type, values, ttl) {
    this.records.set(name, { ...(this.records.get(name) ?? {}), [type]: [ttl, values] });
  }

  soa() {
    const rdata = w.rdataSoa(`ns1.${ZONE}`, `hostmaster.${ZONE}`, Math.floor(Date.now() / 1000), 3600, 600, 86400, SOA_MINIMUM);
    return w.rr(ZONE, 'SOA', SOA_MINIMUM, rdata);
  }

  answer(query, maxSize) {
    let [name, qtype] = w.queryName(query);
    this.queries++;
    if (!name.endsWith(ZONE)) return w.buildResponse(query, { rcode: 5, aa: false, maxSize }); // REFUSED: not our zone
    let node = this.records.get(name);
    if (!node) return w.buildResponse(query, { authority: [this.soa()], rcode: 3, maxSize }); // NXDOMAIN
    const answer = [];
    if (node.CNAME && qtype !== 'CNAME') { // an alias: answer with the alias and its target
      const [ttl, [target]] = node.CNAME;
      answer.push(w.rr(name, 'CNAME', ttl, w.encodeName(target)));
      [name, node] = [target, this.records.get(target) ?? {}];
    }
    if (node[qtype]) {
      const [ttl, values] = node[qtype];
      for (const v of values) {
        const data = qtype === 'A' ? w.rdataA(v) : qtype === 'TXT' ? w.rdataTxt(v) : w.encodeName(v);
        answer.push(w.rr(name, qtype, ttl, data));
      }
    }
    if (!answer.length) return w.buildResponse(query, { authority: [this.soa()], maxSize }); // NODATA
    return w.buildResponse(query, { answer, maxSize });
  }
}

export class ToyServer {
  static async start(zone, port = 8053, host = '127.0.0.1') {
    const server = new ToyServer();
    server.udp = dgram.createSocket('udp4');
    server.udp.on('message', (data, from) => {
      if (zone.down) return;
      server.udp.send(zone.answer(data, w.queryName(data)[2]), from.port, from.address);
    });
    server.tcp = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (zone.down || buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
        const reply = zone.answer(buf.subarray(2, 2 + buf.readUInt16BE(0)), 65535);
        const len = Buffer.alloc(2);
        len.writeUInt16BE(reply.length);
        sock.end(Buffer.concat([len, reply]));
      });
      sock.on('error', () => {});
    });
    await new Promise((ok, fail) => server.udp.once('error', fail).bind(port, host, ok));
    await new Promise((ok, fail) => server.tcp.once('error', fail).listen(port, host, ok));
    return server;
  }

  close() {
    this.udp.close();
    this.tcp.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ToyServer.start(new Zone({ apiTtl: 60 }));
  console.log(`authoritative for ${ZONE} on 127.0.0.1:8053 (UDP and TCP). Ctrl+C to stop.`);
  console.log('try: nslookup -port=8053 api.shop.example.test 127.0.0.1');
}
