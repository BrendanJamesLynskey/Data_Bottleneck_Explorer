# Model vs simulation: the agreement rule

Fixed on 2026-10-26, before the first comparison run, as was done for the MLPerf and Genoa-controller checks. The
rule and the settings below are not changed to make a row pass. A row that misses is published as a finding on the
Checks tab, with what it shows about the model.

`sim/compare.py` applies this rule. It runs `sim/sim.py` on every example's exported spec (`sim/examples/*.json`) and
writes `sim/results.json`, which the Checks tab shows.

## What is compared

For each example, and for each pool when prefill and decode are split, there is one row per check.

The simulation reports each figure as the mean over its runs, with a 95 % confidence interval (Student t over the
runs). Call that interval [lo, hi].

**Agreement means that the model's figure lies in [lo·(1 − w), hi·(1 + w)]**, where w is the widening for that kind
of figure:

| Figure | Rows | w | Why this width |
|---|---|---|---|
| Ceiling | One per pool: the rate the queued stages carry when saturated, against the model's ceiling for the same stages | 2 % | For a line of queues this is close to an identity. A wider gap would mean an export or composition error, not an approximation. |
| Utilisation | One per queued stage that the model loads to at least 1 % on average | 2 % | As above. |
| Mean latency | One per pool | 5 % | The mean is a sum of fixed and service times plus Kingman waits, and only the waits are approximate. |
| Queueing wait | One per stage whose model wait is at least 1 % of the model's mean latency | 10 % | This is Kingman's G/G/1 approximation itself, tested stage by stage. Smaller waits can't move the latency, so they are not judged. |
| The design's percentile (p99 or p99.9) | One per pool | 10 % | The explorer composes per-stage lognormals with the chosen correlation. That is an approximation to the true tail. |
| Tolerance stack | One per pool | bound | The stack (every part at its own percentile at once) is meant to be conservative. It passes if it is at least lo of the simulated percentile. |

### Designs the model calls unbounded

Some designs load a part to 100 % or more on average, so the model gives no latency. For these there is one row: it
passes if the simulated latency keeps growing, meaning the lower end of the CI for the drift ratio exceeds 1.5. The
drift ratio is the mean latency of the last tenth of measured blocks over that of the first tenth.

Utilisation rows are not judged for these designs: the stages after the overloaded part carry only what it passes on.

If the only overloaded part is the on-chip network, the row is shown but not counted. The simulation queues its
packets at the model's own utilisation, so both are unbounded by construction.

## Settings

- 10 runs.
- Seed 1.
- 20,000 measured blocks per run after 2,000 blocks of warm-up.
- A saturated run of 5,000 blocks per seed for the ceiling.

These are the defaults of `sim/compare.py`. CI re-runs it and fails if any verdict or figure differs from the
committed `sim/results.json`.

## What this does and doesn't test

It tests the analytic shortcuts:
- Kingman's wait at each stage;
- composing stage percentiles under the chosen correlation;
- the tolerance stack as a bound;
- the most loaded queued stage setting the line's ceiling.

It does not test the catalogue (capacities, efficiencies, energies). The simulator takes those from the explorer, so
the Checks tab's published-figure rows cover them.

Arrivals are a renewal process with the design's arrival CV, at the average rate. The explorer's peak-to-average
sizes capacity against the ceiling but has no duration, so it isn't simulated as a modulated process.
