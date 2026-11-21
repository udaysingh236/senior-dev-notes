"""How much does one log line cost? Measured, not guessed.

Writes 100,000 lines to a file in a temporary folder with:
  - plain text through the logging module
  - JSON through the logging module (the formatter from logging_demo.py)
and times a DEBUG call when DEBUG is switched off, with and without building an expensive message.

Run: python3 bench.py
"""
import json
import logging
import os
import tempfile
import time

N = 100_000


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        event = {"time": record.created, "level": record.levelname, "service": record.name,
                 "request_id": "req-9c21", "msg": record.getMessage()}
        event.update(getattr(record, "fields", {}))
        return json.dumps(event)


def file_logger(name: str, path: str, formatter: logging.Formatter) -> tuple[logging.Logger, logging.Handler]:
    log = logging.getLogger(name)
    log.propagate = False
    log.setLevel(logging.INFO)
    handler = logging.FileHandler(path)
    handler.setFormatter(formatter)
    log.addHandler(handler)
    return log, handler


def time_lines(log: logging.Logger, structured: bool) -> float:
    start = time.perf_counter()
    for i in range(N):
        if structured:
            log.info("card charged", extra={"fields": {"order_id": 1042 + i, "amount_inr": 1499, "took_ms": 180}})
        else:
            log.info("card charged order_id=%s amount_inr=%s took_ms=%s", 1042 + i, 1499, 180)
    return (time.perf_counter() - start) * 1_000_000 / N  # microseconds per line


def cart_summary() -> str:
    """Stands in for an expensive message: formatting a big object."""
    return json.dumps({"items": [{"sku": f"SKU-{i}", "qty": 1} for i in range(200)]})


def main() -> None:
    with tempfile.TemporaryDirectory() as d:
        for name, structured, fmt in [
            ("text", False, logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")),
            ("json", True, JsonFormatter()),
        ]:
            path = os.path.join(d, f"{name}.log")
            log, handler = file_logger(name, path, fmt)
            us = time_lines(log, structured)
            handler.close()
            size = os.path.getsize(path) / N
            print(f"  {name:4}: {us:5.1f} microseconds per line, {size:4.0f} bytes per line")

        quiet = logging.getLogger("quiet")
        quiet.setLevel(logging.INFO)  # DEBUG is off
        calls = 2_000
        start = time.perf_counter()
        for _ in range(calls):
            quiet.debug(f"cart: {cart_summary()}")           # the message is built anyway
        eager = (time.perf_counter() - start) * 1_000_000 / calls
        start = time.perf_counter()
        for _ in range(calls):
            if quiet.isEnabledFor(logging.DEBUG):           # checked first, so nothing is built
                quiet.debug("cart: %s", cart_summary())
        lazy = (time.perf_counter() - start) * 1_000_000 / calls
        print(f"  debug off, message built anyway: {eager:6.1f} microseconds per call")
        print(f"  debug off, level checked first:  {lazy:6.2f} microseconds per call")


if __name__ == "__main__":
    main()
