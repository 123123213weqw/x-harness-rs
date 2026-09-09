use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Role used by the provider-neutral transcript projection.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

impl MessageRole {
    /// Stable provider-neutral spelling used by protocol adapters.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// One provider-neutral tool invocation assembled from model deltas.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Harness execution identity. It must be non-empty and globally unique
    /// in one session log; approvals, audit events and results use this ID.
    pub id: String,
    /// Provider-native call identity used only when replaying the model wire
    /// protocol. Older logs omit it and fall back to `id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_call_id: Option<String>,
    /// Position in the assistant message's tool-call list.
    pub index: usize,
    /// Registered tool name.
    pub name: String,
    /// Arguments exactly as emitted by the model. Invalid JSON remains an
    /// auditable model fact and is handled by the tool runtime later.
    pub arguments_json: String,
}

impl ToolCall {
    /// Identity that protocol adapters must use for assistant tool calls and
    /// their corresponding tool output.
    pub fn provider_id(&self) -> &str {
        self.provider_call_id.as_deref().unwrap_or(&self.id)
    }
}

/// Durable identity and verified metadata. No local path, base64 or provider fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentRef {
    pub id: String,
    pub session_id: String,
    pub media_type: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Image { attachment: AttachmentRef },
}

/// Provider-neutral message used by [`crate::derive_messages`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Message {
    /// Stable harness identity for durable user/assistant inputs. Providers do
    /// not receive this field unless an adapter explicitly maps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub role: MessageRole,
    #[serde(default)]
    pub content: String,
    /// Ordered multimodal content, authoritative when present. `content` remains
    /// a text projection for legacy stores, UI and text-only policies.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_blocks: Vec<ContentBlock>,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Provider-native call identity associated with a tool result message.
    /// Durable execution identity remains in `tool/call` and `tool/result`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Opaque provider-owned state needed for a lossless stateless replay.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_items: Vec<Value>,
    /// The assistant stream was deliberately interrupted by runtime steering.
    #[serde(default, skip_serializing_if = "is_false")]
    pub interrupted: bool,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

impl Message {
    pub fn new(role: MessageRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            ..Self::default()
        }
    }

    pub fn with_content_blocks(mut self, blocks: Vec<ContentBlock>) -> Self {
        self.content = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("");
        self.content_blocks = blocks;
        self
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::new(MessageRole::System, content)
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::new(MessageRole::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::new(MessageRole::Assistant, content)
    }

    pub fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Tool,
            content: content.into(),
            tool_call_id: Some(call_id.into()),
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod multimodal_tests {
    use super::*;
    #[test]
    fn legacy_string_and_new_reference_roundtrip_without_base64() {
        let old: Message = serde_json::from_str(r#"{"role":"user","content":"hello"}"#).unwrap();
        assert!(old.content_blocks.is_empty());
        assert_eq!(old.content, "hello");
        let r = AttachmentRef {
            id: "a".repeat(64),
            session_id: "s".into(),
            media_type: "image/png".into(),
            width: 64,
            height: 32,
            bytes: 123,
        };
        let image =
            Message::user("").with_content_blocks(vec![ContentBlock::Image { attachment: r }]);
        let json = serde_json::to_string(&image).unwrap();
        assert_eq!(serde_json::from_str::<Message>(&json).unwrap(), image);
        assert!(!json.contains("base64"));
        assert!(image.content.is_empty());
    }
}
