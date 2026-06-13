//! Graft native decode core — PoC (see ../README.md).
//!
//! Exposes two Python entry points via PyO3:
//!   * `decode(bytes) -> object`  — full decode that materialises a *native
//!     Python* value graph (None/bool/int/float/str/list/dict), preserving
//!     shared identity and cycles via the FORMAT.md §4 two-pass heap. This is
//!     the realistic "native binding" experience a Python caller would get.
//!   * `parse_count(bytes) -> int` — decode into a Rust-only value graph and
//!     return the heap node count. Measures the raw parse ceiling with no
//!     Python-object marshalling, i.e. the number a Rust *consumer* would see.
//!
//! Scope: the JSON-shaped hot path (the bulk of mock fixtures). Tags outside
//! null/undefined/bool/int/bigint/float/string/array/object raise — the PoC is
//! about throughput on the common case, not feature coverage.

use std::cell::RefCell;
use std::rc::Rc;

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

// ---- low-level reader (varint / ZigZag / float-LE / UTF-8) -----------------

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
    fn usize(&mut self) -> Result<usize, String> {
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
    fn f64(&mut self) -> Result<f64, String> {
        let b = self.take(8)?;
        let arr: [u8; 8] = b.try_into().map_err(|_| "short f64".to_string())?;
        Ok(f64::from_le_bytes(arr))
    }
    fn string(&mut self) -> Result<String, String> {
        let n = self.usize()?;
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes)
            .map(|s| s.to_owned())
            .map_err(|_| "invalid utf-8".into())
    }
}

fn header(r: &mut Reader) -> Result<(usize, usize), String> {
    if r.take(4)? != b"GRF1" {
        return Err("bad magic: not a Graft file".into());
    }
    if r.u8()? != 1 {
        return Err("unsupported version".into());
    }
    let root = r.usize()?;
    let count = r.usize()?;
    Ok((root, count))
}

// ---- path 1: decode into native Python objects (PyO3) ----------------------

enum PyFiller {
    Array(usize, Vec<usize>),
    Object(usize, Vec<(String, usize)>),
}

fn read_py_node(
    py: Python<'_>,
    r: &mut Reader,
    idx: usize,
) -> Result<(Py<PyAny>, Option<PyFiller>), String> {
    let tag = r.u8()?;
    let leaf = |o: Py<PyAny>| Ok((o, None));
    match tag {
        0 => leaf(py.None()),
        1 => leaf(py.None()), // undefined -> None for the PoC payload
        2 => leaf(false.into_pyobject(py).unwrap().to_owned().into_any().unbind()),
        3 => leaf(true.into_pyobject(py).unwrap().to_owned().into_any().unbind()),
        4 => leaf(r.svarint()?.into_pyobject(py).unwrap().into_any().unbind()),
        5 => leaf(r.f64()?.into_pyobject(py).unwrap().into_any().unbind()),
        6 => {
            let sign = r.u8()?;
            let mag = r.uvarint()?;
            let v = if sign == 1 { -(mag as i128) } else { mag as i128 };
            leaf(v.into_pyobject(py).unwrap().into_any().unbind())
        }
        7 => leaf(r.string()?.into_pyobject(py).unwrap().into_any().unbind()),
        20 => {
            let n = r.usize()?;
            let mut refs = Vec::with_capacity(n);
            for _ in 0..n {
                refs.push(r.usize()?);
            }
            let list = PyList::empty(py);
            Ok((list.into_any().unbind(), Some(PyFiller::Array(idx, refs))))
        }
        21 => {
            let n = r.usize()?;
            let mut entries = Vec::with_capacity(n);
            for _ in 0..n {
                let kind = r.u8()?;
                if kind != 0 {
                    return Err("PoC decodes string keys only".into());
                }
                let key = r.string()?;
                let val = r.usize()?;
                entries.push((key, val));
            }
            let dict = PyDict::new(py);
            Ok((dict.into_any().unbind(), Some(PyFiller::Object(idx, entries))))
        }
        other => Err(format!("PoC does not decode tag {} (JSON-shaped only)", other)),
    }
}

