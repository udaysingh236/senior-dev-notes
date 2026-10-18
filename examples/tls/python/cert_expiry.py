"""A certificate expiry monitor: the check behind most avoided TLS outages.

For each endpoint: connect with full verification (exactly as clients will), read the validity
dates, and raise an alert when renewal is overdue rather than when expiry is near. Healthy
automation renews at about two-thirds of the lifetime, so a certificate past that point means the
automation is broken, while there is still time to fix it. Exit code 2 = page someone.
Standard library only. Run it from cron or a monitoring system.
"""

import socket
import ssl
import sys
import time

TARGETS = [
    "example.com",
    "github.com",
    "letsencrypt.org",
    "expired.badssl.com",
    "wrong.host.badssl.com",
    "untrusted-root.badssl.com",
]
CRITICAL_DAYS = 7  # whatever the lifetime, under a week left is an emergency


def check(host: str, port: int = 443) -> tuple[str, str]:
    context = ssl.create_default_context()  # the system trust store, like a real client
    try:
        with socket.create_connection((host, port), timeout=5) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                cert = tls.getpeercert()
    except ssl.SSLCertVerificationError as err:
        return "CRIT", f"verification failed: {err.verify_message}"
    except (OSError, ssl.SSLError) as err:
        return "CRIT", f"cannot connect: {err}"

    start = ssl.cert_time_to_seconds(cert["notBefore"])
    end = ssl.cert_time_to_seconds(cert["notAfter"])
    lifetime = (end - start) / 86400
    left = (end - time.time()) / 86400
    issuer = dict(item[0] for item in cert["issuer"]).get("organizationName", "?")
    detail = f"{left:5.0f} of {lifetime:3.0f} days left, issuer {issuer}"

    if left < CRITICAL_DAYS:
        return "CRIT", detail
    if left < lifetime / 3:  # renewal should have happened by now
        return "WARN", detail + " (renewal overdue)"
    return "OK", detail


def main() -> int:
    worst = 0
    for host in TARGETS:
        status, detail = check(host)
        worst = max(worst, {"OK": 0, "WARN": 1, "CRIT": 2}[status])
        print(f"{status:<5}{host:<27}{detail}")
    return worst


if __name__ == "__main__":
    sys.exit(main())
