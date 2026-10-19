//! Model-visible context projection for XHarness.
//!
//! The append-only session remains the source of truth. A [`ContextPolicy`]
//! derives a disposable [`ContextSurface`] for one model request. Policies may
//! prune or compact that surface, but they never mutate durable history.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use xharness_compaction::{ToolResultPruner, ToolResultPrunerConfig};
use xharness_session::{ContentBlock, Message, MessageRole};

mod working_set;
pub use working_set::{
    approximate_working_set_tokens, calibrate_working_set_tokens, project_working_set,
    project_working_set_retaining, reuse_working_set, WorkingSetConfig, WorkingSetSource,
    WorkingSetSourceKind,
};

/// Maximum raw image bytes materialized into one model request. This is a
/// request resource budget, never a lifetime/session attachment limit.
pub const MAX_REQUEST_IMAGE_BYTES: u64 = 40 * 1024 * 1024;

/// Everything the context layer can inspect before a provider request is
/// prepared.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContextRequest {
    /// Complete provider-neutral transcript derived from the session log.
    pub messages: Vec<Message>,
    /// Stable provider adapter identity.
    pub provider: String,
    /// Configured model identity, if the adapter exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// One-based loop step.
    pub step: usize,
    /// Complete model-visible tool definitions encoded as provider-neutral
    /// JSON. They are present because schemas consume context budget too.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    /// Genuine user-message coordinates supplied by immutable event provenance.
    /// `None` is the legacy/unknown seam; `Some([])` explicitly means no real
    /// user request is present. Checkpoints, history references and runtime
    /// continuations must not establish a new user-request boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genuine_user_indices: Option<Vec<usize>>,
    /// Execution's per-result UTF-8 byte limit. The newest contiguous tool
    /// batch is preserved within this limit; older or oversized results remain
    /// prunable. `None` retains legacy pruning for callers without a limit.
    /// This does not replace admission against the whole request's token budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result_limit_bytes: Option<usize>,
}

impl ContextRequest {
    pub fn new(messages: Vec<Message>) -> Self {
        Self {
            messages,
            provider: "unknown".to_owned(),
            model: None,
            step: 0,
            tools: Vec::new(),
            genuine_user_indices: None,
            tool_result_limit_bytes: None,
        }
    }

    pub fn with_target(
        mut self,
        provider: impl Into<String>,
        model: Option<impl Into<String>>,
    ) -> Self {
        self.provider = provider.into();
        self.model = model.map(Into::into);
        self
    }

    pub const fn with_step(mut self, step: usize) -> Self {
        self.step = step;
        self
    }

    pub fn with_tools(mut self, tools: Vec<Value>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_genuine_user_indices(mut self, indices: Vec<usize>) -> Self {
        self.genuine_user_indices = Some(indices);
        self
    }

    pub fn with_tool_result_limit_bytes(mut self, limit: usize) -> Self {
        self.tool_result_limit_bytes = Some(limit);
        self
    }
}

/// Stable identity recorded beside every model-visible surface.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextPolicyId {
    pub name: String,
    pub version: u32,
}

impl ContextPolicyId {
    pub fn new(name: impl Into<String>, version: u32) -> Self {
        Self {
            name: name.into(),
            version,
        }
    }
}

/// Why a source range was replaced on the model-visible surface.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum SurfaceEditKind {
    ToolResultPruned,
    /// A completed assistant message was shortened without changing the
    /// immutable transcript. Counts describe the exact source characters
    /// removed from reasoning and tool arguments.
    AssistantHistoryPruned {
        reasoning_chars_removed: usize,
        /// Legacy audit field; v3 leaves tool arguments intact and records zero.
        tool_argument_chars_removed: usize,
    },
    HistoryCompacted,
    Custom(String),
}

/// One half-open replacement range in source-message coordinates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceEdit {
    pub source_start: usize,
    pub source_end: usize,
    pub replacement_messages: usize,
    pub kind: SurfaceEditKind,
}

impl SurfaceEdit {
    pub fn new(
        source_start: usize,
        source_end: usize,
        replacement_messages: usize,
        kind: SurfaceEditKind,
    ) -> Self {
        Self {
            source_start,
            source_end,
            replacement_messages,
            kind,
        }
    }
}

/// Disposable transcript sent toward the provider for one model step.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContextSurface {
    pub policy: ContextPolicyId,
    pub source_message_count: usize,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edits: Vec<SurfaceEdit>,
    /// Images remain in durable history; this counts references deferred only
    /// from the current model request. Kept separate from source-range edits
    /// because a compacted surface no longer has one-to-one source indexes.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub deferred_images: usize,
}

