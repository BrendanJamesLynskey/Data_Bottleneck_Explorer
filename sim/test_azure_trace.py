"""The Azure traces load as published and the replay machinery does what it says.

    .venv/bin/python -m pytest sim
"""

import os
import shutil

import pytest

import azure_trace as trace
import sim


def test_traces_match_the_splitwise_paper():
    # Patel et al., ISCA 2024, section III: median prompts 1,500 (code) and 1,020 (conversation) tokens; replies 13, 129
    for name, prompt, reply in (("code", 1500, 13), ("conv", 1020, 129)):
        s = trace.stats(trace.load(name))
        assert abs(s["prompt"]["p50"] / prompt - 1) <= 0.03
        assert s["reply"]["p50"] == reply
    assert trace.stats(trace.load("code"))["requests"] == 8819
    assert trace.stats(trace.load("conv"))["requests"] == 19366


def test_refuses_a_changed_file(tmp_path, monkeypatch):
    fname = trace.TRACES["conv"][0]
    shutil.copy(os.path.join(trace.HERE, fname), tmp_path / fname)
    with open(tmp_path / fname, "a") as f:
        f.write("2023-11-16 19:14:09.0000000,1,1\n")
    monkeypatch.setattr(trace, "HERE", str(tmp_path))
    with pytest.raises(ValueError):
        trace.load("conv")


def test_bootstrap_is_seeded_and_scaling_hits_the_rate():
    tr = trace.load("conv")
    a, b, c = trace.bootstrap(tr, 7), trace.bootstrap(tr, 7), trace.bootstrap(tr, 8)
    assert a == b and a != c
    assert all(x[0] <= y[0] for x, y in zip(a, a[1:]))
    s = trace.scale_to(a, 31.0)
    assert abs((len(s) - 1) / (s[-1][0] - s[0][0]) / 31.0 - 1) < 1e-12
    assert [p for _, p in s] == [p for _, p in a]


def test_replay_serves_each_block_for_its_own_size():
    # one server, no jitter, arrivals far apart: each latency is exactly the table's service at that size
    pool = sim.Pool("t", 1.0, 1.0, 1, 0.0, 0.0, [sim.Stage("s", "server", "block", 0.0, 0.0, 0.1, 0.0)],
                    svc_table={"sizes": [100, 200, 400], "svc_s": {"s": [0.1, 0.2, 0.6]}})
    sizes = [100, 150, 200, 300, 400, 800]
    res = sim.run_once(pool, 1, 0, 0, arrivals=[(10.0 * i, x) for i, x in enumerate(sizes)])
    assert sorted(res.latencies) == pytest.approx(sorted([0.1, 0.15, 0.2, 0.4, 0.6, 1.4]))
