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
    /// Ordered durable content. Empty means the legacy `content` text is authoritative.
    /// Only immutable references belong here, never base64 or host paths.
    #[serde(
        default,
        rename = "contentBlocks",
        skip_serializing_if = "Vec::is_empty"
    )]
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
    pub fn with_content_blocks(mut self, blocks: Vec<ContentBlock>) -> Self {
        self.content_blocks = blocks;
        self
    }
    pub fn new(role: MessageRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            ..Self::default()
        }
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

/// Provider-neutral reference to a validated, immutable attachment object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRef {
    pub attachment_id: String,
    pub media_type: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        attachment: AttachmentRef,
        /// Request-local only: never read from or written to session JSON.
        #[serde(skip)]
        data_url: Option<String>,
    },
    File {
        attachment: AttachmentRef,
    },
}

impl ContentBlock {
    /// Typed image-tool payload retained in the existing durable result metadata.
    pub fn from_tool_metadata(metadata: Option<&Value>) -> Vec<Self> {
        metadata
            .and_then(|v| v.get("xharnessContentBlocks"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }

    pub fn attachment(&self) -> Option<&AttachmentRef> {
        match self {
            Self::Image { attachment, .. } | Self::File { attachment } => Some(attachment),
            Self::Text { .. } => None,
        }
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::*;

    #[test]
    fn legacy_messages_and_request_only_image_bytes() {
        let old: Message = serde_json::from_str(r#"{"role":"user","content":"hello"}"#).unwrap();
        assert!(old.content_blocks.is_empty());
        assert!(serde_json::to_value(old)
            .unwrap()
            .get("contentBlocks")
            .is_none());
        let block = ContentBlock::Image {
            attachment: AttachmentRef {
                attachment_id: format!("sha256:{}", "a".repeat(64)),
                media_type: "image/png".into(),
                bytes: 10,
                name: None,
                width: Some(1),
                height: Some(1),
            },
            data_url: Some("data:image/png;base64,PRIVATE_BYTES".into()),
        };
        let encoded = serde_json::to_string(&block).unwrap();
        assert!(!encoded.contains("PRIVATE_BYTES"));
        assert!(matches!(
            serde_json::from_str::<ContentBlock>(&encoded).unwrap(),
            ContentBlock::Image { data_url: None, .. }
        ));
    }
}
