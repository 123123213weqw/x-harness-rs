use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Message, ToolCall};

/// Monotonic position in a session log.
pub type Sequence = u64;

/// Single-writer generation used by compare-and-swap appends.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revision(pub u64);

impl Revision {
    pub const ZERO: Self = Self(0);

    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Request envelope that must be recoverable independently of derived chat
/// messages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequestHeader {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    /// Exact provider-neutral input after context policy preparation. Keeping
    /// it here makes every model-visible request independently auditable even
    /// while compaction policies are still evolving.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input: Vec<Message>,
    /// Provider- or harness-specific call controls not yet promoted to stable
    /// fields. A sorted map keeps serialized snapshots deterministic.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, Value>,
}

impl RequestHeader {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            reasoning_effort: None,
            system: None,
            tools: Vec::new(),
            input: Vec::new(),
            options: BTreeMap::new(),
        }
    }
}

/// Provider-neutral raw streaming chunk retained for replay fidelity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum AssistantChunk {
    TextDelta(String),
    ReasoningDelta(String),
    ToolCallDelta {
        index: usize,
        id: String,
        name: String,
        arguments_delta: String,
    },
    Usage(Value),
    Finish {
        reason: String,
    },
    /// Lossless escape hatch for a provider lifecycle item that does not yet
    /// have a portable harness representation.
    Provider(Value),
}

/// Why a durable turn closed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    LimitReached,
    Failed {
        error: String,
    },
    /// Used by recovery when a stored lifecycle ended without a closer.
    Interrupted,
}

/// Classification carried beside one model-facing tool result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    Success,
    Error,
    /// The call was durably recorded but no authoritative outcome survived.
    OutcomeUnknown,
}

/// One durable tool outcome. The model-facing message is derived from these
/// fields instead of being stored as a second copy.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResultData {
    pub call_id: String,
    pub outcome: ToolOutcome,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl ToolResultData {
    pub fn success(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            outcome: ToolOutcome::Success,
            content: content.into(),
            metadata: None,
        }
    }

    pub fn error(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            outcome: ToolOutcome::Error,
            content: content.into(),
            metadata: None,
        }
    }
}

/// Complete vocabulary accepted by the first session-log version.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum EventData {
    #[serde(rename = "request/header")]
    RequestHeader { header: RequestHeader },
    #[serde(rename = "turn/start")]
    TurnStart { turn: u32 },
    #[serde(rename = "turn/end")]
    TurnEnd { turn: u32, reason: TurnEndReason },
    #[serde(rename = "step/start")]
    StepStart { turn: u32, step: u32 },
    #[serde(rename = "step/end")]
    StepEnd { turn: u32, step: u32 },
    #[serde(rename = "user/message")]
    UserMessage { message: Message },
    #[serde(rename = "assistant/chunk")]
    AssistantChunk {
        turn: u32,
        step: u32,
        chunk: AssistantChunk,
    },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        turn: u32,
        step: u32,
        message: Message,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Value>,
    },
    #[serde(rename = "tool/call")]
    ToolCall {
        turn: u32,
        step: u32,
        call: ToolCall,
    },
    #[serde(rename = "tool/result")]
    ToolResult {
        turn: u32,
        step: u32,
        result: ToolResultData,
    },
    #[serde(rename = "session/end-seed")]
    SessionEndSeed,
}

/// An event waiting to receive its durable log coordinates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionEvent(pub EventData);

impl SessionEvent {
    pub const fn new(data: EventData) -> Self {
        Self(data)
    }

    pub const fn data(&self) -> &EventData {
        &self.0
    }

    pub fn into_data(self) -> EventData {
        self.0
    }
}

impl From<EventData> for SessionEvent {
    fn from(value: EventData) -> Self {
        Self(value)
    }
}

/// One accepted event with immutable append coordinates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoggedEvent {
    pub seq: Sequence,
    /// All events accepted by one atomic append share this revision.
    pub revision: Revision,
    pub timestamp_ms: u64,
    pub event: SessionEvent,
}

impl LoggedEvent {
    pub const fn data(&self) -> &EventData {
        self.event.data()
    }
}
