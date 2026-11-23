"""Back-of-the-envelope estimate for a chat app, three ways.

Run: python3 estimate.py
All inputs are illustrative assumptions, written down at the top on purpose.
"""

SECONDS_PER_DAY = 24 * 60 * 60  # 86,400
DAYS_PER_YEAR = 365

# --- Assumptions: every estimate starts with a short, written list -----------------
DAILY_USERS = 10_000_000       # people who open the app on a given day
SENDS_PER_USER = 40            # messages each one sends a day
FETCHES_PER_USER = 100         # times each one opens a chat or scrolls (one request each)
MESSAGE_BYTES = 200            # one stored message: text plus ids, time, index share
MESSAGES_PER_FETCH = 50        # one fetch returns up to 50 messages
PEAK_FACTOR = 3                # busiest hour vs the day's average (illustrative)
COPIES = 3                     # replicas of every message
REQS_PER_SERVER = 1_000        # what one app server serves at a safe 60% busy


def naive() -> None:
    """Average only, and bytes mixed up with bits: both classic mistakes."""
    requests_per_day = DAILY_USERS * (SENDS_PER_USER + FETCHES_PER_USER)
    per_second = requests_per_day / SECONDS_PER_DAY
    servers = per_second / REQS_PER_SERVER
    out_bytes_per_s = DAILY_USERS * FETCHES_PER_USER / SECONDS_PER_DAY * MESSAGES_PER_FETCH * MESSAGE_BYTES
    print("Naive (average traffic, bytes read as bits):")
    print(f"  {per_second:,.0f} requests/s -> {servers:,.0f} servers")
    print(f"  outgoing data: {out_bytes_per_s / 1e6:,.0f} Mbit/s   <- wrong: that number was MB/s")


def careful() -> None:
    """Peak traffic, units carried on every line, copies counted."""
    sends_per_day = DAILY_USERS * SENDS_PER_USER
    fetches_per_day = DAILY_USERS * FETCHES_PER_USER
    avg = (sends_per_day + fetches_per_day) / SECONDS_PER_DAY
    peak = avg * PEAK_FACTOR
    servers = peak / REQS_PER_SERVER
    peak_fetches = fetches_per_day / SECONDS_PER_DAY * PEAK_FACTOR
    out_bytes = peak_fetches * MESSAGES_PER_FETCH * MESSAGE_BYTES
    per_day_gb = sends_per_day * MESSAGE_BYTES / 1e9
    per_year_tb = per_day_gb * DAYS_PER_YEAR / 1e3
    per_year_tb_all_copies = per_year_tb * COPIES
    print("\nCareful (peak, units, copies):")
    print(f"  messages sent per day:    {sends_per_day:,}")
    print(f"  requests per day:         {sends_per_day + fetches_per_day:,}")
    print(f"  average requests/s:       {avg:,.0f}")
    print(f"  peak requests/s (x{PEAK_FACTOR}):    {peak:,.0f}")
    print(f"  app servers at peak:      {servers:,.0f}")
    print(f"  outgoing data at peak:    {out_bytes / 1e6:,.0f} MB/s = {out_bytes * 8 / 1e9:,.1f} Gbit/s")
    print(f"  new data per day:         {per_day_gb:,.0f} GB (one copy)")
    print(f"  new data per year:        {per_year_tb:,.1f} TB (one copy), "
          f"{per_year_tb_all_copies:,.1f} TB with {COPIES} copies")


def in_your_head() -> None:
    """The same estimate with round numbers: 86,400 s becomes 100,000 s."""
    per_second = 10e6 * 140 / 1e5      # 1.4 billion requests a day / 100,000 s
    print("\nIn your head (a day is about 100,000 s):")
    print(f"  {per_second:,.0f} requests/s average, {per_second * 3:,.0f} at peak, "
          f"{per_second * 3 / 1000:,.0f} servers")


def with_ranges() -> None:
    """Production-shaped: each guess gets a low and a high; see which one moves the answer."""
    low = {"users": 8e6, "sends": 20, "fetches": 60, "peak": 2}
    high = {"users": 12e6, "sends": 60, "fetches": 150, "peak": 5}
    base = {"users": 10e6, "sends": 40, "fetches": 100, "peak": 3}

    def servers(a: dict[str, float]) -> float:
        return a["users"] * (a["sends"] + a["fetches"]) / SECONDS_PER_DAY * a["peak"] / REQS_PER_SERVER

    print("\nWith ranges (servers at peak):")
    print(f"  low {servers(low):,.0f}, likely {servers(base):,.0f}, high {servers(high):,.0f}")
    for name in base:
        lo, hi = servers({**base, name: low[name]}), servers({**base, name: high[name]})
        print(f"  only '{name}' uncertain: {lo:,.0f} to {hi:,.0f}")


if __name__ == "__main__":
    naive()
    careful()
    in_your_head()
    with_ranges()
