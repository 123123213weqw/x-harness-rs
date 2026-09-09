//! Replay numeric-only observations; contains no prompt or credential handling.
use serde::Deserialize;
use std::io::{self, BufRead};
use xharness_token::{Calibration, WireFeatures};
#[derive(Deserialize)]
struct Row {
    scope: String,
    request_id: String,
    features: WireFeatures,
    actual: u64,
    old_estimate: u64,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut c = Calibration::default();
    for line in io::stdin().lock().lines() {
        let r: Row = serde_json::from_str(&line?)?;
        let e = c.estimate(&r.scope, &r.features);
        println!(
            "{}",
            serde_json::json!({"request":r.request_id,"old_estimate":r.old_estimate,"estimate":e.input_tokens,"actual":r.actual,"accuracy":e.accuracy,"under":e.input_tokens<r.actual})
        );
        c.observe(&r.scope, &r.request_id, r.features, r.actual);
    }
    Ok(())
}
