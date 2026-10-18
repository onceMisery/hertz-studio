// SPDX-License-Identifier: MIT
#[path = "../tests/support/pitch_cases.rs"]
mod cases;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let report = cases::evaluate();
    let encoded = serde_json::to_string_pretty(&report)?;
    if let Some(path) = std::env::args().nth(1) {
        std::fs::write(path, &encoded)?;
    }
    println!("{encoded}");
    if report["passed"] != report["caseCount"] {
        std::process::exit(1);
    }
    Ok(())
}
