# Logging examples

Code behind the snippets on the [Logging](https://seniordevnotes.in/observability/logging/) page.
Python 3.11+ and Node 20+, standard library only.

| File | What it shows | Run |
|---|---|---|
| `python/logging_demo.py` | free text vs JSON lines with a request ID; redacting secrets; a 20 ms-per-line destination, blocking vs a bounded queue that drops | `python3 python/logging_demo.py` |
| `js/logging-demo.mjs` | the same, in JavaScript (`AsyncLocalStorage` carries the request ID) | `node js/logging-demo.mjs` |
| `python/bench.py` | measured cost of one log line (text vs JSON) and of a DEBUG message built while DEBUG is off | `python3 python/bench.py` |

Output of `python/bench.py` on one laptop (Python 3.13, November 2026); yours will differ a little:

```
  text:   6.1 microseconds per line,   90 bytes per line
  json:   7.4 microseconds per line,  169 bytes per line
  debug off, message built anyway:   56.1 microseconds per call
  debug off, level checked first:    0.04 microseconds per call
```

The timestamps in the demo output are the real time of your run, so they differ every time. The
slow-destination numbers are real timings too and will differ a little.
