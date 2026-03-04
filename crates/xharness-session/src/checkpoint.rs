//! Small, provider-independent execution checkpoint snapshots. Never store raw tool data.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepetitionState {
    pub fingerprint: String,
    pub count: usize,
    pub warned: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionCheckpointState {
    pub phase: u64,
    pub phase_end_step: usize,
    pub stage_pending: bool,
    pub repetition: RepetitionState,
    /// Kept until a complete model response consumes the checkpoint, including across compaction.
    pub pending_notice: Option<String>,
    pub pending_repetitions: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionNotice {
    pub kind: String,
    pub message: String,
    pub phase: u64,
    pub steps_completed: usize,
    pub phase_end_step: usize,
    pub hard_max_steps: Option<usize>,
}
