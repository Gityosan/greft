//! Graft binary decoder. Two-pass over the heap (FORMAT.md §4): build every node
//! (reference types as empty `Rc` placeholders), then fill containers by cloning
//! the now-populated heap slots, so shared identity and cycles are restored.

use crate::value::{ErrorObj, Key, SymbolKind, Value};
use std::cell::RefCell;
use std::rc::Rc;

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.data.len() {
            return Err("EOF".into());
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn uvarint(&mut self) -> Result<u64, String> {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let byte = self.u8()?;
            result |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
            if shift >= 64 {
                return Err("uvarint overflows 64 bits".into());
            }
        }
        Ok(result)
    }
    fn uvarint_usize(&mut self) -> Result<usize, String> {
        Ok(self.uvarint()? as usize)
    }
    fn svarint(&mut self) -> Result<i64, String> {
        let z = self.uvarint()?;
        Ok(if z & 1 == 0 {
            (z >> 1) as i64
        } else {
            -(((z + 1) >> 1) as i64)
        })
    }
    /// Reads a LEB128 value as its 7-bit groups (little-endian) for bigints.
    fn uvarint_groups(&mut self) -> Result<Vec<u8>, String> {
        let mut groups = Vec::new();
        loop {
            let b = self.u8()?;
            groups.push(b & 0x7f);
            if b & 0x80 == 0 {
                break;
            }
        }
        Ok(groups)
    }
    fn f64(&mut self) -> Result<f64, String> {
        let b = self.take(8)?;
        let arr: [u8; 8] = b.try_into().map_err(|_| "short f64".to_string())?;
        Ok(f64::from_le_bytes(arr))
    }
    fn string(&mut self) -> Result<String, String> {
        let n = self.uvarint_usize()?;
        let bytes = self.take(n)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| "invalid utf-8".into())
    }
}

fn groups_to_decimal(sign: u8, groups: &[u8]) -> String {
    // value = sum(groups[i] * 128^i); groups are little-endian 7-bit payloads.
    use num_bigint::BigUint;
    let b128 = BigUint::from(128u32);
    let mut n = BigUint::from(0u32);
    for &g in groups.iter().rev() {
        n = n * &b128 + BigUint::from(g);
    }
    let s = n.to_str_radix(10);
    if sign == 1 && s != "0" {
        format!("-{}", s)
    } else {
        s
    }
}

fn element_type_name(code: u8) -> Result<&'static str, String> {
    Ok(match code {
        0 => "Uint8",
        1 => "Uint8Clamped",
        2 => "Uint16",
        3 => "Uint32",
        4 => "Int8",
        5 => "Int16",
        6 => "Int32",
        7 => "Float32",
        8 => "Float64",
        9 => "BigInt64",
        10 => "BigUint64",
        other => return Err(format!("unknown element type: {}", other)),
    })
}

enum RawKey {
    Str(String),
    Sym(usize),
}
struct RawEntry {
    key: RawKey,
    val: usize,
}

enum Filler {
    Array(Rc<RefCell<Vec<Value>>>, Vec<usize>),
    Object(Rc<RefCell<Vec<(Key, Value)>>>, Vec<RawEntry>),
    Map(Rc<RefCell<Vec<(Value, Value)>>>, Vec<(usize, usize)>),
    Set(Rc<RefCell<Vec<Value>>>, Vec<usize>),
    Error(Rc<RefCell<ErrorObj>>, Option<usize>, Vec<RawEntry>),
}

fn read_entries(r: &mut Reader) -> Result<Vec<RawEntry>, String> {
    let n = r.uvarint_usize()?;
    let mut entries = Vec::with_capacity(n);
    for _ in 0..n {
        let kind = r.u8()?;
        let key = if kind == 0 {
            RawKey::Str(r.string()?)
        } else {
            RawKey::Sym(r.uvarint_usize()?)
        };
        let val = r.uvarint_usize()?;
        entries.push(RawEntry { key, val });
    }
    Ok(entries)
}

