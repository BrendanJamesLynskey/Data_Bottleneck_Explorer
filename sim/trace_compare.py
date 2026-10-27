"""Model vs real traffic: replay Microsoft's Azure LLM traces through an LLM design's prefill pool and judge the
explorer's time-to-first-token figures by the rule in TOLERANCE.md ("Real traffic"). Writes sim/trace_results.json,
which the Checks tab shows.

    python sim/trace_compare.py --stats       describe the traces (sim/traces/stats.json; tools/sim_sync.js reads it)
    python sim/trace_compare.py               replay both traces, write sim/trace_results.json
    python sim/trace_compare.py --check       CI: re-run and fail if anything differs from the committed file

The specs come from the page (simTraceSpec, exported by tools/sim_sync.js to sim/traces/specs/): the split-pool
example moved to each trace's mean prompt at the same prompt-token rate, once as designed and once with the trace's
measured arrival CV. Both share the simulated pool; only the model's figures differ.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sim  # noqa: E402
import azure_trace as trace  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SPECS = os.path.join(HERE, "traces", "specs")
STATS = os.path.join(HERE, "traces", "stats.json")
RESULTS = os.path.join(HERE, "trace_results.json")
DESIGN = "llmsplit"
# fixed in TOLERANCE.md before the first replay: widening of the CI by kind, as for the per-example checks
RULE = {"mean": sim.RULE["mean"], "pct": sim.RULE["pct"], "util": sim.RULE["util"]}
SETTINGS = {"runs": 20, "seed": 1, "warmup_share": 0.05, "segment_s": trace.SEGMENT_S}


def spec_path(name: str, variant: str) -> str:
    return os.path.join(SPECS, f"{DESIGN}_{name}_{variant}.json")


def replay(name: str) -> dict:
    """Replay one trace through the as-designed prefill pool; per-run figures and their 95 % confidence intervals."""
    with open(spec_path(name, "designed")) as f:
        spec = json.load(f)
    pool = sim.Pool.from_json(spec["pools"][0], spec["workload"])
    pct = spec["workload"]["percentile"]
    tr = trace.load(name)
    per = {"mean": [], "p50": [], "p99": [], "pX": [], "drift": []}
    util = {s.k: [] for s in pool.servers()}
    wait = {s.k: [] for s in pool.servers()}
    for r in range(SETTINGS["runs"]):
        seed = SETTINGS["seed"] * 1000003 + r
        arrivals = trace.scale_to(trace.bootstrap(tr, seed), pool.block_rate)
        res = sim.run_once(pool, seed, 0, int(SETTINGS["warmup_share"] * len(arrivals)), arrivals=arrivals)
        lat = res.latencies
        per["mean"].append(statistics.fmean(lat))
        for key, p in (("p50", 0.5), ("p99", 0.99), ("pX", pct)):
            per[key].append(sim.quantile(lat, p))
        per["drift"].append(res.drift)
        for k in util:
            util[k].append(res.util[k])
            wait[k].append(res.wait[k])
    return {"mean_s": sim.ci(per["mean"]), "p50_s": sim.ci(per["p50"]), "p99_s": sim.ci(per["p99"]), "pX_s": sim.ci(per["pX"]),
            "drift": sim.ci(per["drift"]), "util": {k: sim.ci(v) for k, v in util.items()}, "wait_s": {k: sim.ci(v) for k, v in wait.items()}}


def diagnostics(name: str) -> dict:
    """Not judged: why the replays come out as they do. The load each minute of the trace puts on the busiest stage
    (at the design's average rate); the trace replayed once in its original order (no bootstrap); and the same prompts
    with random (Poisson) arrivals at the same rate."""
    with open(spec_path(name, "designed")) as f:
        spec = json.load(f)
    pool = sim.Pool.from_json(spec["pools"][0], spec["workload"])
    busy = max((s for s in pool.servers()), key=lambda s: s.util)
    tr = trace.load(name)
    arr = trace.scale_to(list(zip(tr.t, tr.prompt)), pool.block_rate)
    w = 60 * arr[-1][0] / tr.span
    n = int(arr[-1][0] // w)
    load = [0.0] * n
    for t, p in arr:
        if int(t // w) < n:
            load[int(t // w)] += pool.svc_of(busy, p) / w
    seed = SETTINGS["seed"]
    warm = int(SETTINGS["warmup_share"] * len(arr))
    orig = sorted(sim.run_once(pool, seed, 0, warm, arrivals=arr).latencies)
    r = random.Random(seed)
    t, pois = 0.0, []
    for _, p in arr:
        t += r.expovariate(pool.block_rate)
        pois.append((t, p))
    rand = sorted(sim.run_once(pool, seed, 0, warm, arrivals=pois).latencies)
    return {"stage": busy.name, "minutes": n, "minute_load": {"mean": statistics.fmean(load), "max": max(load),
            "over_0.9": sum(x > 0.9 for x in load)},
            "original_order": {"mean_s": statistics.fmean(orig), "p99_s": sim.quantile(orig, 0.99)},
            "poisson_arrivals": {"mean_s": statistics.fmean(rand), "p99_s": sim.quantile(rand, 0.99)}}


def rows_for(name: str, res: dict) -> list[dict]:
    rows = []
    for variant, label in (("designed", "as designed"), ("traceca", "with the trace's arrival CV")):
        with open(spec_path(name, variant)) as f:
            spec = json.load(f)
        p = spec["pools"][0]
        lat, pname = p["analytic"]["latency"], f"p{spec['workload']['percentile'] * 100:g}"
        ca = spec["workload"]["arrival_cv"]
        for kind, check, model, simc in (("mean", "Mean time to first token", lat["mean_s"], res["mean_s"]),
                                         ("pct", f"Time to first token, {pname}", lat["pX_s"], res["pX_s"])):
            ok = model is not None and sim.judge(model, simc, RULE[kind]) == "pass"
            rows.append({"kind": kind, "variant": variant, "check": f"{check}, model {label} (arrival CV {ca:.2g})",
                         "model": model, "sim": simc, "w": RULE[kind], "verdict": "pass" if ok else "miss",
                         "note": "" if model is not None else "The model calls this unbounded."})
        if variant == "designed":   # the load the replay put on the busiest stage, against the model's
            busy = max((s for s in p["stages"] if s["level"] == "block"), key=lambda s: s["util"])
            rows.append({"kind": "util", "variant": variant, "check": f"Utilisation: {busy['name']}", "part": busy["k"],
                         "model": busy["util"], "sim": res["util"][busy["k"]], "w": RULE["util"],
                         "verdict": sim.judge(busy["util"], res["util"][busy["k"]], RULE["util"]), "note": ""})
    return rows


def write_stats() -> dict:
    out = {name: trace.stats(trace.load(name)) for name in trace.TRACES}
    with open(STATS, "w") as f:
        f.write(json.dumps(out, indent=1) + "\n")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Replay the Azure LLM traces through the split-pool example's prefill pool")
    ap.add_argument("--stats", action="store_true", help="only describe the traces (writes sim/traces/stats.json)")
    ap.add_argument("--check", action="store_true", help="re-run and compare with the committed trace_results.json")
    a = ap.parse_args(argv)
    stats = write_stats() if not a.check else {name: trace.stats(trace.load(name)) for name in trace.TRACES}
    if a.stats:
        for s in stats.values():
            print(f"{s['service']}: {s['requests']} requests in {s['span_s'] / 60:.0f} min, arrival CV {s['arrival_cv']:.2f}, "
                  f"peak/avg {s['peak_to_average']}, prompt mean {s['prompt']['mean']:.0f} (CV {s['prompt']['cv']:.2f})")
        return 0
    traces = []
    for name in trace.TRACES:
        res = replay(name)
        rows = rows_for(name, res)
        traces.append({"name": name, "service": stats[name]["service"], "stats": stats[name], "sim": res, "rows": rows,
                       "diagnostics": diagnostics(name)})
        for r in rows:
            m = r["model"]
            print(f"{r['verdict']:4} {name}: {r['check']}  model {m if m is None else round(m, 6)}  "
                  f"sim {r['sim']['mean']:.6g} [{r['sim']['lo']:.6g}, {r['sim']['hi']:.6g}]")
    out = sim.jsonable({"schema": sim.SCHEMA + "/traces", "sim_version": sim.VERSION, "design": DESIGN, "rule": RULE,
                        "settings": SETTINGS, "source": "Azure LLM inference traces 2023 (Patel et al., Splitwise, ISCA 2024), CC-BY 4.0",
                        "traces": traces})
    if a.check:
        with open(RESULTS) as f:
            old = json.load(f)
        import compare
        if not compare.close(old, json.loads(sim.dumps(out))):
            print("FAIL the trace replays differ from sim/trace_results.json (re-run python sim/trace_compare.py and commit)")
            return 1
        print("ok   real-traffic replays reproduce sim/trace_results.json")
        return 0
    with open(RESULTS, "w") as f:
        f.write(sim.dumps(out, indent=1) + "\n")
    print("wrote sim/trace_results.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
