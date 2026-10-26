"""The simulator against closed forms (M/M/1, M/D/1, a packet-level M/M/1) and its determinism under a fixed seed.

    .venv/bin/python -m pytest sim
"""

import math

import pytest

import sim


def spec(stages, rate, ca=1.0, corr=0.0, pct=0.99):
    return {"schema": sim.SCHEMA, "workload": {"arrival_cv": ca, "stage_corr": corr, "percentile": pct},
            "pools": [{"name": "test", "block_rate": rate, "block_B": 1.0, "accelerators": 1, "stages": stages}]}


def server(svc, dist, util, cv=1.0, fixed=0.0):
    return {"k": "s", "name": "server", "level": "block", "fixed_s": fixed, "fixed_cv": 0.0, "svc_s": svc,
            "svc_cv": cv, "util": util, "dist": dist}


def within(c, x, slack=0.0):
    """x lies in the confidence interval c, widened by a relative slack."""
    return c["lo"] * (1 - slack) <= x <= c["hi"] * (1 + slack)


def test_mm1():
    # λ = 0.7, μ = 1: sojourn is exponential with rate μ − λ, so mean 1/(μ−λ) and p99 = ln(100)/(μ−λ)
    lam, mu = 0.7, 1.0
    r = sim.simulate(spec([server(1 / mu, "exp", lam / mu)], lam), runs=20, seed=3, blocks=20000)["pools"][0]
    assert within(r["mean_s"], 1 / (mu - lam))
    assert within(r["wait_s"]["s"], lam / (mu * (mu - lam)))
    assert within(r["p99_s"], math.log(100) / (mu - lam), 0.02)
    assert within(r["util"]["s"], lam / mu)
    assert within(r["throughput_Bps"], lam, 0.01)
    assert within(r["ceiling_Bps"], mu, 0.01)


def test_md1():
    # Pollaczek–Khinchine with deterministic service: mean wait ρ/(2μ(1−ρ)), plus the service itself
    lam, mu = 0.8, 1.0
    rho = lam / mu
    r = sim.simulate(spec([server(1 / mu, "det", rho, cv=0.0)], lam), runs=20, seed=5, blocks=20000)["pools"][0]
    assert within(r["mean_s"], rho / (2 * mu * (1 - rho)) + 1 / mu)


def test_packet_stage_mm1():
    # the packet-level queue is Lindley's recursion; with Poisson arrivals and exponential packets its mean wait is ρ/(μ−λ)
    rho, svc = 0.6, 1e-8
    st = {"k": "noc", "name": "NoC", "level": "packet", "fixed_s": svc, "fixed_cv": 1.0, "svc_s": 0.0, "svc_cv": 0.0,
          "util": rho, "dist": "exp"}
    waits = [sim.statistics.fmean(sim.packet_waits(sim.Stage.from_json(st), 1.0, s, n=100000)) for s in range(10)]
    c = sim.ci(waits)
    assert within(c, rho * svc / (1 - rho))


def test_overloaded_drifts():
    r = sim.simulate(spec([server(1.0, "exp", 1.2)], 1.2), runs=5, seed=1, blocks=5000)["pools"][0]
    assert r["drift"]["lo"] > 2
    assert r["throughput_Bps"]["hi"] < 1.2 * 0.95


def test_deterministic_under_seed():
    s = spec([server(1.0, "lognormal", 0.5, cv=0.5, fixed=0.1), server(0.5, "lognormal", 0.25, cv=0.3)], 0.5, ca=0.5, corr=0.3)
    s["pools"][0]["stages"][1]["k"] = "t"
    a = sim.simulate(s, runs=3, seed=42, blocks=3000)
    b = sim.simulate(s, runs=3, seed=42, blocks=3000)
    c = sim.simulate(s, runs=3, seed=43, blocks=3000)
    assert a == b
    assert a["pools"][0]["mean_s"] != c["pools"][0]["mean_s"]


def test_rejects_other_schema():
    with pytest.raises(ValueError):
        sim.simulate({"schema": "something-else"})
