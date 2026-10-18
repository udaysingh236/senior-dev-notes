// A certificate expiry monitor: the check behind most avoided TLS outages.
//
// For each endpoint: connect with full verification (exactly as clients will), read the validity
// dates, and raise an alert when renewal is overdue rather than when expiry is near. Healthy
// automation renews at about two-thirds of the lifetime, so a certificate past that point means the
// automation is broken, while there is still time to fix it. Exit code 2 = page someone.
// Standard library only. Run it from cron or a monitoring system.
import tls from 'node:tls';

const TARGETS = [
  'example.com',
  'github.com',
  'letsencrypt.org',
  'expired.badssl.com',
  'wrong.host.badssl.com',
  'untrusted-root.badssl.com',
];
const CRITICAL_DAYS = 7; // whatever the lifetime, under a week left is an emergency
const DAY = 86_400_000;

function check(host, port = 443) {
  return new Promise((resolve) => {
    // Node's default trust store (Mozilla's roots), like a real client
    const socket = tls.connect({ host, port, servername: host, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const [start, end] = [Date.parse(cert.valid_from), Date.parse(cert.valid_to)];
      const lifetime = (end - start) / DAY;
      const left = (end - Date.now()) / DAY;
      const detail = `${left.toFixed(0).padStart(5)} of ${lifetime.toFixed(0).padStart(3)} days left, issuer ${cert.issuer.O ?? '?'}`;
      if (left < CRITICAL_DAYS) resolve(['CRIT', detail]);
      else if (left < lifetime / 3) resolve(['WARN', `${detail} (renewal overdue)`]); // should have renewed by now
      else resolve(['OK', detail]);
    });
    socket.once('timeout', () => socket.destroy(new Error('timed out')));
    socket.once('error', (err) =>
      resolve(['CRIT', err.code?.startsWith('ERR_TLS') || /CERT|SIGNATURE|ISSUER/.test(err.code ?? '')
        ? `verification failed: ${err.code}`
        : `cannot connect: ${err.message || err.errors?.map((e) => e.code).join(', ') || err.code}`])); // AggregateError (IPv6 + IPv4 both failed) has no message
  });
}

let worst = 0;
for (const host of TARGETS) {
  const [status, detail] = await check(host);
  worst = Math.max(worst, { OK: 0, WARN: 1, CRIT: 2 }[status]);
  console.log(`${status.padEnd(5)}${host.padEnd(27)}${detail}`);
}
process.exitCode = worst;
