//! Matches a decoded value against its `.meta.json` description (../README.md §2).
//! Binds each `$ref` index to the decoded object on first sight and asserts
//! pointer identity on every later occurrence, so shared references and cycles
//! must be genuinely restored. Container entries are matched positionally, which
//! also verifies the property order the format mandates.

use crate::value::{hex, ref_id, Key, Value};
use serde_json::Value as Json;
use std::collections::{HashMap, HashSet};

pub fn match_vector(decoded: &Value, meta: &Json) -> Result<(), String> {
    let nodes = meta
        .get("nodes")
        .and_then(Json::as_array)
        .ok_or("meta.nodes missing")?;
    let root = meta.get("root").ok_or("meta.root missing")?;
    let mut m = Matcher {
        nodes,
        bound: HashMap::new(),
        claimed: HashSet::new(),
    };
    m.match_value(root, decoded, "$")
}

struct Matcher<'a> {
    nodes: &'a Vec<Json>,
    bound: HashMap<usize, usize>,
    claimed: HashSet<usize>,
}

fn req(ok: bool, path: &str, msg: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(format!("{}: {}", path, msg))
    }
}

impl<'a> Matcher<'a> {
    fn match_value(&mut self, mv: &Json, actual: &Value, path: &str) -> Result<(), String> {
        if let Some(idx) = mv.get("$ref").and_then(Json::as_i64) {
            let idx = idx as usize;
            let node = self
                .nodes
                .get(idx)
                .ok_or_else(|| format!("{}: dangling $ref {}", path, idx))?;
            let sub = format!("{}#{}", path, idx);
            match ref_id(actual) {
                Some(ptr) => {
                    if let Some(&prev) = self.bound.get(&idx) {
                        return req(
                            prev == ptr,
                            path,
                            &format!("identity mismatch for $ref {}", idx),
                        );
                    }
                    self.bound.insert(idx, ptr);
                    self.claimed.insert(ptr);
                    self.match_node(node, actual, &sub)
                }
                // Value-type leaves (Date/Bytes/RegExp/Url/DataView/TypedArray)
                // carry no identity; match structurally. Golden never shares them.
                None => self.match_node(node, actual, &sub),
            }
        } else {
            self.match_inline(mv, actual, path)
        }
    }

    fn match_inline(&mut self, mv: &Json, actual: &Value, path: &str) -> Result<(), String> {
        let tag = mv
            .get("$")
            .and_then(Json::as_str)
            .ok_or("missing inline $")?;
        match tag {
            "null" => req(matches!(actual, Value::Null), path, "expected null"),
            "undefined" => req(
                matches!(actual, Value::Undefined),
                path,
                "expected undefined",
            ),
            "bool" => {
                let v = mv.get("v").and_then(Json::as_bool).ok_or("bad bool")?;
                req(
                    matches!(actual, Value::Bool(b) if *b == v),
                    path,
                    "bool mismatch",
                )
            }
            "int" => {
                let v = mv.get("v").and_then(Json::as_i64).ok_or("bad int")?;
                req(
                    matches!(actual, Value::Int(i) if *i == v),
                    path,
                    "int mismatch",
                )
            }
            "bigint" => {
                let v = mv.get("v").and_then(Json::as_str).ok_or("bad bigint")?;
                req(
                    matches!(actual, Value::BigInt(s) if s == v),
                    path,
                    "bigint mismatch",
                )
            }
            "string" => {
                let v = mv.get("v").and_then(Json::as_str).ok_or("bad string")?;
                req(
                    matches!(actual, Value::Str(s) if s == v),
                    path,
                    "string mismatch",
                )
            }
            "float" => self.match_float(mv.get("v").ok_or("bad float")?, actual, path),
            other => Err(format!("{}: unknown inline tag {}", path, other)),
        }
    }

    fn match_float(&self, v: &Json, actual: &Value, path: &str) -> Result<(), String> {
        let f = match actual {
            Value::Float(f) => *f,
            _ => return Err(format!("{}: expected float", path)),
        };
        match v.as_str() {
            Some("NaN") => req(f.is_nan(), path, "expected NaN"),
            Some("Infinity") => req(f == f64::INFINITY, path, "expected Infinity"),
            Some("-Infinity") => req(f == f64::NEG_INFINITY, path, "expected -Infinity"),
            Some("-0") => req(f == 0.0 && f.is_sign_negative(), path, "expected -0"),
            Some(_) => Err(format!("{}: unexpected float token", path)),
            None => {
                let n = v.as_f64().ok_or("bad float value")?;
                req(f == n, path, "float mismatch")
            }
        }
    }

