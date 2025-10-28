//! Browser-safe wire contract shared by the Rust host and Web clients.
//!
//! This crate intentionally models the transport envelope and complete method
//! directory before business implementations. Internal Agent/Session structs
//! must be projected into these DTOs rather than serialized directly.

use std::{fmt, pin::Pin, str::FromStr};

use async_trait::async_trait;
use futures::{stream, Stream};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

pub const API_PREFIX: &str = "/api";
/// Upstream Web contract snapshot used to build the method and frame catalog.
pub const UPSTREAM_CONTRACT_REVISION: &str = "deepseek-harness@141eb6fef8";
pub const RESPOND_PATH: &str = "/api/respond";
pub const MUX_EVENTS_PATH: &str = "/api/events.mux";
pub const HOST_EVENTS_PATH: &str = "/api/events.host";
pub const SESSION_EXPORT_PATH: &str = "/api/session.export";
pub const INVALID_REQUEST_RPC_ID: &str = "invalid-request";

macro_rules! rpc_methods {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum RpcMethod { $($variant),+ }

        impl RpcMethod {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire),+ }
            }
        }

        impl fmt::Display for RpcMethod {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for RpcMethod {
            type Err = UnknownRpcMethod;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(UnknownRpcMethod(value.to_owned())),
                }
            }
        }

        impl Serialize for RpcMethod {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where S: Serializer {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for RpcMethod {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where D: Deserializer<'de> {
                String::deserialize(deserializer)?
                    .parse()
                    .map_err(D::Error::custom)
            }
        }
    };
}

rpc_methods! {
    SessionList => "session.list",
    SessionSearch => "session.search",
    SessionCreate => "session.create",
    SessionHistory => "session.history",
    SessionModels => "session.models",
    SessionSelectModel => "session.selectModel",
    SessionRename => "session.rename",
    SessionFork => "session.fork",
    SessionPrompt => "session.prompt",
    SessionAttachment => "session.attachment",
    SessionUpdateQueue => "session.updateQueue",
    SessionCancel => "session.cancel",
    SubagentList => "subagent.list",
    SubagentHistory => "subagent.history",
    SubagentPrompt => "subagent.prompt",
    SubagentInterrupt => "subagent.interrupt",
    HostDescribe => "host.describe",
    HostPickDirectory => "host.pickDirectory",
    HostListDirectory => "host.listDirectory",
    HostCreateDirectory => "host.createDirectory",
    HostOpenPath => "host.openPath",
    WorkspaceList => "workspace.list",
    WorkspaceCreate => "workspace.create",
    WorkspaceRename => "workspace.rename",
    WorkspaceDelete => "workspace.delete",
    WorkspaceInsertBefore => "workspace.insertBefore",
    WorkspaceInsertSessionBefore => "workspace.insertSessionBefore",
    WorkspaceArchiveSession => "workspace.archiveSession",
    SkillList => "skill.list",
    AgentPresetList => "agentPreset.list",
    AgentPresetSelect => "agentPreset.select",
    AgentPresetRead => "agentPreset.read",
    AgentPresetCopy => "agentPreset.copy",
    AgentPresetOpenDocument => "agentPreset.openDocument",
    AgentPresetRemove => "agentPreset.remove",
    GoalCreate => "goal.create",
    GoalEdit => "goal.edit",
    GoalPause => "goal.pause",
    GoalResume => "goal.resume",
    GoalComplete => "goal.complete",
    GoalClear => "goal.clear",
    SettingsDescribe => "settings.describe",
    SettingsOpenDocument => "settings.openDocument",
    SettingsUpdate => "settings.update",
    SettingsReplace => "settings.replace",
    SettingsMutate => "settings.mutate",
    CredentialsDescribe => "credentials.describe",
    CredentialsSet => "credentials.set",
    CredentialsUnset => "credentials.unset",
    LlmProviders => "llm.providers",
    LlmModels => "llm.models",
    LlmDiscoverModels => "llm.discoverModels",
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("unknown RPC method {0:?}")]
pub struct UnknownRpcMethod(pub String);

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RpcId(pub String);

