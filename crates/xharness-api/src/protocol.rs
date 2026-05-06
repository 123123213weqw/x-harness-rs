//! Typed unary RPC payload catalog.
//!
//! The browser wire predates the Rust host and remains compatibility-frozen.
//! These DTOs therefore model the existing JSON rather than changing it. The
//! transport envelope stays in the crate root; application code can migrate
//! one method family at a time from raw `Value` payloads to this catalog.

use std::collections::BTreeMap;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::RpcMethod;

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{side} payload for {method} does not match the frozen protocol: {message}")]
pub struct ProtocolShapeError {
    pub method: RpcMethod,
    pub side: &'static str,
    pub message: String,
}

fn decode<T: DeserializeOwned>(
    method: RpcMethod,
    side: &'static str,
    value: &Value,
) -> Result<T, ProtocolShapeError> {
    serde_json::from_value(value.clone()).map_err(|error| ProtocolShapeError {
        method,
        side,
        message: error.to_string(),
    })
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EmptyParams {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdParams {
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionSearchParams {
    pub query: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_preset: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSelectModelParams {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenameParams {
    pub session_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    pub session_id: String,
    pub mode: String,
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_idle: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_time_zone: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachmentParams {
    pub session_id: String,
    pub attachment_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateQueueParams {
    pub session_id: String,
    pub item_id: String,
    pub action: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListParams {
    pub parent_session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentHistoryParams {
    pub parent_session_id: String,
    pub child_session_id: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPromptParams {
    pub parent_session_id: String,
    pub child_session_id: String,
    pub mode: String,
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_time_zone: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInterruptParams {
    pub parent_session_id: String,
    pub child_session_id: String,
    pub mode: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostListDirectoryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostCreateDirectoryParams {
    pub path: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostOpenPathParams {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceCreateParams {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenameParams {
    pub workspace_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdParams {
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInsertBeforeParams {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_workspace_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInsertSessionBeforeParams {
    pub workspace_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetSelectParams {
    pub session_id: String,
    pub agent_preset: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetParams {
    pub agent_preset: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetCopyParams {
    pub from: String,
    pub agent_preset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GoalRef {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalCreateParams {
    pub session_id: String,
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_goal_rounds: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEditParams {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub goal_ref: GoalRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_goal_rounds: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalTransitionParams {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub goal_ref: GoalRef,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateParams {
    pub ns: String,
    pub patch: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsReplaceParams {
    pub ns: String,
    pub section: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum SettingsPathOperation {
    Set { path: Vec<String>, value: Value },
    Unset { path: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsMutateParams {
    pub ns: String,
    pub ops: Vec<SettingsPathOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CredentialsDescribeParams {
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CredentialsSetParams {
    #[serde(rename = "ref")]
    pub credential_ref: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CredentialsUnsetParams {
    #[serde(rename = "ref")]
    pub credential_ref: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmDiscoverModelsParams {
    pub settings_ns: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

// Response DTOs intentionally keep extension-owned interiors as `Value`.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub updated_at: f64,
    pub running: bool,
    pub blank: bool,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub agent_preset: Option<String>,
    #[serde(default)]
    pub projections: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionListResponse {
    pub items: Vec<SessionSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchItem {
    pub session_id: String,
    pub snippet: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResponse {
    pub items: Vec<SessionSearchItem>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateResponse {
    pub session_id: String,
    #[serde(default)]
    pub agent_preset: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryResponse {
    pub events: Vec<Value>,
    pub has_more: bool,
    #[serde(default)]
    pub projections: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub context_window_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelReasoningEffort {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReasoning {
    pub efforts: Vec<ModelReasoningEffort>,
    #[serde(default)]
    pub default_effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub context_window_source: Option<String>,
    #[serde(default)]
    pub context_window_capability: Option<Value>,
    #[serde(default)]
    pub reasoning_capability: Option<Value>,
    #[serde(default)]
    pub reasoning: Option<ModelReasoning>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelProviderGroup {
    pub id: String,
    pub name: String,
    pub models: Vec<ModelCatalogEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelCatalogFailure {
    pub id: String,
    pub name: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionModelsResponse {
    pub current: ModelSelection,
    pub routable: bool,
    pub groups: Vec<ModelProviderGroup>,
    pub failures: Vec<ModelCatalogFailure>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionSelectModelResponse {
    pub selected: ModelSelection,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionRenameResponse {
    pub title: String,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentityResponse {
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AcceptedResponse {
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionPromptResponse {
    pub accepted: bool,
    #[serde(default)]
    pub command: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionAttachmentResponse {
    pub attachment: Value,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListResponse {
    pub entries: Vec<Value>,
    pub parent_available: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageIdResponse {
    pub message_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDescribeResponse {
    pub version: String,
    pub cwd: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub attached_sessions: usize,
    pub home: String,
    pub can_open_path: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostPickDirectoryResponse {
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub hidden: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostListDirectoryResponse {
    pub path: String,
    pub home: String,
    pub crumbs: Vec<DirectoryEntry>,
    pub entries: Vec<DirectoryEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PathResponse {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OpenedResponse {
    pub opened: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub workspace_id: String,
    pub path: String,
    pub title: String,
    pub session_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListResponse {
    pub items: Vec<WorkspaceView>,
    pub archived_session_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceCreateResponse {
    pub workspace: WorkspaceView,
    pub created: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceResponse {
    pub workspace: WorkspaceView,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeletedResponse {
    pub deleted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOrderResponse {
    pub workspace_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSessionsResponse {
    pub archived_session_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub when_to_use: Option<String>,
    pub model_invocable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SkillListResponse {
    pub skills: Vec<SkillEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetEntry {
    pub id: String,
    pub trust: String,
    pub is_default: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub broken: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetListResponse {
    pub presets: Vec<AgentPresetEntry>,
    pub authorable: bool,
    pub has_document: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetResponse {
    pub agent_preset: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresetReadResponse {
    pub agent_preset: String,
    pub trust: String,
    pub content: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GoalRefResponse {
    #[serde(rename = "ref")]
    pub goal_ref: GoalRef,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClearedResponse {
    pub cleared: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSecretView {
    pub path: Vec<String>,
    pub set: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsNamespaceView {
    pub ns: String,
    pub schema: Value,
    pub value: Value,
    #[serde(default)]
    pub base: Option<Value>,
    #[serde(default)]
    pub user: Option<Value>,
    pub applies: String,
    pub secrets: Vec<SettingsSecretView>,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDescribeResponse {
    pub writable: bool,
    pub has_document: bool,
    pub namespaces: Vec<SettingsNamespaceView>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CredentialView {
    pub configured: bool,
    #[serde(default)]
    pub source: Option<String>,
    pub writable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CredentialsDescribeResponse {
    pub credentials: BTreeMap<String, CredentialView>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurableProviderView {
    pub provider: String,
    pub display_name: String,
    pub settings_ns: String,
    pub settings_path: Vec<String>,
    pub active: bool,
    #[serde(default)]
    pub declared: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LlmProvidersResponse {
    pub providers: Vec<ConfigurableProviderView>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LlmModelsResponse {
    pub groups: Vec<ModelProviderGroup>,
    pub failures: Vec<ModelCatalogFailure>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModelView {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LlmDiscoverModelsResponse {
    pub models: Vec<DiscoveredModelView>,
}

macro_rules! typed_rpc_catalog {
    ($($variant:ident => ($params:ty, $response:ty)),+ $(,)?) => {
        #[derive(Clone, Debug, PartialEq)]
        pub enum TypedRpcParams {
            $($variant($params)),+
        }

        impl TypedRpcParams {
            pub fn decode(method: RpcMethod, payload: &Value) -> Result<Self, ProtocolShapeError> {
                Ok(match method {
                    $(RpcMethod::$variant => Self::$variant(decode(method, "request", payload)?)),+
                })
            }

            pub const fn method(&self) -> RpcMethod {
                match self {
                    $(Self::$variant(_) => RpcMethod::$variant),+
                }
            }

            pub fn to_value(&self) -> Value {
                match self {
                    $(Self::$variant(value) => serde_json::to_value(value)),+
                }
                .expect("typed RPC params are always serializable")
            }
        }

        #[derive(Clone, Debug, PartialEq)]
        pub enum TypedRpcResponse {
            $($variant($response)),+
        }

        impl TypedRpcResponse {
            pub fn decode(method: RpcMethod, value: &Value) -> Result<Self, ProtocolShapeError> {
                Ok(match method {
                    $(RpcMethod::$variant => Self::$variant(decode(method, "response", value)?)),+
                })
            }

            pub const fn method(&self) -> RpcMethod {
                match self {
                    $(Self::$variant(_) => RpcMethod::$variant),+
                }
            }
        }
    };
}

typed_rpc_catalog! {
    SessionList => (SessionListParams, SessionListResponse),
    SessionSearch => (SessionSearchParams, SessionSearchResponse),
    SessionCreate => (SessionCreateParams, SessionCreateResponse),
    SessionHistory => (SessionHistoryParams, SessionHistoryResponse),
    SessionModels => (SessionIdParams, SessionModelsResponse),
    SessionSelectModel => (SessionSelectModelParams, SessionSelectModelResponse),
    SessionRename => (SessionRenameParams, SessionRenameResponse),
    SessionFork => (SessionForkParams, SessionIdentityResponse),
    SessionPrompt => (SessionPromptParams, SessionPromptResponse),
    SessionAttachment => (SessionAttachmentParams, SessionAttachmentResponse),
    SessionUpdateQueue => (SessionUpdateQueueParams, AcceptedResponse),
    SessionCancel => (SessionIdParams, AcceptedResponse),
    SubagentList => (SubagentListParams, SubagentListResponse),
    SubagentHistory => (SubagentHistoryParams, SessionHistoryResponse),
    SubagentPrompt => (SubagentPromptParams, MessageIdResponse),
    SubagentInterrupt => (SubagentInterruptParams, AcceptedResponse),
    HostDescribe => (EmptyParams, HostDescribeResponse),
    HostPickDirectory => (EmptyParams, HostPickDirectoryResponse),
    HostListDirectory => (HostListDirectoryParams, HostListDirectoryResponse),
    HostCreateDirectory => (HostCreateDirectoryParams, PathResponse),
    HostOpenPath => (HostOpenPathParams, OpenedResponse),
    WorkspaceList => (EmptyParams, WorkspaceListResponse),
    WorkspaceCreate => (WorkspaceCreateParams, WorkspaceCreateResponse),
    WorkspaceRename => (WorkspaceRenameParams, WorkspaceResponse),
    WorkspaceDelete => (WorkspaceIdParams, DeletedResponse),
    WorkspaceInsertBefore => (WorkspaceInsertBeforeParams, WorkspaceOrderResponse),
    WorkspaceInsertSessionBefore => (WorkspaceInsertSessionBeforeParams, WorkspaceResponse),
    WorkspaceArchiveSession => (SessionIdParams, ArchivedSessionsResponse),
    SkillList => (SessionIdParams, SkillListResponse),
    AgentPresetList => (EmptyParams, AgentPresetListResponse),
    AgentPresetSelect => (AgentPresetSelectParams, AgentPresetResponse),
    AgentPresetRead => (AgentPresetParams, AgentPresetReadResponse),
    AgentPresetCopy => (AgentPresetCopyParams, AgentPresetResponse),
    AgentPresetOpenDocument => (AgentPresetParams, OpenedResponse),
    AgentPresetRemove => (AgentPresetParams, EmptyParams),
    GoalCreate => (GoalCreateParams, GoalRefResponse),
    GoalEdit => (GoalEditParams, GoalRefResponse),
    GoalPause => (GoalTransitionParams, GoalRefResponse),
    GoalResume => (GoalTransitionParams, GoalRefResponse),
    GoalComplete => (GoalTransitionParams, GoalRefResponse),
    GoalClear => (GoalTransitionParams, ClearedResponse),
    SettingsDescribe => (EmptyParams, SettingsDescribeResponse),
    SettingsOpenDocument => (EmptyParams, OpenedResponse),
    SettingsUpdate => (SettingsUpdateParams, SettingsNamespaceView),
    SettingsReplace => (SettingsReplaceParams, SettingsNamespaceView),
    SettingsMutate => (SettingsMutateParams, SettingsNamespaceView),
    CredentialsDescribe => (CredentialsDescribeParams, CredentialsDescribeResponse),
    CredentialsSet => (CredentialsSetParams, EmptyParams),
    CredentialsUnset => (CredentialsUnsetParams, EmptyParams),
    LlmProviders => (EmptyParams, LlmProvidersResponse),
    LlmModels => (EmptyParams, LlmModelsResponse),
    LlmDiscoverModels => (LlmDiscoverModelsParams, LlmDiscoverModelsResponse),
}
