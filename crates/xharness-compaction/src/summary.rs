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
pub const DEFAULT_COMPACTION_INSTRUCTION: &str = "Act as the compaction engine. Write compact technical evidence notes for ONLY the supplied raw historical fragment. Later messages may exist outside this span and determine the current task. Preserve any stated task scope and explicit restrictions, including ones at the beginning of a long fragment. Preserve exact paths, identifiers, commands, tested changes, failures, numeric values and explicit user corrections. Distinguish observations, proposals and unknown outcomes. Attribute uncorroborated assistant assertions as claims; passing tests establish only the cases actually tested. An assistant plan is not a standing user instruction. Existing checkpoints are not summary sources: do not re-summarize or merge prior compacted notes. Omit empty sections and boilerplate; target substantially less text than the source. Output only notes; do not call tools.";

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
    fn compaction_instruction_limits_input_to_new_raw_evidence() {
        assert!(
            DEFAULT_COMPACTION_INSTRUCTION.contains("ONLY the supplied raw historical fragment")
        );
        assert!(DEFAULT_COMPACTION_INSTRUCTION
            .contains("An assistant plan is not a standing user instruction"));
        assert!(DEFAULT_COMPACTION_INSTRUCTION
            .contains("do not re-summarize or merge prior compacted notes"));
        assert!(!DEFAULT_COMPACTION_INSTRUCTION.contains("## Next Step"));
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
