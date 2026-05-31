package main

// Matches a decoded value against its .meta.json description (../README.md §2).
// Binds each $ref index to the decoded object on first sight and asserts pointer
// identity on every later occurrence, so shared references and cycles must be
// genuinely restored. Container entries are matched positionally, which also
// verifies the property order the format mandates.

import (
	"encoding/hex"
	"fmt"
	"math"
	"reflect"
)

type matcher struct {
	nodes []interface{}
	bound map[int]uintptr
}

// MatchVector checks the whole decoded value against a parsed meta object.
func MatchVector(decoded interface{}, meta map[string]interface{}) error {
	nodes, ok := meta["nodes"].([]interface{})
	if !ok {
		return fmt.Errorf("meta.nodes missing")
	}
	m := &matcher{nodes: nodes, bound: map[int]uintptr{}}
	return m.matchValue(meta["root"], decoded, "$")
}

// refID returns a stable identity for reference types, else (0,false).
func refID(v interface{}) (uintptr, bool) {
	switch v.(type) {
	case *Array, *Object, *MapV, *SetV, *ErrorV, *Symbol:
		return reflect.ValueOf(v).Pointer(), true
	}
	return 0, false
}

func errf(path, format string, args ...interface{}) error {
	return fmt.Errorf("%s: %s", path, fmt.Sprintf(format, args...))
}

func (m *matcher) matchValue(mv, actual interface{}, path string) error {
	obj, ok := mv.(map[string]interface{})
	if !ok {
		return errf(path, "malformed meta value")
	}
	if rf, has := obj["$ref"]; has {
		idx := int(rf.(float64))
		if idx < 0 || idx >= len(m.nodes) {
			return errf(path, "dangling $ref %d", idx)
		}
		node := m.nodes[idx].(map[string]interface{})
		sub := fmt.Sprintf("%s#%d", path, idx)
		if ptr, isRef := refID(actual); isRef {
			if prev, seen := m.bound[idx]; seen {
				if prev != ptr {
					return errf(path, "identity mismatch for $ref %d", idx)
				}
				return nil
			}
			m.bound[idx] = ptr
			return m.matchNode(node, actual, sub)
		}
		// Value-type leaves carry no identity; golden never shares them.
		return m.matchNode(node, actual, sub)
	}
	if _, has := obj["$"]; has {
		return m.matchInline(obj, actual, path)
	}
	return errf(path, "meta value is neither $ref nor inline")
}

func (m *matcher) matchInline(mv map[string]interface{}, actual interface{}, path string) error {
	switch mv["$"].(string) {
	case "null":
		return req(actual == nil, path, "expected null")
	case "undefined":
		_, ok := actual.(Undefined)
		return req(ok, path, "expected undefined")
	case "bool":
		b, ok := actual.(bool)
		return req(ok && b == mv["v"].(bool), path, "bool mismatch")
	case "int":
		i, ok := actual.(int64)
		return req(ok && i == int64(mv["v"].(float64)), path, "int mismatch")
	case "bigint":
		s, ok := actual.(BigInt)
		return req(ok && string(s) == mv["v"].(string), path, "bigint mismatch")
	case "string":
		s, ok := actual.(string)
		return req(ok && s == mv["v"].(string), path, "string mismatch")
	case "float":
		return matchFloat(mv["v"], actual, path)
	default:
		return errf(path, "unknown inline tag %v", mv["$"])
	}
}

func matchFloat(v, actual interface{}, path string) error {
	f, ok := actual.(float64)
	if !ok {
		return errf(path, "expected float")
	}
	if s, isStr := v.(string); isStr {
		switch s {
		case "NaN":
			return req(math.IsNaN(f), path, "expected NaN")
		case "Infinity":
			return req(math.IsInf(f, 1), path, "expected Infinity")
		case "-Infinity":
			return req(math.IsInf(f, -1), path, "expected -Infinity")
		case "-0":
			return req(f == 0 && math.Signbit(f), path, "expected -0")
		default:
			return errf(path, "unknown float token %q", s)
		}
	}
	return req(f == v.(float64), path, "float mismatch")
}

