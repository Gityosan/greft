#!/usr/bin/env bash
# Build the PyO3 extension and link it under its import name.
# Requires: rustc/cargo, python3 with dev headers (Python.h), network for crates.io.
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release
# PyO3 emits lib<name>.so; Python imports <name>.so.
cp target/release/libgraft_native.so graft_native.so
python3 -c "import graft_native; print('graft_native ok:', dir(graft_native)[-2:])"
echo "built. run: python3 gen_payload.py && python3 bench.py"
