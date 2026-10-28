"""Cross-check: the explorer's LLM serving figures against Disaggregated_Inference_Sim, the owner's SimPy simulator of
prefill/decode serving (pinned in sim/requirements.txt), by the rule in TOLERANCE.md ("Cross-check:
Disaggregated_Inference_Sim"). Writes sim/disagg_results.json, which the Checks tab shows.

    python sim/disagg_compare.py --jobs 2     run every design, write sim/disagg_results.json
    python sim/disagg_compare.py --check      CI: re-run and fail if anything differs from the committed file

The specs come from the page (simLlmSpec, exported by tools/sim_sync.js to sim/disagg/specs/). Each gives the
simulator the explorer's own hardware figures, so the two differ only in how they model serving: the explorer's
steady-state stages in series against the simulator's requests, continuous batching and roofline steps.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

from disagg_sim.hardware import MODELS, Accelerator, Link
from disagg_sim.sim import SimConfig, Simulation, simulate
from disagg_sim.workload import Request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sim  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SPECS = os.path.join(HERE, "disagg", "specs")
RESULTS = os.path.join(HERE, "disagg_results.json")
DESIGNS = ["llmserve", "llmserve_b128", "llmserve_b32", "llmserve_8b", "llmsplit"]
SPLIT = "llmsplit"            # its prefill pool serves the decode-only designs, whose prefill isn't judged
DISAGG_COMMIT = "a2c14e23f300bb04881e392d453280d961d4113e"
# fixed in TOLERANCE.md before the first run: ±10 % for the two tools' deterministic figures, the per-example
# widening of the CI for the simulated ones, matching verdicts against each budget
RULE = {"step": 0.10, "fit": 0.10, "mean": sim.RULE["mean"], "pct": sim.RULE["pct"]}
SETTINGS = {"runs": 10, "seed": 1, "lifetimes": 6, "warmup_frac": 1 / 3}
FORMATS = {2: "bf16", 1: "fp8", 0.5: "fp4"}


def load(name: str) -> dict:
    with open(os.path.join(SPECS, name + ".json")) as f:
        return json.load(f)


def prompt_of(spec: dict) -> int:
    """The prompt length: the design's own, or for a decode-only design the context less half the reply, so the
    average context during decode matches the explorer's."""
    w = spec["workload"]
    return round(w["prompt"]) if w["prefill"] else round(w["ctx"] - w["reply"] / 2)


def config(spec: dict) -> SimConfig:
    """The design in the simulator's terms, on the explorer's own hardware figures."""
    w, d, dec = spec["workload"], spec["device"], spec["decode"]
    pre = (spec if spec["prefill"] else load(SPLIT))["prefill"]
    dev = Accelerator("explorer: " + spec["design"]["name"], peak_flops=d["peak_8bit_ops"] / 2, mem_bw=d["dram_peak_Bps"],
                      mem_capacity=d["capacity_B"], flops_eff=d["util"], bw_eff=d["dram_eff"],
                      native_formats=(("fp8", 2.0), ("int8", 2.0), ("fp4", 4.0)))
    wf, kf = FORMATS[spec["model"]["w_bytes"]], FORMATS[spec["model"]["kv_bytes"]]
    return SimConfig(model=MODELS[spec["model"]["disagg"]], device=dev, mode="disagg",
                     n_prefill=round(pre["copies"]), n_decode=round(dec["copies"]),
                     prefill_devices_per_instance=round(pre["accelerators_per_copy"]),
                     decode_devices_per_instance=round(dec["accelerators_per_copy"]),
                     link=Link("explorer NICs", bandwidth=pre["nic_Bps_per_copy"], channels=round(pre["copies"])),
                     max_prefill_tokens=prompt_of(spec), max_decode_batch=round(w["batch"]),
                     ttft_slo=spec["prefill"]["analytic"]["budget_s"] if spec["prefill"] else math.inf,
                     tpot_slo=1 / w["tps"], warmup_frac=SETTINGS["warmup_frac"],
                     weight_format=wf, kv_format=kf, compute_format=wf)


