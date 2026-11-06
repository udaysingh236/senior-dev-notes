"""TOTP from scratch (RFC 4226 + RFC 6238), and three server-side verifiers.

Standard library only. Run: python3 totp.py

Sections:
  0. The RFC test vectors, as a check that hotp() and totp() are right
  1. Dynamic truncation, one byte at a time, for counter 0
  2. From the clock to the counter
  3. Naive vs windowed verifier: a code typed across a 30 s boundary
  4. Replay: the same code twice in one step
  5. Clock drift over 90 days: fixed window vs drift tracking
  6. Guessing odds for window sizes and attempt limits

The clock is passed in as a number, so nothing here sleeps.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import struct
from dataclasses import dataclass

STEP = 30  # seconds per time step (RFC 6238 default)
DIGITS = 6


# --- the algorithm ---------------------------------------------------------------------------

def hotp(secret: bytes, counter: int, digits: int = DIGITS) -> str:
    """RFC 4226: HMAC the 8-byte counter, take 4 bytes at an offset, keep the last digits."""
    mac = hmac.new(secret, struct.pack(">Q", counter), "sha1").digest()
    offset = mac[-1] & 0x0F  # low 4 bits of the last byte: 0..15
    number = int.from_bytes(mac[offset:offset + 4], "big") & 0x7FFFFFFF  # drop the top bit
    return str(number % 10**digits).zfill(digits)  # a string: keep leading zeros


def totp(secret: bytes, unix_time: float, digits: int = DIGITS) -> str:
    """RFC 6238: HOTP where the counter is the number of 30 s steps since 1970-01-01 UTC."""
    return hotp(secret, int(unix_time // STEP), digits)


def secret_from_base32(text: str) -> bytes:
    """The QR code carries the secret in Base32 without '=' padding; put the padding back."""
    text = text.replace(" ", "").upper()
    return base64.b32decode(text + "=" * (-len(text) % 8))


# --- three verifiers ------------------------------------------------------------------------

def verify_naive(secret: bytes, code: str, now: float) -> bool:
    """Accept only the code for the server's current step."""
    return hmac.compare_digest(totp(secret, now), code)


