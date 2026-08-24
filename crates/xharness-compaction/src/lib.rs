//! Provider-neutral context compaction for XHarness.
//!
//! This crate owns policy resolution, pressure decisions, balanced surface
//! range planning, deterministic tool-result pruning and the summarization
//! backend seam. It deliberately does not mutate a session. The host/session
//! integration must journal a durable start/summary/replacement/end
//! transaction before a planned replacement becomes authoritative.

mod config;
mod planner;
mod pruner;
mod summary;

pub use config::{
    CompactionConfig, CompactionPolicyOverride, CompactionSpec, ModelCompactionPolicy, ModelTarget,
    RetentionPolicy, DEFAULT_COMPACTION_RETRIES, DEFAULT_MAX_OVERFLOW_RETRIES,
    DEFAULT_MAX_SUMMARY_TOKENS, DEFAULT_RETAIN_RATIO, DEFAULT_THRESHOLD_RATIO,
};
pub use planner::{
    select_compactable_range, BasicCompactionPlanner, CompactionDecision, CompactionPlan,
    CompactionRange, CompactionRequest, CompactionTrigger, SurfaceNode, SurfaceNodeKind,
};
pub use pruner::{
    PrunedText, ToolResultPruner, ToolResultPrunerConfig, DEFAULT_HEAD_CHARS, DEFAULT_TAIL_CHARS,
    DEFAULT_TOOL_RESULT_THRESHOLD_CHARS, PRUNE_MARKER,
};
pub use summary::{
    frame_summary, CompactionSummarizer, SummaryInput, SummaryRequest, SummaryResponse,
    CHECKPOINT_PREAMBLE, DEFAULT_COMPACTION_INSTRUCTION, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG,
};

/// Fail-closed errors shared by configuration, planning and summarization.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompactionError {
    #[error("invalid compaction configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid compaction surface: {0}")]
    InvalidSurface(String),
    #[error("compaction summary failed: {0}")]
    Summary(String),
    #[error("compaction was cancelled")]
    Cancelled,
}

impl CompactionError {
    pub fn invalid_config(message: impl Into<String>) -> Self {
        Self::InvalidConfig(message.into())
    }

    pub fn invalid_surface(message: impl Into<String>) -> Self {
        Self::InvalidSurface(message.into())
    }

    pub fn summary(message: impl Into<String>) -> Self {
        Self::Summary(message.into())
    }
}
