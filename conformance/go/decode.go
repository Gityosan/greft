// Package main is the Graft conformance port for Go: a zero-dependency decoder
// plus a runner that matches spec/golden/*.bin against the .meta.json sidecars.
//
// This file holds the value graph and the two-pass heap decoder (FORMAT.md §4):
// reference types are created as empty pointers first, then filled, so shared
// identity and cycles are restored rather than copied.
package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"math/big"
)

// --- value graph -----------------------------------------------------------
//
// A decoded Value is held in an interface{}. Reference types are pointers so
// they carry identity (shared refs / cycles); leaves are plain values.

// Undefined models JS `undefined`, kept distinct from nil (JS `null`).
type Undefined struct{}

var undefinedVal = Undefined{}

// BigInt is an arbitrary-precision integer as its canonical decimal string.
type BigInt string

type Bytes []byte    // JS ArrayBuffer
type DataView []byte // JS DataView (viewed window)

type TypedArray struct {
	ElementType string
	Data        []byte
}

type Date struct {
	UnixMS     int64
	SubMsNanos int64
}

type RegExp struct {
	Source string
	Flags  string
}

type URL struct {
	Href string
}

// Symbol is referenced by pointer so unique symbols compare by identity.
type Symbol struct {
	Kind  string // "registered" | "unique" | "well_known"
	Value string
}

// Entry is one Object/Error property: Key is a string or *Symbol.
type Entry struct {
	Key   interface{}
	Value interface{}
}

type Array struct{ Items []interface{} }
type Object struct{ Entries []Entry }

type Pair struct{ Key, Value interface{} }
type MapV struct{ Entries []Pair }
type SetV struct{ Values []interface{} }

type ErrorV struct {
	Name     string
	Message  string
	HasCause bool
	Cause    interface{}
	Extra    []Entry
}

// --- reader ----------------------------------------------------------------

type reader struct {
	data []byte
	pos  int
}

func (r *reader) take(n int) ([]byte, error) {
	if r.pos+n > len(r.data) {
		return nil, fmt.Errorf("EOF")
	}
	out := r.data[r.pos : r.pos+n]
	r.pos += n
	return out, nil
}

