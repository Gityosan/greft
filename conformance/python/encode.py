"""Graft binary encoder — Python port.

The inverse of decode.py. It mirrors the reference JS encoder's algorithm
exactly — depth-first pre-order interning, identity dedup for objects and value
dedup for primitives — so that `encode(decode(bytes)) == bytes` for the golden
vectors (a byte-identical round-trip), even though byte equality is not required
for conformance in general (conformance/README.md §2).
"""

from __future__ import annotations

import struct
from typing import Any, Dict, List, Tuple

from decode import (
    BigInt,
    Bytes,
    DataView,
    Date,
    ELEMENT_TYPE_NAMES,
    GraftError,
    GraftMap,
    GraftSet,
    RegExp,
    Symbol,
    TypedArray,
    _Undefined,
    Url,
)

ELEMENT_TYPE_CODES = {name: code for code, name in ELEMENT_TYPE_NAMES.items()}
SYMBOL_TAG = {"registered": 10, "unique": 11, "well_known": 12}


class ByteWriter:
    def __init__(self) -> None:
        self.buf = bytearray()

    def u8(self, b: int) -> None:
        self.buf.append(b & 0xFF)

    def raw(self, data: bytes) -> None:
        self.buf.extend(data)

    def uvarint(self, n: int) -> None:
        if n < 0:
            raise ValueError("uvarint expects non-negative")
        while True:
            byte = n & 0x7F
            n >>= 7
            if n:
                self.buf.append(byte | 0x80)
            else:
                self.buf.append(byte)
                return

    def svarint(self, n: int) -> None:
        self.uvarint((n << 1) if n >= 0 else ((-n << 1) - 1))

    def f64(self, v: float) -> None:
        self.buf.extend(struct.pack("<d", v))

    def string(self, s: str) -> None:
        b = s.encode("utf-8")
        self.uvarint(len(b))
        self.buf.extend(b)

    def to_bytes(self) -> bytes:
        return bytes(self.buf)


# Reference types are deduped by object identity; primitives by value, matching
# the single identity/value map the JS encoder keys on.
_REF_TYPES = (
    list,
    dict,
    Symbol,
    GraftMap,
    GraftSet,
    GraftError,
    Date,
    Bytes,
    DataView,
    TypedArray,
    RegExp,
    Url,
)


def _is_ref(v: Any) -> bool:
    return isinstance(v, _REF_TYPES)


def _val_key(v: Any) -> Tuple:
    if v is None:
        return ("null",)
    if isinstance(v, _Undefined):
        return ("undef",)
    if isinstance(v, bool):
        return ("bool", v)
    if isinstance(v, BigInt):
        return ("bigint", str(int(v)))
    if isinstance(v, int):
        return ("int", v)
    if isinstance(v, float):
        return ("float", struct.pack("<d", v))
    if isinstance(v, str):
        return ("str", v)
    raise TypeError(f"not a primitive: {v!r}")


def encode(root: Any) -> bytes:
    heap: List[bytes] = []
    ids_obj: Dict[int, int] = {}  # id(obj) -> heap index
    ids_val: Dict[Tuple, int] = {}  # (kind, value) -> heap index

    def intern(v: Any) -> int:
        if _is_ref(v):
            key = id(v)
            if key in ids_obj:
                return ids_obj[key]
            idx = len(heap)
            ids_obj[key] = idx
            heap.append(b"")  # reserve index before building children (cycles)
            heap[idx] = build(v)
            return idx
        key2 = _val_key(v)
        if key2 in ids_val:
            return ids_val[key2]
        idx = len(heap)
        ids_val[key2] = idx
        heap.append(b"")
        heap[idx] = build(v)
        return idx

    def write_entries(w: ByteWriter, items) -> None:
        # JS order: string keys first (insertion order), then symbol keys; the
        # decoded dict already preserves that order. Refs are interned eagerly.
        parts: List[Tuple[int, Any, int]] = []
        for k, val in items:
            if isinstance(k, Symbol):
                parts.append((1, intern(k), intern(val)))
            else:
                parts.append((0, k, intern(val)))
        w.uvarint(len(parts))
        for kind, key, valref in parts:
            w.u8(kind)
            if kind == 0:
                w.string(key)
            else:
                w.uvarint(key)
            w.uvarint(valref)

    def build(v: Any) -> bytes:
        w = ByteWriter()
        if v is None:
            w.u8(0)
        elif isinstance(v, _Undefined):
            w.u8(1)
        elif isinstance(v, bool):
            w.u8(3 if v else 2)
        elif isinstance(v, BigInt):
            n = int(v)
            w.u8(6)
            w.u8(1 if n < 0 else 0)
            w.uvarint(abs(n))
        elif isinstance(v, int):
            w.u8(4)
            w.svarint(v)
        elif isinstance(v, float):
            w.u8(5)
            w.f64(v)
        elif isinstance(v, str):
            w.u8(7)
            w.string(v)
        elif isinstance(v, Symbol):
            w.u8(SYMBOL_TAG[v.kind])
            w.string(v.value)
        elif isinstance(v, Date):
            w.u8(40)
            w.svarint(v.unix_ms)
            w.svarint(v.sub_ms_nanos)
        elif isinstance(v, Bytes):
            w.u8(41)
            w.uvarint(len(v.data))
            w.raw(bytes(v.data))
        elif isinstance(v, TypedArray):
            w.u8(42)
            w.u8(ELEMENT_TYPE_CODES[v.element_type])
            w.uvarint(len(v.data))
            w.raw(bytes(v.data))
        elif isinstance(v, RegExp):
            w.u8(43)
            w.string(v.source)
            w.string(v.flags)
        elif isinstance(v, Url):
            w.u8(44)
            w.string(v.href)
        elif isinstance(v, DataView):
            w.u8(45)
            w.uvarint(len(v.data))
            w.raw(bytes(v.data))
        elif isinstance(v, list):  # Array
            refs = [intern(x) for x in v]
            w.u8(20)
            w.uvarint(len(refs))
            for r in refs:
                w.uvarint(r)
        elif isinstance(v, dict):  # Object
            w.u8(21)
            write_entries(w, v.items())
        elif isinstance(v, GraftMap):
            pairs = [(intern(k), intern(val)) for k, val in v.entries]
            w.u8(22)
            w.uvarint(len(pairs))
            for kr, vr in pairs:
                w.uvarint(kr)
                w.uvarint(vr)
        elif isinstance(v, GraftSet):
            refs = [intern(x) for x in v.values]
            w.u8(23)
            w.uvarint(len(refs))
            for r in refs:
                w.uvarint(r)
        elif isinstance(v, GraftError):
            cause_ref = intern(v.cause) if v.has_cause else 0
            w.u8(46)
            w.string(v.name)
            w.string(v.message)
            w.u8(1 if v.has_cause else 0)
            if v.has_cause:
                w.uvarint(cause_ref)
            write_entries(w, v.extra.items())
        else:
            raise TypeError(f"cannot encode {v!r}")
        return w.to_bytes()

    root_id = intern(root)
    out = ByteWriter()
    out.raw(b"GRF1")
    out.u8(1)
    out.uvarint(root_id)
    out.uvarint(len(heap))
    for node in heap:
        out.raw(node)
    return out.to_bytes()