const fn is_zero(value: &usize) -> bool {
    *value == 0
}

impl ContextSurface {
    /// Build an unchanged surface while preserving the exact provider-neutral
    /// message representation, including opaque replay items.
    pub fn identity(messages: Vec<Message>) -> Self {
        let source_message_count = messages.len();
        Self {
            policy: ContextPolicyId::new("identity", 1),
            source_message_count,
            messages,
            edits: Vec::new(),
            deferred_images: 0,
        }
    }

    /// Build a transformed surface. [`Self::validate`] must succeed before the
    /// surface is used for provider I/O.
    pub fn transformed(
        policy: ContextPolicyId,
        source_message_count: usize,
        messages: Vec<Message>,
        edits: Vec<SurfaceEdit>,
    ) -> Self {
        Self {
            policy,
            source_message_count,
            messages,
            edits,
            deferred_images: 0,
        }
    }

    /// Keep recent visual context within the wire budget. Older images become
    /// explicit, session-scoped `read` references, not silent omissions. This
    /// changes only the disposable surface; the session log and UI stay intact.
    /// No fixed count of images is imposed on a conversation or request.
    pub fn defer_images_over_budget(&mut self, max_bytes: u64) {
        let mut used = 0u64;
        for message in self.messages.iter_mut().rev() {
            for block in message.content_blocks.iter_mut().rev() {
                let ContentBlock::Image { attachment } = block else {
                    continue;
                };
                if attachment.bytes <= max_bytes.saturating_sub(used) {
                    used = used.saturating_add(attachment.bytes);
                    continue;
                }
                let path = serde_json::to_string(&format!("attachment://{}", attachment.id))
                    .unwrap_or_default();
                *block = ContentBlock::Text {
                    text: format!(
                        "[Earlier image retained in conversation but deferred from this request because of the image budget. To inspect it again, use read with path {path}.]"
                    ),
                };
                self.deferred_images += 1;
            }
        }
    }

    /// Structural validation shared by every policy implementation.
    pub fn validate(&self) -> Result<(), ContextError> {
        if self.policy.name.trim().is_empty() {
            return Err(ContextError::invalid_surface(
                "context policy name must not be empty",
            ));
        }
        if self.policy.version == 0 {
            return Err(ContextError::invalid_surface(
                "context policy version must be greater than zero",
            ));
        }

        let mut previous_end = 0usize;
        for (index, edit) in self.edits.iter().enumerate() {
            if edit.source_start >= edit.source_end {
                return Err(ContextError::invalid_surface(format!(
                    "surface edit {index} has an empty or reversed source range"
                )));
            }
            if edit.source_end > self.source_message_count {
                return Err(ContextError::invalid_surface(format!(
                    "surface edit {index} ends beyond the source transcript"
                )));
            }
            if index > 0 && edit.source_start < previous_end {
                return Err(ContextError::invalid_surface(format!(
                    "surface edit {index} overlaps or is out of order"
                )));
            }
            previous_end = edit.source_end;
        }
        Ok(())
    }

    pub fn into_messages(self) -> Vec<Message> {
        self.messages
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ContextError {
    #[error("context policy failed: {message}")]
    Policy { message: String },
    #[error("invalid model-visible context surface: {message}")]
    InvalidSurface { message: String },
}

impl ContextError {
    pub fn policy(message: impl Into<String>) -> Self {
        Self::Policy {
            message: message.into(),
        }
    }

    pub fn invalid_surface(message: impl Into<String>) -> Self {
        Self::InvalidSurface {
            message: message.into(),
        }
    }
}

/// Projects immutable session history into one disposable model-visible
/// surface. Token counting and hard budget enforcement are deliberately later
/// stages because they must operate on the provider's prepared request.
#[async_trait]
pub trait ContextPolicy: Send + Sync + 'static {
    async fn prepare(&self, request: ContextRequest) -> Result<ContextSurface, ContextError>;
}

/// Compatibility policy that exposes the complete transcript unchanged.
/// Production hosts should replace this once budget enforcement is installed.
#[derive(Clone, Copy, Debug, Default)]
pub struct IdentityContextPolicy;

#[async_trait]
impl ContextPolicy for IdentityContextPolicy {
    async fn prepare(&self, request: ContextRequest) -> Result<ContextSurface, ContextError> {
        Ok(ContextSurface::identity(request.messages))
    }
}

/// Projection that deterministically shortens oversized tool observations and
/// reasoning from completed turns while preserving the immutable transcript.
///
/// Reasoning in the current user turn, every tool call's arguments and all
/// provider-owned replay items stay byte-for-byte intact. Do not replace file
/// contents with omission markers or add private fields to executable inputs.
/// The newest tool batch also stays intact within the caller's execution limit,
/// so the model can consume bounded structured observations before they age.
/// Large input histories are handled by the separate whole-history compaction
/// coordinator, which creates a clearly framed summary instead of fake calls.
/// This is deliberately model-free, so it also protects the request used to
/// run the normal LLM compaction coordinator.
#[derive(Clone, Debug, Default)]
pub struct ToolResultPruningContextPolicy {
    pruner: ToolResultPruner,
}

impl ToolResultPruningContextPolicy {
    pub fn new(config: ToolResultPrunerConfig) -> Result<Self, ContextError> {
        let pruner = ToolResultPruner::new(config)
            .map_err(|error| ContextError::policy(error.to_string()))?;
        Ok(Self { pruner })
    }

