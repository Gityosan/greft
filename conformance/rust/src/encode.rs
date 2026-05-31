//! Graft binary encoder — the inverse of decode.rs. It mirrors the reference JS
//! encoder's algorithm (depth-first pre-order interning, identity dedup for
//! reference types, value dedup for primitives) so `encode(decode(bytes))`
//! reproduces the original bytes for the golden vectors.

use crate::value::{ref_id, ErrorObj, Key, Value};
use std::collections::HashMap;

#[derive(Hash, Eq, PartialEq)]
enum ValKey {
    Null,
    Undef,
    Bool(bool),
    Int(i64),
    Float(u64), // raw bits
    BigInt(String),
    Str(String),
}

// Primitives are deduped by value; reference types by identity (ref_id).
// Value-type leaves (Date/Bytes/RegExp/Url/DataView/TypedArray) carry no
// identity here and are emitted fresh — the golden vectors never share them.
fn val_key(v: &Value) -> Option<ValKey> {
    Some(match v {
        Value::Null => ValKey::Null,
        Value::Undefined => ValKey::Undef,
        Value::Bool(b) => ValKey::Bool(*b),
        Value::Int(i) => ValKey::Int(*i),
        Value::Float(f) => ValKey::Float(f.to_bits()),
        Value::BigInt(s) => ValKey::BigInt(s.clone()),
        Value::Str(s) => ValKey::Str(s.clone()),
        _ => return None,
    })
}

fn element_type_code(name: &str) -> u8 {
    match name {
        "Uint8" => 0,
        "Uint8Clamped" => 1,
        "Uint16" => 2,
        "Uint32" => 3,
        "Int8" => 4,
        "Int16" => 5,
        "Int32" => 6,
        "Float32" => 7,
        "Float64" => 8,
        "BigInt64" => 9,
        "BigUint64" => 10,
        _ => panic!("unknown element type {}", name),
    }
}

fn push_uvarint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n != 0 {
            out.push(byte | 0x80);
        } else {
            out.push(byte);
            return;
        }
    }
}

fn push_svarint(out: &mut Vec<u8>, n: i64) {
    let z = ((n << 1) ^ (n >> 63)) as u64;
    push_uvarint(out, z);
}

