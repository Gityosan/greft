// Runs the whole golden suite under `cargo test`. Prints each vector so a
// failure shows which one and why.

#[test]
fn all_golden_vectors_pass() {
    let report = graft_conformance::run_all();
    for line in &report.lines {
        println!("{}", line);
    }
    assert_eq!(
        report.failed, 0,
        "{} conformance vector(s) failed",
        report.failed
    );
}
