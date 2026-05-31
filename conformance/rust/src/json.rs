//! Minimal JSON parser for the `.meta.json` sidecars. Hand-rolled so the
//! conformance port has zero external dependencies. Supports the subset emitted
//! by `JSON.stringify`: objects (order-preserving), arrays, strings with the
//! standard escapes (incl. `\uXXXX` and surrogate pairs), numbers, and literals.

#[derive(Debug, Clone)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(v) => v.iter().find(|(k, _)| k == key).map(|(_, val)| val),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Int(i) => Some(*i),
            Json::Float(f) => Some(*f as i64),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Float(f) => Some(*f),
            Json::Int(i) => Some(*i as f64),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Json>> {
        match self {
            Json::Array(v) => Some(v),
            _ => None,
        }
    }
}

pub fn parse(s: &str) -> Result<Json, String> {
    let mut p = Parser {
        chars: s.chars().collect(),
        pos: 0,
    };
    p.skip_ws();
    let v = p.value()?;
    p.skip_ws();
    if p.pos != p.chars.len() {
        return Err("trailing data after JSON".into());
    }
    Ok(v)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }
    fn next(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }
    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c == ' ' || c == '\n' || c == '\t' || c == '\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        match self.peek() {
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => Ok(Json::Str(self.string()?)),
            Some('t') | Some('f') => self.boolean(),
            Some('n') => self.null(),
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            other => Err(format!("unexpected character: {:?}", other)),
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.next(); // {
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.next();
            return Ok(Json::Object(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some('"') {
                return Err("expected string key".into());
            }
            let key = self.string()?;
            self.skip_ws();
            if self.next() != Some(':') {
                return Err("expected ':'".into());
            }
            self.skip_ws();
            let val = self.value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.next() {
                Some(',') => continue,
                Some('}') => break,
                other => return Err(format!("expected ',' or '}}', got {:?}", other)),
            }
        }
        Ok(Json::Object(entries))
    }

    fn array(&mut self) -> Result<Json, String> {
        self.next(); // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(']') {
            self.next();
            return Ok(Json::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value()?);
            self.skip_ws();
            match self.next() {
                Some(',') => continue,
                Some(']') => break,
                other => return Err(format!("expected ',' or ']', got {:?}", other)),
            }
        }
        Ok(Json::Array(items))
    }

    fn string(&mut self) -> Result<String, String> {
        self.next(); // opening quote
        let mut out = String::new();
        loop {
            match self.next() {
                None => return Err("unterminated string".into()),
                Some('"') => break,
                Some('\\') => {
                    let esc = self.next().ok_or("unterminated escape")?;
                    match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{0008}'),
                        'f' => out.push('\u{000C}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.unicode_escape()?),
                        other => return Err(format!("bad escape \\{}", other)),
                    }
                }
                Some(c) => out.push(c),
            }
        }
        Ok(out)
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for _ in 0..4 {
            let c = self.next().ok_or("unterminated \\u escape")?;
            let d = c.to_digit(16).ok_or("bad hex digit in \\u escape")?;
            v = v * 16 + d;
        }
        Ok(v)
    }

    fn unicode_escape(&mut self) -> Result<char, String> {
        let hi = self.hex4()?;
        // Combine a UTF-16 surrogate pair if present.
        if (0xD800..=0xDBFF).contains(&hi) {
            if self.next() != Some('\\') || self.next() != Some('u') {
                return Err("expected low surrogate".into());
            }
            let lo = self.hex4()?;
            if !(0xDC00..=0xDFFF).contains(&lo) {
                return Err("invalid low surrogate".into());
            }
            let cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
            return char::from_u32(cp).ok_or_else(|| "invalid code point".into());
        }
        char::from_u32(hi).ok_or_else(|| "invalid code point".into())
    }

    fn boolean(&mut self) -> Result<Json, String> {
        if self.consume("true") {
            Ok(Json::Bool(true))
        } else if self.consume("false") {
            Ok(Json::Bool(false))
        } else {
            Err("invalid literal".into())
        }
    }

    fn null(&mut self) -> Result<Json, String> {
        if self.consume("null") {
            Ok(Json::Null)
        } else {
            Err("invalid literal".into())
        }
    }

    fn consume(&mut self, word: &str) -> bool {
        let end = self.pos + word.len();
        if end <= self.chars.len() && self.chars[self.pos..end].iter().collect::<String>() == word {
            self.pos = end;
            true
        } else {
            false
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        let mut is_float = false;
        while let Some(c) = self.peek() {
            match c {
                '0'..='9' | '-' | '+' => self.pos += 1,
                '.' | 'e' | 'E' => {
                    is_float = true;
                    self.pos += 1;
                }
                _ => break,
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        if is_float {
            text.parse::<f64>().map(Json::Float).map_err(|e| e.to_string())
        } else {
            match text.parse::<i64>() {
                Ok(i) => Ok(Json::Int(i)),
                Err(_) => text.parse::<f64>().map(Json::Float).map_err(|e| e.to_string()),
            }
        }
    }
}
