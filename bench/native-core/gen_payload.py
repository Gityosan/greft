#!/usr/bin/env python3
"""Generate JSON-shaped Graft payloads for the native-core benchmark.

Builds "mock fixture"-shaped data (a list of records with int/float/str/bool/
null fields and nested arrays/objects), encodes it with the reference Python
encoder (encode.py), and writes the bytes to disk. No Node/JS needed.

Two sizes are emitted:
  small.bin  — a handful of records (fixture-sized; exercises the FFI-overhead
               regime where per-call cost can dominate).
  large.bin  — tens of thousands of records (bulk fixtures; the regime where a
               native decoder is expected to pay off).

Usage:  python3 gen_payload.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY_PORT = os.path.normpath(os.path.join(HERE, "..", "..", "conformance", "python"))
sys.path.insert(0, PY_PORT)

from encode import encode  # noqa: E402


def make_record(i: int) -> dict:
    return {
        "id": i,
        "name": f"user_{i}",
        "email": f"user_{i}@example.com",
        "score": (i % 1000) * 0.5,
        "active": (i % 2) == 0,
        "deleted": None,
        "tags": [f"tag{i % 7}", f"tag{i % 13}", "common"],
        "profile": {
            "age": 18 + (i % 60),
            "city": ["Tokyo", "Osaka", "Kyoto", "Nagoya"][i % 4],
            "verified": (i % 3) == 0,
            "ratio": (i % 97) / 97.0,
        },
    }


def build(n: int) -> list:
    return [make_record(i) for i in range(n)]


def emit(name: str, n: int) -> None:
    data = encode(build(n))
    path = os.path.join(HERE, name)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  {name:10s} records={n:<7d} bytes={len(data):>10,d}")


def main() -> int:
    print("Generating payloads (encode.py reference encoder)\n")
    emit("small.bin", 5)
    emit("large.bin", 20_000)
    print("\ndone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
