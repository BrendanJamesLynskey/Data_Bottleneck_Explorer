"""A discrete-event simulation of one Hardware System Design Explorer design, to check the explorer's analytic shortcuts.

The explorer exports a design as JSON (``simSpec`` in ``index.html``, schema ``hw-explorer-sim/1``) built from the
model's computed fields: for each pool, the stages a block of data passes through (``m.stages``) with their fixed
latency, service time, service variability and utilisation. This script runs that line of stages as SimPy queues::

    arrivals ─► stage 1 ─► stage 2 ─► … ─► stage n ─► done          (one accelerator's blocks, in m.stages order)
    renewal, CV ca      each stage: fixed delay, then a FIFO server

Stage kinds (``level`` in the spec):

- ``block``: a FIFO server (``simpy.Resource``). The block holds it for its service time, lognormal with the stage's
  mean and CV, as the explorer assumes. When the model loads the part with more than this block's own transfer (the
  read requests that a pulled host-to-device copy puts on the D→H direction, say), the block leaves a companion job of
  that extra length behind it, so later blocks queue behind it while this one moves on.
- ``packet``: the on-chip network, whose packets take nanoseconds while blocks arrive milliseconds apart. Simulating
  every packet in SimPy would cost millions of events per block, so it runs separately as a G/G/1 queue of packets
  (the Lindley recursion, exact for FIFO) at the model's utilisation, and each block draws one packet's wait from it.
  The time scales are so far apart that the draws are independent.
- ``delay``: a pure delay (host submit and completion), which the model doesn't queue either.

Every fixed part is also lognormal with the stage's jitter CV. One block's draws across stages are correlated through
a shared normal factor, as in the explorer's ``latencyStats``: z = √ρ·z₀ + √(1−ρ)·zᵢ.

Each run is seeded; a warm-up is discarded. Across runs it reports throughput, per-stage utilisation and latency mean,
p50, p99, p99.9 and the design's own percentile, each with a 95 % confidence interval (Student t over the runs). A
second, saturated run of each seed (arrivals at twice the slowest server's rate) measures the most the line carries.

    python sim/sim.py design.json --runs 200 --seed 1 --json out.json

Pure Python on SimPy 4.1.1, so the same file runs under CPython, in CI and in the browser under Pyodide.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import random
import statistics
import sys
from dataclasses import dataclass, field

import simpy

SCHEMA = "hw-explorer-sim/1"
VERSION = "1.0.0"

# two-sided 95 % Student t quantiles by degrees of freedom; 1.96 beyond the table
_T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
        11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
        25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000, 120: 1.980}


def t95(df: int) -> float:
    if df <= 0:
        return math.inf
    for d in sorted(_T95):
        if df <= d:
            return _T95[d]
    return 1.96


def ci(xs: list[float]) -> dict:
    """Mean of the per-run figures with a 95 % confidence interval; infinite runs make the whole figure infinite."""
    if not xs:
        return {"mean": None, "lo": None, "hi": None, "n": 0}
    if any(not math.isfinite(x) for x in xs):
        return {"mean": math.inf, "lo": math.inf, "hi": math.inf, "n": len(xs)}
    m = statistics.fmean(xs)
    h = t95(len(xs) - 1) * statistics.stdev(xs) / math.sqrt(len(xs)) if len(xs) > 1 else math.inf
    return {"mean": m, "lo": m - h, "hi": m + h, "n": len(xs)}


def quantile(sorted_xs: list[float], p: float) -> float:
    """The p-quantile of sorted data, the same rule as the explorer (the element at floor(p·n))."""
    return sorted_xs[min(len(sorted_xs) - 1, int(p * len(sorted_xs)))]


def ln_params(cv: float) -> tuple[float, float]:
    """(mu, sigma) of a lognormal with mean 1 and the given coefficient of variation."""
    sg = math.sqrt(math.log(1 + cv * cv))
    return -sg * sg / 2, sg


@dataclass
class Stage:
    k: str
    name: str
    level: str                 # "block" | "packet" | "delay"
    fixed: float               # s, mean fixed latency
    fixed_cv: float
    svc: float                 # s, mean service (transfer) time of one block
    svc_cv: float
    extra: float = 0.0         # s, more occupancy per block that this block doesn't wait for
    util: float = 0.0          # the model's average utilisation of the part
    dist: str = "lognormal"    # service distribution: "lognormal" | "exp" | "det"

    @classmethod
    def from_json(cls, d: dict) -> "Stage":
        return cls(k=d["k"], name=d["name"], level=d["level"], fixed=d["fixed_s"], fixed_cv=d.get("fixed_cv", 0.0),
                   svc=d["svc_s"], svc_cv=d.get("svc_cv", 0.0), extra=d.get("extra_s", 0.0), util=d.get("util", 0.0),
                   dist=d.get("dist", "lognormal"))

    @property
    def occupancy(self) -> float:
        """Mean time the server is busy per block: the block's own service plus its companion job."""
        return self.svc + self.extra


