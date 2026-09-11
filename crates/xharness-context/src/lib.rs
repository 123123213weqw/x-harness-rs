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
use xharness_session::{Message, MessageRole};

/// Legacy threshold retained for source compatibility. Tool arguments are no
/// longer pruned: historical calls must not teach executable placeholder text.
#[deprecated(note = "tool arguments are preserved exactly; use whole-history compaction")]
pub const DEFAULT_TOOL_ARGUMENT_PRUNE_THRESHOLD_CHARS: usize = 1_024;

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
}

impl ContextRequest {
    pub fn new(messages: Vec<Message>) -> Self {
        Self {
            messages,
            provider: "unknown".to_owned(),
            model: None,
            step: 0,
            tools: Vec::new(),
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

        let latest_user_index = request
            .messages
            .iter()
            .rposition(|message| message.role == MessageRole::User);

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
            let Some(pruned) = self.pruner.prune(&message.content) else {
                continue;
            };
            let call_id = message.tool_call_id.as_deref().unwrap_or("unknown");
            let tool = call_names
                .get(call_id)
                .map(String::as_str)
                .unwrap_or("unknown");
            message.content = json!({
                "format": "tool_result_pruned/v1",
                "tool": tool,
                "call_id": call_id,
                "chars_before": pruned.chars_before,
                "chars_removed": pruned.chars_removed,
                "content": pruned.text,
            })
            .to_string();
            edits.push(SurfaceEdit::new(
                index,
                index + 1,
                1,
                SurfaceEditKind::ToolResultPruned,
            ));
        }

        Ok(ContextSurface::transformed(
            ContextPolicyId::new("context-history-pruning", 3),
            source_message_count,
            messages,
            edits,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use xharness_session::{MessageRole, ToolCall};

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
            assert_eq!(surface.policy.version, 3);
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
