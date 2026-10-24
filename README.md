# System Design Explorer

An interactive sizing tool for data-processing systems: a host CPU and its memory, a host link
(PCIe or on-package UCIe), accelerators with on-chip SRAM and device DRAM, scale-up fabrics and
scale-out networks up to many racks, optionally fed from the network or NVMe storage. You set the requirements (processing rate, latency budget, block size,
peak-to-average ratio, headroom) and the workload (bytes over the link and through DRAM per byte
processed, arithmetic per byte), and it shows which component is the bottleneck. It also gives the
minimum specification of every component, and the power, performance and area (PPA) of the result.

**Live app:** https://data-bottleneck-explorer.vercel.app/ (also mirrored on [GitHub Pages](https://brendanjameslynskey.github.io/Data_Bottleneck_Explorer/))

![System view](system.png)

## Layout

A sober black-and-white page with little on screen at once: the verdict, a one-line summary of the
requirements and a compact live block diagram, with the analysis in tabs below. Detail is hidden until
you ask for it: hover a block for its figures, click it for its settings, and open the legend, the
example's description, the less-used tabs (Latency, Headroom, Roofline, Model), the impractical DRAM
options and the passing checks only when you want them. Status is shown by weight and inversion rather than colour
(grey within the utilisation ceiling, dashed above it, white over capacity, the bottleneck inverted).
Inputs live in a drawer that slides in from the left; clicking any block opens its settings in a drawer
on the right. On wide screens the drawers push the page aside so the diagram stays visible while you drag.

![Inputs drawer](inputs.png)

## Many accelerators and racks

Set accelerators per node, nodes per rack and racks. Each accelerator then handles its share of the
rate and each host its node's share. Peer traffic splits into what stays inside the scale-up domain
(a node or a whole rack, over PCIe peer-to-peer, NVLink 4/5, UALink or Ethernet scale-up) and what
crosses the scale-out network (200G to 1.6T NICs). The *Racks* tab draws the rack elevation and
checks rack power against a cooling limit (air, rear-door, direct liquid). The sizing says how many
accelerators this design needs, and the fabric table shows which fabrics fit and whether the domain is
too big for them.

![Racks](racks.png)

## Design assistant

Type what the system has to do in plain language, for example *"serve a 70B model at 3,000 tokens/s,
under 50 ms per token"*, and the assistant turns it into the model's inputs. It asks up to three short
follow-up questions with clickable answers when something that would change the design is missing, and
assumes typical values (and says so) when you can't say. It then picks DRAM, links, fabric, NICs and
the on-chip network until every component sits under the utilisation ceiling, and the page redraws
as it goes.

It runs Claude (`claude-opus-5-5`) in your browser through the official Anthropic SDK, with **your own
API key**. The key goes only to `api.anthropic.com` and is stored only if you tick *remember*. Claude
works through five tools that drive the page's model: `set_requirements`, `set_hardware`, `evaluate`,
`load_example` and `ask_user`. Without a key, a small rule-based parser reads rates, latencies and the
kind of workload, and starts from the nearest example.

![Design assistant](assistant.png)

## On-chip interconnect

Each accelerator has an on-chip interconnect and SRAM banks. It can be a network-on-chip (2-D mesh,
torus, ring or full crossbar) or one of the AMBA fabrics:

- **CHI**: a coherent mesh in the style of Arm's CMN, where snoops and responses share each link.
- **AXI5** and **ACE5**: crossbars of masters and memory-side slave ports, with independent read and
  write channels (ACE adds snoop channels).
- **AXI4-Stream**: parallel point-to-point pipelines.
- **AHB5**: a shared bus, one transfer at a time, with reads and writes taking turns.
- **APB**: registers only.