def workload(spec: dict, seed: int) -> list[Request]:
    """Requests at the design's rate with gamma gaps at its arrival CV, for six lifetimes at its tokens per second."""
    w = spec["workload"]
    rate = w["users"] * w["tps"] / w["reply"]
    n = int(rate * SETTINGS["lifetimes"] * w["reply"] / w["tps"])
    r, ca, t, out = random.Random(seed), w["arrival_cv"], 0.0, []
    for i in range(n):
        out.append(Request(i, t, prompt_of(spec), round(w["reply"])))
        t += r.gammavariate(1 / ca**2, ca**2 / rate) if ca > 0 else 1 / rate
    return out


def run(args: tuple[str, int]) -> dict:
    """One seeded run of one design: its p99 time per output token, and its time to first token."""
    name, seed = args
    spec = load(name)
    res = simulate(config(spec), workload(spec, seed))
    done = sorted((r for r in res.requests if r.finish is not None), key=lambda r: r.arrival)
    steady = done[int(len(done) * SETTINGS["warmup_frac"]):]
    pct = spec["workload"]["percentile"]
    tpot, ttft = sorted(r.tpot for r in steady if r.tpot is not None), sorted(r.ttft for r in steady)
    # not judged: how evenly the prefill instances share the prompts, and how long a prompt waits for one
    busy = [i.busy / res.horizon for i in res.instances if i.name.startswith("prefill")]
    return {"name": name, "requests": len(res.requests), "finished": len(done), "tpot_p99": sim.quantile(tpot, 0.99),
            "tpot_mean": statistics.fmean(tpot), "ttft_mean": statistics.fmean(ttft), "ttft_pX": sim.quantile(ttft, pct),
            "prefill_wait": statistics.fmean(r.prefill_start - r.arrival for r in steady), "prefill_busy": busy}


def costs(spec: dict) -> dict:
    """The simulator's cost model on the design: a decode step at its batch and context, the KV-cache users that fit
    per instance, and (split) one prompt's prefill step."""
    s = Simulation(config(spec), [])
    w, B = spec["workload"], round(spec["workload"]["batch"])
    cd = s.cost_for("decode")
    # not judged: each step's arithmetic and memory times (the roofline takes the larger), its fixed overhead, and what
    # bound it ("power": the simulator's default power model, an illustrative H100's, stretched it to fit 700 W)
    parts = lambda c, st: {"arithmetic": st.flops / c.flops_rate, "memory": st.bytes / c.byte_rate, "overhead": c.step_overhead,
                           "bound": st.bound}
    d = cd.decode_sum(round(B * w["ctx"]), B)
    out = {"decode_step_s": d.time, "decode_parts_s": parts(cd, d), "users_fit": cd.kv_capacity_tokens / w["ctx"],
           "memory_allowance": cd.mem_util}
    if spec["prefill"]:
        cp = s.cost_for("prefill")
        p = cp.prefill([prompt_of(spec)])
        out["prefill_step_s"], out["prefill_parts_s"] = p.time, parts(cp, p)
    return out


