//! Content-free transport measurements, independent of journal commit time.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceptionSample {
    pub time_ms: u64,
    pub text_units: u64,
    pub reasoning_units: u64,
    pub argument_units: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReception {
    pub attempt: u32,
    pub start_ms: u64,
    pub first_delta_ms: Option<u64>,
    pub elapsed_ms: u64,
    /// Monotonic first-reception -> completion span. A single instant burst
    /// uses request elapsed time instead of dividing by zero.
    pub reception_ms: u64,
    pub estimated_units: u64,
    #[serde(default)]
    pub estimated_reasoning_units: u64,
    pub finished: bool,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    /// Incremental, one-second buckets; never contains provider text.
    pub samples: Vec<ReceptionSample>,
}

/// Additive quarter-token weights; chunk boundaries do not change the count.
pub fn reception_units(text: &str) -> u64 {
    text.chars().fold(0u64, |n, c| {
        n.saturating_add(if c.is_ascii() { 1 } else { 4 })
    })
}