Choosing a type sets its typical width and clock. DRAM, host-link and peer traffic enter at the die
edge, and tile-to-tile traffic follows a pattern (all-to-all, nearest neighbour, or mostly local).
Each kind is checked where it actually saturates: edge channels, bisection and tile ports for a NoC;
memory ports, master ports and the crossbar for AXI; pipeline entries and the busiest link for
streams; the single bus for AHB and APB. SRAM bank bandwidth is checked for all of them. The Notes tab
covers AXI outstanding transactions (bandwidth × DRAM latency) and warns when AHB or APB is asked to
carry bulk data. The *On-chip* tab draws the chosen fabric and compares all ten at their typical
settings. Edge-device and FPGA examples use AXI; the detector trigger uses AXI4-Stream.

![AXI crossbar](amba.png)

![On-chip network](onchip.png)

## Variability, percentiles and the weakest link

Sizing everything for the same simultaneous peak, and adding up every stage's worst latency, stacks
tolerances to a worst case that rarely happens. A collapsed *Variability & tolerances* section offers
the alternative:

- **Deadline: soft or hard.** A soft deadline is judged at a percentile (p99, p99.9 or p99.99) of a
  Monte Carlo of the whole path. Each stage's delay is lognormal around its mean; long transfers average
  out their jitter, compute keeps its data-dependent jitter, and queueing waits vary about as much as
  their mean. A hard deadline (trading, triggers, 5G slots) keeps the worst-case stack of per-stage
  percentiles. The Latency tab shows the histogram with p50, the percentile, the worst-case stack and the
  budget, so the margin that stacking would waste is visible.
- **Do peaks line up?** Independent or partly correlated bursts smooth out where many streams share a
  resource: a host serving eight accelerators is sized for a smaller peak than any one of them sees.
  Fully correlated reproduces the worst case.
- **Arrival burstiness and jitter** feed Kingman's G/G/1 queueing formula. Clocked work such as LLM
  decode steps and camera frames arrives regularly; random requests are Poisson.
- **Catalogue tolerance** (±10–30 %) draws every capacity figure at random and reports how often the
  design stays under the ceiling, and which component turns out weakest.

A **weakest-link** strip under the headline figures lists every component on the data path, in order,
with the rate it alone could sustain. The weakest is inverted and sets the system's maximum rate. With
tolerance on, each link also shows how often it came out weakest.

![Latency distribution](latency.png)

## The question it was built for

*A system has to process 1 GB of data per millisecond. How wide would a bank of LPDDR4 at full speed
have to be? Would it need HBM? If every byte processed also has to cross the host link in each
direction, what link does it need?*

1 GB/ms is 1 TB/s. At 3200 MT/s an x16 LPDDR4 channel peaks at 6.4 GB/s, so even at 100 % efficiency
with no headroom the bus would be about **2,500 bits wide**. At a realistic 92 % streaming efficiency
and an 80 % utilisation ceiling it is **213 channels, a 3,408-bit bus**: about 7,000 signal balls,
190 mm of PHY beachfront on the die and roughly 230 mm² of PHY. That is far beyond the 256-bit to
1024-bit that LPDDR is ever built at. Two HBM3E stacks carry the same traffic with 14 mm of edge.
The link is the harder problem: a PCIe 5.0 x16 delivers about 52 GB/s per direction after encoding
and TLP overhead, so 1 TB/s each way needs 24 of them (6 even at PCIe 7.0). The tool's answer is to
move less data across the link, or to put the accelerator on the package. It also shows that the host's own DRAM
would have to carry 4 TB/s to feed that link.

## What's inside

- **Live data-flow diagram**: moving dashes on every path, with each block marked by its
  utilisation against your ceiling. The bottleneck is flagged. Click a block to configure it.
- **Verdict strip**: the bottleneck, the maximum sustainable rate, latency per block against the
  budget, system and per-rack power, and the accelerator count.
- **Minimum specs**: every DRAM technology (DDR4/5, LPDDR4/4X/5/5X/6, GDDR6/6X/7, HBM2 to HBM4)
  sized for the requirement, with bus width, capacity, power, PHY area, beachfront, signal pins and a
  practical / stretch / impractical verdict. Also every link (PCIe 3.0 to 7.0, UCIe), host memory
  channels, scale-up fabrics, scale-out NICs, compute, host cores, network ports and SSDs. One click
  applies any option.