    pub fn config(&self) -> &ToolResultPrunerConfig {
        self.pruner.config()
    }
}

#[async_trait]
impl ContextPolicy for ToolResultPruningContextPolicy {
    async fn prepare(&self, request: ContextRequest) -> Result<ContextSurface, ContextError> {
        let source_message_count = request.messages.len();
        let mut call_names = HashMap::new();
        for message in &request.messages {
            for call in &message.tool_calls {
                call_names.insert(call.provider_id().to_owned(), call.name.clone());
            }
        }

        let latest_user_index = if let Some(indices) = &request.genuine_user_indices {
            for &index in indices {
                if request
                    .messages
                    .get(index)
                    .is_none_or(|message| message.role != MessageRole::User)
                {
                    return Err(ContextError::invalid_surface(format!(
                        "genuine user-message index {index} is outside the transcript or is not user-role"
                    )));
                }
            }
            // Coordinates are a set; don't silently trust caller ordering.
            indices.iter().copied().max()
        } else {
            request
                .messages
                .iter()
                .rposition(|message| message.role == MessageRole::User)
        };

        // Only the trailing batch has not yet been consumed by an assistant.
        // Its execution budget is explicit: imported/oversized results do not
        // gain an unlimited exemption, and prior batches remain prunable.
        let fresh_tools_start = request
            .messages
            .iter()
            .rposition(|message| message.role != MessageRole::Tool)
            .map_or(0, |index| index + 1);
        let mut messages = request.messages;
        let mut edits = Vec::new();
        for (index, message) in messages.iter_mut().enumerate() {
            if message.role == MessageRole::Assistant {
                let mut reasoning_chars_removed = 0;

                if latest_user_index.is_some_and(|latest| index < latest)
                    && !message.reasoning.is_empty()
                {
                    reasoning_chars_removed = message.reasoning.chars().count();
                    message.reasoning.clear();
                }

                if reasoning_chars_removed > 0 {
                    edits.push(SurfaceEdit::new(
                        index,
                        index + 1,
                        1,
                        SurfaceEditKind::AssistantHistoryPruned {
                            reasoning_chars_removed,
                            tool_argument_chars_removed: 0,
                        },
                    ));
                }
                continue;
            }

            if message.role != MessageRole::Tool {
                continue;
            }
            if index >= fresh_tools_start
                && request
                    .tool_result_limit_bytes
                    .is_some_and(|limit| message.content.len() <= limit)
            {
                continue;
            }
            let Some(pruned) = self.pruner.prune(&message.content) else {
                continue;
            };
            let call_id = message.tool_call_id.as_deref().unwrap_or("unknown");
            let tool = call_names
                .get(call_id)
                .map(String::as_str)
                .unwrap_or("unknown");
            // Keep durable recovery handles out of the head/tail excerpt: a
            // subsequent projection must not truncate the only way back to raw output.
            let archive = serde_json::from_str::<Value>(&message.content)
                .ok()
                .and_then(|value| {
                    let archive = value.get("archive")?;
                    let key = archive.get("sha256")?.as_str()?;
                    xharness_session::ToolArchiveRef::validate_key(key).ok()?;
                    let bytes = archive.get("bytes")?.as_u64()?;
                    if bytes > xharness_session::MAX_TOOL_ARCHIVE_BYTES as u64 { return None; }
                    // Rebuild bounded fields instead of copying arbitrary large JSON.
                    Some(json!({"sha256":key,"bytes":bytes,"read_with":"history","format":"tool_result/v1"}))
                });
            let mut envelope = json!({
                "format": "tool_result_pruned/v1",
                "tool": tool,
                "call_id": call_id,
                "chars_before": pruned.chars_before,
                "chars_removed": pruned.chars_removed,
                "content": pruned.text,
            });
            if let Some(archive) = archive {
                envelope["archive"] = archive;
            }
            message.content = envelope.to_string();
            edits.push(SurfaceEdit::new(
                index,
                index + 1,
                1,
                SurfaceEditKind::ToolResultPruned,
            ));
        }

        Ok(ContextSurface::transformed(
            ContextPolicyId::new("context-history-pruning", 4),
            source_message_count,
            messages,
            edits,
        ))
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn durable_archive_reference_survives_additional_pruning() {
        let archive = json!({"sha256":"a".repeat(64),"bytes":30000,"read_with":"history","format":"tool_result/v1"});
        let original = json!({"content":"x".repeat(20000),"archive":archive}).to_string();
        let policy = ToolResultPruningContextPolicy::default();
        let surface = policy
            .prepare(ContextRequest::new(vec![Message::tool("call", original)]))
            .await
            .unwrap();
        let value: Value = serde_json::from_str(&surface.messages[0].content).unwrap();
        assert_eq!(value["archive"], archive);
    }
    use super::*;
    use serde_json::json;
    use xharness_session::{AttachmentRef, MessageRole, ToolCall};

    fn image(id: char, bytes: u64) -> ContentBlock {
        ContentBlock::Image {
            attachment: AttachmentRef {
                id: id.to_string().repeat(64),
                session_id: "session".into(),
                media_type: "image/png".into(),
                bytes,
                width: 64,
                height: 64,
            },
        }
    }

    #[test]
    fn image_projection_does_not_limit_conversation_to_sixteen_images() {
        let messages = (0..17)
            .map(|_| Message::user("image").with_content_blocks(vec![image('a', 1)]))
            .collect::<Vec<_>>();
        let mut surface = ContextSurface::identity(messages.clone());
        surface.defer_images_over_budget(MAX_REQUEST_IMAGE_BYTES);
        assert_eq!(surface.deferred_images, 0);
        assert_eq!(surface.messages, messages);
    }

    #[test]
    fn image_projection_defers_old_references_without_mutating_history() {
        let messages = vec![
            Message::user("first").with_content_blocks(vec![image('a', 20)]),
            Message::user("second").with_content_blocks(vec![image('b', 20)]),
            Message::user("latest").with_content_blocks(vec![image('c', 20)]),
        ];
        let original = messages.clone();
        let mut surface = ContextSurface::identity(messages);
        surface.defer_images_over_budget(40);
        assert_eq!(surface.deferred_images, 1);
        let ContentBlock::Text { text } = &surface.messages[0].content_blocks[0] else {
            panic!("old image was not deferred");
        };
        assert!(text.contains(&format!("attachment://{}", "a".repeat(64))));
        assert!(matches!(
            surface.messages[1].content_blocks[0],
            ContentBlock::Image { .. }
        ));
        assert!(matches!(
            surface.messages[2].content_blocks[0],
            ContentBlock::Image { .. }
        ));
        assert!(matches!(
            original[0].content_blocks[0],
            ContentBlock::Image { .. }
        ));
        surface.validate().unwrap();
    }

    #[test]
    fn identity_preserves_lossless_messages() {
        let message = Message {
            content_blocks: Vec::new(),
            id: None,
            role: MessageRole::Assistant,
            content: "answer".to_owned(),
            reasoning: "reason".to_owned(),
            tool_calls: vec![ToolCall {
                id: "call-1".to_owned(),
                provider_call_id: None,
                index: 0,
                name: "read".to_owned(),
                arguments_json: r#"{"path":"a"}"#.to_owned(),
            }],
            tool_call_id: None,
            provider_items: vec![json!({"opaque": true})],
            interrupted: false,
        };
        let surface = ContextSurface::identity(vec![message.clone()]);
        surface.validate().unwrap();
        assert_eq!(surface.messages, vec![message]);
        assert_eq!(surface.source_message_count, 1);
        assert!(surface.edits.is_empty());
    }

    #[test]
    fn transformed_surface_rejects_overlapping_edits() {
        let surface = ContextSurface::transformed(
            ContextPolicyId::new("test", 1),
            4,
            vec![Message::user("replacement")],
            vec![
                SurfaceEdit::new(0, 2, 1, SurfaceEditKind::HistoryCompacted),
                SurfaceEdit::new(1, 3, 1, SurfaceEditKind::ToolResultPruned),
            ],
        );
        assert!(surface.validate().is_err());
    }

    #[tokio::test]
    async fn identity_policy_consumes_context_request() {
        let request = ContextRequest::new(vec![Message::user("hello")])
            .with_target("openai", Some("model"))
            .with_step(3)
            .with_tools(vec![json!({"name": "read"})]);
        let surface = IdentityContextPolicy.prepare(request).await.unwrap();
        assert_eq!(surface.messages, vec![Message::user("hello")]);
    }

    #[tokio::test]
    async fn tool_result_policy_prunes_large_observations_without_breaking_call_identity() {
        let marker_chars = xharness_compaction::PRUNE_MARKER.chars().count();
        let policy = ToolResultPruningContextPolicy::new(ToolResultPrunerConfig {
            threshold_chars: marker_chars + 12,
            head_chars: 8,
            tail_chars: 4,
        })
        .unwrap();
        let assistant = Message {
            content_blocks: Vec::new(),
            role: MessageRole::Assistant,
            tool_calls: vec![ToolCall {
                id: "execution-1".to_owned(),
                provider_call_id: Some("provider-1".to_owned()),
                index: 0,
                name: "web_fetch".to_owned(),
                arguments_json: r#"{"url":"https://example.com"}"#.to_owned(),
            }],
            ..Message::default()
        };
        let source = "甲乙丙丁".repeat(marker_chars + 20);
        let tool = Message::tool("provider-1", &source);
        let surface = policy
            .prepare(ContextRequest::new(vec![assistant.clone(), tool.clone()]))
            .await
            .unwrap();
        surface.validate().unwrap();

        assert_eq!(surface.source_message_count, 2);
        assert_eq!(surface.messages[0], assistant);
        assert_eq!(
            surface.messages[1].tool_call_id.as_deref(),
            Some("provider-1")
        );
        assert_ne!(surface.messages[1].content, source);
        let envelope: Value = serde_json::from_str(&surface.messages[1].content).unwrap();
        assert_eq!(envelope["format"], "tool_result_pruned/v1");
        assert_eq!(envelope["tool"], "web_fetch");
        assert_eq!(envelope["call_id"], "provider-1");
        assert!(envelope["content"]
            .as_str()
            .unwrap()
            .contains("middle pruned"));
        assert_eq!(surface.edits.len(), 1);
        assert_eq!(surface.edits[0].source_start, 1);
        assert_eq!(surface.edits[0].kind, SurfaceEditKind::ToolResultPruned);
        assert_eq!(tool.content, source, "source transcript remains untouched");
    }

    #[tokio::test]
    async fn tool_result_policy_keeps_small_results_exactly() {
        let source = vec![Message::tool("provider-1", "small")];
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(source.clone()))
            .await
            .unwrap();
        assert_eq!(surface.messages, source);
        assert!(surface.edits.is_empty());
    }

