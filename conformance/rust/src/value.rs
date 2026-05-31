//! Decoded value graph. Reference types are wrapped in `Rc` so shared identity
//! and cycles (FORMAT.md §4) are preserved across the heap, and so the matcher
//! can compare object identity by pointer.

use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone)]
pub enum Value {
    Null,
    Undefined,
    Bool(bool),
    Int(i64),
    Float(f64),
    BigInt(String), // signed decimal string (arbitrary precision)
    Str(String),
    Bytes(Vec<u8>),
    DataView(Vec<u8>),
    TypedArray { element_type: String, data: Vec<u8> },
    Date { unix_ms: i64, sub_ms_nanos: i64 },
    Regex { source: String, flags: String },
    Url(String),
    Symbol(Rc<SymbolKind>),
    Array(Rc<RefCell<Vec<Value>>>),
    Object(Rc<RefCell<Vec<(Key, Value)>>>),
    Map(Rc<RefCell<Vec<(Value, Value)>>>),
    Set(Rc<RefCell<Vec<Value>>>),
    Error(Rc<RefCell<ErrorObj>>),
}

pub struct SymbolKind {
    pub kind: String, // "registered" | "unique" | "well_known"
    pub value: String,
}

#[derive(Clone)]
pub enum Key {
    Str(String),
    Sym(Value), // always a Value::Symbol
}

pub struct ErrorObj {
    pub name: String,
    pub message: String,
    pub has_cause: bool,
    pub cause: Value,
    pub extra: Vec<(Key, Value)>,
}

/// Stable identity for reference types (used to verify shared refs / cycles).
pub fn ref_id(v: &Value) -> Option<usize> {
    match v {
        Value::Array(r) => Some(Rc::as_ptr(r) as *const () as usize),
        Value::Object(r) => Some(Rc::as_ptr(r) as *const () as usize),
        Value::Map(r) => Some(Rc::as_ptr(r) as *const () as usize),
        Value::Set(r) => Some(Rc::as_ptr(r) as *const () as usize),
        Value::Error(r) => Some(Rc::as_ptr(r) as *const () as usize),
        Value::Symbol(r) => Some(Rc::as_ptr(r) as *const () as usize),
        _ => None,
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
