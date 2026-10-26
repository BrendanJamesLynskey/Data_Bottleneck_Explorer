# Case study: Hardware System Design Explorer

**Live:** https://hw-system-design-explorer.vercel.app · **Code and tests:** this repository

A browser tool that sizes a data-processing system from what it has to do. You give it a rate and a latency budget,
or a model and a number of users. It works out the host, links, accelerators, memory, on-chip interconnect, fabric,
network, racks, power and cost, and says which part runs out first and by how much.

## The problem

The first question in most hardware projects is "what does this need?", and it usually gets answered in a
spreadsheet. A spreadsheet hides its assumptions and doesn't carry protocol overheads, queueing, or the
interactions between parts. Nor does it say when the answer stops being trustworthy.

I wanted a model that is quick enough to explore with, and specific enough to argue over:
- **Specific about overheads:** PCIe framing at your payload size, DRAM refresh and turnaround, ECC.
- **Honest about variability:** percentile latency, not just the mean.
- **Checked:** against published figures, with the misses shown.

## What it does

- **Throughput and latency.** Every part on the data path gets a demand (rate × peak-to-average × bytes it moves
  per byte processed) and a capacity (peak × efficiency). The most loaded part sets the system. Latency is each
  stage's fixed delay, transfer and queueing, with a seeded Monte Carlo for the percentiles.
- **Power, area and cost.**
  - Power is energy per bit and per operation for each technology, plus fans and conversion losses set by the rack's
    cooling.
  - Die area switches to pad-limited when the PHYs need more edge than the logic provides.
  - Build cost covers wafer price, dies per wafer and yield, DRAM per GB, packaging and its yield loss.
  - System cost adds the facility, hardware written off over its life, and electricity.
- **AI workloads from first principles.**
  - *LLM serving:* the workload comes from the model's shape, users, tokens per second, batch and context, with
    optional prefill. Prefill and decode can run on separate pools, as production serving increasingly does.
  - *LLM training:* compute, memory and traffic come from tensor, pipeline and data parallelism, including pipeline
    bubbles, activation recomputation and ZeRO-1.
- **Inside the chip.**
  - A compute array of cores, rows × columns of processing elements, clock, supply voltage, precision and dataflow can
    derive the accelerator's peak, area and energy.
  - A representative matrix multiply is mapped onto it for utilisation, and tiled through SRAM for the least DRAM
    traffic.
  - Junction temperature is solved with the leakage it causes.
  - An optional memory-controller model works from banks, timings and queue depth.
  - A floorplan and package view, and chiplets joined by UCIe links, set cost and yield against die-to-die power.
- **Design tools.**
  - An optimiser searches DRAM types and speed grades, links, interconnects and fabrics for the cheapest design that
    meets every limit.
  - A rate sweep shows where the design has to step up as the requirement grows.
  - Compare sets two designs side by side.
  - Every headline figure opens its own calculation, with the design's numbers in it.
  - A one-page spec sheet prints or saves as PDF.
- **An assistant.** Describe a system in plain English and an LLM sets the inputs, asks what it needs to know and
  runs the optimiser. Visitors bring their own key (OpenAI, Gemini, OpenRouter or Anthropic). It stays in their
  browser and goes only to that provider. A recorded session plays without a key.

There are 32 worked examples, from rack-scale LLM inference and a 1,024-accelerator training cluster to a 5G radio
unit, an ultrasound beamformer and a detector trigger. Six are deliberately broken, each showing a classic
bottleneck.

## How it is checked

This is the part I care most about. The Checks tab compares the model with published figures:

- **15 validations, all within tolerance:**
  - HBM, LPDDR and DDR bandwidths for NVIDIA, AMD, Intel, Google and Apple parts;
  - a STREAM Triad result, from the access-pattern model and again from a first-principles memory-controller model;
  - measured PCIe 5.0 copies in both directions;
  - DGX H100, GB200 NVL72 rack and NVL72 compute-tray power;
  - MLPerf Inference v5.0 Llama 2 70B throughput on 8 × H200: +11.5 % against a ±25 % tolerance fixed before the run.
- **4 calibration points:** energy per operation from the H100 and B200 TDPs, and the cost model's packaging price
  and defect density, chosen with published H100 and B200 build-cost estimates in view (both land within 8 %).
  They are labelled as fits, not counted as validations.