    #[tokio::test]
    async fn fresh_tool_batch_is_intact_within_execution_limit_then_ages_into_pruning() {
        let content =
            json!({"frame_id":"frame", "ref":"n40", "text":"x".repeat(10_000)}).to_string();
        let source = vec![
            Message::tool("old", &content),
            Message::assistant("inspect again"),
            Message::tool("fresh-a", &content),
            Message::tool("fresh-b", &content),
        ];
        let policy = ToolResultPruningContextPolicy::default();
        let surface = policy
            .prepare(
                ContextRequest::new(source.clone()).with_tool_result_limit_bytes(content.len()),
            )
            .await
            .unwrap();
        surface.validate().unwrap();
        assert_eq!(surface.policy.version, 4);
        assert_ne!(surface.messages[0].content, content);
        assert_eq!(surface.messages[1..], source[1..]);
        assert_eq!(surface.edits.len(), 1);
        assert_eq!(surface.edits[0].source_start, 0);

        let mut consumed = source.clone();
        consumed.push(Message::assistant("done"));
        let aged = policy
            .prepare(ContextRequest::new(consumed).with_tool_result_limit_bytes(content.len()))
            .await
            .unwrap();
        aged.validate().unwrap();
        assert_eq!(aged.edits.len(), 3);
        for index in [0, 2, 3] {
            assert_ne!(aged.messages[index].content, content);
            assert_eq!(
                aged.messages[index].tool_call_id,
                source[index].tool_call_id
            );
            assert_eq!(source[index].content, content, "history remains immutable");
        }
    }

