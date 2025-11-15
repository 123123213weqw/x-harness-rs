use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use xharness_session::Message;

use crate::{CompactionError, CompactionPlan, ModelTarget};

pub const SUMMARY_OPEN_TAG: &str = "<compacted-summary>";
pub const SUMMARY_CLOSE_TAG: &str = "</compacted-summary>";
pub const CHECKPOINT_PREAMBLE: &str = "This is an automatically generated checkpoint condensing an earlier conversation span. Treat it as established background, continue from the messages that follow, and do not restate or acknowledge the checkpoint.";

/// Default final user instruction for a cache-friendly summary request. A
/// backend replays the original system/tools/messages before appending this
/// instruction, so the expensive prefix remains cacheable.
pub const DEFAULT_COMPACTION_INSTRUCTION: &str = r#"Act as the compaction engine for this coding agent. Condense the conversation above into one terse Markdown checkpoint that preserves everything needed to resume correctly.

Keep these sections, in order; write "(none)" for an empty section:
## Primary Request and Intent
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Pending Jobs
## Current Work
## Next Step
## Critical Context

Preserve exact paths, commands, errors, identifiers, numeric values and explicit user corrections. Merge still-valid facts from any prior compacted summary instead of copying it verbatim. Output only checkpoint text; do not call tools and do not mention compaction."#;

/// Cache-aligned replay input for the summary backend.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    pub messages: Vec<Message>,
}

/// Fully prepared auxiliary call. `purpose` is fixed by the consumer to
/// `compaction`; it is not a normal agent step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRequest {
    pub plan: CompactionPlan,
    pub input: SummaryInput,
    pub instruction: String,
}

impl SummaryRequest {
    pub fn new(plan: CompactionPlan, input: SummaryInput) -> Self {
        Self {
            plan,
            input,
            instruction: DEFAULT_COMPACTION_INSTRUCTION.to_owned(),
        }
    }

    pub fn target(&self) -> &ModelTarget {
        self.plan
            .spec
            .summarization_target
            .as_ref()
            .unwrap_or(&self.plan.spec.target)
    }
}

/// Text-only, complete summary. Truncated, image-bearing or empty provider
/// output must be rejected by the backend before constructing this value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResponse {
    pub text: String,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

/// Provider/model-specific summary execution seam. Durable replacement and
/// size comparison remain the compaction coordinator's responsibility.
#[async_trait]
pub trait CompactionSummarizer: Send + Sync + 'static {
    async fn summarize(
        &self,
        request: SummaryRequest,
        cancellation: CancellationToken,
    ) -> Result<SummaryResponse, CompactionError>;
}

pub fn frame_summary(summary: &str) -> Result<String, CompactionError> {
    if summary.trim().is_empty() {
        return Err(CompactionError::summary(
            "summarization produced no text content",
        ));
    }
    Ok(format!(
        "{CHECKPOINT_PREAMBLE}\n\n{SUMMARY_OPEN_TAG}\n{summary}\n{SUMMARY_CLOSE_TAG}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_frame_is_a_single_established_user_checkpoint() {
        let framed = frame_summary("## Current Work\n- fix parser").unwrap();
        assert!(framed.starts_with(CHECKPOINT_PREAMBLE));
        assert!(framed.contains("<compacted-summary>\n## Current Work"));
        assert!(framed.ends_with(SUMMARY_CLOSE_TAG));
        assert!(frame_summary("  \n").is_err());
    }
}