@dataclass
class Pool:
    name: str
    block_rate: float          # blocks/s arriving at one accelerator, on average
    block_bytes: float
    accelerators: int
    arrival_cv: float
    corr: float
    stages: list[Stage] = field(default_factory=list)
    svc_table: dict | None = None  # {"sizes": [...], "svc_s": {k: [...]}}: service at each block size, for replays

    @classmethod
    def from_json(cls, d: dict, w: dict) -> "Pool":
        return cls(name=d["name"], block_rate=d["block_rate"], block_bytes=d["block_B"], accelerators=d["accelerators"],
                   arrival_cv=w["arrival_cv"], corr=w["stage_corr"], stages=[Stage.from_json(s) for s in d["stages"]],
                   svc_table=d.get("svc_by_size"))

    def svc_of(self, s: Stage, size: float | None) -> float:
        """Mean service of a block of this size at stage s: the model's own figures at a grid of sizes, linear
        between grid points and beyond the ends. Without a size (renewal runs) it is the stage's design service."""
        if size is None or not self.svc_table or s.k not in self.svc_table["svc_s"]:
            return s.svc
        xs, ys = self.svc_table["sizes"], self.svc_table["svc_s"][s.k]
        i = min(max(bisect.bisect_right(xs, size) - 1, 0), len(xs) - 2)
        return max(0.0, ys[i] + (ys[i + 1] - ys[i]) * (size - xs[i]) / (xs[i + 1] - xs[i]))

    def servers(self) -> list[Stage]:
        return [s for s in self.stages if s.level == "block" and s.occupancy > 0]


class Draws:
    """One run's random numbers: interarrival gaps, and per block a correlated set of lognormal factors."""

    def __init__(self, seed: int, ca: float, corr: float):
        self.r = random.Random(seed)
        self.ca, self.sr, self.si = ca, math.sqrt(corr), math.sqrt(1 - corr)

    def gap(self, mean: float) -> float:
        """Renewal interarrival with the arrival CV: deterministic at 0, gamma (shape 1/ca²) otherwise; exponential at 1."""
        if self.ca <= 0:
            return mean
        k = 1 / (self.ca * self.ca)
        return self.r.gammavariate(k, mean / k)

    def factor(self, z0: float, cv: float, dist: str = "lognormal") -> float:
        """A mean-1 multiplier with the given CV, correlated with the block's shared factor z0."""
        if cv <= 0 or dist == "det":
            return 1.0
        if dist == "exp":
            return self.r.expovariate(1.0)
        mu, sg = ln_params(cv)
        return math.exp(mu + sg * (self.sr * z0 + self.si * self.r.gauss(0, 1)))


def packet_waits(stage: Stage, ca: float, seed: int, n: int = 40000, warm: int = 4000) -> list[float]:
    """Stationary waits of a G/G/1 queue of packets (Lindley: W' = max(0, W + S − A)) at the stage's utilisation,
    packet service lognormal(fixed, fixed_cv), renewal arrivals with CV ca. Infinite if the part is overloaded."""
    if stage.util >= 1:
        return [math.inf]
    if stage.util <= 0 or stage.fixed <= 0:
        return [0.0]
    d = Draws(seed, ca, 0.0)
    gap = stage.fixed / stage.util
    w, out = 0.0, []
    for i in range(n + warm):
        if i >= warm:
            out.append(w)
        w = max(0.0, w + stage.fixed * d.factor(0.0, stage.fixed_cv, stage.dist) - d.gap(gap))
    return out