    fn match_node(&mut self, node: &Json, actual: &Value, path: &str) -> Result<(), String> {
        let tag = node
            .get("tag")
            .and_then(Json::as_str)
            .ok_or("node missing tag")?;
        match tag {
            "Object" => self.match_object(node, actual, path),
            "Array" => {
                let items = node
                    .get("items")
                    .and_then(Json::as_array)
                    .ok_or("bad items")?;
                if let Value::Array(rc) = actual {
                    let arr = rc.borrow();
                    req(arr.len() == items.len(), path, "array length mismatch")?;
                    for (i, mv) in items.iter().enumerate() {
                        self.match_value(mv, &arr[i], &format!("{}[{}]", path, i))?;
                    }
                    Ok(())
                } else {
                    Err(format!("{}: expected array", path))
                }
            }
            "Map" => {
                let entries = node
                    .get("entries")
                    .and_then(Json::as_array)
                    .ok_or("bad entries")?;
                if let Value::Map(rc) = actual {
                    let pairs = rc.borrow();
                    req(pairs.len() == entries.len(), path, "map size mismatch")?;
                    for (i, e) in entries.iter().enumerate() {
                        self.match_value(
                            e.get("key").ok_or("key")?,
                            &pairs[i].0,
                            &format!("{}{{k{}}}", path, i),
                        )?;
                        self.match_value(
                            e.get("value").ok_or("value")?,
                            &pairs[i].1,
                            &format!("{}{{v{}}}", path, i),
                        )?;
                    }
                    Ok(())
                } else {
                    Err(format!("{}: expected Map", path))
                }
            }
            "Set" => {
                let values = node
                    .get("values")
                    .and_then(Json::as_array)
                    .ok_or("bad values")?;
                if let Value::Set(rc) = actual {
                    let vals = rc.borrow();
                    req(vals.len() == values.len(), path, "set size mismatch")?;
                    for (i, mv) in values.iter().enumerate() {
                        self.match_value(mv, &vals[i], &format!("{}{{{}}}", path, i))?;
                    }
                    Ok(())
                } else {
                    Err(format!("{}: expected Set", path))
                }
            }
            "Date" => {
                let ms = node
                    .get("unix_ms")
                    .and_then(Json::as_i64)
                    .ok_or("bad unix_ms")?;
                req(
                    matches!(actual, Value::Date { unix_ms, .. } if *unix_ms == ms),
                    path,
                    "Date mismatch",
                )
            }
            "Bytes" => {
                let h = node.get("hex").and_then(Json::as_str).unwrap_or("");
                req(
                    matches!(actual, Value::Bytes(b) if hex(b) == h),
                    path,
                    "Bytes mismatch",
                )
            }
            "DataView" => {
                let h = node.get("hex").and_then(Json::as_str).unwrap_or("");
                req(
                    matches!(actual, Value::DataView(b) if hex(b) == h),
                    path,
                    "DataView mismatch",
                )
            }
            "TypedArray" => {
                let et = node
                    .get("element_type")
                    .and_then(Json::as_str)
                    .unwrap_or("");
                let h = node.get("hex").and_then(Json::as_str).unwrap_or("");
                req(
                    matches!(actual, Value::TypedArray { element_type, data } if element_type == et && hex(data) == h),
                    path,
                    "TypedArray mismatch",
                )
            }
            "RegExp" => {
                let src = node.get("source").and_then(Json::as_str).unwrap_or("");
                let fl = node.get("flags").and_then(Json::as_str).unwrap_or("");
                req(
                    matches!(actual, Value::Regex { source, flags } if source == src && flags == fl),
                    path,
                    "RegExp mismatch",
                )
            }
            "Url" => {
                let href = node.get("href").and_then(Json::as_str).unwrap_or("");
                req(
                    matches!(actual, Value::Url(h) if h == href),
                    path,
                    "Url mismatch",
                )
            }
            "Error" => self.match_error(node, actual, path),
            "SymbolRegistered" => self.match_symbol(actual, "registered", node.get("key"), path),
            "SymbolUnique" => self.match_symbol(actual, "unique", node.get("description"), path),
            "SymbolWellKnown" => self.match_symbol(actual, "well_known", node.get("name"), path),
            other => Err(format!("{}: unknown node tag {}", path, other)),
        }
    }