fn read_node(r: &mut Reader) -> Result<(Value, Option<Filler>), String> {
    let tag = r.u8()?;
    Ok(match tag {
        0 => (Value::Null, None),
        1 => (Value::Undefined, None),
        2 => (Value::Bool(false), None),
        3 => (Value::Bool(true), None),
        4 => (Value::Int(r.svarint()?), None),
        5 => (Value::Float(r.f64()?), None),
        6 => {
            let sign = r.u8()?;
            let groups = r.uvarint_groups()?;
            (Value::BigInt(groups_to_decimal(sign, &groups)), None)
        }
        7 => (Value::Str(r.string()?), None),

        10 => (sym(r, "registered")?, None),
        11 => (sym(r, "unique")?, None),
        12 => (sym(r, "well_known")?, None),

        20 => {
            let n = r.uvarint_usize()?;
            let mut refs = Vec::with_capacity(n);
            for _ in 0..n {
                refs.push(r.uvarint_usize()?);
            }
            let rc = Rc::new(RefCell::new(Vec::new()));
            (Value::Array(rc.clone()), Some(Filler::Array(rc, refs)))
        }
        21 => {
            let entries = read_entries(r)?;
            let rc = Rc::new(RefCell::new(Vec::new()));
            (Value::Object(rc.clone()), Some(Filler::Object(rc, entries)))
        }
        22 | 30 => {
            let n = r.uvarint_usize()?;
            let mut pairs = Vec::with_capacity(n);
            for _ in 0..n {
                pairs.push((r.uvarint_usize()?, r.uvarint_usize()?));
            }
            let rc = Rc::new(RefCell::new(Vec::new()));
            (Value::Map(rc.clone()), Some(Filler::Map(rc, pairs)))
        }
        23 | 31 => {
            let n = r.uvarint_usize()?;
            let mut refs = Vec::with_capacity(n);
            for _ in 0..n {
                refs.push(r.uvarint_usize()?);
            }
            let rc = Rc::new(RefCell::new(Vec::new()));
            (Value::Set(rc.clone()), Some(Filler::Set(rc, refs)))
        }

        40 => {
            let unix_ms = r.svarint()?;
            let sub_ms_nanos = r.svarint()?;
            (
                Value::Date {
                    unix_ms,
                    sub_ms_nanos,
                },
                None,
            )
        }
        41 => {
            let n = r.uvarint_usize()?;
            (Value::Bytes(r.take(n)?.to_vec()), None)
        }
        42 => {
            let et = r.u8()?;
            let n = r.uvarint_usize()?;
            let raw = r.take(n)?.to_vec();
            (
                Value::TypedArray {
                    element_type: element_type_name(et)?.to_string(),
                    data: raw,
                },
                None,
            )
        }
        43 => (
            Value::Regex {
                source: r.string()?,
                flags: r.string()?,
            },
            None,
        ),
        44 => (Value::Url(r.string()?), None),
        45 => {
            let n = r.uvarint_usize()?;
            (Value::DataView(r.take(n)?.to_vec()), None)
        }
        46 => {
            let name = r.string()?;
            let message = r.string()?;
            let flags = r.u8()?;
            let has_cause = flags & 1 != 0;
            let cause_ref = if has_cause {
                Some(r.uvarint_usize()?)
            } else {
                None
            };
            let entries = read_entries(r)?;
            let rc = Rc::new(RefCell::new(ErrorObj {
                name,
                message,
                has_cause,
                cause: Value::Null,
                extra: Vec::new(),
            }));
            (
                Value::Error(rc.clone()),
                Some(Filler::Error(rc, cause_ref, entries)),
            )
        }

        other => return Err(format!("unknown tag: {}", other)),
    })
}

fn sym(r: &mut Reader, kind: &str) -> Result<Value, String> {
    Ok(Value::Symbol(Rc::new(SymbolKind {
        kind: kind.to_string(),
        value: r.string()?,
    })))
}

fn resolve_key(key: &RawKey, heap: &[Value]) -> Key {
    match key {
        RawKey::Str(s) => Key::Str(s.clone()),
        RawKey::Sym(i) => Key::Sym(heap[*i].clone()),
    }
}

fn fill(filler: Filler, heap: &[Value]) {
    match filler {
        Filler::Array(rc, refs) => {
            let mut v = rc.borrow_mut();
            for i in refs {
                v.push(heap[i].clone());
            }
        }
        Filler::Object(rc, entries) => {
            let mut v = rc.borrow_mut();
            for e in entries {
                v.push((resolve_key(&e.key, heap), heap[e.val].clone()));
            }
        }
        Filler::Map(rc, pairs) => {
            let mut v = rc.borrow_mut();
            for (k, val) in pairs {
                v.push((heap[k].clone(), heap[val].clone()));
            }
        }
        Filler::Set(rc, refs) => {
            let mut v = rc.borrow_mut();
            for i in refs {
                v.push(heap[i].clone());
            }
        }
        Filler::Error(rc, cause_ref, entries) => {
            let mut e = rc.borrow_mut();
            if let Some(ci) = cause_ref {
                e.cause = heap[ci].clone();
            }
            for entry in entries {
                e.extra
                    .push((resolve_key(&entry.key, heap), heap[entry.val].clone()));
            }
        }
    }
}

pub fn decode(data: &[u8]) -> Result<Value, String> {
    let mut r = Reader::new(data);
    if r.take(4)? != b"GRF1" {
        return Err("bad magic: not a Graft file".into());
    }
    let version = r.u8()?;
    if version != 1 {
        return Err(format!("unsupported version: {}", version));
    }
    let root = r.uvarint_usize()?;
    let count = r.uvarint_usize()?;

    let mut heap: Vec<Value> = Vec::with_capacity(count);
    let mut fillers: Vec<Filler> = Vec::new();
    for _ in 0..count {
        let (value, filler) = read_node(&mut r)?;
        heap.push(value);
        if let Some(f) = filler {
            fillers.push(f);
        }
    }
    for f in fillers {
        fill(f, &heap);
    }
    heap.get(root)
        .cloned()
        .ok_or_else(|| format!("root index {} out of range", root))
}