- **4 indicative rows that show where the model stops:**
  - NVIDIA's energy per operation carries to AMD and Intel parts only to about ±25 %.
  - The same MLPerf model with FP4 weights over-predicts B200 by 79 %, against a tolerance fixed beforehand.
    The published B200 ÷ H200 ratio is 2.8×, against 4.5× at peak, so FP4 reaches a smaller share of its peak in
    practice. That miss stays on the page rather than being tuned away.

Some things are deliberately *not* checked. The training model has no published run to compare with: Meta's Llama
3.1 runs don't publish enough of their settings, and adjusting knobs until the GPU-hours match would be fitting, not
checking.

Behind that, a regression suite runs in GitHub Actions on every push:
- **Regression:** all 32 examples against golden results within 2 %.
- **Hand calculations:**
  - the overhead breakdowns multiply out to the model's capacities;
  - the LLM and training workloads match the sums done by hand;
  - the prefill and decode pools split the arithmetic exactly, and power and capital add up across them;
  - every explanation panel ends on the figure shown.
- **Features:** the optimiser finds a design for every example that can be fixed; short share links round-trip
  exactly; each spec sheet fits one A4 page.
- **Assistant adapters:** each provider is run against mocked APIs.
- **Accessibility:** an axe-core audit of 19 page states, with no violations allowed.

## Five things the model shows

1. **In LLM serving the KV cache, not the weights, is often the traffic.** With Llama 3.1 70B at 8 bits, 500 users per
   copy and 4k-token contexts, 83 % of every decode step's DRAM reads are KV cache.
2. **Prompts can dominate the arithmetic.** With 3,600-token prompts and 1,000-token replies, reading the prompts is
   about three quarters of the compute, and a design sized for decode becomes compute-bound at 188 %.
3. **Splitting prefill from decode can be the difference between meeting a latency budget and missing it.** On the
   same 48 accelerators, one shared pool stretches each decode step to 73 ms against a 50 ms budget. Split into 16
   decode and 32 prefill, decode steps stay inside 50 ms and the first token arrives in about 140 ms.
4. **At build cost, the building can cost more than the computers.** For a 16-accelerator inference cluster, the
   facility to power and cool it at full load is $190k of $322k capital. Vendor margins usually hide this.
5. **Training is compute-bound, not memory-bound.** Training Llama 3.1 70B in BF16 on 1,024 accelerators (tensor
   parallel 8, pipeline 4, data 32) does about 9,800 operations per byte of DRAM traffic. Compute runs at 62 % and
   DRAM at about 2 %, and the pipeline bubble adds a fifth to the arithmetic. The levers are parallelism and
   micro-batching, not memory bandwidth.

## Engineering decisions

- **One static file.** The app is a single `index.html` (about 340 KB) with no build step and no backend. It loads
  instantly, and a reviewer can read the whole model in one place. Catalogue values sit
  at the top of the script with their sources.
- **Keys stay with the visitor.** The assistant calls each provider directly from the browser, so the site never
  holds anyone's key.
- **Reproducible randomness.** The Monte Carlo is seeded, so figures don't flicker as you drag a slider, and the
  regression suite can pin them.
- **State in the address.** A share link holds the example plus only what you changed (`#d=nvl72,dev.units:6`), so
  links stay short; older full-state links still load.
- **Sober interface.** Monochrome, with status shown by weight and inversion rather than colour, and detail kept in
  drawers and behind clicks.

## Limits

It is a first-order model, good for seeing which part limits and by roughly how much, not for sign-off.
- The catalogue is indicative.
- Compute is one achievable fraction of peak per accelerator.
- Collective operations are modelled as bandwidth with a latency term, not simulated.
- Cooling plant outside the rack is not counted in power.
- Several system prices (fabric, network ports, hosts) are assumptions, and DRAM prices are a 2026 snapshot.

## How it was built

I chose the scope, wrote the specifications and set the rules for checking. Every number comes from tested code or a
cited, dated source, and every model is checked against something independent of it. The building was done with
Claude (Anthropic's Claude Code) as an agentic engineering workflow. Every commit made that way carries a
`Co-Authored-By: Claude` line, so the split is visible in the history.

*Brendan Lynskey, October 2026*