def rows_for(spec: dict, cost: dict, runs: list[dict]) -> list[dict]:
    a, rows = spec["decode"]["analytic"], []

    def near(kind, check, model, other, note=""):
        ok = model is not None and abs(model / other - 1) <= RULE[kind]
        rows.append({"kind": kind, "check": check, "model": model, "sim": other, "w": RULE[kind],
                     "verdict": "pass" if ok else "miss", "note": note})

    def meets(check, model, simc, budget, note=""):
        m_ok, s_ok = model is not None and model <= budget, simc["mean"] <= budget
        rows.append({"kind": "budget", "check": check, "model": model, "sim": simc, "budget": budget,
                     "model_meets": m_ok, "sim_meets": s_ok, "verdict": "pass" if m_ok == s_ok else "miss", "note": note})

    w = spec["workload"]
    near("step", f"Decode step, batch {w['batch']:g} at {w['ctx']:g} tokens of context", a["step_s"], cost["decode_step_s"])
    near("fit", "Users per copy that fit in memory", a["users_fit"], cost["users_fit"])
    meets(f"Decode meets its budget ({a['head_label']} per step against p99 time per output token)", a["latency_head_s"],
          sim.ci([r["tpot_p99"] for r in runs]), a["budget_s"])
    if spec["prefill"]:
        p = spec["prefill"]["analytic"]
        pname = f"p{w['percentile'] * 100:g}"
        near("step", f"Prefill of one {prompt_of(spec):,}-token prompt", p["step_s"], cost["prefill_step_s"])
        for kind, check, model, key in (("mean", "Mean time to first token", p["ttft_mean_s"], "ttft_mean"),
                                        ("pct", f"Time to first token, {pname}", p["ttft_pX_s"], "ttft_pX")):
            c = sim.ci([r[key] for r in runs])
            rows.append({"kind": kind, "check": check, "model": model, "sim": c, "w": RULE[kind],
                         "verdict": "pass" if model is not None and sim.judge(model, c, RULE[kind]) == "pass" else "miss",
                         "note": "" if model is not None else "The model calls this unbounded."})
        meets(f"Time to first token meets its budget ({pname})", p["ttft_head_s"], sim.ci([r["ttft_pX"] for r in runs]),
              p["budget_s"])
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="The explorer's LLM serving designs against Disaggregated_Inference_Sim")
    ap.add_argument("--check", action="store_true", help="re-run and compare with the committed disagg_results.json")
    ap.add_argument("--jobs", type=int, default=1)
    a = ap.parse_args(argv)
    jobs = [(n, SETTINGS["seed"] * 1000003 + r) for n in DESIGNS for r in range(SETTINGS["runs"])]
    if a.jobs > 1:
        with ProcessPoolExecutor(a.jobs) as ex:
            out = list(ex.map(run, jobs))
    else:
        out = [run(j) for j in jobs]
    designs = []
    for n in DESIGNS:
        spec, runs = load(n), [r for r in out if r["name"] == n]
        cost = costs(spec)
        rows = rows_for(spec, cost, runs)
        sims = {k: sim.ci([r[k] for r in runs]) for k in ("tpot_mean", "tpot_p99", "ttft_mean", "ttft_pX", "prefill_wait")}
        sims["prefill_busy"] = [statistics.fmean(r["prefill_busy"][i] for r in runs) for i in range(len(runs[0]["prefill_busy"]))]
        designs.append({"id": n, "name": spec["design"]["name"], "link": spec["design"]["link"],
                        "model_hash": spec["explorer"]["model_hash"], "cost": cost, "sim": sims,
                        "explorer_parts_s": {"decode": spec["decode"]["analytic"]["step_parts_s"],
                                             "prefill": spec["prefill"]["analytic"]["step_parts_s"] if spec["prefill"] else None},
                        "requests": runs[0]["requests"], "unfinished": sum(r["requests"] - r["finished"] for r in runs),
                        "rows": rows})
        for r in rows:
            m = r["model"]
            s = r["sim"] if not isinstance(r["sim"], dict) else f"{r['sim']['mean']:.6g} [{r['sim']['lo']:.6g}, {r['sim']['hi']:.6g}]"
            print(f"{r['verdict']:4} {n}: {r['check']}  explorer {m if m is None else round(m, 6)}  simulator {s}")
    rows = [r for d in designs for r in d["rows"]]
    res = sim.jsonable({"schema": sim.SCHEMA + "/disagg", "disagg_sim": {"commit": DISAGG_COMMIT,
                        "url": "https://github.com/BrendanJamesLynskey/Disaggregated_Inference_Sim"},
                        "rule": RULE, "settings": SETTINGS,
                        "summary": {"rows": len(rows), "pass": sum(r["verdict"] == "pass" for r in rows)}, "designs": designs})
    print(f"{res['summary']['rows']} rows: {res['summary']['pass']} agree")
    if a.check:
        with open(RESULTS) as f:
            old = json.load(f)
        import compare
        if not compare.close(old, json.loads(sim.dumps(res))):
            print("FAIL the cross-check differs from sim/disagg_results.json (re-run python sim/disagg_compare.py and commit)")
            return 1
        print("ok   the Disaggregated_Inference_Sim cross-check reproduces sim/disagg_results.json")
        return 0
    with open(RESULTS, "w") as f:
        f.write(sim.dumps(res, indent=1) + "\n")
    print("wrote sim/disagg_results.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
