#!/usr/bin/env python3
"""Encoder round-trip check — Python port.

For every spec/golden/*.bin: decode it, re-encode the decoded value, and assert
the bytes are identical to the original. This proves the Python encoder is a
faithful clone of the reference encoder (same heap order + dedup + tag layout).

Run with:  python3 conformance/python/roundtrip.py
Exits non-zero on any mismatch.
"""

from __future__ import annotations

import os
import sys

from decode import decode
from encode import encode

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "spec", "golden"))


def main() -> int:
    files = sorted(f for f in os.listdir(GOLDEN_DIR) if f.endswith(".bin"))
    print(f"Graft encoder round-trip — Python port ({len(files)} vectors)\n")
    passed = 0
    failed = 0
    for name in files:
        try:
            with open(os.path.join(GOLDEN_DIR, name), "rb") as f:
                original = f.read()
            reencoded = encode(decode(original))
            if reencoded == original:
                print(f"  ok   {name} ({len(original)} bytes)")
                passed += 1
            else:
                print(f"  FAIL {name}: {len(original)} vs {len(reencoded)} bytes, not identical")
                failed += 1
        except Exception as err:  # noqa: BLE001
            print(f"  FAIL {name}: {err}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