def verify_window(secret: bytes, code: str, now: float, window: int = 1) -> bool:
    """Also accept the codes of `window` steps before and after (RFC 6238, section 5.2)."""
    step = int(now // STEP)
    return any(hmac.compare_digest(hotp(secret, step + k), code) for k in range(-window, window + 1))


@dataclass
class Enrollment:
    """What the server keeps per user. In a database: one row, secret encrypted at rest."""
    secret: bytes
    last_step: int = -1  # highest step ever accepted: the replay guard
    drift: int = 0       # learned offset of the phone's clock, in steps
    failures: int = 0    # consecutive failed attempts

MAX_FAILURES = 10

def verify(e: Enrollment, code: str, now: float, window: int = 1, fallback: bool = True) -> str:
    if e.failures >= MAX_FAILURES:
        return "locked"
    server_step = int(now // STEP)
    centre = server_step + e.drift
    steps = {centre + k for k in range(-window, window + 1)}
    if fallback:  # the phone may have corrected its clock since the drift was learned
        steps |= {server_step + k for k in range(-window, window + 1)}
    for step in sorted(steps, key=lambda s: (abs(s - centre), s)):  # most likely step first
        if step <= e.last_step:
            continue  # this step, or a later one, was already used: a replay
        if hmac.compare_digest(hotp(e.secret, step), code):
            # In SQL: one conditional UPDATE ... WHERE last_step < :step (see the page)
            e.last_step, e.drift, e.failures = step, step - server_step, 0
            return "ok"
    e.failures += 1
    return "rejected"


# --- experiments ------------------------------------------------------------------------------

def section(title: str) -> None:
    print(f"\n== {title} ==")


def main() -> None:
    section("0. RFC test vectors")
    rfc_secret = b"12345678901234567890"
    got = [hotp(rfc_secret, c) for c in range(10)]
    want = ["755224", "287082", "359152", "969429", "338314",
            "254676", "287922", "162583", "399871", "520489"]
    print("RFC 4226 HOTP counters 0-9:", "ok" if got == want else f"MISMATCH {got}")
    vectors = {59: "94287082", 1111111109: "07081804", 1234567890: "89005924",
               2000000000: "69279037", 20000000000: "65353130"}
    ok = all(totp(rfc_secret, t, digits=8) == code for t, code in vectors.items())
    print("RFC 6238 TOTP SHA-1, 8 digits, 5 times:", "ok" if ok else "MISMATCH")

    section("1. Dynamic truncation, counter 0")
    mac = hmac.new(rfc_secret, struct.pack(">Q", 0), "sha1").digest()
    print("counter bytes :", struct.pack(">Q", 0).hex(" "))
    print("HMAC-SHA1     :", mac.hex(" "))
    offset = mac[-1] & 0x0F
    chunk = mac[offset:offset + 4]
    number = int.from_bytes(chunk, "big") & 0x7FFFFFFF
    print(f"last byte {mac[-1]:#04x} -> offset {offset}")
    print(f"bytes {offset}-{offset + 3}     : {chunk.hex(' ')} -> top bit cleared -> {number:,}")
    print(f"{number:,} mod 1,000,000 = {number % 10**6:06d}")

    section("2. From the clock to the counter")
    demo = secret_from_base32("ONSW42LPOJSGK5TON52GK4ZNMRSW23ZB")  # demo secret, never reuse
    now = 1793961737  # 2026-11-06 10:42:17 UTC
    print(f"unix time {now} // {STEP} = step {now // STEP}, {now % STEP} s into it")
    for t in (now, now + 12, now + 13, now + 43):
        print(f"  t = {t} (step {t // STEP}) -> {totp(demo, t)}")

    section("3. A code typed across a step boundary")
    read_at = 1793961749  # 29 s into step 59798724
    code = totp(demo, read_at)
    for delay in (0, 4, 15, 35, 65):
        arrive = read_at + delay
        print(f"  read at :{read_at % 60:02d}, arrives {delay:>2} s later -> "
              f"naive {'ok' if verify_naive(demo, code, arrive) else 'REJECTED':8} "
              f"window +-1 {'ok' if verify_window(demo, code, arrive) else 'REJECTED'}")

    section("4. Replay: the same code twice")
    e = Enrollment(demo)
    code = totp(demo, now)
    print("  first use      :", verify(e, code, now))
    print("  same code, +5 s:", verify(e, code, now + 5), " (a phished code replayed)")
    print("  window-only verifier would say:", "ok" if verify_window(demo, code, now + 5) else "rejected")

    section("5. Phone clock gains 2 s a day; the user logs in every 3 days")
    fixed_fail = tracked_fail = 0
    tracked = Enrollment(demo)
    for day in range(0, 91, 3):
        server = now + day * 86400
        phone = server + 2 * day  # the phone's clock runs ahead
        code = totp(demo, phone)
        fixed_ok = verify_window(demo, code, server)
        tracked_ok = verify(tracked, code, server) == "ok"
        fixed_fail += not fixed_ok
        tracked_fail += not tracked_ok
        if day % 15 == 0:
            print(f"  day {day:>2}: phone ahead {2 * day:>3} s -> fixed window "
                  f"{'ok' if fixed_ok else 'REJECTED':8} tracked {'ok' if tracked_ok else 'REJECTED':8}"
                  f" (learned drift {tracked.drift:+d} steps)")
    print(f"  failed logins out of 31: fixed window {fixed_fail}, drift tracking {tracked_fail}")

    print("  day 93: the phone corrects its clock (back online); learned drift is now wrong")
    no_fallback = Enrollment(demo, last_step=tracked.last_step, drift=tracked.drift)
    for attempt in (1, 2):
        server = now + 93 * 86400 + attempt * 60
        code = totp(demo, server)  # phone and server agree again
        print(f"    login {attempt}: drift only -> {verify(no_fallback, code, server, fallback=False):8}"
              f" drift + fallback -> {verify(tracked, code, server)} (drift now {tracked.drift:+d})")

    section("6. Guessing odds (6 digits)")
    for window in (0, 1, 2):
        valid = 2 * window + 1
        p = valid / 10**DIGITS
        half = math.log(2) / -math.log1p(-p)
        print(f"  window +-{window}: {valid} valid code{"s" if valid > 1 else ""}, 1 guess = {p:.4%}, "
              f"100 guesses = {1 - (1 - p) ** 100:.3%}, 50% after {half:,.0f} guesses")


if __name__ == "__main__":
    main()
