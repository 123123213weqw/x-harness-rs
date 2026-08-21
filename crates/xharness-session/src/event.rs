use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Message, ToolCall};

/// Monotonic position in a session log.
pub type Sequence = u64;

/// One of the two ordered durable input lists owned by a long-lived agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InboxTarget {
    /// An ordinary prompt waiting to open its own turn.
    NextTurn,
    /// Context or steering waiting for the nearest later model step.
    NextStep,
}

/// Identified user input retained in the durable inbox until a step claims it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InboxMessage {
    /// Stable identity used by queue editing, deduplication and UI projection.
    pub id: String,
    /// Provider-neutral model-facing content. Its role must be `user`.
    pub message: Message,
    /// Transport- or product-specific provenance retained for audit/UI replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

impl InboxMessage {
    pub fn user(id: impl Into<String>, content: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            message: Message::user(content).with_id(id.clone()),
            id,
            source: None,
        }
    }
}

/// Why an inbox splice deliberately discarded pending input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxSpliceOutcome {
    Cancelled,
}

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

/// Closed, fail-safe outcome of one human approval request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    AllowedOnce,
    Rejected,
    Cancelled,
    Unavailable,
}

/// Session-level answerer policy. Only `AllowedOnce` can grant a particular
/// call; this value controls whether interactive asks are attempted at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    Ask,
    Never,
}

/// Session-level sandbox policy vocabulary shared by every enforcing tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionSandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// Marks a policy value copied into a child activation rather than selected
/// directly by the current session's user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicySource {
    Delegation,
}

/// Human-facing origin of one slash-command invocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CommandSource {
    User,
}

/// Closed command result vocabulary projected directly by Web clients.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandResultKind {
    Success,
    Error,
}

/// Exact auxiliary route retained when an automatic title came from a model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTitleModelProvenance {
    pub provider: String,
    pub model: String,
}

/// Durable owner of one accepted session title.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionTitleSource {
    Fallback,
    Provider {
        provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<SessionTitleModelProvenance>,
    },
    User,
}

/// Provider-neutral failure retained by a durable model-retry audit record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmFailure {
    pub message: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_retry_after_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl LlmFailure {
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "TRANSPORT".to_owned(),
            status: None,
            provider_retry_after_ms: None,
            request_id: None,
        }
    }
}

/// Retry policy mode recorded at the durable scheduling boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmRetryMode {
    Normal,
    Always,
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
    /// Named Agent preset selected for subsequent turns in this session.
    #[serde(rename = "agent-preset/selected")]
    AgentPresetSelected {
        #[serde(rename = "agentPreset")]
        agent_preset: String,
    },
    /// A normalized splice over one durable pending-input list. Replaying all
    /// such events after the seed reconstructs the exact live inbox.
    #[serde(rename = "agent/inbox/spliced")]
    AgentInboxSpliced {
        target: InboxTarget,
        start: usize,
        #[serde(default, skip_serializing_if = "is_zero")]
        removed_count: usize,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        inserted: Vec<InboxMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outcome: Option<InboxSpliceOutcome>,
    },
    #[serde(rename = "request/header")]
    RequestHeader { header: RequestHeader },
    /// Log-only audit fact written before an approval answerer is consulted.
    #[serde(rename = "approval/asked")]
    ApprovalAsked {
        id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "callId", default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Log-only decision paired one-to-one with an `approval/asked` event.
    #[serde(rename = "approval/decided")]
    ApprovalDecided {
        id: String,
        outcome: ApprovalOutcome,
    },
    /// Named product preset whose fold controls sandbox and approval policy.
    #[serde(rename = "permission/preset")]
    PermissionPreset { preset: String },
    /// Durable session sandbox-policy override; log-only, never model-facing.
    #[serde(rename = "sandbox/mode")]
    SandboxMode {
        mode: SessionSandboxMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<PolicySource>,
    },
    /// Durable session approval-policy override; log-only, never model-facing.
    #[serde(rename = "approval/policy")]
    ApprovalPolicy {
        policy: ApprovalPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<PolicySource>,
    },
    /// A resolved slash command entered its handler.
    #[serde(rename = "command/run")]
    CommandRun {
        #[serde(rename = "commandId")]
        command_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<String>,
        source: CommandSource,
    },
    /// Settlement paired one-to-one with a prior `command/run`.
    #[serde(rename = "command/done")]
    CommandDone {
        #[serde(rename = "commandId")]
        command_id: String,
        kind: CommandResultKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(
            rename = "sourceEventSeq",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_event_seq: Option<Sequence>,
    },
    /// Latest-wins log-only title snapshot. It never enters model history.
    #[serde(rename = "session/title")]
    SessionTitle {
        title: String,
        #[serde(rename = "messageSeqs")]
        message_seqs: Vec<Sequence>,
        source: SessionTitleSource,
    },
    /// One durable provider retry scheduled after a failed request attempt.
    #[serde(rename = "llm/retry")]
    LlmRetry {
        #[serde(rename = "retryId")]
        retry_id: String,
        turn: u32,
        step: u32,
        provider: String,
        mode: LlmRetryMode,
        #[serde(rename = "policyKey")]
        policy_key: String,
        retry: u32,
        #[serde(
            rename = "maxRetries",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        max_retries: Option<u32>,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        failure: LlmFailure,
    },
    /// Durable transition immediately before the scheduled retry begins.
    #[serde(rename = "llm/retry-started")]
    LlmRetryStarted {
        #[serde(rename = "retryId")]
        retry_id: String,
        turn: u32,
        step: u32,
        retry: u32,
    },
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

const fn is_zero(value: &usize) -> bool {
    *value == 0
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
