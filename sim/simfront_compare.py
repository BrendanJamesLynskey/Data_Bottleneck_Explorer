"""Cross-check: the Chip tab's matrix multiply against simfront.accel, the SimPy accelerator model in the owner's
Torch_Sim_Frontend (pinned in .github/workflows/checks.yml), by the rule in TOLERANCE.md ("Cross-check:
Torch_Sim_Frontend's accelerator model"). Writes sim/simfront_results.json, which the Checks tab shows.

    python sim/simfront_compare.py            run every design, write sim/simfront_results.json
    python sim/simfront_compare.py --check    CI: re-run and fail if anything differs from the committed file

The specs come from the page (simChipSpec, exported by tools/sim_sync.js to sim/simfront/specs/). Each gives the
simulator the explorer's own array, buffer and memory bandwidth, so the two differ only in how they model the
multiply: the explorer's mapping and best tiling in closed form against blocks run event by event through DMA
engines, a buffer and an output-stationary array.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from simfront.accel import AccelConfig, lower, report, simulate
from simfront.trace import Op, TensorMeta, Trace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sim  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SPECS = os.path.join(HERE, "simfront", "specs")
RESULTS = os.path.join(HERE, "simfront_results.json")
DESIGNS = ["chiparray", "chiparray_os", "llmserve", "llmserve_os", "llmserve_b32", "trainllm"]
SIMFRONT_COMMIT = "53b1419c9eb26fa01b4eb6f1fd2593a715c142d9"
# fixed in TOLERANCE.md before the first run: ±10 % for the three figures, matching verdicts for what bounds it
RULE = {"array": 0.10, "traffic": 0.10, "time": 0.10}


def load(name: str) -> dict:
    with open(os.path.join(SPECS, name + ".json")) as f:
        return json.load(f)


def config(spec: dict) -> AccelConfig:
    """The explorer's cores as one array at their combined clock; its SRAM, half per tile; its DRAM bandwidth as one
    channel, with an interconnect as fast. Latencies stay at the simulator's defaults."""
    c = spec["chip"]
    return AccelConfig(name=spec["design"]["example"], clock_hz=c["clock_hz"] * c["cores"], array_rows=c["rows"],
                       array_cols=c["cols"], buffer_bytes=int(c["sram_B"]), tile_fraction=0.5,
                       dram_bw=c["dram_Bps"], dram_channels=1, noc_bw=c["dram_Bps"])


def trace(spec: dict) -> Trace:
    """One aten.mm, C[M×N] = A[M×K] · B[K×N]: A the activations, B the weights, every element at the explorer's width."""
    g = spec["gemm"]
    e = int(g["bytes"])
    a, b, c = TensorMeta("A", (g["M"], g["K"]), e), TensorMeta("B", (g["K"], g["N"]), e, param=True), TensorMeta("C", (g["M"], g["N"]), e)
    op = Op("aten.mm", [a, b], [c], category="matmul", flops=2 * g["M"] * g["K"] * g["N"],
            bytes_read=a.nbytes + b.nbytes, bytes_written=c.nbytes, weight_bytes=b.nbytes)
    return Trace(spec["design"]["example"], "explorer", [op])


def run(spec: dict) -> dict:
    prog = lower(trace(spec), config(spec))
    tm, _ = simulate(prog)
    rep = report(prog, tm)
    tiles = prog.tiles
    array_s = sum(tm.comp_end[i] - tm.comp_start[i] for i in range(len(tiles)))
    memory_s = sum(tm.load_end[i] - tm.alloc[i] for i in range(len(tiles))) + \
        sum(tm.store_end[i] - tm.store_start[i] for i in range(len(tiles)) if tiles[i].stores)
    return {"time_s": tm.makespan, "array_s": array_s, "memory_s": memory_s,
            "traffic_B": sum(t.load_bytes + t.store_bytes for t in tiles),
            "loads_B": sum(t.load_bytes for t in tiles), "stores_B": sum(t.store_bytes for t in tiles),
            "bound": "compute" if array_s > memory_s else "DRAM",
            "tiles": len(tiles), "macs": sum(t.macs for t in tiles), "stalls_s": rep.stalls, "hotspot": rep.hotspot,
            "block": _block(prog)}


def _block(prog) -> dict:
    """The block size simfront.accel chose (the first tile's), for the diagnostics."""
    t = prog.tiles[0]
    return {"load_B": t.load_bytes, "store_B": t.store_bytes}


def rows_for(spec: dict, res: dict) -> list[dict]:
    a, rows = spec["analytic"], []

    def near(kind, check, model, other):
        ok = abs(model / other - 1) <= RULE[kind]
        rows.append({"kind": kind, "check": check, "model": model, "sim": other, "w": RULE[kind],
                     "verdict": "pass" if ok else "miss", "note": ""})

    near("array", "Array time", a["array_s"], res["array_s"])
    near("traffic", "DRAM traffic", a["traffic_B"], res["traffic_B"])
    near("time", "Time for the multiply", a["time_s"], res["time_s"])
    rows.append({"kind": "bound", "check": "What bounds it", "model": a["bound"], "sim": res["bound"],
                 "verdict": "pass" if a["bound"] == res["bound"] else "miss", "note": ""})
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="The Chip tab's matrix multiply against Torch_Sim_Frontend's simfront.accel")
    ap.add_argument("--check", action="store_true", help="re-run and compare with the committed simfront_results.json")
    a = ap.parse_args(argv)
    designs = []
    for n in DESIGNS:
        spec = load(n)
        res = run(spec)
        rows = rows_for(spec, res)
        g, c = spec["gemm"], spec["chip"]
        designs.append({"id": n, "name": spec["design"]["name"], "link": spec["design"]["link"],
                        "model_hash": spec["explorer"]["model_hash"], "gemm": g, "chip": c,
                        "explorer": spec["analytic"], "sim": res, "rows": rows})
        for r in rows:
            m, s = r["model"], r["sim"]
            print(f"{r['verdict']:4} {n}: {r['check']}  explorer {m if isinstance(m, str) else f'{m:.6g}'}  "
                  f"simfront.accel {s if isinstance(s, str) else f'{s:.6g}'}")
    rows = [r for d in designs for r in d["rows"]]
    out = sim.jsonable({"schema": sim.SCHEMA + "/simfront", "simfront": {"commit": SIMFRONT_COMMIT,
                        "url": "https://github.com/BrendanJamesLynskey/Torch_Sim_Frontend"}, "rule": RULE,
                        "summary": {"rows": len(rows), "pass": sum(r["verdict"] == "pass" for r in rows)}, "designs": designs})
    print(f"{out['summary']['rows']} rows: {out['summary']['pass']} agree")
    if a.check:
        with open(RESULTS) as f:
            old = json.load(f)
        import compare
        if not compare.close(old, json.loads(sim.dumps(out))):
            print("FAIL the cross-check differs from sim/simfront_results.json (re-run python sim/simfront_compare.py and commit)")
            return 1
        print("ok   the Torch_Sim_Frontend cross-check reproduces sim/simfront_results.json")
        return 0
    with open(RESULTS, "w") as f:
        f.write(sim.dumps(out, indent=1) + "\n")
    print("wrote sim/simfront_results.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
