#!/usr/bin/env python3
"""Benchmark: native Rust decode core vs the pure-Python reference decoder.

For each payload it:
  1. Decodes with both the pure-Python `decode.py` and the native `graft_native`
     extension, and asserts the two value graphs are EQUAL (correctness gate —
     no point timing a decoder that returns the wrong thing).
  2. Times three things:
       py-decode     pure Python   bytes -> native Python objects   (baseline)
       rust-decode   PyO3          bytes -> native Python objects   (realistic
                                                                     binding UX)
       rust-parse    PyO3          bytes -> Rust objects (count)    (parse
                                                                     ceiling / a
                                                                     Rust consumer)
  3. Prints throughput (MB/s) and the speedup over the pure-Python baseline.

Build the extension first (see README.md), then:  python3 bench.py
"""

from __future__ import annotations

import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY_PORT = os.path.normpath(os.path.join(HERE, "..", "..", "conformance", "python"))
sys.path.insert(0, PY_PORT)
sys.path.insert(0, HERE)

from decode import decode as py_decode  # noqa: E402

try:
    import graft_native  # noqa: E402
except ImportError as e:  # pragma: no cover
    print(f"cannot import graft_native ({e}). Build it first — see README.md.")
    sys.exit(1)


def time_it(fn, data: bytes, min_time: float = 1.5) -> tuple[float, int]:
    """Run fn(data) repeatedly for at least min_time seconds; return per-call
    seconds and the iteration count. A warmup call primes caches/JIT-free
    interpreter state so the first call isn't penalised."""
    fn(data)  # warmup
    iters = 0
    start = time.perf_counter()
    deadline = start + min_time
    # Batch in small groups so the clock check isn't the bottleneck.
    while True:
        for _ in range(8):
            fn(data)
        iters += 8
        if time.perf_counter() >= deadline:
            break
    elapsed = time.perf_counter() - start
    return elapsed / iters, iters


def mbps(nbytes: int, per_call: float) -> float:
    return (nbytes / (1024 * 1024)) / per_call


def assert_equal(a, b, path: str = "$") -> None:
    if type(a) is not type(b):
        raise AssertionError(f"{path}: type {type(a).__name__} != {type(b).__name__}")
    if isinstance(a, dict):
        if a.keys() != b.keys():
            raise AssertionError(f"{path}: key sets differ")
        for k in a:
            assert_equal(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if len(a) != len(b):
            raise AssertionError(f"{path}: len {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            assert_equal(x, y, f"{path}[{i}]")
    else:
        if a != b:
            raise AssertionError(f"{path}: {a!r} != {b!r}")


def bench_one(name: str, data: bytes) -> None:
    nodes = graft_native.parse_count(data)

    # correctness gate
    assert_equal(py_decode(data), graft_native.decode(data))

    py_t, _ = time_it(py_decode, data)
    rs_t, _ = time_it(graft_native.decode, data)
    rp_t, _ = time_it(graft_native.parse_count, data)

    print(f"\n{name}  ({len(data):,} bytes, {nodes:,} heap nodes)")
    print(f"  {'':14s} {'us/call':>12s} {'MB/s':>10s} {'speedup':>9s}")
    rows = [
        ("py-decode", py_t, 1.0),
        ("rust-decode", rs_t, py_t / rs_t),
        ("rust-parse", rp_t, py_t / rp_t),
    ]
    for label, t, speedup in rows:
        print(f"  {label:14s} {t * 1e6:12.2f} {mbps(len(data), t):10.1f} {speedup:8.1f}x")


def main() -> int:
    payloads = ["small.bin", "large.bin"]
    missing = [p for p in payloads if not os.path.exists(os.path.join(HERE, p))]
    if missing:
        print(f"missing payloads {missing} — run: python3 gen_payload.py")
        return 1

    print("Graft native-core benchmark")
    print(f"  python   {sys.version.split()[0]}")
    print("  baseline = pure-Python decode.py -> native Python objects")

    for name in payloads:
        with open(os.path.join(HERE, name), "rb") as f:
            bench_one(name, f.read())
    return 0


if __name__ == "__main__":
    sys.exit(main())
