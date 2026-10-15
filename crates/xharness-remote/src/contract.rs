//! Version-one typed ingress: no arbitrary RPC, local path, or controller-supplied identity.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_INBOUND_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PENDING: usize = 1024;
pub const MAX_RECORDS: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    MobileWeb,
    Telegram,
    Feishu,
    Lark,
    Weixin,
}

/// Constructed by an authenticated transport, never read from a message body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sender {
    pub channel: Channel,
    pub account: String,
    pub user: String,
}

/// Trusted desktop administrative state. Scope requires BOTH workspace and session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Principal {
    pub id: String,
    pub host: String,
    pub sender: Sender,
    pub workspaces: BTreeSet<String>,
    pub sessions: BTreeSet<String>,
    pub revision: u64,
    pub revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub principal: String,
    pub conversation: String,
    pub workspace: String,
    pub session: String,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptMode {
    Queue,
    Steer,
}
impl PromptMode {
    pub(crate) fn wire(&self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Steer => "steer",
        }
    }
}

/// Inline uploads go through Host's existing validated attachment ingestion.
/// References, URLs, filesystem paths and arbitrary content blocks are not ingress types.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Content {
    Text {
        text: String,
    },
    Image {
        media_type: String,
        data: String,
        name: Option<String>,
    },
    File {
        media_type: String,
        data: String,
        name: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Prompt {
        mode: PromptMode,
        content: Vec<Content>,
        client_time_zone: Option<String>,
    },
    Cancel,
    AutomationRead {
        read: xharness_api::AutomationRead,
    },
    AutomationControl {
        control: xharness_api::AutomationControl,
    },
    CreateSession {
        workspace: String,
    },
    Select {
        target: crate::SessionSelection,
    },
    Catalogue {
        after: Option<xharness_api::CatalogueCursor>,
    },
    AnswerInteraction {
        ticket: crate::TicketToken,
        answer: xharness_api::ScopedInteractionAnswer,
    },
    History {
        before_seq: Option<u64>,
        max_messages: u16,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inbound {
    pub request_id: String,
    pub binding: String,
    pub generation: u64,
    pub command: Command,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Queued,
    Dispatching,
    Completed,
    Rejected,
    Uncertain,
    Abandoned,
}
impl DeliveryState {
    pub(crate) fn wire(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Dispatching => "dispatching",
            Self::Completed => "completed",
            Self::Rejected => "rejected",
            Self::Uncertain => "uncertain",
            Self::Abandoned => "abandoned",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Delivery {
    pub sequence: i64,
    pub key: String,
    pub principal: String,
    pub principal_revision: u64,
    pub binding: Binding,
    pub inbound: Inbound,
    pub state: DeliveryState,
    /// Admission/operation result, not Agent completion or external reply delivery.
    pub result: Option<xharness_api::RpcResult>,
    pub reason: Option<String>,
}

/// Account identity and fencing belong to the trusted adapter, not message text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account {
    pub channel: Channel,
    pub id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountLease {
    pub account: Account,
    pub generation: u64,
    pub cursor: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionCode {
    Malformed,
    Unsupported,
    UnboundSender,
    Forbidden,
    InvalidCommand,
}

/// Trusted normalization result. Payload bodies are not retained for rejection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiveInput {
    Command {
        principal: String,
        sender: Sender,
        conversation: String,
        inbound: Box<Inbound>,
    },
    Reject {
        code: RejectionCode,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReceiveOutcome {
    Accepted { delivery_key: String },
    Rejected { code: RejectionCode },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiveReceipt {
    pub account: Account,
    pub event_id: String,
    pub payload_sha256: String,
    pub generation: u64,
    pub outcome: ReceiveOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryReview {
    pub delivery_key: String,
    pub actor: String,
    pub evidence_sha256: String,
    pub resolution: RecoveryResolution,
}
/// Terminal, trusted observation. No retry/replay resolution exists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryResolution {
    ObservedAccepted,
    VerifiedNotApplied,
    AbandonWithoutReplay,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecoveryAudit {
    pub sequence: i64,
    pub review: RecoveryReview,
    pub previous: DeliveryState,
    pub current: DeliveryState,
}
