"""Graft binary format decoder — Python reference port.

Zero-dependency (stdlib only). Decodes a Graft stream
(`MAGIC VERSION ROOT COUNT NODE{COUNT}`, see ../../spec/FORMAT.md) into a native
Python value graph, applying the documented fallbacks for types Python lacks.

The two-pass heap algorithm (FORMAT.md §4) is mandatory: reference types are
created as empty placeholders first, then filled, so shared identity and cycles
survive.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


# --- value types for things Python has no exact native equivalent for ---


class _Undefined:
    """JS `undefined`, kept distinct from `None` (which models JS `null`)."""

    _instance: "Optional[_Undefined]" = None

    def __repr__(self) -> str:
        return "undefined"


UNDEFINED = _Undefined()


@dataclass
class Bytes:
    """JS ArrayBuffer (raw bytes)."""

    data: bytes


@dataclass
class DataView:
    """JS DataView over its viewed window."""

    data: bytes


@dataclass
class TypedArray:
    element_type: str  # e.g. "Uint8", "Float64"
    data: bytes  # little-endian element bytes


@dataclass
class Date:
    unix_ms: int
    sub_ms_nanos: int = 0


@dataclass
class RegExp:
    source: str
    flags: str


@dataclass
class Url:
    href: str


@dataclass(eq=False)
class Symbol:
    """JS Symbol. eq=False -> identity equality/hash, so unique symbols can be
    dict keys and shared symbols (deduped by the heap) compare by object id."""

    kind: str  # "registered" | "unique" | "well_known"
    value: str  # key / description / well-known name


@dataclass
class GraftMap:
    entries: list = field(default_factory=list)  # list[(key, value)]


@dataclass
class GraftSet:
    values: list = field(default_factory=list)


@dataclass
class GraftError:
    name: str
    message: str
    has_cause: bool = False
    cause: Any = None
    extra: dict = field(default_factory=dict)  # str|Symbol -> value


# Object -> dict, Array -> list (native).


ELEMENT_TYPE_NAMES = {
    0: "Uint8",
    1: "Uint8Clamped",
    2: "Uint16",
    3: "Uint32",
    4: "Int8",
    5: "Int16",
    6: "Int32",
    7: "Float32",
    8: "Float64",
    9: "BigInt64",
    10: "BigUint64",
}


class Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            raise ValueError("EOF")
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out

    def u8(self) -> int:
        return self.take(1)[0]

    def uvarint(self) -> int:
        result = 0
        shift = 0
        while True:
            byte = self.u8()
            result |= (byte & 0x7F) << shift
            if (byte & 0x80) == 0:
                break
            shift += 7
        return result

    def svarint(self) -> int:
        z = self.uvarint()
        return (z >> 1) if (z & 1) == 0 else -((z + 1) >> 1)

    def f64(self) -> float:
        return struct.unpack("<d", self.take(8))[0]

    def string(self) -> str:
        n = self.uvarint()
        return self.take(n).decode("utf-8")


# A node decodes to (value, fill); fill is None for leaves, else a closure that
# populates the (already-created) container using a resolver over the heap.
Fill = Callable[[Callable[[int], Any]], None]


def _read_entries(r: Reader) -> list:
    """Object/Error property entries: (kind, key_or_ref, value_ref)."""
    n = r.uvarint()
    entries = []
    for _ in range(n):
        kind = r.u8()
        key = r.string() if kind == 0 else r.uvarint()
        val = r.uvarint()
        entries.append((kind, key, val))
    return entries


def _fill_entries(target: dict, entries: list, resolve: Callable[[int], Any]) -> None:
    for kind, key, val in entries:
        k = key if kind == 0 else resolve(key)
        target[k] = resolve(val)


def _read_node(r: Reader) -> "tuple[Any, Optional[Fill]]":
    tag = r.u8()
    if tag == 0:
        return None, None
    if tag == 1:
        return UNDEFINED, None
    if tag == 2:
        return False, None
    if tag == 3:
        return True, None
    if tag == 4:
        return r.svarint(), None
    if tag == 5:
        return r.f64(), None
    if tag == 6:
        sign = r.u8()
        mag = r.uvarint()
        return (-mag if sign else mag), None
    if tag == 7:
        return r.string(), None

    if tag == 10:
        return Symbol("registered", r.string()), None
    if tag == 11:
        return Symbol("unique", r.string()), None
    if tag == 12:
        return Symbol("well_known", r.string()), None

    if tag == 20:  # Array
        n = r.uvarint()
        refs = [r.uvarint() for _ in range(n)]
        arr: list = []

        def fill_arr(resolve: Callable[[int], Any]) -> None:
            arr.extend(resolve(x) for x in refs)

        return arr, fill_arr
    if tag == 21:  # Object
        entries = _read_entries(r)
        obj: dict = {}

        def fill_obj(resolve: Callable[[int], Any]) -> None:
            _fill_entries(obj, entries, resolve)

        return obj, fill_obj
    if tag == 22:  # Map
        n = r.uvarint()
        pairs = [(r.uvarint(), r.uvarint()) for _ in range(n)]
        m = GraftMap()

        def fill_map(resolve: Callable[[int], Any]) -> None:
            for kref, vref in pairs:
                m.entries.append((resolve(kref), resolve(vref)))

        return m, fill_map
    if tag == 23:  # Set
        n = r.uvarint()
        refs = [r.uvarint() for _ in range(n)]
        s = GraftSet()

        def fill_set(resolve: Callable[[int], Any]) -> None:
            for x in refs:
                s.values.append(resolve(x))

        return s, fill_set
    if tag in (30, 31):  # WeakMap / WeakSet (not exercised by golden, but parse)
        n = r.uvarint()
        if tag == 30:
            pairs = [(r.uvarint(), r.uvarint()) for _ in range(n)]
            m = GraftMap()

            def fill_wm(resolve: Callable[[int], Any]) -> None:
                for kref, vref in pairs:
                    m.entries.append((resolve(kref), resolve(vref)))

            return m, fill_wm
        refs = [r.uvarint() for _ in range(n)]
        s = GraftSet()

        def fill_ws(resolve: Callable[[int], Any]) -> None:
            for x in refs:
                s.values.append(resolve(x))

        return s, fill_ws

    if tag == 40:  # Date
        ms = r.svarint()
        sub = r.svarint()
        return Date(ms, sub), None
    if tag == 41:  # Bytes
        n = r.uvarint()
        return Bytes(r.take(n)), None
    if tag == 42:  # TypedArray
        et = r.u8()
        n = r.uvarint()
        raw = r.take(n)
        name = ELEMENT_TYPE_NAMES.get(et)
        if name is None:
            raise ValueError(f"unknown element type: {et}")
        return TypedArray(name, raw), None
    if tag == 43:  # RegExp
        return RegExp(r.string(), r.string()), None
    if tag == 44:  # Url
        return Url(r.string()), None
    if tag == 45:  # DataView
        n = r.uvarint()
        return DataView(r.take(n)), None
    if tag == 46:  # Error
        name = r.string()
        message = r.string()
        flags = r.u8()
        has_cause = (flags & 1) != 0
        cause_ref = r.uvarint() if has_cause else -1
        entries = _read_entries(r)
        err = GraftError(name, message, has_cause)

        def fill_err(resolve: Callable[[int], Any]) -> None:
            if has_cause:
                err.cause = resolve(cause_ref)
            _fill_entries(err.extra, entries, resolve)

        return err, fill_err

    raise ValueError(f"unknown tag: {tag}")


def decode(data: bytes) -> Any:
    r = Reader(data)
    if r.take(4) != b"GRF1":
        raise ValueError("bad magic: not a Graft file")
    version = r.u8()
    if version != 1:
        raise ValueError(f"unsupported version: {version}")
    root = r.uvarint()
    count = r.uvarint()

    values: list = [None] * count
    fills: list = []
    for i in range(count):
        value, fill = _read_node(r)
        values[i] = value
        if fill is not None:
            fills.append(fill)

    def resolve(idx: int) -> Any:
        return values[idx]

    for fill in fills:
        fill(resolve)

    return values[root]