fn fill_py(py: Python<'_>, heap: &[Py<PyAny>], f: PyFiller) -> Result<(), String> {
    match f {
        PyFiller::Array(i, refs) => {
            let bound = heap[i].bind(py);
            let list = bound.downcast::<PyList>().map_err(|e| e.to_string())?;
            for r in refs {
                list.append(heap[r].clone_ref(py)).map_err(|e| e.to_string())?;
            }
        }
        PyFiller::Object(i, entries) => {
            let bound = heap[i].bind(py);
            let dict = bound.downcast::<PyDict>().map_err(|e| e.to_string())?;
            for (k, v) in entries {
                dict.set_item(k, heap[v].clone_ref(py))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn decode_to_py(py: Python<'_>, data: &[u8]) -> Result<Py<PyAny>, String> {
    let mut r = Reader::new(data);
    let (root, count) = header(&mut r)?;
    let mut heap: Vec<Py<PyAny>> = Vec::with_capacity(count);
    let mut fillers: Vec<PyFiller> = Vec::new();
    for i in 0..count {
        let (val, filler) = read_py_node(py, &mut r, i)?;
        heap.push(val);
        if let Some(f) = filler {
            fillers.push(f);
        }
    }
    for f in fillers {
        fill_py(py, &heap, f)?;
    }
    heap.get(root)
        .map(|v| v.clone_ref(py))
        .ok_or_else(|| "root index out of range".into())
}

// ---- path 2: decode into a Rust-only graph (the parse ceiling) -------------

#[derive(Clone)]
enum RVal {
    Leaf,
    Str(Rc<String>),
    Array(Rc<RefCell<Vec<RVal>>>),
    Object(Rc<RefCell<Vec<(String, RVal)>>>),
}

enum RFiller {
    Array(Rc<RefCell<Vec<RVal>>>, Vec<usize>),
    Object(Rc<RefCell<Vec<(String, RVal)>>>, Vec<(String, usize)>),
}

fn read_r_node(r: &mut Reader) -> Result<(RVal, Option<RFiller>), String> {
    let tag = r.u8()?;
    match tag {
        0 | 1 | 2 | 3 => Ok((RVal::Leaf, None)),
        4 => {
            r.svarint()?;
            Ok((RVal::Leaf, None))
        }
        5 => {
            r.f64()?;
            Ok((RVal::Leaf, None))
        }
        6 => {
            r.u8()?;
            r.uvarint()?;
            Ok((RVal::Leaf, None))
        }
        7 => Ok((RVal::Str(Rc::new(r.string()?)), None)),
        20 => {
            let n = r.usize()?;
            let mut refs = Vec::with_capacity(n);
            for _ in 0..n {
                refs.push(r.usize()?);
            }
            let rc = Rc::new(RefCell::new(Vec::new()));
            Ok((RVal::Array(rc.clone()), Some(RFiller::Array(rc, refs))))
        }
        21 => {
            let n = r.usize()?;
            let mut entries = Vec::with_capacity(n);
            for _ in 0..n {
                let kind = r.u8()?;
                if kind != 0 {
                    return Err("PoC decodes string keys only".into());
                }
                let key = r.string()?;
                let val = r.usize()?;
                entries.push((key, val));
            }
            let rc = Rc::new(RefCell::new(Vec::new()));
            Ok((RVal::Object(rc.clone()), Some(RFiller::Object(rc, entries))))
        }
        other => Err(format!("PoC does not decode tag {} (JSON-shaped only)", other)),
    }
}

fn parse_to_rust(data: &[u8]) -> Result<usize, String> {
    let mut r = Reader::new(data);
    let (_root, count) = header(&mut r)?;
    let mut heap: Vec<RVal> = Vec::with_capacity(count);
    let mut fillers: Vec<RFiller> = Vec::new();
    for _ in 0..count {
        let (val, filler) = read_r_node(&mut r)?;
        heap.push(val);
        if let Some(f) = filler {
            fillers.push(f);
        }
    }
    for f in fillers {
        match f {
            RFiller::Array(rc, refs) => {
                let mut v = rc.borrow_mut();
                for i in refs {
                    v.push(heap[i].clone());
                }
            }
            RFiller::Object(rc, entries) => {
                let mut v = rc.borrow_mut();
                for (k, i) in entries {
                    v.push((k, heap[i].clone()));
                }
            }
        }
    }
    Ok(heap.len())
}

// ---- PyO3 surface ----------------------------------------------------------

#[pyfunction]
fn decode(py: Python<'_>, data: &[u8]) -> PyResult<Py<PyAny>> {
    decode_to_py(py, data).map_err(PyValueError::new_err)
}

#[pyfunction]
fn parse_count(data: &[u8]) -> PyResult<usize> {
    parse_to_rust(data).map_err(PyValueError::new_err)
}

#[pymodule]
fn graft_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(decode, m)?)?;
    m.add_function(wrap_pyfunction!(parse_count, m)?)?;
    Ok(())
}
