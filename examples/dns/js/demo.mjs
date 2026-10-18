// Shared scaffolding for the demos: a toy DNS server, pretend API servers, and a clock.
//
// The DNS traffic in every demo is real (UDP and TCP packets to the toy server on localhost). The
// API servers are pretend: a set of addresses that are "up", so we can switch the old one off.
import { setTimeout as sleep } from 'node:timers/promises';
import { ToyServer, Zone } from './toy-server.mjs';

export const OLD = '203.0.113.10'; // documentation addresses (RFC 5737), never real hosts
export const NEW = '198.51.100.20';
export const API = 'api.shop.example.test.';
export const DNS = ['127.0.0.1', 8053];

export class Fleet {
  up = new Set([OLD]);
  call(address) {
    return this.up.has(address) ? '200 OK' : 'FAILED: connection refused (nothing runs there now)';
  }
}

export class Clock {
  start = performance.now();
  now() { return (performance.now() - this.start) / 1000; }
  stamp() { return `t=${this.now().toFixed(1)}s`; }
  sleepUntil(t) { return sleep(Math.max(0, (t - this.now()) * 1000)); }
}

export async function start(apiTtl = 2) {
  const zone = new Zone({ apiTtl });
  return { zone, server: await ToyServer.start(zone, DNS[1]), fleet: new Fleet(), clock: new Clock() };
}

/** The operator's side of a move: start the new server, point DNS at it. */
export function migrate(zone, fleet, clock, ttl) {
  fleet.up.add(NEW);
  zone.set(API, 'A', [NEW], ttl);
  console.log(`${clock.stamp()}  operator: new server is up, api now points to ${NEW}`);
}

export function retireOld(fleet, clock) {
  fleet.up.delete(OLD);
  console.log(`${clock.stamp()}  operator: waited longer than the TTL, switching off the old server ${OLD}`);
}
