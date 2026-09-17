//! Validate numeric-only recovery candidates without handling any prompts/keys.
use std::io::{self, Read};
use xharness_token::{Calibration, WireFeatures, MAX_CALIBRATION_BYTES};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_CALIBRATION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    let calibration = Calibration::restore(&bytes).map_err(io::Error::other)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    for (scope, rows) in value["scopes"].as_object().ok_or("missing scopes")? {
        let rows = rows.as_array().ok_or("missing rows")?;
        if let Some(last) = rows.last() {
            let features: WireFeatures = serde_json::from_value(last["features"].clone())?;
            let estimate = calibration.estimate(scope, &features);
            println!(
                "{}",
                serde_json::json!({"samples":rows.len(),"last_actual":last["actual"],"estimate":estimate.input_tokens,"accuracy":estimate.accuracy})
            );
        }
    }
    Ok(())
}
