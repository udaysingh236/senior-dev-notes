# SLIs, SLOs and error budgets — research notes

Track: observability, order 6, slug `slis-slos-error-budgets`. Single-topic page.
Researched November 2026. Alerting, incident response and the observability overview have their
own planned pages.

## Key facts (with sources)

- Google Cloud Monitoring: request-based SLOs count good requests ÷ total requests; windows-based
  SLOs count good measurement intervals ÷ total intervals. Burn-rate alerting uses the
  `select_slo_burn_rate` selector; Google suggests a fast-burn and a slow-burn policy together.
  — docs.cloud.google.com/monitoring/service-monitoring/ui-workflows ; .../alerting-on-budget-burn-rate (living docs, checked November 2026).
- Multi-window, multi-burn-rate alerts: page at 14.4× over 1 h (short window 5 min), which spends
  2% of a 30-day budget in an hour; page at 6× over 6 h (short window 30 min), 5% in 6 hours;
  ticket at 1× over 3 days (short window 6 h). Both windows must exceed the rate. — Grafana Labs
  blog, "How to implement multi-window, multi-burn-rate alerts with Grafana Cloud" (2025-02-28);
  Splunk Observability docs, "Burn rate alerts" (living). Origin: Google SRE Workbook, "Alerting on
  SLOs" (2018, kept as history).
- OpenSLO v1 spec: SLO has `timeWindow` (rolling, e.g. 28d/30d, or calendar-aligned),
  `budgetingMethod` (Occurrences, Timeslices, RatioTimeslices), `objectives` with targets, and an
  indicator (SLI). — github.com/OpenSLO/OpenSLO (v1, 2022–2026).
- Amazon EC2 SLA: region-level commitment 99.99% monthly uptime; service credit of 10% of the
  monthly EC2 bill in that region below 99.99% (deeper tiers lower down); credits only, no refunds.
  — aws.amazon.com/ec2-sla/ (living, checked November 2026).
- Google "SLO Adoption and Usage in SRE" report (2020): SLOs should be reviewed regularly; many
  teams start without error budget policies. — sre.google/static/pdf/SloAdoptionAndUsageInSre.pdf (2020).
- Open-source SLO rule generators for Prometheus: Sloth and Pyrra generate multi-window burn-rate
  alert rules from a short SLO file. — github.com/slok/sloth, github.com/pyrra-dev/pyrra (living).

## Computed here (examples/slis-slos-error-budgets, illustrative month)

- 30 days = 43,200 minutes; 25 requests/min → 1,080,000 requests. SLO 99.9% → budget 1,080
  failed requests, or 43.2 minutes of full outage.
- Background 0.02% (outside incidents): 194 (18%). 5-min blip at 5%: 6 (1%). 20-min outage: 500 (46%). 3-day leak at
  0.3%: 324 (30%). Total 1,025 failed, SLI 99.9051%, 5% budget left.
- Alerts: naive "errors > 1% over 5 min" fires on the blip (1 min) and the outage (1 min), never on
  the leak. 14.4×/1 h: outage only, after 1 min. 6×/6 h: outage, after 3 min. 1×/3 days: outage
  after 4 min, leak after 1,235 min (about 20.6 h). Working for the leak: (0.3% × t + 0.02% ×
  (4,320 − t)) ÷ 4,320 ≥ 0.1% → t ≥ 1,234.3 minutes.

## Numbers used (worked on the page)

- Nines per 30 days: 99% → 432 min (7.2 h); 99.9% → 43.2 min; 99.95% → 21.6 min; 99.99% →
  4.32 min; 99.999% → 26 s.
- Burn rate 14.4 for 1 hour: 1 h is 1/720 of 30 days; 14.4 × 1/720 = 0.02 = 2% of the budget.
- Three dependencies in series at 99.9%: 0.999 × 0.999 × 0.999 ≈ 0.997 → 99.7%.

## Misconceptions

- "100% is the right target": users cannot tell 99.99% from 100% through their own Wi-Fi and
  phone; each extra nine costs far more.
- SLA = SLO: the SLA is a contract with money attached, set looser than the internal SLO.
- Uptime measured by a ping every minute ≠ what users see; measure requests where users meet them.
- Averages hide pain: use "share of requests faster than X" rather than average latency.
- Alerting on raw error rate pages on blips and misses slow leaks; alert on budget burn.

## How explainers structure it

- Most posts (2021–2025): definitions of SLI/SLO/SLA, a nines table, "error budget = 1 − SLO".
  They leave out: worked month with real spending, why burn-rate alerts behave better than
  thresholds (shown with numbers), dependency maths, and how to pick the SLI from the user's view.

## Sources (Further reading)

1. Google Cloud: Concepts in service monitoring (living).
2. Google Cloud: Alerting on your burn rate (living).
3. Grafana Labs blog: multi-window, multi-burn-rate alerts (2025).
4. Splunk Observability: Burn rate alerts (living).
5. OpenSLO specification (v1).
6. Amazon EC2 SLA (living).
7. Google, SLO Adoption and Usage in SRE (2020).
8. Sloth and Pyrra (living).
9. Google SRE Workbook, Implementing SLOs and Alerting on SLOs (2018, kept as history).

## Fresher read

Done by the publishing session, top to bottom, on 2026-11-23. Items found and fixed:

- Part 1 step 6 had to explain why 216 + 6 + 500 + 324 did not equal the example's total → the
  examples now count background failures only outside incidents (194), so the parts add up to the
  total (up to rounding of 1).
- "pager", "page", "ticket", "health page", "migrations", "Prometheus", "YAML", "recording rules",
  "deploys" → explained in place or replaced with plain words.
- Step 2's example ratio marked "for example" so it is not confused with the month's result.
- Banned word "easy" ×3 and "just" ×1 → rewritten.

Skipped on purpose (style guide, standing feedback 16): no simulation and no step-through. The
mechanism a sim would show, how alerts react to a blip, an outage and a slow leak, is shown with
real computed numbers in the runnable example's output and in the budget chart; a sim would add
length without adding understanding.

Open items: none. Part 1 alone explains the idea in three sentences: measure the share of good
requests (SLI); set a target below 100% (SLO); the gap is the error budget, and whether it is left
or spent decides between shipping and fixing.
