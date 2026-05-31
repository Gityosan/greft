use graft_conformance::run_all;

fn main() {
    let report = run_all();
    println!(
        "Graft conformance — Rust port ({} vectors)\n",
        report.passed + report.failed
    );
    for line in &report.lines {
        println!("{}", line);
    }
    println!("\n{} passed, {} failed", report.passed, report.failed);
    std::process::exit(if report.failed == 0 { 0 } else { 1 });
}
