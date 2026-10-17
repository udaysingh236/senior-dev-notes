// A small page-load probe: time every step, put a timeout on every step, and when something
// fails, say which step failed and what a browser would have shown.
//
// Node 20+, no dependencies. Run:  node probe.mjs [url ...]
//
// With no arguments it probes a healthy site and five broken ones, one per step that can fail.
// This is the shape of the checks that uptime monitors and synthetic tests run in production.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

const TIMEOUTS = { dns: 3000, connect: 3000, tls: 5000, response: 10000 }; // ms, per step

class StepFailed extends Error {
  constructor(step, reason, browserSays) {
    super(reason);
    Object.assign(this, { step, reason, browserSays });
  }
}

/** Rejects with `onTimeout()` if the promise has not settled after `ms`. */
function within(ms, promise, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(onTimeout()), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolve(host) {
  try {
    return await within(TIMEOUTS.dns, lookup(host, { all: true, order: 'ipv6first' }),
      () => new StepFailed('dns', 'resolver did not answer', 'DNS_PROBE_FINISHED_NO_INTERNET'));
  } catch (err) {
    if (err instanceof StepFailed) throw err;
    throw new StepFailed('dns', 'no such name', 'DNS_PROBE_FINISHED_NXDOMAIN');
  }
}

/** Try each address in turn (browsers race IPv6 and IPv4 instead: "Happy Eyeballs"). */
async function connect(addresses, port) {
  let last = new StepFailed('connect', 'no addresses', 'ERR_NAME_NOT_RESOLVED');
  for (const { address } of addresses) {
    const sock = net.connect({ host: address, port });
    try {
      await within(TIMEOUTS.connect, new Promise((ok, fail) => sock.once('connect', ok).once('error', fail)),
        () => new StepFailed('connect', `no answer from ${address}`, 'ERR_CONNECTION_TIMED_OUT'));
      return sock;
    } catch (err) {
      sock.destroy();
      last = err instanceof StepFailed ? err
        : new StepFailed('connect', `${address} refused`, 'ERR_CONNECTION_REFUSED');
    }
  }
  throw last;
}

async function handshake(socket, host) {
  const sock = tls.connect({ socket, servername: host });
  const browser = { CERT_HAS_EXPIRED: 'NET::ERR_CERT_DATE_INVALID', ERR_TLS_CERT_ALTNAME_INVALID: 'NET::ERR_CERT_COMMON_NAME_INVALID' };
  try {
    await within(TIMEOUTS.tls, new Promise((ok, fail) => sock.once('secureConnect', ok).once('error', fail)),
      () => new StepFailed('tls', 'handshake timed out', 'ERR_TIMED_OUT'));
    return sock;
  } catch (err) {
    sock.destroy();
    if (err instanceof StepFailed) throw err;
    throw new StepFailed('tls', err.reason ?? err.message, browser[err.code] ?? 'NET::ERR_CERT_INVALID');
  }
}

export async function probe(url) {
  const result = { url, timings: {}, status: '', failure: null };
  const { hostname: host, port, pathname } = new URL(url);
  const timed = async (step, fn) => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      result.timings[step] = performance.now() - t;
    }
  };

  try {
    const addresses = await timed('dns', () => resolve(host));
    const socket = await timed('connect', () => connect(addresses, Number(port) || 443));
    const sock = await timed('tls', () => handshake(socket, host));
    const first = await timed('first byte', () => {
      sock.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      return within(TIMEOUTS.response, new Promise((ok) => sock.once('data', ok)),
        () => new StepFailed('response', 'no response', 'ERR_TIMED_OUT'));
    });
    sock.destroy();
    result.status = first.toString('latin1').split('\r\n', 1)[0];
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    result.failure = err;
  }
  return result;
}

function report({ url, timings, status, failure }) {
  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  const steps = Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join('  ');
  console.log(`${url}\n  ${steps}  (total ${total.toFixed(0)} ms)`);
  if (failure) console.log(`  FAILED at ${failure.step}: ${failure.reason}  -> a browser shows ${failure.browserSays}\n`);
  else console.log(`  OK: ${status}\n`);
}

const DEFAULT_TARGETS = [
  'https://example.com/',
  'https://no-such-host.invalid/', // .invalid is reserved: it never resolves (RFC 6761)
  'https://10.255.255.1/', // a private address nothing answers on
  'https://127.0.0.1:9/', // our own machine, a port nothing listens on
  'https://expired.badssl.com/', // public test site with an expired certificate
  'https://wrong.host.badssl.com/', // certificate for a different name
];

for (const target of process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS) {
  report(await probe(target));
}
