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

## Cross-check: Disaggregated_Inference_Sim

Fixed on 2026-10-27, before the first run. As above, neither the rule nor the settings change to make a row pass.

`sim/disagg_compare.py` runs the explorer's LLM serving designs through
[Disaggregated_Inference_Sim](https://github.com/BrendanJamesLynskey/Disaggregated_Inference_Sim), the owner's
SimPy simulator of prefill/decode serving, pinned at commit `a2c14e2` (`sim/requirements.txt`; first run at `ba37774`). It writes
`sim/disagg_results.json`.

The two tools model serving differently. The explorer is a steady-state sizing model: a decode step reads the
weights and every user's KV cache, its stages (memory, arithmetic, the tensor-parallel all-reduce) add up in
series, and users are served at a fixed tokens per second. The simulator runs request by request with continuous
batching and a roofline step (memory and arithmetic overlap, plus a fixed 0.5 ms per step). The check asks whether
the explorer's figures survive that more detailed model.

### Same hardware, different models

Each spec is exported from the page (`simLlmSpec`, by `tools/sim_sync.js`, to `sim/disagg/specs/`). The simulator
gets the explorer's own hardware figures, so differences come from the modelling, not the catalogue:
- **The device:**
  - peak arithmetic is the explorer's 8-bit dense rate, given as half that in BF16 with native FP8 units at 2×;
  - achievable arithmetic is the explorer's utilisation;
  - memory bandwidth is the explorer's peak, at the explorer's own DRAM efficiency for this traffic;
  - capacity is the explorer's device memory.
- **Formats:** weights and KV cache at the explorer's widths (8-bit runs as FP8), computing in that format.
- **Pools:**
  - decode: one instance per copy of the model, with the explorer's accelerators per copy, and its batch as the
    largest decode batch;
  - prefill: the explorer's prefill copies (one node each), one prompt per prefill step, as the explorer models it.
- **The KV hand-off:** one channel per prefill copy, at that node's NIC bandwidth with the explorer's 95 %
  efficiency.
- **Everything else** stays at the simulator's defaults: its step overhead, its 90 % memory allowance, and no cost
  for the tensor-parallel all-reduce.

The decode-only designs have no prefill in the explorer. In the simulator they use the split example's prefill
pool, and only their decode rows are judged.

### Designs

Fixed in advance:
- `llmserve` as it stands: Llama 3.1 70B at 8 bits, 2,000 users, batch 500, a 4,096-token context;
- the same at batch 128 (512 users) and at batch 32 (128 users), so four copies of the model throughout;
- the same with Llama 3.1 8B;
- `llmsplit` as it stands.

Each decode-only design's requests have prompts of the context less half the reply, so the average context
matches the explorer's.

### The workload and runs

- **Requests:** arrive at the design's rate (users × tokens per second ÷ reply length), with gamma-distributed
  gaps at the design's arrival CV; fixed prompt and reply lengths.
- **Duration:** six request lifetimes at the design's tokens per second, with the first third discarded as warm-up.
- **Runs:** 10 seeds from 1, with 95 % Student-t confidence intervals over the runs.

### Rows and the rule

For every design:

| Row | Explorer | Simulator | Agrees when |
|---|---|---|---|
| Decode step at the design's batch and context | its decode stages' fixed and transfer times, summed (no queueing) | the cost model's decode step | within ±10 % |
| Users per copy that fit in memory | the copy's device memory less the weights, ÷ one user's KV cache | KV-cache tokens per instance ÷ the context | within ±10 % |
| Decode meets its budget (1 ÷ tokens per second) | its decode latency headline at or under the budget | the mean over runs of the p99 time per output token at or under the budget | the verdicts match |

For the split design, as well:

| Row | Explorer | Simulator | Agrees when |
|---|---|---|---|
| Prefill of one prompt | its prefill stages' fixed and transfer times, summed | the cost model's prefill step | within ±10 % |
| Mean time to first token | the prefill pool's mean latency | mean TTFT, 95 % CI | within the CI widened by 5 % |
| p99 time to first token | the prefill pool's p99 latency | p99 TTFT, 95 % CI | within the CI widened by 10 % |
| Time to first token meets its budget | the prefill pool's headline at or under it | the mean p99 TTFT at or under it | the verdicts match |

±10 % for the deterministic rows: both are first-order models of the same hardware, and this is the band they
should agree within if neither leaves out a first-order cost. The simulated rows use the same widening as the
per-example checks.

### Recorded after the first run

Neither the rule nor the verdicts changed; a second run with the same seeds reproduced all 19 verdicts.
- **Unjudged diagnostics added** to explain the misses:
  - each step's parts on both sides (the explorer's stages; the simulator's arithmetic, memory and overhead, and
    what bound the step);
  - the prefill instances' busy shares and the mean wait for one.
- **A default not listed above:** the simulator's power model. It bounds each device at 700 W with an illustrative
  H100's coefficients, not the explorer's. It stretches the 70B decode steps at batch 500, which are close to
  balanced, from the roofline's 19.4 ms to 22.3 ms.
- **A finding about the simulator:** its prefill dispatcher measures load by waiting prompts alone, not the one in
  service, so ties send new prompts to the first instance. That adds a 38 ms mean wait in the split design.

### Re-run on the fixed simulator (2026-10-28)

