package main

// Graft binary encoder — the inverse of decode.go. Mirrors the reference JS
// encoder's algorithm (depth-first pre-order interning, identity dedup for
// reference types, value dedup for primitives) so that encode(decode(bytes))
// reproduces the original bytes for the golden vectors.

import (
	"encoding/binary"
	"math"
	"math/big"
	"strconv"
)

type byteWriter struct{ buf []byte }

func (w *byteWriter) u8(b byte)    { w.buf = append(w.buf, b) }
func (w *byteWriter) raw(b []byte) { w.buf = append(w.buf, b...) }
func (w *byteWriter) str(s string) { w.uvarint(uint64(len(s))); w.buf = append(w.buf, s...) }

func (w *byteWriter) uvarint(n uint64) {
	for {
		b := byte(n & 0x7f)
		n >>= 7
		if n != 0 {
			w.buf = append(w.buf, b|0x80)
		} else {
			w.buf = append(w.buf, b)
			return
		}
	}
}

func (w *byteWriter) svarint(n int64) {
	w.uvarint(uint64((n << 1) ^ (n >> 63)))
}

func (w *byteWriter) f64(v float64) {
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], math.Float64bits(v))
	w.buf = append(w.buf, b[:]...)
}

func (w *byteWriter) bigUvarint(n *big.Int) {
	b128 := big.NewInt(128)
	q := new(big.Int).Set(n)
	r := new(big.Int)
	for {
		q.DivMod(q, b128, r)
		b := byte(r.Int64())
		if q.Sign() != 0 {
			w.buf = append(w.buf, b|0x80)
		} else {
			w.buf = append(w.buf, b)
			return
		}
	}
}

var elementTypeCodes = func() map[string]byte {
	m := make(map[string]byte, len(elementTypeNames))
	for code, name := range elementTypeNames {
		m[name] = code
	}
	return m
}()

var symbolTag = map[string]byte{"registered": 10, "unique": 11, "well_known": 12}

// valKey returns a dedup key for primitives (value dedup), else ok=false.
func valKey(v interface{}) (string, bool) {
	switch x := v.(type) {
	case nil:
		return "n", true
	case Undefined:
		return "u", true
	case bool:
		if x {
			return "b:1", true
		}
		return "b:0", true
	case BigInt:
		return "B:" + string(x), true
	case int64:
		return "i:" + strconv.FormatInt(x, 10), true
	case float64:
		return "f:" + strconv.FormatUint(math.Float64bits(x), 10), true
	case string:
		return "s:" + x, true
	}
	return "", false
}

type encoder struct {
	heap   [][]byte
	objIDs map[uintptr]int
	valIDs map[string]int
}

func (e *encoder) intern(v interface{}) int {
	if ptr, ok := refID(v); ok {
		if i, seen := e.objIDs[ptr]; seen {
			return i
		}
		idx := len(e.heap)
		e.objIDs[ptr] = idx
		e.heap = append(e.heap, nil) // reserve index before building children
		e.heap[idx] = e.build(v)
		return idx
	}
	if key, ok := valKey(v); ok {
		if i, seen := e.valIDs[key]; seen {
			return i
		}
		idx := len(e.heap)
		e.valIDs[key] = idx
		e.heap = append(e.heap, nil)
		e.heap[idx] = e.build(v)
		return idx
	}
	// value-type leaf (Date/Bytes/RegExp/Url/DataView/TypedArray): no dedup.
	idx := len(e.heap)
	e.heap = append(e.heap, nil)
	e.heap[idx] = e.build(v)
	return idx
}

func (e *encoder) writeEntries(w *byteWriter, entries []Entry) {
	type part struct {
		kind       byte
		key        string
		kref, vref int
	}
	// JS order: string keys first then symbol keys (decoded order already).
	parts := make([]part, 0, len(entries))
	for _, en := range entries {
		if sym, ok := en.Key.(*Symbol); ok {
			parts = append(parts, part{1, "", e.intern(sym), e.intern(en.Value)})
		} else {
			parts = append(parts, part{0, en.Key.(string), 0, e.intern(en.Value)})
		}
	}
	w.uvarint(uint64(len(parts)))
	for _, p := range parts {
		w.u8(p.kind)
		if p.kind == 0 {
			w.str(p.key)
		} else {
			w.uvarint(uint64(p.kref))
		}
		w.uvarint(uint64(p.vref))
	}
}

