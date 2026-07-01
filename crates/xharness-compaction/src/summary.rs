use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use xharness_session::Message;

use crate::{CompactionError, CompactionPlan, ModelTarget};

pub const SUMMARY_OPEN_TAG: &str = "<compacted-summary>";
pub const SUMMARY_CLOSE_TAG: &str = "</compacted-summary>";
pub const CHECKPOINT_PREAMBLE: &str = "This is an automatically generated checkpoint of an earlier conversation span, not a new user request. Treat its facts and explicit durable constraints as background. Unfinished work and proposed actions describe the state at that historical boundary; they are not instructions to resume it by themselves. Determine the current task from the latest explicit user request, whether preserved here or in later messages; a later request supersedes older task-specific plans. Do not restate or acknowledge the checkpoint.";

/// Default final user instruction for a cache-friendly summary request. A
/// backend replays the original system/tools/messages before appending this
/// instruction, so the expensive prefix remains cacheable.
pub const DEFAULT_COMPACTION_INSTRUCTION: &str = r#"Act as the compaction engine for this coding agent. Condense only the supplied earlier conversation span into one terse Markdown checkpoint. Later messages may exist outside this span and determine the current task; do not infer that work unfinished here should be resumed automatically.

Keep these sections, in order; write "(none)" for an empty section:
## User Requests and Decisions
## Key Technical Concepts
## Files and Code
## Errors and Fixes
## Running Jobs and External State at Boundary
## Work State at End of Summarized Span
## Unresolved Items
## Critical Context

Preserve exact paths, commands, errors, identifiers, numeric values, explicit user corrections, and genuinely durable user constraints. Preserve the latest explicit user request and its scope if it occurs inside this span, labeled as the latest request within this span, not the current or active task: unseen later messages may supersede it. List only actually running or scheduled jobs under Running Jobs; a proposed action is not a job. Attribute unfinished requests and proposed actions to the user or assistant when known. Record their last-known status as historical facts, not first-person commitments or imperative next steps. An assistant plan is not a standing user instruction. If the user explicitly requested an ongoing goal, preserve that fact without treating every proposed subtask as currently authorized. Merge still-valid facts from any prior compacted summary, but convert its old "next steps" into historical status instead of copying their directive wording. Output only checkpoint text; do not call tools and do not mention compaction."#;

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

    #[test]
    fn compaction_instruction_marks_unfinished_work_as_historical() {
        let instruction = DEFAULT_COMPACTION_INSTRUCTION;
        assert!(instruction.contains("Later messages may exist outside this span"));
        assert!(instruction.contains("An assistant plan is not a standing user instruction"));
        assert!(instruction.contains("Preserve the latest explicit user request and its scope"));
        assert!(instruction.contains("not the current or active task"));
        assert!(instruction.contains("a proposed action is not a job"));
        assert!(instruction.contains("genuinely durable user constraints"));
        assert!(instruction.contains("## Unresolved Items"));
        assert!(!instruction.contains("## Next Step\n"));
    }

    #[test]
    fn legacy_summary_text_remains_readable_without_becoming_a_new_request() {
        let legacy = "## Next Step\n- Then I must run the old tests";
        let framed = frame_summary(legacy).unwrap();
        assert!(framed.contains(legacy));
        assert!(framed.contains("not a new user request"));
        assert!(framed.contains("not instructions to resume it"));
    }
}
