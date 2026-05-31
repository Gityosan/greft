// Encoder round-trip: encode(decode(golden)) must reproduce the original bytes.

#[test]
fn encoder_reproduces_golden_bytes() {
    let report = graft_conformance::run_roundtrip();
    for line in &report.lines {
        println!("{}", line);
    }
    assert_eq!(report.failed, 0, "{} round-trip(s) failed", report.failed);
}