func (r *reader) u8() (byte, error) {
	b, err := r.take(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (r *reader) uvarint() (uint64, error) {
	var result uint64
	var shift uint
	for {
		b, err := r.u8()
		if err != nil {
			return 0, err
		}
		result |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			break
		}
		shift += 7
		if shift >= 64 {
			return 0, fmt.Errorf("uvarint overflows 64 bits")
		}
	}
	return result, nil
}

func (r *reader) uvarintInt() (int, error) {
	v, err := r.uvarint()
	return int(v), err
}

func (r *reader) svarint() (int64, error) {
	z, err := r.uvarint()
	if err != nil {
		return 0, err
	}
	if z&1 == 0 {
		return int64(z >> 1), nil
	}
	return -int64((z + 1) >> 1), nil
}

// uvarintGroups returns a LEB128 value's 7-bit groups (little-endian) for bigints.
func (r *reader) uvarintGroups() ([]byte, error) {
	var groups []byte
	for {
		b, err := r.u8()
		if err != nil {
			return nil, err
		}
		groups = append(groups, b&0x7f)
		if b&0x80 == 0 {
			break
		}
	}
	return groups, nil
}

func (r *reader) f64() (float64, error) {
	b, err := r.take(8)
	if err != nil {
		return 0, err
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(b)), nil
}

func (r *reader) str() (string, error) {
	n, err := r.uvarintInt()
	if err != nil {
		return "", err
	}
	b, err := r.take(n)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// --- node decoding ---------------------------------------------------------

func bigIntDecimal(sign byte, groups []byte) string {
	n := big.NewInt(0)
	base := big.NewInt(128)
	tmp := new(big.Int)
	for i := len(groups) - 1; i >= 0; i-- {
		n.Mul(n, base)
		n.Add(n, tmp.SetInt64(int64(groups[i])))
	}
	s := n.String()
	if sign == 1 && s != "0" {
		s = "-" + s
	}
	return s
}

var elementTypeNames = map[byte]string{
	0: "Uint8", 1: "Uint8Clamped", 2: "Uint16", 3: "Uint32",
	4: "Int8", 5: "Int16", 6: "Int32",
	7: "Float32", 8: "Float64", 9: "BigInt64", 10: "BigUint64",
}

type rawEntry struct {
	isSym  bool
	keyStr string
	keyRef int
	valRef int
}

func readEntries(r *reader) ([]rawEntry, error) {
	n, err := r.uvarintInt()
	if err != nil {
		return nil, err
	}
	entries := make([]rawEntry, 0, n)
	for i := 0; i < n; i++ {
		kind, err := r.u8()
		if err != nil {
			return nil, err
		}
		var e rawEntry
		if kind == 0 {
			if e.keyStr, err = r.str(); err != nil {
				return nil, err
			}
		} else {
			e.isSym = true
			if e.keyRef, err = r.uvarintInt(); err != nil {
				return nil, err
			}
		}
		if e.valRef, err = r.uvarintInt(); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, nil
}

func readRefs(r *reader) ([]int, error) {
	n, err := r.uvarintInt()
	if err != nil {
		return nil, err
	}
	refs := make([]int, 0, n)
	for i := 0; i < n; i++ {
		ref, err := r.uvarintInt()
		if err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	return refs, nil
}

// filler populates a container in the second pass using the completed heap.
type filler func(heap []interface{})

func resolveKey(e rawEntry, heap []interface{}) interface{} {
	if e.isSym {
		return heap[e.keyRef]
	}
	return e.keyStr
}

func readNode(r *reader) (interface{}, filler, error) {
	tag, err := r.u8()
	if err != nil {
		return nil, nil, err
	}
	switch tag {
	case 0:
		return nil, nil, nil
	case 1:
		return undefinedVal, nil, nil
	case 2:
		return false, nil, nil
	case 3:
		return true, nil, nil
	case 4:
		v, err := r.svarint()
		return v, nil, err
	case 5:
		v, err := r.f64()
		return v, nil, err
	case 6:
		sign, err := r.u8()
		if err != nil {
			return nil, nil, err
		}
		groups, err := r.uvarintGroups()
		if err != nil {
			return nil, nil, err
		}
		return BigInt(bigIntDecimal(sign, groups)), nil, nil
	case 7:
		v, err := r.str()
		return v, nil, err

	case 10, 11, 12:
		kind := map[byte]string{10: "registered", 11: "unique", 12: "well_known"}[tag]
		v, err := r.str()
		if err != nil {
			return nil, nil, err
		}
		return &Symbol{Kind: kind, Value: v}, nil, nil

	case 20: // Array
		refs, err := readRefs(r)
		if err != nil {
			return nil, nil, err
		}
		arr := &Array{}
		return arr, func(heap []interface{}) {
			for _, i := range refs {
				arr.Items = append(arr.Items, heap[i])
			}
		}, nil
	case 21: // Object
		entries, err := readEntries(r)
		if err != nil {
			return nil, nil, err
		}
		obj := &Object{}
		return obj, func(heap []interface{}) {
			for _, e := range entries {
				obj.Entries = append(obj.Entries, Entry{Key: resolveKey(e, heap), Value: heap[e.valRef]})
			}
		}, nil
	case 22, 30: // Map / WeakMap
		n, err := r.uvarintInt()
		if err != nil {
			return nil, nil, err
		}
		pairs := make([][2]int, 0, n)
		for i := 0; i < n; i++ {
			k, err := r.uvarintInt()
			if err != nil {
				return nil, nil, err
			}
			v, err := r.uvarintInt()
			if err != nil {
				return nil, nil, err
			}
			pairs = append(pairs, [2]int{k, v})
		}
		m := &MapV{}
		return m, func(heap []interface{}) {
			for _, p := range pairs {
				m.Entries = append(m.Entries, Pair{Key: heap[p[0]], Value: heap[p[1]]})
			}
		}, nil
	case 23, 31: // Set / WeakSet
		refs, err := readRefs(r)
		if err != nil {
			return nil, nil, err
		}
		s := &SetV{}
		return s, func(heap []interface{}) {
			for _, i := range refs {
				s.Values = append(s.Values, heap[i])
			}
		}, nil

	case 40: // Date
		ms, err := r.svarint()
		if err != nil {
			return nil, nil, err
		}
		sub, err := r.svarint()
		if err != nil {
			return nil, nil, err
		}
		return Date{UnixMS: ms, SubMsNanos: sub}, nil, nil
	case 41: // Bytes
		n, err := r.uvarintInt()
		if err != nil {
			return nil, nil, err
		}
		b, err := r.take(n)
		if err != nil {
			return nil, nil, err
		}
		return Bytes(append([]byte(nil), b...)), nil, nil
	case 42: // TypedArray
		et, err := r.u8()
		if err != nil {
			return nil, nil, err
		}
		n, err := r.uvarintInt()
		if err != nil {
			return nil, nil, err
		}
		b, err := r.take(n)
		if err != nil {
			return nil, nil, err
		}
		name, ok := elementTypeNames[et]
		if !ok {
			return nil, nil, fmt.Errorf("unknown element type: %d", et)
		}
		return TypedArray{ElementType: name, Data: append([]byte(nil), b...)}, nil, nil
	case 43: // RegExp
		src, err := r.str()
		if err != nil {
			return nil, nil, err
		}
		flags, err := r.str()
		if err != nil {
			return nil, nil, err
		}
		return RegExp{Source: src, Flags: flags}, nil, nil
	case 44: // Url
		href, err := r.str()
		if err != nil {
			return nil, nil, err
		}
		return URL{Href: href}, nil, nil
	case 45: // DataView
		n, err := r.uvarintInt()
		if err != nil {
			return nil, nil, err
		}
		b, err := r.take(n)
		if err != nil {
			return nil, nil, err
		}
		return DataView(append([]byte(nil), b...)), nil, nil
	case 46: // Error
		name, err := r.str()
		if err != nil {
			return nil, nil, err
		}
		message, err := r.str()
		if err != nil {
			return nil, nil, err
		}
		flags, err := r.u8()
		if err != nil {
			return nil, nil, err
		}
		hasCause := flags&1 != 0
		causeRef := -1
		if hasCause {
			if causeRef, err = r.uvarintInt(); err != nil {
				return nil, nil, err
			}
		}
		entries, err := readEntries(r)
		if err != nil {
			return nil, nil, err
		}
		e := &ErrorV{Name: name, Message: message, HasCause: hasCause}
		return e, func(heap []interface{}) {
			if hasCause {
				e.Cause = heap[causeRef]
			}
			for _, en := range entries {
				e.Extra = append(e.Extra, Entry{Key: resolveKey(en, heap), Value: heap[en.valRef]})
			}
		}, nil
	}
	return nil, nil, fmt.Errorf("unknown tag: %d", tag)
}

// Decode parses a Graft stream into a native value graph.
func Decode(data []byte) (interface{}, error) {
	r := &reader{data: data}
	magic, err := r.take(4)
	if err != nil {
		return nil, err
	}
	if string(magic) != "GRF1" {
		return nil, fmt.Errorf("bad magic: not a Graft file")
	}
	version, err := r.u8()
	if err != nil {
		return nil, err
	}
	if version != 1 {
		return nil, fmt.Errorf("unsupported version: %d", version)
	}
	root, err := r.uvarintInt()
	if err != nil {
		return nil, err
	}
	count, err := r.uvarintInt()
	if err != nil {
		return nil, err
	}

	heap := make([]interface{}, count)
	var fills []filler
	for i := 0; i < count; i++ {
		v, fill, err := readNode(r)
		if err != nil {
			return nil, err
		}
		heap[i] = v
		if fill != nil {
			fills = append(fills, fill)
		}
	}
	for _, fill := range fills {
		fill(heap)
	}
	if root < 0 || root >= len(heap) {
		return nil, fmt.Errorf("root index %d out of range", root)
	}
	return heap[root], nil
}