The dispatcher was fixed in Disaggregated_Inference_Sim
([PR #2](https://github.com/BrendanJamesLynskey/Disaggregated_Inference_Sim/pull/2)); `a2c14e2` is `ba37774` plus
that fix alone. The pin moved to it and the check re-ran with the rule, settings, specs and seeds unchanged. The
first run's results are kept in `sim/disagg_results_ba37774.json`.
- **Unchanged:** every step and memory figure (the cost model doesn't depend on dispatch), and every decode verdict.
- **Changed:** in the split design the four prefill instances run 83 %, 81 %, 76 % and 19 % busy (were 99 %, 99 %,
  62 %, 0 %) and the mean wait for one falls from 38 ms to under a microsecond. Time to first token falls to one
  prefill step, 65.9 ms, at the mean and the p99 (were 103.5 and 131.4 ms).
- **One verdict flips:** the p99 time to first token, which agreed (explorer 143.2 ms) only because the
  simulator's wait offset the explorer's all-reduce, now misses at 2.17×. **5 of 19 rows agree** (were 6).

## Cross-check: Torch_Sim_Frontend's accelerator model

Fixed on 2026-10-28, before the first run. As above, neither the rule nor the settings change to make a row pass.

`sim/simfront_compare.py` runs the matrix multiply the Chip tab analyses through `simfront.accel`, the SimPy
accelerator model in [Torch_Sim_Frontend](https://github.com/BrendanJamesLynskey/Torch_Sim_Frontend), pinned at
commit `53b1419`. It writes `sim/simfront_results.json`. Only `simfront.accel` and the trace format are used, so it
is installed without PyTorch (`pip install --no-deps`).

The two tools model the multiply differently:
- **The explorer (`gemmMap`)** maps the multiply onto its cores with the chosen dataflow, paying the array's fill
  and drain (rows + columns cycles) once per round of tiles. It picks the SRAM tiling with the least DRAM traffic,
  partial sums included, and takes the time as the larger of arithmetic and DRAM transfer.
- **`simfront.accel`** cuts the multiply into blocks that fit its buffer, halving the largest dimension until they
  do. Every block loads both operands, with no reuse between blocks, and keeps its partial sums on chip. It then
  runs the blocks through DMA engines, a buffer with back-pressure and an output-stationary array, event by event.
  Load, compute and store overlap only as far as the buffer and the order allow.

### Same hardware

Each spec is exported from the page (`simChipSpec`, by `tools/sim_sync.js`, to `sim/simfront/specs/`):
- **The array:** one array of the explorer's rows × columns, clocked at the explorer's core clock × its cores.
  `simfront.accel` models one array, so this keeps the peak multiply-accumulate rate. It treats the cores as
  perfectly balanced: the explorer's rounding of tiles to whole rounds of cores has no counterpart.
- **The buffer:** the explorer's on-chip SRAM, half of it for a tile, as the explorer assumes.
- **Memory:** the bandwidth the explorer uses for the multiply (`devBW`: its DRAM at its own efficiency), as one
  channel, with an interconnect as fast so it never binds.
- **Elements:** operands and results at the explorer's width.
- **Everything else** stays at the simulator's defaults: 100 ns of memory and 20 ns of interconnect latency per
  transfer, and an output-stationary array whatever the explorer's dataflow.

### Designs

Fixed in advance, each the multiply on the design's Chip tab:
- `chiparray` as it stands: 4,096 × 4,096 × 4,096 at 8 bits on 1,747 cores of 32 × 32, weight-stationary;
- the same, output-stationary;
- `llmserve`: the decode FFN up-projection for one copy's batch of 500, on the default chip (64 cores of 32 × 32,
  weight-stationary);
- the same, output-stationary;
- the same at batch 32;
- `trainllm`: the training FFN up-projection for one micro-batch (Llama 3.1 70B, BF16, 8,192-token sequences, tensor
  parallel 8).

### Rows and the rule

`simfront.accel` is deterministic, so each design runs once. For every design:

| Row | Explorer | `simfront.accel` | Agrees when |
|---|---|---|---|
| Array time | cycles ÷ clock | the array's busy time | within ±10 % |
| DRAM traffic | bytes for its best tiling | bytes loaded plus bytes stored | within ±10 % |
| Time for the multiply | the larger of array time and DRAM time | the run's makespan | within ±10 % |
| What bounds it | DRAM or compute | compute when the array is busy for longer than memory, else DRAM | the verdicts match |

±10 % as for the Disaggregated_Inference_Sim step rows: both are first-order models of the same multiply on the same
hardware.

Before the first run, one design was corrected to match its description above: the export first named the
`train1k` example, whose Chip tab multiply is the custom 4,096-cubed one (the same as `chiparray`), not the training
FFN; `trainllm` is the example with the training workload on. Nothing had been run.

### Outcome (2026-10-28, `sim/simfront_results.json`)

18 of 24 rows agree; neither the rule nor the designs changed after the run.
- **Arithmetic** agrees within 8 % where both stream a long depth; it misses on `llmserve` weight-stationary (1.10×)
  and at batch 32 (3.00×), where the explorer's array pays fill and drain on each weight tile and the
  output-stationary-only simulator cannot.
- **Traffic** misses on `llmserve` (both dataflows, 1.10×) and `trainllm` (2.04×): the explorer writes partial sums
  to DRAM and reads them back; the simulator keeps them on chip. For `llmserve` the operand reads are identical.
- **Time** misses only at batch 32 (2.54×), following the array; **bounds** all match, all compute.

## The three tools together

The Checks tab ends with one table: for each kind of figure, how many rows agree with the explorer's own simulator
(`sim/sim.py`, per example and on real traffic), with Disaggregated_Inference_Sim and with `simfront.accel`. It is a
count of the rows above, with no rule of its own.
