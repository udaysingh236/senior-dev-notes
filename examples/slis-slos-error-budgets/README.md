# SLIs, SLOs and error budgets examples

Code behind the snippets on the [SLIs, SLOs and Error Budgets](https://seniordevnotes.in/observability/slis-slos-error-budgets/) page.
Python 3.11+ and Node 20+, standard library only. Both print exactly the same output.

| File | What it shows | Run |
|---|---|---|
| `python/slo_demo.py` | one month of a checkout service at 99.9%: the error budget, what each problem spent, and when a naive alert and three burn-rate alerts fire | `python3 python/slo_demo.py` |
| `js/slo-demo.mjs` | the same, in JavaScript | `node js/slo-demo.mjs` |

The month is made up (illustrative), and the counts are expected values, not random, so every run
prints the same numbers. The `BudgetMonth` diagram on the page was drawn from this script's data.