impl RpcId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn invalid_request() -> Self {
        Self(INVALID_REQUEST_RPC_ID.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: RpcErrorCode,
    pub message: String,
    pub details: Value,
}

impl RpcError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: RpcErrorCode::Internal,
            message: message.into(),
            details: json!({}),
        }
    }

    pub fn bad_request(message: impl Into<String>, issues: Value) -> Self {
        Self {
            code: RpcErrorCode::BadRequest,
            message: message.into(),
            details: json!({ "issues": issues }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcErrorCode {
    BadRequest,
    Cancelled,
    SessionNotFound,
    ModelUnavailable,
    SessionConflict,
    InvalidTimeZone,
    WorkspaceAttachFailed,
    WorkspaceNotFound,
    WorkspaceInvalidPath,
    WorkspaceNameConflict,
    WorkspaceMoveInvalid,
    DirectoryUnreadable,
    DirectoryExists,
    DirectoryCreateFailed,
    DirectoryPickerUnavailable,
    AgentPresetReadOnly,
    AgentPresetLocked,
    AgentPresetConflict,
    AgentPresetNotFound,
    AgentPresetInvalid,
    AgentBusy,
    AttachmentError,
    QueueItemNotFound,
    SteerUnavailable,
    CommandError,
    UnknownCommand,
    SettingsRejected,
    SettingsConflict,
    CredentialRejected,
    ModelDiscoveryFailed,
    TitleInvalid,
    ForkUnavailable,
    SubagentParentUnavailable,
    SubagentNotFound,
    SubagentCatalogDiagnostic,
    SubagentNotResumable,
    SubagentUnauthorized,
    SubagentDeliveryUnavailable,
    Internal,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RpcResult {
    Success { value: Option<Value> },
    Failure { error: RpcError },
}

impl RpcResult {
    pub fn success(value: impl Into<Value>) -> Self {
        Self::Success {
            value: Some(value.into()),
        }
    }

    pub const fn success_void() -> Self {
        Self::Success { value: None }
    }

    pub const fn failure(error: RpcError) -> Self {
        Self::Failure { error }
    }

    pub fn unavailable(method: RpcMethod) -> Self {
        Self::failure(RpcError::internal(format!(
            "capability unavailable: {}",
            method.as_str()
        )))
    }

    pub const fn is_ok(&self) -> bool {
        matches!(self, Self::Success { .. })
    }
}

impl Serialize for RpcResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::Success { value } => {
                map.serialize_entry("ok", &true)?;
                if let Some(value) = value {
                    map.serialize_entry("value", value)?;
                }
            }
            Self::Failure { error } => {
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for RpcResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut object = Map::<String, Value>::deserialize(deserializer)?;
        let ok = object
            .remove("ok")
            .and_then(|value| value.as_bool())
            .ok_or_else(|| D::Error::custom("RPC result requires boolean ok"))?;
        if ok {
            if object.contains_key("error") {
                return Err(D::Error::custom(
                    "successful RPC result cannot contain error",
                ));
            }
            Ok(Self::Success {
                value: object.remove("value"),
            })
        } else {
            if object.contains_key("value") {
                return Err(D::Error::custom("failed RPC result cannot contain value"));
            }
            let error = object
                .remove("error")
                .ok_or_else(|| D::Error::custom("failed RPC result requires error"))?;
            Ok(Self::Failure {
                error: serde_json::from_value(error).map_err(D::Error::custom)?,
            })
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClientRequest {
    #[serde(rename = "type")]
    pub kind: ClientRequestKind,
    #[serde(rename = "rpcId")]
    pub rpc_id: RpcId,
    pub method: String,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientRequestKind {
    #[serde(rename = "client-request")]
    ClientRequest,
}

impl ClientRequest {
    pub fn new(rpc_id: RpcId, method: RpcMethod, payload: Value) -> Self {
        Self {
            kind: ClientRequestKind::ClientRequest,
            rpc_id,
            method: method.as_str().to_owned(),
            payload,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerResponse {
    #[serde(rename = "type")]
    pub kind: ServerResponseKind,
    #[serde(rename = "rpcId")]
    pub rpc_id: RpcId,
    pub result: RpcResult,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerResponseKind {
    #[serde(rename = "server-response")]
    ServerResponse,
}

impl ServerResponse {
    pub const fn new(rpc_id: RpcId, result: RpcResult) -> Self {
        Self {
            kind: ServerResponseKind::ServerResponse,
            rpc_id,
            result,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ServerRequest {
    #[serde(rename = "type")]
    pub kind: ServerRequestKind,
    #[serde(rename = "rpcId")]
    pub rpc_id: RpcId,
    pub method: String,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerRequestKind {
    #[serde(rename = "server-request")]
    ServerRequest,
}

impl ServerRequest {
    pub fn new(rpc_id: RpcId, method: impl Into<String>, payload: Value) -> Self {
        Self {
            kind: ServerRequestKind::ServerRequest,
            rpc_id,
            method: method.into(),
            payload,
        }
    }

    pub fn frame(rpc_id: RpcId, payload: Value) -> Result<Self, RpcError> {
        let method = payload
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::internal("stream frame requires string type"))?
            .to_owned();
        Ok(Self::new(rpc_id, method, payload))
    }
}

/// All-session downlink frames. Domain-owned event/view payloads remain JSON
/// until the corresponding Rust domain contract is implemented, while the
/// carrier discriminants and correlation fields are already fixed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MuxFrame {
    #[serde(rename = "session/event", rename_all = "camelCase")]
    SessionEvent {
        session_id: String,
        event: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        view: Option<Value>,
    },
    #[serde(rename = "session/subscribed", rename_all = "camelCase")]
    SessionSubscribed { session_id: String, last_seq: i64 },
    #[serde(rename = "approval/requested", rename_all = "camelCase")]
    ApprovalRequested {
        session_id: String,
        approval_id: String,
        tool_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "approval/resolved", rename_all = "camelCase")]
    ApprovalResolved {
        session_id: String,
        approval_id: String,
        outcome: Value,
    },
    #[serde(rename = "question/requested", rename_all = "camelCase")]
    QuestionRequested {
        session_id: String,
        questions: Vec<Value>,
    },
    #[serde(rename = "question/resolved", rename_all = "camelCase")]
    QuestionResolved {
        session_id: String,
        question_rpc_id: RpcId,
        outcome: QuestionOutcome,
    },
    #[serde(rename = "session/queue", rename_all = "camelCase")]
    SessionQueue {
        session_id: String,
        items: Vec<Value>,
    },
    #[serde(rename = "session/jobs", rename_all = "camelCase")]
    SessionJobs {
        session_id: String,
        jobs: Vec<Value>,
    },
    #[serde(rename = "session/projection", rename_all = "camelCase")]
    SessionProjection {
        session_id: String,
        key: String,
        value: Value,
        seq: i64,
    },
    #[serde(rename = "stream/error")]
    StreamError { error: RpcError },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionOutcome {
    Answered,
    Cancelled,
}

impl MuxFrame {
    pub fn into_server_request(self, rpc_id: RpcId) -> ServerRequest {
        let payload = serde_json::to_value(self).expect("MuxFrame is always JSON serializable");
        ServerRequest::frame(rpc_id, payload).expect("MuxFrame always has a type")
    }
}

/// Host-level downlink frames.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HostFrame {
    #[serde(rename = "host/session-added", rename_all = "camelCase")]
    SessionAdded {
        session_id: String,
        blank: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_preset: Option<String>,
    },
    #[serde(rename = "host/session-removed", rename_all = "camelCase")]
    SessionRemoved { session_id: String },
    #[serde(rename = "host/session-status", rename_all = "camelCase")]
    SessionStatus { session_id: String, running: bool },
    #[serde(rename = "host/agent-error", rename_all = "camelCase")]
    AgentError { session_id: String, message: String },
    #[serde(rename = "host/workspace-changed")]
    WorkspaceChanged { workspace: Value },
    #[serde(rename = "host/workspace-removed", rename_all = "camelCase")]
    WorkspaceRemoved { workspace_id: String },
    #[serde(rename = "host/workspace-order-changed", rename_all = "camelCase")]
    WorkspaceOrderChanged { workspace_ids: Vec<String> },
    #[serde(rename = "host/archived-sessions-changed", rename_all = "camelCase")]
    ArchivedSessionsChanged { archived_session_ids: Vec<String> },
    #[serde(rename = "host/remote-event")]
    RemoteEvent { event: String, args: Vec<Value> },
    #[serde(rename = "stream/error")]
    StreamError { error: RpcError },
}

impl HostFrame {
    pub fn into_server_request(self, rpc_id: RpcId) -> ServerRequest {
        let payload = serde_json::to_value(self).expect("HostFrame is always JSON serializable");
        ServerRequest::frame(rpc_id, payload).expect("HostFrame always has a type")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClientResponse {
    #[serde(rename = "type")]
    pub kind: ClientResponseKind,
    #[serde(rename = "rpcId")]
    pub rpc_id: RpcId,
    pub result: RpcResult,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientResponseKind {
    #[serde(rename = "client-response")]
    ClientResponse,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcReceipt {
    Accepted,
    Rejected { reason: ReceiptRejection },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReceiptRejection {
    NotPending,
    BadResponse,
}

impl Serialize for RpcReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::Accepted => map.serialize_entry("accepted", &true)?,
            Self::Rejected { reason } => {
                map.serialize_entry("accepted", &false)?;
                map.serialize_entry("reason", reason)?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for RpcReceipt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut object = Map::<String, Value>::deserialize(deserializer)?;
        let accepted = object
            .remove("accepted")
            .and_then(|value| value.as_bool())
            .ok_or_else(|| D::Error::custom("RPC receipt requires boolean accepted"))?;
        if accepted {
            Ok(Self::Accepted)
        } else {
            let reason = object
                .remove("reason")
                .ok_or_else(|| D::Error::custom("rejected receipt requires reason"))?;
            Ok(Self::Rejected {
                reason: serde_json::from_value(reason).map_err(D::Error::custom)?,
            })
        }
    }
}

pub type EventStream = Pin<Box<dyn Stream<Item = ServerRequest> + Send + 'static>>;

/// Download body returned by `/api/session.export`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionExport {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl SessionExport {
    pub fn json(filename: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            filename: filename.into(),
            content_type: "application/json; charset=utf-8".to_owned(),
            bytes,
        }
    }
}

#[async_trait]
pub trait ApiBackend: Send + Sync + 'static {
    async fn call(
        &self,
        rpc_id: RpcId,
        method: RpcMethod,
        payload: Value,
        cancellation: CancellationToken,
    ) -> RpcResult;

    /// Dispatch one generated Typert Remote endpoint such as
    /// `commands/execute`.  These endpoints intentionally live outside the
    /// fixed upstream [`RpcMethod`] directory.  Returning `None` keeps an
    /// unknown endpoint at the transport-level HTTP 404 boundary.
    async fn call_dynamic(
        &self,
        _rpc_id: RpcId,
        _endpoint: &str,
        _payload: Value,
        _cancellation: CancellationToken,
    ) -> Option<RpcResult> {
        None
    }

    async fn respond(&self, response: ClientResponse) -> RpcReceipt;

    fn mux_events(&self) -> EventStream;

    fn host_events(&self) -> EventStream;

    /// Export one session without routing a large binary body through the RPC
    /// envelope. Backends that do not retain sessions may keep the default.
    async fn export_session(
        &self,
        _session_id: &str,
        _cancellation: CancellationToken,
    ) -> Result<SessionExport, RpcError> {
        Err(RpcError::internal("capability unavailable: session.export"))
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableBackend;

#[async_trait]
impl ApiBackend for UnavailableBackend {
    async fn call(
        &self,
        _rpc_id: RpcId,
        method: RpcMethod,
        _payload: Value,
        _cancellation: CancellationToken,
    ) -> RpcResult {
        RpcResult::unavailable(method)
    }

    async fn respond(&self, _response: ClientResponse) -> RpcReceipt {
        RpcReceipt::Rejected {
            reason: ReceiptRejection::NotPending,
        }
    }

    fn mux_events(&self) -> EventStream {
        Box::pin(stream::pending())
    }

    fn host_events(&self) -> EventStream {
        Box::pin(stream::pending())
    }
}