@dataclass
class RunResult:
    latencies: list[float]
    throughput: float          # blocks/s completed, per accelerator
    util: dict[str, float]
    wait: dict[str, float]     # mean queueing wait per stage, s
    offered: float             # blocks/s offered, per accelerator
    drift: float               # mean latency of the last tenth over the first tenth (after warm-up)


def run_once(pool: Pool, seed: int, blocks: int, warm: int, rate: float | None = None,
             arrivals: list[tuple[float, float]] | None = None, keep_order: bool = False) -> RunResult:
    """One seeded run of `blocks` blocks through the pool's stages; the first `warm` are not measured. With
    `arrivals`, a list of (time, size), blocks arrive at those times instead, each served for its own size. Latencies
    come back sorted, or in arrival order with keep_order."""
    if arrivals is not None:
        blocks = len(arrivals)
    env = simpy.Environment()
    rate = pool.block_rate if rate is None else rate
    d = Draws(seed, pool.arrival_cv, pool.corr)
    servers = {s.k: simpy.Resource(env, capacity=1) for s in pool.servers()}
    busy = {k: 0.0 for k in servers}
    waits = {s.k: packet_waits(s, pool.arrival_cv, seed * 7919 + i) for i, s in enumerate(pool.stages) if s.level == "packet"}
    wsum = {k: 0.0 for k in list(servers) + list(waits)}
    arr, dep = [0.0] * blocks, [0.0] * blocks
    t_first = [None]

    def hold(res, req, dt):
        yield env.timeout(dt)
        res.release(req)

    def block(i):
        z0 = d.r.gauss(0, 1)
        delay = 0.0            # pure delays add up until the next server, so they cost one event between servers
        for s in pool.stages:
            if s.fixed > 0:
                delay += s.fixed * d.factor(z0, s.fixed_cv)
            if s.level == "packet" and s.k in waits:
                w = waits[s.k][d.r.randrange(len(waits[s.k]))]
                if not math.isfinite(w):
                    dep[i] = math.inf
                    return
                delay += w
                if i >= warm:
                    wsum[s.k] += w
            elif s.k in servers:
                f = d.factor(z0, s.svc_cv, s.dist) * (pool.svc_of(s, arrivals[i][1]) / s.svc if arrivals is not None and s.svc > 0 else 1.0)
                if delay > 0:
                    yield env.timeout(delay)
                    delay = 0.0
                res = servers[s.k]
                req, t = res.request(), env.now
                yield req
                if i >= warm:
                    wsum[s.k] += env.now - t
                    if t_first[0] is None:
                        t_first[0] = env.now
                yield env.timeout(s.svc * f)
                if i >= warm:
                    busy[s.k] += (s.svc + s.extra) * f
                if s.extra > 0:
                    env.process(hold(res, req, s.extra * f))
                else:
                    res.release(req)
        if delay > 0:
            yield env.timeout(delay)
        dep[i] = env.now

    def source():
        t = 0.0
        for i in range(blocks):
            arr[i] = t
            env.process(block(i))
            g = arrivals[i + 1][0] - arrivals[i][0] if arrivals is not None and i + 1 < blocks else d.gap(1 / rate)
            t += g
            yield env.timeout(g)

    env.process(source())
    env.run()
    lat = [dep[i] - arr[i] for i in range(warm, blocks)]
    if not keep_order:
        lat.sort()
    meas = [dep[i] for i in range(warm, blocks)]
    if any(not math.isfinite(x) for x in meas):
        return RunResult([math.inf] * len(lat), 0.0, {k: math.nan for k in servers}, {k: math.inf for k in wsum}, rate, math.inf)
    span = max(meas) - (t_first[0] or arr[warm])
    util = {k: (busy[k] / span if span > 0 else math.nan) for k in servers}
    tput = (blocks - warm) / (max(meas) - arr[warm]) if max(meas) > arr[warm] else math.nan
    n10 = max(1, (blocks - warm) // 10)
    first = statistics.fmean(dep[i] - arr[i] for i in range(warm, warm + n10))
    last = statistics.fmean(dep[i] - arr[i] for i in range(blocks - n10, blocks))
    wait = {k: v / (blocks - warm) for k, v in wsum.items()}
    return RunResult(lat, tput, util, wait, rate, last / first if first > 0 else math.inf)


def saturated(pool: Pool, seed: int, blocks: int) -> float:
    """Blocks/s per accelerator the line carries when offered twice what its slowest server can take: the departure
    rate over the middle 80 % of departures."""
    sv = pool.servers()
    if not sv:
        return math.inf
    rate = 2 / max(s.occupancy for s in sv)
    env = simpy.Environment()
    d = Draws(seed, pool.arrival_cv, pool.corr)
    servers = {s.k: simpy.Resource(env, capacity=1) for s in sv}
    deps = []

    def hold(res, req, dt):
        yield env.timeout(dt)
        res.release(req)

    def block():
        z0 = d.r.gauss(0, 1)
        for s in pool.stages:
            if s.k in servers:
                f = d.factor(z0, s.svc_cv, s.dist)
                res = servers[s.k]
                req = res.request()
                yield req
                yield env.timeout(s.svc * f)
                if s.extra > 0:
                    env.process(hold(res, req, s.extra * f))
                else:
                    res.release(req)
        deps.append(env.now)

    def source():
        for _ in range(blocks):
            env.process(block())
            yield env.timeout(d.gap(1 / rate))

    env.process(source())
    env.run()
    deps.sort()
    a, b = len(deps) // 10, len(deps) - 1 - len(deps) // 10
    return (b - a) / (deps[b] - deps[a]) if deps[b] > deps[a] else math.inf


def simulate_pool(pool: Pool, pct: float, runs: int, seed: int, blocks: int, warm: int, progress=None) -> dict:
    """Many seeded runs of one pool; per-run figures, then their means with 95 % confidence intervals."""
    per = {"mean": [], "p50": [], "p99": [], "p999": [], "pX": [], "tput": [], "sat": [], "drift": []}
    util = {s.k: [] for s in pool.servers()}
    wait = {s.k: [] for s in pool.stages if s.level in ("block", "packet") and (s.k in util or s.level == "packet")}
    for r in range(runs):
        s = seed * 1000003 + r
        res = run_once(pool, s, blocks, warm)
        lat = res.latencies
        per["mean"].append(statistics.fmean(lat) if all(math.isfinite(x) for x in lat) else math.inf)
        for key, p in (("p50", 0.5), ("p99", 0.99), ("p999", 0.999), ("pX", pct)):
            per[key].append(quantile(lat, p))
        per["tput"].append(res.throughput)
        per["drift"].append(res.drift)
        for k in util:
            util[k].append(res.util.get(k, math.nan))
        for k in wait:
            wait[k].append(res.wait.get(k, math.inf))
        per["sat"].append(saturated(pool, s + 17, max(2000, blocks // 4)))
        if progress:
            progress(pool.name, r + 1, runs)
    bps = pool.block_bytes * pool.accelerators
    out = {"name": pool.name, "offered_Bps": pool.block_rate * bps}
    for k in ("mean", "p50", "p99", "p999", "pX"):
        out[k + "_s"] = ci(per[k])
    out["throughput_Bps"] = scale(ci(per["tput"]), bps)
    out["ceiling_Bps"] = scale(ci(per["sat"]), bps)
    out["util"] = {k: ci([x for x in v if math.isfinite(x)]) for k, v in util.items()}
    out["wait_s"] = {k: ci(v) for k, v in wait.items()}
    out["drift"] = ci(per["drift"])
    return out


def scale(c: dict, f: float) -> dict:
    return {k: (v * f if isinstance(v, float) and k != "n" else v) for k, v in c.items()}


# the rule (TOLERANCE.md): widening of the simulation's 95 % CI by kind of figure, and the thresholds for judging a row
RULE = {"ceiling": 0.02, "util": 0.02, "mean": 0.05, "wait": 0.10, "pct": 0.10,
        "util_min": 0.01, "wait_share_min": 0.01, "drift_min": 1.5}


def band(c: dict, w: float) -> tuple[float, float]:
    return c["lo"] * (1 - w), c["hi"] * (1 + w)


def judge(x: float, c: dict, w: float) -> str:
    lo, hi = band(c, w)
    return "pass" if lo <= x <= hi else "miss"


def checks(spec_pool: dict, res_pool: dict, pct: float) -> list[dict]:
    """One pool's model-vs-simulation rows, each judged by RULE."""
    a, lat = spec_pool["analytic"], spec_pool["analytic"]["latency"]
    stages = {s["k"]: s for s in spec_pool["stages"]}
    rows = []

    def row(kind, check, model, simc, w, verdict=None, note="", part=None):
        rows.append({"kind": kind, "check": check, "part": part, "model": model, "sim": simc, "w": w,
                     "verdict": verdict or judge(model, simc, w), "note": note})

    names = {p["k"]: p["name"] for p in spec_pool["parts"]}
    worst = a["worst"]
    on_path = next((p["on_path"] for p in spec_pool["parts"] if p["k"] == worst["k"]), False)
    busiest = max((s for s in spec_pool["stages"] if s["level"] == "block"), key=lambda s: s["util"])
    note = "" if on_path else (f"The model's busiest part, {worst['name']}, is not a queued stage in the simulation; "
                               f"this compares the busiest queued stage, {busiest['name']}.")
    row("ceiling", "Ceiling: the most loaded queued stage sets the rate", a["path_ceiling_Bps"], res_pool["ceiling_Bps"],
        RULE["ceiling"], note=note, part=busiest["k"])

    if a["unbounded"]:
        over = [s for s in spec_pool["stages"] if s["level"] in ("block", "packet") and s["util"] >= 1]
        only_noc = bool(over) and all(s["level"] == "packet" for s in over)
        d = res_pool["drift"]
        if only_noc:
            row("unbounded", "Unbounded latency", None, d, None, verdict="n/a",
                note="Only the on-chip network is overloaded; the simulation queues its packets at the model's own "
                     "utilisation, so both are unbounded by construction.")
        else:
            grows = d["lo"] is None or d["lo"] > RULE["drift_min"]
            row("unbounded", "Unbounded latency: the backlog keeps growing", None, d, None,
                verdict="pass" if grows else "miss",
                note="Overloaded: " + ", ".join(f"{s['name']} ({s['util']:.0%})" for s in over) + ".")
        return rows

    for k, c in res_pool["util"].items():
        u = stages[k]["util"]
        if u >= RULE["util_min"]:
            row("util", f"Utilisation: {stages[k]['name']}", u, c, RULE["util"], part=k)
    row("mean", "Mean latency", lat["mean_s"], res_pool["mean_s"], RULE["mean"])
    for k, c in res_pool["wait_s"].items():
        q = stages[k]["wait_s"]
        if q is not None and q >= RULE["wait_share_min"] * lat["mean_s"]:
            row("wait", f"Queueing wait (Kingman): {stages[k]['name']}", q, c, RULE["wait"], part=k,
                note=f"{q / lat['mean_s']:.0%} of the mean latency; utilisation {stages[k]['util']:.0%}.")
    pname = f"p{pct * 100:g}"
    row("pct", f"Latency {pname}", lat["pX_s"], res_pool["pX_s"], RULE["pct"])
    c = res_pool["pX_s"]
    row("stack", f"Tolerance stack bounds the {pname}", lat["stack_s"], c, None,
        verdict="pass" if lat["stack_s"] >= c["lo"] else "miss",
        note=f"Stack is {lat['stack_s'] / c['mean']:.2f} × the simulated {pname}.")
    return rows


def judged(spec: dict, res: dict) -> list[dict]:
    """Every pool's model-vs-simulation rows for a simulated spec."""
    pct = spec["workload"]["percentile"]
    return [{"name": sp["name"], "rows": checks(sp, rp, pct)} for sp, rp in zip(spec["pools"], res["pools"])]


def default_blocks(pct: float) -> int:
    """Enough blocks per run for the tail: about 20 beyond the design's percentile, at least 20,000, at most 100,000."""
    return int(min(100000, max(20000, 20 / (1 - pct))))


def simulate(spec: dict, runs: int = 200, seed: int = 1, blocks: int | None = None, warm: int | None = None,
             progress=None) -> dict:
    """Simulate every pool in a design spec; the result carries the spec's analytic figures alongside."""
    if spec.get("schema") != SCHEMA:
        raise ValueError(f"expected schema {SCHEMA}, got {spec.get('schema')}")
    w = spec["workload"]
    pct = w["percentile"]
    blocks = blocks or default_blocks(pct)
    warm = warm if warm is not None else max(1000, blocks // 10)
    pools = [simulate_pool(Pool.from_json(p, w), pct, runs, seed, blocks + warm, warm, progress) for p in spec["pools"]]
    return {"schema": SCHEMA + "/result", "sim_version": VERSION, "simpy": simpy.__version__,
            "design": spec.get("design", {}), "runs": runs, "seed": seed, "blocks": blocks, "warmup": warm,
            "percentile": pct, "pools": pools}


def jsonable(o):
    """The result as standard JSON values: infinite or undefined figures (an unbounded queue) become null."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    return o


def dumps(res: dict, **kw) -> str:
    return json.dumps(jsonable(res), allow_nan=False, **kw)


def _fmt_s(x):
    if x is None or not math.isfinite(x):
        return "∞"
    for unit, f in (("s", 1), ("ms", 1e-3), ("µs", 1e-6), ("ns", 1e-9)):
        if abs(x) >= f:
            return f"{x / f:.4g} {unit}"
    return f"{x / 1e-9:.3g} ns"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("spec", help="design.json exported from the explorer")
    ap.add_argument("--runs", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--blocks", type=int, default=None, help="measured blocks per run (default: by percentile)")
    ap.add_argument("--json", default=None, help="write the results here")
    a = ap.parse_args(argv)
    with open(a.spec) as f:
        spec = json.load(f)
    res = simulate(spec, runs=a.runs, seed=a.seed, blocks=a.blocks,
                   progress=lambda n, r, R: print(f"\r{n}: run {r}/{R}", end="", file=sys.stderr))
    print(file=sys.stderr)
    pX = f"p{res['percentile'] * 100:g}"
    for p, sp in zip(res["pools"], spec["pools"]):
        a_ = sp["analytic"]
        print(f"{p['name']}  ({res['runs']} runs × {res['blocks']} blocks, seed {res['seed']})")
        for key, label, ref in (("mean_s", "mean", a_["latency"]["mean_s"]), ("p50_s", "p50", None),
                                ("p99_s", "p99", None), ("p999_s", "p99.9", None), ("pX_s", pX, a_["latency"]["pX_s"])):
            c = p[key]
            model = f"   model {_fmt_s(ref)}" if ref is not None else ""
            print(f"  latency {label:6} {_fmt_s(c['mean']):>12}  [{_fmt_s(c['lo'])}, {_fmt_s(c['hi'])}]{model}")
        c = p["ceiling_Bps"]
        print(f"  ceiling        {c['mean'] / 1e9:12.4g} GB/s  [{c['lo'] / 1e9:.4g}, {c['hi'] / 1e9:.4g}]"
              f"   model {a_['path_ceiling_Bps'] / 1e9:.4g} GB/s")
        for k, c in p["wait_s"].items():
            q = next(s["wait_s"] for s in sp["stages"] if s["k"] == k)
            print(f"  wait {k:9} {_fmt_s(c['mean']):>12}  [{_fmt_s(c['lo'])}, {_fmt_s(c['hi'])}]   model {_fmt_s(q)}")
        for k, c in p["util"].items():
            u = next(s["util"] for s in sp["stages"] if s["k"] == k)
            if c["mean"] is not None and math.isfinite(c["mean"]):
                print(f"  util {k:9} {c['mean']:12.4f}  [{c['lo']:.4f}, {c['hi']:.4f}]   model {u:.4f}")
    print("model vs simulation (rule: sim/TOLERANCE.md)")
    for p in judged(spec, res):
        for r in p["rows"]:
            print(f"  {r['verdict']:4}  {p['name']}: {r['check']}" + (f"  ({r['note']})" if r["note"] and r["verdict"] != "pass" else ""))
    if a.json:
        with open(a.json, "w") as f:
            f.write(dumps(res, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
