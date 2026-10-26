"""Model vs simulation over every example: run sim.py on each exported spec and judge each analytic figure by the rule
fixed in TOLERANCE.md. Writes sim/results.json, which the Checks tab shows (tools/sim_sync.js embeds it in the page).

    python sim/compare.py                     run every example, write sim/results.json
    python sim/compare.py --check --jobs 4    CI: re-run and fail if any verdict or figure differs from the committed file
    python sim/compare.py --only llm radar    a few examples, printed, nothing written
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sim  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results.json")

# the settings fixed in TOLERANCE.md; the rule itself is sim.RULE, so the page's in-browser run judges rows the same way
SETTINGS = {"runs": 10, "seed": 1, "blocks": 20000, "warmup": 2000}


def run_example(path: str) -> dict:
    with open(path) as f:
        spec = json.load(f)
    pct = spec["workload"]["percentile"]
    res = sim.simulate(spec, runs=SETTINGS["runs"], seed=SETTINGS["seed"], blocks=SETTINGS["blocks"], warm=SETTINGS["warmup"])
    pools = []
    for sp, rp in zip(spec["pools"], res["pools"]):
        pools.append({"name": sp["name"], "rows": sim.checks(sp, rp, pct),
                      "sim": {k: rp[k] for k in ("mean_s", "p50_s", "p99_s", "p999_s", "pX_s", "throughput_Bps", "drift")}})
    return sim.jsonable({"id": spec["design"]["example"], "name": spec["design"]["name"], "percentile": pct,
                         "model_hash": spec["explorer"]["model_hash"], "pools": pools})


def summary(examples: list[dict]) -> dict:
    rows = [r for e in examples for p in e["pools"] for r in p["rows"]]
    by = {}
    for r in rows:
        b = by.setdefault(r["kind"], {"pass": 0, "miss": 0, "n/a": 0})
        b[r["verdict"]] += 1
    return {"rows": len(rows), "pass": sum(r["verdict"] == "pass" for r in rows),
            "miss": sum(r["verdict"] == "miss" for r in rows), "na": sum(r["verdict"] == "n/a" for r in rows), "by_kind": by}


def close(a, b, rel=1e-6) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k], rel) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y, rel) for x, y in zip(a, b))
    if isinstance(a, float) and isinstance(b, (int, float)) or isinstance(b, float) and isinstance(a, (int, float)):
        return a == b or abs(a - b) <= rel * max(abs(a), abs(b))
    return a == b


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Model vs simulation over every example, by the rule in TOLERANCE.md")
    ap.add_argument("--check", action="store_true", help="re-run and compare with the committed results.json")
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--only", nargs="*", help="example ids; prints, writes nothing")
    a = ap.parse_args(argv)
    paths = sorted(glob.glob(os.path.join(HERE, "examples", "*.json")))
    if a.only:
        paths = [p for p in paths if os.path.basename(p)[:-5] in a.only]
    with ProcessPoolExecutor(a.jobs) if a.jobs > 1 else _Serial() as ex:
        examples = list(ex.map(run_example, paths))
    for e in examples:
        for p in e["pools"]:
            for r in p["rows"]:
                if r["verdict"] != "pass":
                    print(f"{r['verdict']:4} {e['id']}/{p['name']}: {r['check']}  model {r['model']}  sim {r['sim']}  {r['note']}")
    out = {"schema": sim.SCHEMA + "/compare", "sim_version": sim.VERSION, "simpy": sim.simpy.__version__,
           "rule": sim.RULE, "settings": SETTINGS, "summary": summary(examples), "examples": examples}
    s = out["summary"]
    print(f"{s['rows']} rows: {s['pass']} pass, {s['miss']} miss, {s['na']} not counted ({len(examples)} examples)")
    if a.only:
        return 0
    if a.check:
        with open(RESULTS) as f:
            old = json.load(f)
        old_v = [(e["id"], p["name"], r["check"], r["verdict"]) for e in old["examples"] for p in e["pools"] for r in p["rows"]]
        new_v = [(e["id"], p["name"], r["check"], r["verdict"]) for e in examples for p in e["pools"] for r in p["rows"]]
        if old_v != new_v or not close(old, json.loads(sim.dumps(out))):
            print("FAIL the simulation results differ from sim/results.json (re-run python sim/compare.py and commit)")
            return 1
        print("ok   model vs simulation reproduces sim/results.json")
        return 0
    with open(RESULTS, "w") as f:
        f.write(sim.dumps(out, indent=1) + "\n")
    print("wrote sim/results.json")
    return 0


class _Serial:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def map(self, f, xs):
        return map(f, xs)


if __name__ == "__main__":
    sys.exit(main())