    #[tokio::test]
    async fn fresh_tool_exemption_uses_bytes_and_never_exempts_oversized_results() {
        let content = "é".repeat(5000);
        let limit = content.len() - 1;
        assert!(content.chars().count() < limit);
        let source = vec![Message::tool("oversized", &content)];
        let policy = ToolResultPruningContextPolicy::new(ToolResultPrunerConfig {
            threshold_chars: 512,
            head_chars: 128,
            tail_chars: 64,
        })
        .unwrap();
        let surface = policy
            .prepare(ContextRequest::new(source.clone()).with_tool_result_limit_bytes(limit))
            .await
            .unwrap();
        surface.validate().unwrap();
        assert_eq!(surface.edits.len(), 1);
        assert_eq!(surface.messages[0].tool_call_id, source[0].tool_call_id);
        let envelope: Value = serde_json::from_str(&surface.messages[0].content).unwrap();
        assert_eq!(envelope["format"], "tool_result_pruned/v1");
        assert_ne!(envelope["content"], content);
    }

    fn completed_call(
        name: &str,
        arguments_json: String,
        reasoning: &str,
        result_ok: bool,
    ) -> Vec<Message> {
        let provider_call_id = format!("provider-{name}");
        vec![
            Message {
                content_blocks: Vec::new(),
                role: MessageRole::Assistant,
                reasoning: reasoning.to_owned(),
                tool_calls: vec![ToolCall {
                    id: format!("execution-{name}"),
                    provider_call_id: Some(provider_call_id.clone()),
                    index: 0,
                    name: name.to_owned(),
                    arguments_json: arguments_json.clone(),
                }],
                provider_items: vec![
                    json!({"type":"reasoning","opaque": name}),
                    json!({
                        "type": "function_call",
                        "call_id": provider_call_id,
                        "name": name,
                        "arguments": arguments_json,
                    }),
                ],
                ..Message::default()
            },
            Message::tool(
                format!("provider-{name}"),
                json!({
                    "ok": result_ok,
                    "content": if result_ok { "completed" } else { "" },
                    "error": if result_ok { "" } else { "failed" },
                    "truncated": false,
                })
                .to_string(),
            ),
        ]
    }

