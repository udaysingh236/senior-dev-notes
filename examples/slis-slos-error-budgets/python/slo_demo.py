"""SLIs, SLOs and error budgets on one month of a checkout service, minute by minute.

The month: 30 days, 25 checkout requests a minute (1,080,000 requests), a target (SLO) of 99.9%.
Four things go wrong:
  day 3:  a 5-minute blip, 5% of requests fail
  day 10: a 20-minute outage, every request fails
  day 18: a slow leak, 0.3% of requests fail for 3 days
  always: 0.02% of requests fail in the background

The script prints the error budget, how much each problem spent, and when each alert first fires:
a naive alert (error rate over 1% in the last 5 minutes) and three burn-rate alerts.

Run: python3 slo_demo.py   (standard library only)
"""
from dataclasses import dataclass

MINUTES = 30 * 24 * 60          # 43,200 minutes in 30 days
PER_MINUTE = 25                  # requests a minute
SLO = 0.999                      # 99.9% of requests must be good
DAY = 24 * 60


@dataclass
class Incident:
    name: str
    start: int      # minute of the month
    minutes: int
    error_rate: float


INCIDENTS = [
    Incident("5-minute blip, 5% errors", 3 * DAY + 600, 5, 0.05),
    Incident("20-minute outage, 100% errors", 10 * DAY + 840, 20, 1.0),
    Incident("3-day slow leak, 0.3% errors", 18 * DAY, 3 * DAY, 0.003),
]
BACKGROUND = 0.0002


def bad_requests_per_minute() -> list[float]:
    """Expected failed requests in each minute of the month."""
    bad = [PER_MINUTE * BACKGROUND] * MINUTES
    for inc in INCIDENTS:
        for m in range(inc.start, inc.start + inc.minutes):
            bad[m] = PER_MINUTE * inc.error_rate
    return bad


def burn_rate(prefix: list[float], end: int, window: int) -> float:
    """Error rate over the last `window` minutes, divided by the allowed error rate (1 - SLO)."""
    start = max(0, end - window)
    errors = prefix[end] - prefix[start]
    requests = (end - start) * PER_MINUTE
    return (errors / requests) / (1 - SLO)


# Burn-rate alerts: (name, burn rate, long window, short window), windows in minutes.
ALERTS = [
    ("page: 14.4x over 1 h and 5 min", 14.4, 60, 5),
    ("page: 6x over 6 h and 30 min", 6.0, 360, 30),
    ("ticket: 1x over 3 days and 6 h", 1.0, 3 * DAY, 360),
]


def main() -> None:
    bad = bad_requests_per_minute()
    total = MINUTES * PER_MINUTE
    budget = total * (1 - SLO)                       # failed requests we may have this month
    print(f"Requests this month: {total:,}. SLO {SLO:.1%}: error budget = {budget:,.0f} failed requests")
    print(f"  as time: {MINUTES:,} minutes x {1 - SLO:.1%} = {MINUTES * (1 - SLO):.1f} minutes of full outage")

    quiet_minutes = MINUTES - sum(inc.minutes for inc in INCIDENTS)   # minutes with no incident
    spent_background = quiet_minutes * PER_MINUTE * BACKGROUND
    print(f"  background 0.02%: {spent_background:6.0f} failed ({spent_background / budget:4.0%} of budget)")
    for inc in INCIDENTS:
        spent = inc.minutes * PER_MINUTE * inc.error_rate
        print(f"  {inc.name:31}: {spent:6.0f} failed ({spent / budget:4.0%} of budget)")
    used = sum(bad)
    sli = 1 - used / total
    print(f"  month total: {used:,.0f} failed, SLI = {sli:.4%}, budget left = {1 - used / budget:.0%}")

    prefix = [0.0]
    for b in bad:
        prefix.append(prefix[-1] + b)

    def first_fire(check, start: int, end: int) -> str:
        for m in range(start + 1, end + 1):
            if check(m):
                return f"fires after {m - start} min"
        return "never fires"

    naive = lambda m: burn_rate(prefix, m, 5) * (1 - SLO) > 0.01       # error rate > 1% over 5 min
    print("When does each alert fire? (counted from the start of each problem)")
    for inc in INCIDENTS:
        print(f"  {inc.name}")
        window_end = inc.start + inc.minutes + 360
        print(f"    naive: errors > 1% over 5 min   {first_fire(naive, inc.start, window_end)}")
        for name, rate, long_w, short_w in ALERTS:
            check = lambda m, r=rate, lw=long_w, sw=short_w: (
                burn_rate(prefix, m, lw) >= r and burn_rate(prefix, m, sw) >= r)
            print(f"    {name:31}  {first_fire(check, inc.start, window_end)}")


if __name__ == "__main__":
    main()
