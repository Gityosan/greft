//! Graft conformance — Rust reference port.
//!
//! Decodes every `spec/golden/*.bin` with the reference decoder and asserts the
//! result against the vector's `.meta.json` sidecar (see `../README.md` §2).
//! Zero external dependencies so it builds and runs offline.

pub mod decode;
pub mod encode;
pub mod json;
pub mod matcher;
pub mod value;

use std::fs;
use std::path::PathBuf;

pub fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/golden")
}

pub struct Report {
    pub passed: usize,
    pub failed: usize,
    pub lines: Vec<String>,
}

/// Runs every golden vector and collects a per-vector pass/fail line.
pub fn run_all() -> Report {
    let dir = golden_dir();
    let mut report = Report {
        passed: 0,
        failed: 0,
        lines: Vec::new(),
    };

    let mut files: Vec<String> = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".bin"))
            .collect(),
        Err(e) => {
            report.failed += 1;
            report.lines.push(format!("  FAIL cannot read {}: {}", dir.display(), e));
            return report;
        }
    };
    files.sort();

    for name in files {
        match run_one(&dir, &name) {
            Ok(()) => {
                report.passed += 1;
                report.lines.push(format!("  ok   {}", name));
            }
            Err(e) => {
                report.failed += 1;
                report.lines.push(format!("  FAIL {}: {}", name, e));
            }
        }
    }
    report
}

fn run_one(dir: &std::path::Path, name: &str) -> Result<(), String> {
    let bin = fs::read(dir.join(name)).map_err(|e| e.to_string())?;
    let meta_name = format!("{}.meta.json", &name[..name.len() - 4]);
    let meta_src = fs::read_to_string(dir.join(&meta_name)).map_err(|e| e.to_string())?;
    let decoded = decode::decode(&bin)?;
    let meta = json::parse(&meta_src)?;
    matcher::match_vector(&decoded, &meta)
}

/// Re-encodes every decoded golden vector and checks the bytes are identical to
/// the original — proving the encoder is a faithful clone of the reference.
pub fn run_roundtrip() -> Report {
    let dir = golden_dir();
    let mut report = Report {
        passed: 0,
        failed: 0,
        lines: Vec::new(),
    };
    let mut files: Vec<String> = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".bin"))
            .collect(),
        Err(e) => {
            report.failed += 1;
            report.lines.push(format!("  FAIL cannot read {}: {}", dir.display(), e));
            return report;
        }
    };
    files.sort();

    for name in files {
        match roundtrip_one(&dir, &name) {
            Ok(len) => {
                report.passed += 1;
                report.lines.push(format!("  ok   {} ({} bytes)", name, len));
            }
            Err(e) => {
                report.failed += 1;
                report.lines.push(format!("  FAIL {}: {}", name, e));
            }
        }
    }
    report
}

fn roundtrip_one(dir: &std::path::Path, name: &str) -> Result<usize, String> {
    let original = fs::read(dir.join(name)).map_err(|e| e.to_string())?;
    let decoded = decode::decode(&original)?;
    let reencoded = encode::encode(&decoded);
    if reencoded == original {
        Ok(original.len())
    } else {
        Err(format!(
            "{} vs {} bytes, not identical",
            original.len(),
            reencoded.len()
        ))
    }
}
