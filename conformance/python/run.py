#!/usr/bin/env python3
"""Graft conformance runner — Python port.

Decodes every spec/golden/*.bin with `decode.py` and asserts the result against
the vector's .meta.json sidecar, following the parallel-walk algorithm in
../README.md §2 (bind each $ref on first sight, assert identity afterwards, so
shared references and cycles must be truly restored).

Run with:  python3 conformance/python/run.py
Exits non-zero if any vector fails.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

from decode import (
    UNDEFINED,
    Bytes,
    DataView,
    Date,
    GraftError,
    GraftMap,
    GraftSet,
    RegExp,
    Symbol,
    TypedArray,
    Url,
    decode,
)

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "spec", "golden"))


class Mismatch(Exception):
    pass


def _hex(data: bytes) -> str:
    return data.hex()


def match_vector(decoded: Any, meta: dict) -> None:
    nodes = meta["nodes"]
    bound: dict = {}  # $ref index -> the decoded object it names
    claimed: set = set()  # id() of decoded objects already bound to some ref

    def fail(path: str, msg: str) -> None:
        raise Mismatch(f"{path}: {msg}")

    def check(ok: bool, path: str, msg: str) -> None:
        if not ok:
            fail(path, msg)

    def is_ref(mv: Any) -> bool:
        return isinstance(mv, dict) and "$ref" in mv

    def match_value(mv: Any, actual: Any, path: str) -> None:
        if is_ref(mv):
            ref = mv["$ref"]
            if ref in bound:
                check(bound[ref] is actual, path, f"identity mismatch for $ref {ref}")
                return
            bound[ref] = actual
            claimed.add(id(actual))
            node = nodes[ref]
            match_node(node, actual, f"{path}#{ref}")
            return
        match_inline(mv, actual, path)

    def match_inline(mv: dict, actual: Any, path: str) -> None:
        tag = mv["$"]
        if tag == "null":
            check(actual is None, path, "expected null")
        elif tag == "undefined":
            check(actual is UNDEFINED, path, "expected undefined")
        elif tag == "bool":
            check(isinstance(actual, bool) and actual == mv["v"], path, f"expected bool {mv['v']}")
        elif tag == "int":
            check(
                isinstance(actual, int) and not isinstance(actual, bool) and actual == mv["v"],
                path,
                f"expected int {mv['v']}",
            )
        elif tag == "bigint":
            check(
                isinstance(actual, int) and not isinstance(actual, bool) and actual == int(mv["v"]),
                path,
                f"expected bigint {mv['v']}",
            )
        elif tag == "string":
            check(isinstance(actual, str) and actual == mv["v"], path, "expected string")
        elif tag == "float":
            match_float(mv["v"], actual, path)
        else:
            fail(path, f"unknown inline tag {tag}")

    def match_float(v: Any, actual: Any, path: str) -> None:
        if not isinstance(actual, float):
            fail(path, "expected float")
        if v == "NaN":
            check(math.isnan(actual), path, "expected NaN")
        elif v == "Infinity":
            check(actual == math.inf, path, "expected Infinity")
        elif v == "-Infinity":
            check(actual == -math.inf, path, "expected -Infinity")
        elif v == "-0":
            check(actual == 0.0 and math.copysign(1.0, actual) == -1.0, path, "expected -0")
        else:
            check(actual == v, path, f"expected float {v}")

    def match_node(node: dict, actual: Any, path: str) -> None:
        tag = node["tag"]
        if tag == "Object":
            match_object(node, actual, path)
        elif tag == "Array":
            items = node["items"]
            check(isinstance(actual, list), path, "expected array")
            check(len(actual) == len(items), path, f"array length {len(actual)} != {len(items)}")
            for i, mv in enumerate(items):
                match_value(mv, actual[i], f"{path}[{i}]")
        elif tag == "Map":
            entries = node["entries"]
            check(isinstance(actual, GraftMap), path, "expected Map")
            check(len(actual.entries) == len(entries), path, "map size mismatch")
            for i, e in enumerate(entries):
                k, val = actual.entries[i]
                match_value(e["key"], k, f"{path}{{key#{i}}}")
                match_value(e["value"], val, f"{path}{{val#{i}}}")
        elif tag == "Set":
            values = node["values"]
            check(isinstance(actual, GraftSet), path, "expected Set")
            check(len(actual.values) == len(values), path, "set size mismatch")
            for i, mv in enumerate(values):
                match_value(mv, actual.values[i], f"{path}{{#{i}}}")
        elif tag == "Date":
            check(
                isinstance(actual, Date) and actual.unix_ms == node["unix_ms"],
                path,
                f"expected Date({node['unix_ms']})",
            )
        elif tag == "Bytes":
            check(isinstance(actual, Bytes) and _hex(actual.data) == node["hex"], path, "Bytes mismatch")
        elif tag == "TypedArray":
            check(
                isinstance(actual, TypedArray)
                and actual.element_type == node["element_type"]
                and _hex(actual.data) == node["hex"],
                path,
                "TypedArray mismatch",
            )
        elif tag == "RegExp":
            check(
                isinstance(actual, RegExp)
                and actual.source == node["source"]
                and actual.flags == node["flags"],
                path,
                "RegExp mismatch",
            )
        elif tag == "Url":
            check(isinstance(actual, Url) and actual.href == node["href"], path, "Url mismatch")
        elif tag == "DataView":
            check(
                isinstance(actual, DataView) and _hex(actual.data) == node["hex"],
                path,
                "DataView mismatch",
            )
        elif tag == "Error":
            match_error(node, actual, path)
        elif tag == "SymbolRegistered":
            check(
                isinstance(actual, Symbol)
                and actual.kind == "registered"
                and actual.value == node["key"],
                path,
                "expected registered symbol",
            )
        elif tag == "SymbolUnique":
            check(
                isinstance(actual, Symbol)
                and actual.kind == "unique"
                and actual.value == node["description"],
                path,
                "expected unique symbol",
            )
        elif tag == "SymbolWellKnown":
            check(
                isinstance(actual, Symbol)
                and actual.kind == "well_known"
                and actual.value == node["name"],
                path,
                "expected well-known symbol",
            )
        else:
            fail(path, f"unknown node tag {tag}")

    def match_object(node: dict, actual: Any, path: str) -> None:
        check(isinstance(actual, dict), path, "expected object")
        entries = node["entries"]
        string_entries = [e for e in entries if e["keyKind"] == "string"]
        symbol_entries = [e for e in entries if e["keyKind"] == "symbol"]

        own_str = [k for k in actual if isinstance(k, str)]
        check(len(own_str) == len(string_entries), path, "string key count mismatch")
        for e in string_entries:
            key = e["key"]
            check(key in actual, path, f"missing string key {key}")
            match_value(e["value"], actual[key], f"{path}.{key}")

        own_syms = [k for k in actual if isinstance(k, Symbol)]
        check(len(own_syms) == len(symbol_entries), path, "symbol key count mismatch")
        for e in symbol_entries:
            target = resolve_symbol_key(e["key"], own_syms, path)
            match_value(e["key"], target, f"{path}[symbol key]")
            match_value(e["value"], actual[target], f"{path}[{target}]")

    def match_error(node: dict, actual: Any, path: str) -> None:
        check(isinstance(actual, GraftError), path, "expected Error")
        check(actual.name == node["name"], path, f"error name {actual.name} != {node['name']}")
        check(actual.message == node["message"], path, "error message mismatch")
        if node["hasCause"]:
            check(actual.has_cause, path, "expected cause")
            match_value(node["cause"], actual.cause, f"{path}.cause")
        else:
            check(not actual.has_cause, path, "unexpected cause")

        extra = node["extra"]
        string_extra = [e for e in extra if e["keyKind"] == "string"]
        symbol_extra = [e for e in extra if e["keyKind"] == "symbol"]
        own_str = [k for k in actual.extra if isinstance(k, str)]
        check(len(own_str) == len(string_extra), path, "error extra string count mismatch")
        for e in string_extra:
            key = e["key"]
            check(key in actual.extra, path, f"missing extra {key}")
            match_value(e["value"], actual.extra[key], f"{path}.{key}")
        own_syms = [k for k in actual.extra if isinstance(k, Symbol)]
        check(len(own_syms) == len(symbol_extra), path, "error extra symbol count mismatch")
        for e in symbol_extra:
            target = resolve_symbol_key(e["key"], own_syms, path)
            match_value(e["key"], target, f"{path}[symbol key]")
            match_value(e["value"], actual.extra[target], f"{path}[{target}]")

    def resolve_symbol_key(key_ref: dict, own_syms: list, path: str) -> Symbol:
        ref = key_ref["$ref"]
        if ref in bound:
            s = bound[ref]
            if s not in own_syms:
                fail(path, f"bound symbol for $ref {ref} not an own key")
            return s
        sym = nodes[ref]
        target = None
        if sym["tag"] == "SymbolRegistered":
            target = next(
                (s for s in own_syms if s.kind == "registered" and s.value == sym["key"]), None
            )
        elif sym["tag"] == "SymbolWellKnown":
            target = next(
                (s for s in own_syms if s.kind == "well_known" and s.value == sym["name"]), None
            )
        elif sym["tag"] == "SymbolUnique":
            target = next(
                (
                    s
                    for s in own_syms
                    if s.kind == "unique"
                    and s.value == sym["description"]
                    and id(s) not in claimed
                ),
                None,
            )
        else:
            fail(path, f"symbol key $ref {ref} -> non-symbol node {sym['tag']}")
        if target is None:
            fail(path, f"no decoded symbol key matches node #{ref}")
        return target

    match_value(meta["root"], decoded, "$")


def main() -> int:
    files = sorted(f for f in os.listdir(GOLDEN_DIR) if f.endswith(".bin"))
    print(f"Graft conformance — Python port ({len(files)} vectors)\n")
    passed = 0
    failed = 0
    for name in files:
        meta_path = os.path.join(GOLDEN_DIR, name[:-4] + ".meta.json")
        try:
            with open(os.path.join(GOLDEN_DIR, name), "rb") as f:
                decoded = decode(f.read())
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            match_vector(decoded, meta)
            print(f"  ok   {name}")
            passed += 1
        except Exception as err:  # noqa: BLE001
            print(f"  FAIL {name}: {err}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