    fn match_symbol(
        &self,
        actual: &Value,
        kind: &str,
        val: Option<&Json>,
        path: &str,
    ) -> Result<(), String> {
        let expected = val.and_then(Json::as_str).ok_or("bad symbol value")?;
        req(
            matches!(actual, Value::Symbol(s) if s.kind == kind && s.value == expected),
            path,
            &format!("expected {} symbol", kind),
        )
    }

    fn match_object(&mut self, node: &Json, actual: &Value, path: &str) -> Result<(), String> {
        let entries = node
            .get("entries")
            .and_then(Json::as_array)
            .ok_or("bad entries")?;
        let rc = match actual {
            Value::Object(rc) => rc,
            _ => return Err(format!("{}: expected object", path)),
        };
        let decoded = rc.borrow();
        req(
            decoded.len() == entries.len(),
            path,
            "object entry count mismatch",
        )?;
        for (i, e) in entries.iter().enumerate() {
            self.match_entry(e, &decoded[i], path)?;
        }
        Ok(())
    }

    fn match_error(&mut self, node: &Json, actual: &Value, path: &str) -> Result<(), String> {
        let rc = match actual {
            Value::Error(rc) => rc,
            _ => return Err(format!("{}: expected Error", path)),
        };
        let err = rc.borrow();
        req(
            Some(err.name.as_str()) == node.get("name").and_then(Json::as_str),
            path,
            "error name mismatch",
        )?;
        req(
            Some(err.message.as_str()) == node.get("message").and_then(Json::as_str),
            path,
            "error message mismatch",
        )?;

        let has_cause = node
            .get("hasCause")
            .and_then(Json::as_bool)
            .unwrap_or(false);
        if has_cause {
            req(err.has_cause, path, "expected cause")?;
            self.match_value(
                node.get("cause").ok_or("cause")?,
                &err.cause,
                &format!("{}.cause", path),
            )?;
        } else {
            req(!err.has_cause, path, "unexpected cause")?;
        }

        let extra = node
            .get("extra")
            .and_then(Json::as_array)
            .ok_or("bad extra")?;
        req(
            err.extra.len() == extra.len(),
            path,
            "error extra count mismatch",
        )?;
        for (i, e) in extra.iter().enumerate() {
            self.match_entry(e, &err.extra[i], path)?;
        }
        Ok(())
    }

    /// Matches one Object/Error property entry against a decoded `(Key, Value)`.
    fn match_entry(&mut self, e: &Json, decoded: &(Key, Value), path: &str) -> Result<(), String> {
        let kind = e
            .get("keyKind")
            .and_then(Json::as_str)
            .ok_or("bad keyKind")?;
        let (key, val) = decoded;
        match kind {
            "string" => {
                let expected = e.get("key").and_then(Json::as_str).ok_or("bad key")?;
                match key {
                    Key::Str(s) => req(
                        s == expected,
                        path,
                        &format!("string key {} != {}", s, expected),
                    )?,
                    Key::Sym(_) => {
                        return Err(format!("{}: expected string key {}", path, expected))
                    }
                }
                self.match_value(
                    e.get("value").ok_or("value")?,
                    val,
                    &format!("{}.{}", path, expected),
                )
            }
            "symbol" => match key {
                Key::Sym(symval) => {
                    self.match_value(
                        e.get("key").ok_or("key")?,
                        symval,
                        &format!("{}[symkey]", path),
                    )?;
                    self.match_value(
                        e.get("value").ok_or("value")?,
                        val,
                        &format!("{}[symval]", path),
                    )
                }
                Key::Str(s) => Err(format!("{}: expected symbol key, got {}", path, s)),
            },
            other => Err(format!("{}: unknown keyKind {}", path, other)),
        }
    }
}