    #[tokio::test]
    async fn genuine_user_boundary_ignores_checkpoint_and_history_reference_roles() {
        let mut assistant = Message::assistant("current work");
        assistant.reasoning = "required current tool-chain reasoning".into();
        assistant.provider_items.push(json!({"opaque":"current"}));
        let messages = vec![
            Message::user("actual task"),
            assistant.clone(),
            Message::user("old checkpoint body"),
            Message::user("bounded history reference"),
        ];
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(messages).with_genuine_user_indices(vec![0]))
            .await
            .unwrap();
        assert_eq!(surface.messages[1], assistant);
        assert!(surface.edits.is_empty());
    }

    #[tokio::test]
    async fn working_set_reference_cannot_prune_protected_current_opaque_reasoning() {
        let mut source = vec![Message::user("current scope")];
        source.extend(completed_call(
            "write",
            json!({"path":"demo.txt","content":"small"}).to_string(),
            "required current reasoning",
            true,
        ));
        let mut read = Message::assistant("inspect old data");
        read.tool_calls.push(ToolCall {
            id: "execution-read".into(),
            provider_call_id: Some("wire-read".into()),
            index: 0,
            name: "read".into(),
            arguments_json: json!({"path":"old.log"}).to_string(),
        });
        source.push(read);
        source.push(Message::tool("wire-read", "old evidence".repeat(10000)));
        let kinds = [
            WorkingSetSourceKind::RawUser,
            WorkingSetSourceKind::RawAssistant,
            WorkingSetSourceKind::ToolResult,
            WorkingSetSourceKind::RawAssistant,
            WorkingSetSourceKind::ToolResult,
        ];
        let origins = kinds
            .into_iter()
            .enumerate()
            .map(|(index, kind)| {
                Some(WorkingSetSource {
                    seq: index as u64,
                    kind,
                    outcome_unknown: false,
                })
            })
            .collect::<Vec<_>>();
        let working = project_working_set(
            source.clone(),
            &origins,
            &WorkingSetConfig {
                pressure: true,
                available_input_tokens: 1000,
                recent_tokens: 0,
                hot_input_budget: None,
                retain_checkpoints: 0,
            },
        )
        .unwrap();
        assert_eq!(working.edits.len(), 1);
        assert_eq!(working.edits[0].source_start, 3);
        assert_eq!(working.messages.len(), 4);
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(working.messages).with_genuine_user_indices(vec![0]))
            .await
            .unwrap();
        assert_eq!(surface.messages[1], source[1]);
        assert_eq!(surface.messages[2], source[2]);
    }

    #[tokio::test]
    async fn runtime_continuation_is_not_a_genuine_user_boundary() {
        let mut partial = Message::assistant("");
        partial.reasoning = "partial reasoning still needed for continuation".into();
        let messages = vec![
            Message::user("actual request"),
            partial.clone(),
            Message::user("runtime: continue preserved reasoning"),
        ];
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(messages).with_genuine_user_indices(vec![0]))
            .await
            .unwrap();
        assert_eq!(surface.messages[1], partial);
    }

    #[tokio::test]
    async fn known_no_genuine_user_does_not_prune_reasoning_at_fake_user_nodes() {
        let mut assistant = Message::assistant("historical technical work");
        assistant.reasoning = "opaque replay companion".into();
        let messages = vec![assistant.clone(), Message::user("legacy checkpoint")];
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(messages).with_genuine_user_indices(Vec::new()))
            .await
            .unwrap();
        assert_eq!(surface.messages[0], assistant);
    }

    #[tokio::test]
    async fn later_actual_user_still_prunes_old_reasoning_with_provenance() {
        let mut old = Message::assistant("prior work");
        old.reasoning = "prior completed reasoning".into();
        let mut current = Message::assistant("current work");
        current.reasoning = "current reasoning".into();
        let messages = vec![
            Message::user("prior request"),
            old,
            Message::user("changed real request"),
            current.clone(),
            Message::user("checkpoint, not request"),
        ];
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(messages).with_genuine_user_indices(vec![2, 0]))
            .await
            .unwrap();
        assert!(surface.messages[1].reasoning.is_empty());
        assert_eq!(surface.messages[3], current);
    }

    #[tokio::test]
    async fn invalid_genuine_user_coordinates_are_rejected() {
        let messages = vec![
            Message::system("system"),
            Message::assistant("work"),
            Message::user("request"),
        ];
        for index in [0, 1, 3, usize::MAX] {
            let result = ToolResultPruningContextPolicy::default()
                .prepare(
                    ContextRequest::new(messages.clone()).with_genuine_user_indices(vec![index]),
                )
                .await;
            assert!(result.is_err(), "invalid index {index} must be rejected");
        }
    }

    #[test]
    fn provenance_metadata_preserves_legacy_unknown_vs_explicit_empty_roundtrip() {
        let legacy = ContextRequest::new(vec![Message::user("legacy")]);
        let encoded = serde_json::to_value(&legacy).unwrap();
        assert!(encoded.get("genuine_user_indices").is_none());
        let decoded: ContextRequest = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.genuine_user_indices, None);
        let known_empty = legacy.with_genuine_user_indices(Vec::new());
        let encoded = serde_json::to_value(&known_empty).unwrap();
        assert_eq!(encoded["genuine_user_indices"], json!([]));
        let decoded: ContextRequest = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.genuine_user_indices, Some(Vec::new()));
    }

    #[tokio::test]
    async fn completed_large_write_arguments_and_provider_items_remain_exact() {
        let original_content = "甲乙丙丁".repeat(400);
        let mut source = vec![Message::user("write it")];
        source.extend(completed_call(
            "write",
            json!({"path":"demo.txt","content": original_content}).to_string(),
            "private completed reasoning",
            true,
        ));
        source.push(Message::assistant("done"));
        source.push(Message::user("what next?"));

        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(source.clone()))
            .await
            .unwrap();
        surface.validate().unwrap();

        let assistant = &surface.messages[1];
        assert!(assistant.reasoning.is_empty());
        assert_eq!(assistant.provider_items[0], source[1].provider_items[0]);
        assert_eq!(assistant.tool_calls[0].provider_id(), "provider-write");
        assert_eq!(assistant.tool_calls, source[1].tool_calls);
        assert_eq!(assistant.provider_items, source[1].provider_items);
        assert_eq!(surface.messages[2], source[2]);
        assert_eq!(source[1].reasoning, "private completed reasoning");
        assert!(source[1].tool_calls[0]
            .arguments_json
            .contains(&original_content));

        assert_eq!(surface.edits.len(), 1);
        assert!(matches!(
            surface.edits[0].kind,
            SurfaceEditKind::AssistantHistoryPruned {
                reasoning_chars_removed: 27,
                tool_argument_chars_removed: 0
            }
        ));
    }

    #[tokio::test]
    async fn failed_or_unresolved_mutations_keep_exact_arguments() {
        let content = "x".repeat(2_048);
        let failed = completed_call(
            "write",
            json!({"path":"failed.txt","content":content}).to_string(),
            "old reasoning",
            false,
        );
        let unresolved = Message {
            content_blocks: Vec::new(),
            role: MessageRole::Assistant,
            tool_calls: vec![ToolCall {
                id: "execution-unresolved".to_owned(),
                provider_call_id: Some("provider-unresolved".to_owned()),
                index: 0,
                name: "write".to_owned(),
                arguments_json: json!({"path":"pending.txt","content":content}).to_string(),
            }],
            ..Message::default()
        };
        let invalid = Message {
            content_blocks: Vec::new(),
            role: MessageRole::Assistant,
            tool_calls: vec![ToolCall {
                id: "execution-invalid".to_owned(),
                provider_call_id: Some("provider-invalid".to_owned()),
                index: 0,
                name: "write".to_owned(),
                arguments_json: "{not-json".to_owned(),
            }],
            ..Message::default()
        };
        let source = vec![
            Message::user("first"),
            failed[0].clone(),
            failed[1].clone(),
            invalid,
            Message::tool(
                "provider-invalid",
                json!({"ok":true,"content":"completed"}).to_string(),
            ),
            Message::user("current"),
            unresolved,
        ];
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(source.clone()))
            .await
            .unwrap();

        assert_eq!(
            surface.messages[1].tool_calls[0].arguments_json,
            source[1].tool_calls[0].arguments_json
        );
        assert_eq!(
            surface.messages[3].tool_calls[0].arguments_json,
            source[3].tool_calls[0].arguments_json
        );
        assert_eq!(
            surface.messages[3].tool_calls[0].arguments_json,
            "{not-json"
        );
        assert_eq!(
            surface.messages[6].tool_calls[0].arguments_json,
            source[6].tool_calls[0].arguments_json
        );
        assert!(surface.messages[1].reasoning.is_empty());
    }

    #[tokio::test]
    async fn current_turn_large_mutations_and_opaque_replay_stay_byte_for_byte_intact() {
        for (name, arguments) in [
            (
                "write",
                format!(
                    "{{ \"path\": \"demo.txt\", \"content\": \"{}\" }}",
                    "x".repeat(8192)
                ),
            ),
            (
                "edit",
                json!({"path":"demo.txt","old":"before".repeat(1000),"new":"after".repeat(1000)})
                    .to_string(),
            ),
        ] {
            let mut source = vec![Message::user("current turn")];
            source.extend(completed_call(name, arguments, "current reasoning", true));
            let surface = ToolResultPruningContextPolicy::default()
                .prepare(ContextRequest::new(source.clone()))
                .await
                .unwrap();
            assert_eq!(surface.policy.version, 4);
            assert_eq!(surface.messages, source);
            assert!(surface.edits.is_empty());
        }
    }

    #[tokio::test]
    async fn current_turn_reasoning_and_small_mutations_remain_exact() {
        let mut source = vec![Message::user("current")];
        source.extend(completed_call(
            "edit",
            json!({"path":"demo.txt","old":"small","new":"tiny"}).to_string(),
            "reason through the current tool chain",
            true,
        ));
        let surface = ToolResultPruningContextPolicy::default()
            .prepare(ContextRequest::new(source.clone()))
            .await
            .unwrap();
        assert_eq!(surface.messages, source);
        assert!(surface.edits.is_empty());
    }

    #[tokio::test]
    async fn completed_large_edit_keeps_old_and_new_exactly_and_deterministically() {
        let old = "old".repeat(600);
        let new = "new".repeat(700);
        let mut source = vec![Message::user("edit")];
        source.extend(completed_call(
            "edit",
            json!({"path":"demo.txt","old":old,"new":new}).to_string(),
            "reason",
            true,
        ));
        source.push(Message::assistant("done"));
        source.push(Message::user("continue"));
        let policy = ToolResultPruningContextPolicy::default();
        let first = policy
            .prepare(ContextRequest::new(source.clone()))
            .await
            .unwrap();
        let second = policy
            .prepare(ContextRequest::new(source.clone()))
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.messages[1].tool_calls, source[1].tool_calls);
        assert_eq!(first.messages[1].provider_items, source[1].provider_items);
    }
    #[tokio::test]
    async fn context_projection_preserves_image_blocks() {
        let message =
            Message::user("").with_content_blocks(vec![xharness_session::ContentBlock::Image {
                attachment: xharness_session::AttachmentRef {
                    id: "sha256-ref".into(),
                    session_id: "image-session".into(),
                    media_type: "image/png".into(),
                    bytes: 128,
                    width: 64,
                    height: 32,
                },
            }]);
        let source = vec![
            message,
            Message::assistant("red and blue"),
            Message::user("look again"),
        ];
        assert_eq!(
            IdentityContextPolicy
                .prepare(ContextRequest::new(source.clone()))
                .await
                .unwrap()
                .messages,
            source
        );
        assert_eq!(
            ToolResultPruningContextPolicy::default()
                .prepare(ContextRequest::new(source.clone()))
                .await
                .unwrap()
                .messages,
            source
        );
    }
}
