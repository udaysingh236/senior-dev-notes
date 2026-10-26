"""Runs one pgbench workload at a series of client counts and prints throughput, p50 and p99.

pgbench reports only the mean latency, so we ask it for a per-transaction log (-l) and compute the
percentiles from that. Called by run.sh; every argument after the label goes to pgbench as is.

Usage: python3 sweep.py <label> <clients, e.g. "1 8 64"> <log dir> <pgbench args...>
"""
import glob
import os
import subprocess
import sys

label, clients, log_dir, *pgbench_args = sys.argv[1:]
print(f"== {label}")
print(f"{'conns':>6} {'tps':>8} {'p50 ms':>8} {'p99 ms':>8}")
for c in (int(x) for x in clients.split()):
    for old in glob.glob(f"{log_dir}/tx*"):
        os.remove(old)
    out = subprocess.run(
        ["pgbench", "-n", "-T", "15", "-c", str(c), "-j", str(min(c, 4)),
         "-l", f"--log-prefix={log_dir}/tx", *pgbench_args],
        capture_output=True, text=True, check=True,
    )
    tps = float(next(line for line in out.stdout.splitlines() if line.startswith("tps")).split()[2])
    # Third field of each log line is the transaction's latency in microseconds.
    latencies = sorted(int(line.split()[2]) / 1000
                       for path in glob.glob(f"{log_dir}/tx*") for line in open(path))
    pct = lambda p: latencies[min(len(latencies) - 1, int(p * len(latencies)))]
    print(f"{c:>6} {tps:>8.0f} {pct(0.50):>8.1f} {pct(0.99):>8.1f}", flush=True)