fn push_str(out: &mut Vec<u8>, s: &str) {
    push_uvarint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

// Writes a bigint magnitude (decimal string, sign stripped) as a uvarint, by
// repeated long-division by 128 of the decimal digits.
fn push_bigint(out: &mut Vec<u8>, decimal: &str) {
    let neg = decimal.starts_with('-');
    let digits = if neg { &decimal[1..] } else { decimal };
    out.push(if neg { 1 } else { 0 });

    let mut dec: Vec<u8> = digits.bytes().map(|b| b - b'0').collect();
    let mut groups: Vec<u8> = Vec::new();
    loop {
        let mut rem: u32 = 0;
        for d in dec.iter_mut() {
            let cur = rem * 10 + *d as u32;
            *d = (cur / 128) as u8;
            rem = cur % 128;
        }
        groups.push(rem as u8);
        while dec.len() > 1 && dec[0] == 0 {
            dec.remove(0);
        }
        if dec.len() == 1 && dec[0] == 0 {
            break;
        }
    }
    for (i, g) in groups.iter().enumerate() {
        if i + 1 < groups.len() {
            out.push(g | 0x80);
        } else {
            out.push(*g);
        }
    }
}

struct Encoder {
    heap: Vec<Vec<u8>>,
    obj_ids: HashMap<usize, usize>,
    val_ids: HashMap<ValKey, usize>,
}

impl Encoder {
    fn intern(&mut self, v: &Value) -> usize {
        if let Some(ptr) = ref_id(v) {
            if let Some(&i) = self.obj_ids.get(&ptr) {
                return i;
            }
            let idx = self.heap.len();
            self.obj_ids.insert(ptr, idx);
            self.heap.push(Vec::new()); // reserve index before building children
            let bytes = self.build(v);
            self.heap[idx] = bytes;
            return idx;
        }
        if let Some(key) = val_key(v) {
            if let Some(&i) = self.val_ids.get(&key) {
                return i;
            }
            let idx = self.heap.len();
            self.val_ids.insert(key, idx);
            self.heap.push(Vec::new());
            let bytes = self.build(v);
            self.heap[idx] = bytes;
            return idx;
        }
        // value-type leaf (no dedup)
        let idx = self.heap.len();
        self.heap.push(Vec::new());
        let bytes = self.build(v);
        self.heap[idx] = bytes;
        idx
    }

    fn write_entries(&mut self, out: &mut Vec<u8>, entries: &[(Key, Value)]) {
        // JS order: string keys first then symbol keys (decoded order already).
        let mut parts: Vec<(u8, Option<String>, usize, usize)> = Vec::new();
        for (k, val) in entries {
            match k {
                Key::Str(s) => {
                    let vref = self.intern(val);
                    parts.push((0, Some(s.clone()), 0, vref));
                }
                Key::Sym(sym) => {
                    let kref = self.intern(sym);
                    let vref = self.intern(val);
                    parts.push((1, None, kref, vref));
                }
            }
        }
        push_uvarint(out, parts.len() as u64);
        for (kind, key, kref, vref) in parts {
            out.push(kind);
            if kind == 0 {
                push_str(out, key.as_deref().unwrap());
            } else {
                push_uvarint(out, kref as u64);
            }
            push_uvarint(out, vref as u64);
        }
    }

    fn build(&mut self, v: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        match v {
            Value::Null => out.push(0),
            Value::Undefined => out.push(1),
            Value::Bool(b) => out.push(if *b { 3 } else { 2 }),
            Value::Int(i) => {
                out.push(4);
                push_svarint(&mut out, *i);
            }
            Value::Float(f) => {
                out.push(5);
                out.extend_from_slice(&f.to_le_bytes());
            }
            Value::BigInt(s) => {
                out.push(6);
                push_bigint(&mut out, s);
            }
            Value::Str(s) => {
                out.push(7);
                push_str(&mut out, s);
            }
            Value::Symbol(sym) => {
                out.push(match sym.kind.as_str() {
                    "registered" => 10,
                    "unique" => 11,
                    "well_known" => 12,
                    other => panic!("bad symbol kind {}", other),
                });
                push_str(&mut out, &sym.value);
            }
            Value::Date { unix_ms, sub_ms_nanos } => {
                out.push(40);
                push_svarint(&mut out, *unix_ms);
                push_svarint(&mut out, *sub_ms_nanos);
            }
            Value::Bytes(b) => {
                out.push(41);
                push_uvarint(&mut out, b.len() as u64);
                out.extend_from_slice(b);
            }
            Value::TypedArray { element_type, data } => {
                out.push(42);
                out.push(element_type_code(element_type));
                push_uvarint(&mut out, data.len() as u64);
                out.extend_from_slice(data);
            }
            Value::Regex { source, flags } => {
                out.push(43);
                push_str(&mut out, source);
                push_str(&mut out, flags);
            }
            Value::Url(href) => {
                out.push(44);
                push_str(&mut out, href);
            }
            Value::DataView(b) => {
                out.push(45);
                push_uvarint(&mut out, b.len() as u64);
                out.extend_from_slice(b);
            }
            Value::Array(rc) => {
                let items = rc.borrow().clone();
                let refs: Vec<usize> = items.iter().map(|x| self.intern(x)).collect();
                out.push(20);
                push_uvarint(&mut out, refs.len() as u64);
                for r in refs {
                    push_uvarint(&mut out, r as u64);
                }
            }
            Value::Object(rc) => {
                let entries = rc.borrow().clone();
                out.push(21);
                self.write_entries(&mut out, &entries);
            }
            Value::Map(rc) => {
                let pairs = rc.borrow().clone();
                let refs: Vec<(usize, usize)> =
                    pairs.iter().map(|(k, val)| (self.intern(k), self.intern(val))).collect();
                out.push(22);
                push_uvarint(&mut out, refs.len() as u64);
                for (kr, vr) in refs {
                    push_uvarint(&mut out, kr as u64);
                    push_uvarint(&mut out, vr as u64);
                }
            }
            Value::Set(rc) => {
                let values = rc.borrow().clone();
                let refs: Vec<usize> = values.iter().map(|x| self.intern(x)).collect();
                out.push(23);
                push_uvarint(&mut out, refs.len() as u64);
                for r in refs {
                    push_uvarint(&mut out, r as u64);
                }
            }
            Value::Error(rc) => {
                let err: ErrorObj = {
                    let e = rc.borrow();
                    ErrorObj {
                        name: e.name.clone(),
                        message: e.message.clone(),
                        has_cause: e.has_cause,
                        cause: e.cause.clone(),
                        extra: e.extra.clone(),
                    }
                };
                let cause_ref = if err.has_cause {
                    Some(self.intern(&err.cause))
                } else {
                    None
                };
                out.push(46);
                push_str(&mut out, &err.name);
                push_str(&mut out, &err.message);
                out.push(if err.has_cause { 1 } else { 0 });
                if let Some(cr) = cause_ref {
                    push_uvarint(&mut out, cr as u64);
                }
                self.write_entries(&mut out, &err.extra);
            }
        }
        out
    }
}

/// Encodes a value graph into a Graft stream.
pub fn encode(root: &Value) -> Vec<u8> {
    let mut enc = Encoder {
        heap: Vec::new(),
        obj_ids: HashMap::new(),
        val_ids: HashMap::new(),
    };
    let root_id = enc.intern(root);

    let mut out = Vec::new();
    out.extend_from_slice(b"GRF1");
    out.push(1);
    push_uvarint(&mut out, root_id as u64);
    push_uvarint(&mut out, enc.heap.len() as u64);
    for node in &enc.heap {
        out.extend_from_slice(node);
    }
    out
}