func (m *matcher) matchNode(node map[string]interface{}, actual interface{}, path string) error {
	switch node["tag"].(string) {
	case "Object":
		return m.matchObject(node, actual, path)
	case "Array":
		items := node["items"].([]interface{})
		arr, ok := actual.(*Array)
		if !ok {
			return errf(path, "expected array")
		}
		if err := req(len(arr.Items) == len(items), path, "array length mismatch"); err != nil {
			return err
		}
		for i, mv := range items {
			if err := m.matchValue(mv, arr.Items[i], fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
		return nil
	case "Map":
		entries := node["entries"].([]interface{})
		mp, ok := actual.(*MapV)
		if !ok {
			return errf(path, "expected Map")
		}
		if err := req(len(mp.Entries) == len(entries), path, "map size mismatch"); err != nil {
			return err
		}
		for i, e := range entries {
			em := e.(map[string]interface{})
			if err := m.matchValue(em["key"], mp.Entries[i].Key, fmt.Sprintf("%s{k%d}", path, i)); err != nil {
				return err
			}
			if err := m.matchValue(em["value"], mp.Entries[i].Value, fmt.Sprintf("%s{v%d}", path, i)); err != nil {
				return err
			}
		}
		return nil
	case "Set":
		values := node["values"].([]interface{})
		s, ok := actual.(*SetV)
		if !ok {
			return errf(path, "expected Set")
		}
		if err := req(len(s.Values) == len(values), path, "set size mismatch"); err != nil {
			return err
		}
		for i, mv := range values {
			if err := m.matchValue(mv, s.Values[i], fmt.Sprintf("%s{%d}", path, i)); err != nil {
				return err
			}
		}
		return nil
	case "Date":
		d, ok := actual.(Date)
		return req(ok && d.UnixMS == int64(node["unix_ms"].(float64)), path, "Date mismatch")
	case "Bytes":
		b, ok := actual.(Bytes)
		return req(ok && hex.EncodeToString(b) == node["hex"].(string), path, "Bytes mismatch")
	case "DataView":
		b, ok := actual.(DataView)
		return req(ok && hex.EncodeToString(b) == node["hex"].(string), path, "DataView mismatch")
	case "TypedArray":
		t, ok := actual.(TypedArray)
		return req(ok && t.ElementType == node["element_type"].(string) &&
			hex.EncodeToString(t.Data) == node["hex"].(string), path, "TypedArray mismatch")
	case "RegExp":
		re, ok := actual.(RegExp)
		return req(ok && re.Source == node["source"].(string) && re.Flags == node["flags"].(string),
			path, "RegExp mismatch")
	case "Url":
		u, ok := actual.(URL)
		return req(ok && u.Href == node["href"].(string), path, "Url mismatch")
	case "Error":
		return m.matchError(node, actual, path)
	case "SymbolRegistered":
		return matchSymbol(actual, "registered", node["key"], path)
	case "SymbolUnique":
		return matchSymbol(actual, "unique", node["description"], path)
	case "SymbolWellKnown":
		return matchSymbol(actual, "well_known", node["name"], path)
	default:
		return errf(path, "unknown node tag %v", node["tag"])
	}
}

func matchSymbol(actual interface{}, kind string, val interface{}, path string) error {
	s, ok := actual.(*Symbol)
	return req(ok && s.Kind == kind && s.Value == val.(string), path, "expected %s symbol", kind)
}

func (m *matcher) matchObject(node map[string]interface{}, actual interface{}, path string) error {
	obj, ok := actual.(*Object)
	if !ok {
		return errf(path, "expected object")
	}
	entries := node["entries"].([]interface{})
	if err := req(len(obj.Entries) == len(entries), path, "object entry count mismatch"); err != nil {
		return err
	}
	for i, e := range entries {
		if err := m.matchEntry(e.(map[string]interface{}), obj.Entries[i], path); err != nil {
			return err
		}
	}
	return nil
}

func (m *matcher) matchError(node map[string]interface{}, actual interface{}, path string) error {
	e, ok := actual.(*ErrorV)
	if !ok {
		return errf(path, "expected Error")
	}
	if err := req(e.Name == node["name"].(string), path, "error name mismatch"); err != nil {
		return err
	}
	if err := req(e.Message == node["message"].(string), path, "error message mismatch"); err != nil {
		return err
	}
	hasCause, _ := node["hasCause"].(bool)
	if hasCause {
		if err := req(e.HasCause, path, "expected cause"); err != nil {
			return err
		}
		if err := m.matchValue(node["cause"], e.Cause, path+".cause"); err != nil {
			return err
		}
	} else if err := req(!e.HasCause, path, "unexpected cause"); err != nil {
		return err
	}
	extra := node["extra"].([]interface{})
	if err := req(len(e.Extra) == len(extra), path, "error extra count mismatch"); err != nil {
		return err
	}
	for i, en := range extra {
		if err := m.matchEntry(en.(map[string]interface{}), e.Extra[i], path); err != nil {
			return err
		}
	}
	return nil
}

// matchEntry matches one Object/Error property entry against a decoded Entry.
func (m *matcher) matchEntry(e map[string]interface{}, decoded Entry, path string) error {
	switch e["keyKind"].(string) {
	case "string":
		key := e["key"].(string)
		s, ok := decoded.Key.(string)
		if !ok || s != key {
			return errf(path, "expected string key %q", key)
		}
		return m.matchValue(e["value"], decoded.Value, fmt.Sprintf("%s.%s", path, key))
	case "symbol":
		sym, ok := decoded.Key.(*Symbol)
		if !ok {
			return errf(path, "expected symbol key")
		}
		if err := m.matchValue(e["key"], sym, path+"[symkey]"); err != nil {
			return err
		}
		return m.matchValue(e["value"], decoded.Value, path+"[symval]")
	default:
		return errf(path, "unknown keyKind %v", e["keyKind"])
	}
}

func req(ok bool, path, format string, args ...interface{}) error {
	if ok {
		return nil
	}
	return errf(path, format, args...)
}