func (e *encoder) build(v interface{}) []byte {
	w := &byteWriter{}
	switch x := v.(type) {
	case nil:
		w.u8(0)
	case Undefined:
		w.u8(1)
	case bool:
		if x {
			w.u8(3)
		} else {
			w.u8(2)
		}
	case BigInt:
		n := new(big.Int)
		n.SetString(string(x), 10)
		sign := byte(0)
		if n.Sign() < 0 {
			sign = 1
		}
		w.u8(6)
		w.u8(sign)
		w.bigUvarint(new(big.Int).Abs(n))
	case int64:
		w.u8(4)
		w.svarint(x)
	case float64:
		w.u8(5)
		w.f64(x)
	case string:
		w.u8(7)
		w.str(x)
	case *Symbol:
		w.u8(symbolTag[x.Kind])
		w.str(x.Value)
	case Date:
		w.u8(40)
		w.svarint(x.UnixMS)
		w.svarint(x.SubMsNanos)
	case Bytes:
		w.u8(41)
		w.uvarint(uint64(len(x)))
		w.raw(x)
	case TypedArray:
		w.u8(42)
		w.u8(elementTypeCodes[x.ElementType])
		w.uvarint(uint64(len(x.Data)))
		w.raw(x.Data)
	case RegExp:
		w.u8(43)
		w.str(x.Source)
		w.str(x.Flags)
	case URL:
		w.u8(44)
		w.str(x.Href)
	case DataView:
		w.u8(45)
		w.uvarint(uint64(len(x)))
		w.raw(x)
	case *Array:
		refs := make([]int, len(x.Items))
		for i, item := range x.Items {
			refs[i] = e.intern(item)
		}
		w.u8(20)
		w.uvarint(uint64(len(refs)))
		for _, r := range refs {
			w.uvarint(uint64(r))
		}
	case *Object:
		w.u8(21)
		e.writeEntries(w, x.Entries)
	case *MapV:
		type pair struct{ k, v int }
		refs := make([]pair, len(x.Entries))
		for i, p := range x.Entries {
			refs[i] = pair{e.intern(p.Key), e.intern(p.Value)}
		}
		w.u8(22)
		w.uvarint(uint64(len(refs)))
		for _, p := range refs {
			w.uvarint(uint64(p.k))
			w.uvarint(uint64(p.v))
		}
	case *SetV:
		refs := make([]int, len(x.Values))
		for i, val := range x.Values {
			refs[i] = e.intern(val)
		}
		w.u8(23)
		w.uvarint(uint64(len(refs)))
		for _, r := range refs {
			w.uvarint(uint64(r))
		}
	case *ErrorV:
		causeRef := 0
		if x.HasCause {
			causeRef = e.intern(x.Cause)
		}
		w.u8(46)
		w.str(x.Name)
		w.str(x.Message)
		if x.HasCause {
			w.u8(1)
			w.uvarint(uint64(causeRef))
		} else {
			w.u8(0)
		}
		e.writeEntries(w, x.Extra)
	default:
		panic("cannot encode value")
	}
	return w.buf
}

// Encode serializes a decoded value graph into a Graft stream.
func Encode(root interface{}) []byte {
	e := &encoder{objIDs: map[uintptr]int{}, valIDs: map[string]int{}}
	rootID := e.intern(root)

	out := &byteWriter{}
	out.raw([]byte("GRF1"))
	out.u8(1)
	out.uvarint(uint64(rootID))
	out.uvarint(uint64(len(e.heap)))
	for _, node := range e.heap {
		out.raw(node)
	}
	return out.buf
}
