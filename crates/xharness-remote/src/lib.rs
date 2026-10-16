//! Transport-neutral scoped admission. Not a second Agent or RPC server.
//! Administrative methods are trusted composition APIs, never channel commands.
mod accounts;
mod administration;
mod automation_commands;
pub use automation_commands::{ControllerAutomationControl, ControllerAutomationRead};
pub use xharness_api::{
    AutomationControl, AutomationControlState, AutomationDetail, AutomationEntry, AutomationKind,
    AutomationMode, AutomationRead, AutomationRunState, AutomationRunView, AutomationState,
    AutomationTarget, ScopedAutomationApplied, ScopedAutomationPage,
};
mod catalogue;
mod selection;
pub use selection::ControllerSelection;
mod creation;
mod creation_commands;
pub use creation::{CreationPolicy, SessionCreation, SessionCreationRequest, SessionCreationState};
pub use creation_commands::ControllerCreated;
mod command_replies;
mod contract;
pub use xharness_api::RpcResult as NativeCommandResult;
mod gateway;
mod media;
mod outbox;
pub use media::{
    valid_media_type, ReplyAttachment, ScopedAttachment, ScopedAttachmentKind,
    MAX_SCOPED_ATTACHMENT_BYTES,
};
mod projection;
mod receive;
pub use projection::{ProjectedReply, ProjectionCheckpoint, ProjectionUpdate};
pub use xharness_api::ScopedEventPage;
mod inbox_recovery;
mod recovery;
pub use inbox_recovery::{
    InboxCommand, InboxInteractionKind, InboxRecoveryEntry, InboxRecoveryIdentity,
    InboxRecoveryPage, InboxRecoveryReceipt,
};
mod routing;
mod store;
mod subscription;
mod tickets;
// Explicit exports keep private additions from silently widening the adapter API.
pub use accounts::{AccountSettings, MAX_ACCOUNTS};
pub use administration::{GrantEntry, GrantPage};
pub use catalogue::{ControllerCatalogue, SessionSelection};
pub use contract::{
    Account, AccountLease, Binding, Channel, Command, Content, Delivery, DeliveryState, Inbound,
    Principal, PromptMode, ReceiveInput, ReceiveOutcome, ReceiveReceipt, RecoveryAudit,
    RecoveryResolution, RecoveryReview, RejectionCode, Sender, MAX_INBOUND_BYTES, MAX_PENDING,
    MAX_RECORDS, MAX_RESULT_BYTES,
};
pub use gateway::Gateway;
pub use outbox::{
    Outgoing, ProviderReceipt, ReplyAudit, ReplyBody, ReplyButton, ReplyFailure, ReplyPlan,
    ReplyResolution, ReplyReview, ReplyState, ReplyTransport, SendOutcome, SendRequest,
    MAX_REPLY_BATCH,
};
pub use routing::ResolvedRoute;
pub use subscription::{RemoteEventStream, Subscription};
pub use tickets::{InteractionTicket, TicketToken};
pub use xharness_api::RpcId as NativeInteractionId;
pub use xharness_api::{
    CatalogueCursor, CatalogueSession, CatalogueWorkspace, ScopedCataloguePage,
};
pub use xharness_api::{ScopedInteractionAnswer, ScopedQuestionAnswer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("remote storage I/O error")]
    Io(#[from] std::io::Error),
    #[error("remote journal error")]
    Sql(#[from] rusqlite::Error),
    #[error("invalid remote data")]
    Json(#[from] serde_json::Error),
    #[error("remote account consumer already owned")]
    ConsumerBusy,
    #[error("invalid remote request: {0}")]
    Invalid(&'static str),
    #[error("remote request unauthorized")]
    Unauthorized,
    #[error("remote request identity conflict")]
    IdentityConflict,
    #[error("remote ingress capacity reached; do not advance receive cursor")]
    Capacity,
    #[error("journal mutex poisoned")]
    Poisoned,
    #[error("journal worker failed")]
    WorkerFailed,
    #[error("Host capability unavailable")]
    HostUnavailable,
    #[error("earlier operation in this session must be reconciled first")]
    SessionBlocked,
    #[error("remote account connection generation is stale")]
    StaleLease,
    #[error("remote receive cursor changed; reload before continuing")]
    CursorConflict,
    #[error(
        "remote session stream has a gap; restore authoritative history before subscribing again"
    )]
    StreamGap,
    #[error("remote journal is closed")]
    Closed,
    #[error("earlier reply in this conversation must be delivered or reconciled first")]
    ReplyBlocked,
    #[error("reply is already sending in this account generation")]
    ReplyBusy,
    #[error("reply rate-limit backoff has not elapsed")]
    ReplyDeferred,
}
