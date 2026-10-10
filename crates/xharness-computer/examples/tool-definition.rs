//! Export the exact model-facing declaration for offline contract/A-B tests.
fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&xharness_computer::definition()).unwrap()
    );
}
