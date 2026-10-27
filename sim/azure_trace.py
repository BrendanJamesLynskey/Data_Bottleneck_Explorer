"""Real request traces for the simulator: Microsoft's Azure LLM inference traces (2023), from the Splitwise paper.

Each trace is one row per request: arrival time, prompt tokens, reply tokens (see traces/SOURCE.md for provenance,
licence and attribution). This module loads a trace, refusing a file whose SHA-256 has changed; describes it in the
explorer's own terms (arrival CV, peak-to-average over windows, prompt-size spread); and resamples it for replay.

Replay keeps the trace's shape and changes only its scale. Each run is a moving-block bootstrap: the trace is cut
into 60-second segments, and segments drawn at random (seeded) are laid end to end to the trace's length. Bursts
shorter than a segment survive, and run-to-run spread reflects the traffic as well as the hardware's jitter. Times
are then stretched so the average request rate equals the design's.
"""

from __future__ import annotations

import csv
import hashlib
import math
import os
import random
import statistics
from dataclasses import dataclass
from datetime import datetime

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "traces")
TRACES = {
    "code": ("AzureLLMInferenceTrace_code.csv", "54e9a6d2a4bd06ba1e060304b900abbc74cbea53de96506e60fe5bb4f2277fb6",
             "code completion"),
    "conv": ("AzureLLMInferenceTrace_conv.csv", "2f1e5b666d4e3055fdbba98598ce2ec307767b9064e03e2fa46676dbcc7d0bf8",
             "conversation"),
}
SEGMENT_S = 60.0


@dataclass
class Trace:
    name: str
    service: str
    t: list[float]             # arrival times, s from the first request
    prompt: list[int]          # ContextTokens
    reply: list[int]           # GeneratedTokens

    @property
    def span(self) -> float:
        return self.t[-1] - self.t[0]


def load(name: str) -> Trace:
    """Load a trace by name ("code" or "conv"), checking its SHA-256 against the pinned copy."""
    fname, sha, service = TRACES[name]
    path = os.path.join(HERE, fname)
    with open(path, "rb") as f:
        raw = f.read()
    got = hashlib.sha256(raw).hexdigest()
    if got != sha:
        raise ValueError(f"{fname}: SHA-256 {got} differs from the pinned {sha}")
    rows = list(csv.DictReader(raw.decode("utf-8-sig").splitlines()))
    # timestamps carry seven decimal places; Python reads six
    ts = [datetime.fromisoformat(r["TIMESTAMP"][:26]).timestamp() for r in rows]
    order = sorted(range(len(rows)), key=lambda i: ts[i])
    t0 = ts[order[0]]
    return Trace(name, service, [ts[i] - t0 for i in order], [int(rows[i]["ContextTokens"]) for i in order],
                 [int(rows[i]["GeneratedTokens"]) for i in order])


def _cv(xs: list[float]) -> float:
    m = statistics.fmean(xs)
    return statistics.pstdev(xs) / m if m > 0 else math.nan


def _q(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return s[min(len(s) - 1, int(p * len(s)))]


def peak_to_average(t: list[float], window: float, weight: list[float] | None = None) -> float:
    """Busiest window's request count (or total weight, e.g. prompt tokens) over the average window's, over whole
    windows of the trace."""
    n = int((t[-1] - t[0]) // window)
    counts = [0.0] * n
    for j, x in enumerate(t):
        i = int((x - t[0]) // window)
        if i < n:
            counts[i] += 1 if weight is None else weight[j]
    return max(counts) / statistics.fmean(counts)


def stats(tr: Trace) -> dict:
    """The trace in the explorer's terms."""
    gaps = [b - a for a, b in zip(tr.t, tr.t[1:])]
    return {"name": tr.name, "service": tr.service, "requests": len(tr.t), "span_s": tr.span,
            "rate_per_s": (len(tr.t) - 1) / tr.span, "arrival_cv": _cv(gaps),
            "peak_to_average": {f"{w:g}s": peak_to_average(tr.t, w) for w in (1.0, 10.0, 60.0)},
            # the busiest minute's prompt tokens over the average minute's: the load the busiest-spell input takes
            "token_peak_to_average": {"60s": peak_to_average(tr.t, 60.0, tr.prompt)},
            "prompt": {"mean": statistics.fmean(tr.prompt), "p50": _q(tr.prompt, 0.5), "p99": _q(tr.prompt, 0.99), "cv": _cv(tr.prompt)},
            "reply": {"mean": statistics.fmean(tr.reply), "p50": _q(tr.reply, 0.5), "p99": _q(tr.reply, 0.99), "cv": _cv(tr.reply)}}


def bootstrap(tr: Trace, seed: int, segment: float = SEGMENT_S) -> list[tuple[float, int]]:
    """One replay: whole segments of the trace drawn with replacement and laid end to end, as (time, prompt) pairs."""
    n = int(tr.span // segment)
    segs: list[list[tuple[float, int]]] = [[] for _ in range(n)]
    for x, p in zip(tr.t, tr.prompt):
        i = int(x // segment)
        if i < n:
            segs[i].append((x - i * segment, p))
    r = random.Random(seed)
    out = []
    for j in range(n):
        out.extend((j * segment + dx, p) for dx, p in segs[r.randrange(n)])
    return out


def scale_to(arrivals: list[tuple[float, int]], rate: float) -> list[tuple[float, int]]:
    """Stretch the times so the average request rate is `rate` per second; sizes unchanged."""
    span = arrivals[-1][0] - arrivals[0][0]
    f = (len(arrivals) - 1) / span / rate
    t0 = arrivals[0][0]
    return [((t - t0) * f, p) for t, p in arrivals]
