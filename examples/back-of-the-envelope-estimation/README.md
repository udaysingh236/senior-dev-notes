# Back-of-the-envelope estimation examples

Code behind the snippets on the [Back-of-the-Envelope Estimation](https://seniordevnotes.in/foundations/back-of-the-envelope-estimation/) page.
Python 3.11+ and Node 20+, standard library only. Both print exactly the same output.

| File | What it shows | Run |
|---|---|---|
| `python/estimate.py` | a chat app with 10 million daily users, estimated four ways: naive (average traffic, bits and bytes mixed up), careful (peak, units, copies), in your head with round numbers, and with low/high ranges to find the assumption that matters most | `python3 python/estimate.py` |
| `js/estimate.mjs` | the same, in JavaScript | `node js/estimate.mjs` |

Every input is an illustrative assumption, listed at the top of each file.