- **PPA**: power broken down by component, a die-area estimate that switches to *pad-limited* when
  the memory and link PHYs need more edge than the logic provides, a reticle-limit check, and a DRAM
  design-space plot of power against PHY area.
- **Latency budget**: one block through every stage (fixed cost, transfer, M/D/1 queueing), plus
  sweeps of latency and host-core load against block size.
- **Headroom**: the utilisation of every component as the rate scales. The first line to cross
  100 % is the bottleneck, and the next line shows what fixing it buys.
- **Roofline**: arithmetic intensity against device DRAM, the ridge point, and a second roof set
  by the rate the host link can feed.
- **Considerations**: checks generated from the current design. They cover half-duplex DRAM against
  full-duplex links, access-pattern efficiency, capacity, PCIe TLP efficiency, outstanding read tags
  (Little's law), DRAM concurrency, CPU cost per block, host memory on the data path, queueing,
  on-chip buffering, data-movement power, beachfront, HBM packaging and ECC.
- **28 example applications**, AI first, each with a note on what it shows. The ones marked ✗ are
  deliberately broken designs that illustrate a classic bottleneck:
  - *AI & LLMs*: rack-scale inference on 72 accelerators in one NVLink domain, a 1,024-accelerator
    training cluster over 32 racks, tensor-parallel prefill on 8 PCIe cards ✗, a mixture-of-experts
    layer that overloads its mesh ✗, LLM decode on an
    8-accelerator server and at the edge, prefill on one accelerator, DLRM embedding lookups, and a data
    loader starving an accelerator ✗.
  - *Fundamentals*: the 1 TB/s question.
  - *Imaging & video*: 4 × 4K60 edge analytics, an 8K60 encoder, line-scan vision, a smartphone ISP +
    NPU, an ultrasound beamformer, an autonomous-driving SoC.
  - *Signal processing & comms*: radar/SDR over 400 GbE, a 5G O-RAN DU, a radio-telescope correlator,
    a trading feed handler ✗, a detector trigger ✗.
  - *Data, storage & networking*: NVMe scan offload, a GPU database join over PCIe ✗, 400 GbE TLS
    offload, storage compression.
  - *Science, HPC & crypto*: a CFD stencil, genomic alignment on an FPGA card, an FHE bootstrapping
    accelerator.
- **Share links**: the whole configuration lives in the URL.

## The model

Everything flows from the processing rate *T*, the bytes of input processed per second. For each
component:

- **demand** = *T* × peak-to-average ratio × bytes that component moves per processed byte;
- **capacity** = peak × efficiency;
- **utilisation** = demand ÷ capacity. The bottleneck is the component with the highest utilisation.

How each kind of component is treated:

- **DRAM.** Efficiency depends on the access pattern, a read/write turnaround penalty and inline-ECC
  overhead. Reads and writes share one half-duplex bus.
- **PCIe.** Usable rate = raw × encoding (128b/130b, or 236/256 in FLIT mode) × payload ÷ (payload
  + header + framing) × DLLP overhead. Each direction is sized separately, and completion size and
  read requests are counted.
- **Power** is average traffic × energy per bit for each technology, plus standby power per unit,
  compute pJ/op and leakage per mm².
- **Area** is compute + SRAM + PHYs + 15 %. It is replaced by the pad-limited area when a square die
  would not have enough edge for the PHYs.

All catalogue numbers are indicative, first-order figures for a 5 nm-class accelerator (JEDEC data
rates, public datasheets and published estimates). They are good for seeing which component limits
and by roughly how much, not for sign-off. The *Model* tab in the app lists every value.

## Running locally

It is one self-contained `index.html` file with no build step: open it in any modern browser.
