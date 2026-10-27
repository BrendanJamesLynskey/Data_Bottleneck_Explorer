# Model vs simulation: the agreement rule

Fixed on 2026-10-26, before the first comparison run, as was done for the MLPerf and Genoa-controller checks. The
rule and the settings below are not changed to make a row pass. A row that misses is published as a finding on the
Checks tab, with what it shows about the model.

The rule is `RULE` and `checks()` in `sim/sim.py`, so the page's in-browser run judges the same way. `sim/compare.py` runs `sim/sim.py` on every example's exported spec (`sim/examples/*.json`) and
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

## Real traffic: the Azure LLM traces

Fixed on 2026-10-27, before the first replay. As above, neither the rule nor the settings change to make a row
pass.

`sim/trace_compare.py` replays Microsoft's two Azure LLM inference traces from 2023 (code completion and
conversation; see `sim/traces/SOURCE.md`) and writes `sim/trace_results.json`.

### What is replayed

The traces drive the split-pool example's prefill pool (`llmsplit`), where a block is one request's prompt and its
latency is the time to first token.

**The design** is the example moved to each trace's mean prompt length, at the same prompt-token rate (the reply
scales with the prompt), so the average load is the design's. Each stage's service time at any prompt length comes
from the model itself: it is evaluated at a grid of prompt lengths (`simTraceSpec`), with linear interpolation
between grid points.

**Each run** is one replay:
- a moving-block bootstrap of the trace (60-second segments drawn with replacement, seeded);
- times stretched so the average request rate is the design's;
- every request's own prompt length;
- the design's jitter on top.

One copy of the model receives the whole scaled stream. Load balancing across copies isn't modelled, which is the
conservative choice.

**Settings:**
- 20 runs from seed 1;
- the first 5 % of each replay discarded as warm-up;
- 95 % confidence intervals over the runs, as above.

### Rows and the rule

Two sets of model figures per trace, against the same replays:

| Model figures | Arrival CV | Question it answers |
|---|---|---|
| As designed | the example's own, 0.2 | Do the example's assumptions hold under real traffic? |
| With the trace's arrival CV | measured from the trace | Given the right burstiness, does Kingman's formula and the composition hold? |

Prompt-length variation has no input in the explorer, so neither set includes it. Where that matters, it shows as
a miss.

Rows and widening, as for the per-example checks:
- mean time to first token: 5 %;
- its p99: 10 %;
- the busiest stage's utilisation (as designed only), which checks the replay carried the design's load: 2 %.

### Added 2026-10-27: the busiest minute

Added after the first replay, which showed that load swings over minutes drive the misses, and before any replay
of this row. The explorer gained a busiest-spell input (how much busier than average, and for how long): each
queue's wait is averaged over that spell, starting from the average's steady state, by the pointwise-stationary
fluid approximation (Wang, Nicol & Feldman, 1996). At 1×, the default, every figure is unchanged.

A third set of model figures per trace, against the same replays and under the same rule:

| Model figures | Arrival CV | Busiest spell | Question it answers |
|---|---|---|---|
| For the trace's busiest minute | the example's own, 0.2 | the busiest minute's prompt tokens ÷ the average minute's, lasting one trace minute at the design's rate | Does designing for the busiest minute give a safe figure under real traffic? |

The model's figures here describe the busiest minute, while the replay's describe the whole hour. The bootstrap
includes the trace's busiest minute in only some replays. So this row is expected to sit at or above the replay,
and a miss on the high side is the conservative kind. Not judged, but reported: the replay's own latency for the
requests arriving in its busiest minute, from the original-order run.

I had seen the diagnostics before choosing the method (the busiest minute's load, 126 % and 280 % of the busiest
stage's capacity at the design's average). The method and its inputs follow from them, with nothing fitted to
the replay's latencies.
