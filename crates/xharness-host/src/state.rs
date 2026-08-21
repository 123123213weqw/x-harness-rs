use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use xharness_core::{AgentMessage, LoopCommand, LoopControlError};

use crate::HostConfig;

/// Product-level permission bundle advertised to the Web client and captured
/// when a turn starts.  Full access is deliberately one preset instead of a
/// loose pair of booleans so the UI can place one explicit risk gate in front
/// of the transition.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionPreset {
    #[default]
    WorkspaceWrite,
    DangerFullAccess,
}

impl PermissionPreset {
    pub const ALL: [Self; 2] = [Self::WorkspaceWrite, Self::DangerFullAccess];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }

    pub const fn sandbox_mode(self) -> &'static str {
        match self {
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }

    pub const fn sandbox_enabled(self) -> bool {
        matches!(self, Self::WorkspaceWrite)
    }

    pub const fn approval_policy(self) -> &'static str {
        match self {
            Self::WorkspaceWrite => "ask",
            Self::DangerFullAccess => "never",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "workspace-write" => Some(Self::WorkspaceWrite),
            "danger-full-access" => Some(Self::DangerFullAccess),
            _ => None,
        }
    }

    pub fn select(self) -> Value {
        json!({
            "options": [
                {
                    "value": "workspace-write",
                    "name": "workspace-write",
                    "description": "Write inside the workspace; wider operations require approval."
                },
                {
                    "value": "danger-full-access",
                    "name": "danger-full-access",
                    "description": "No permission sandbox after one explicit risk confirmation; processes remain managed."
                }
            ],
            "currentValue": self.as_str(),
        })
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn iso_now() -> String {
    // The Web contract requires a string rather than a particular timestamp
    // grammar. Milliseconds are stable, sortable, and lossless for this store.
    now_ms().to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

impl ModelSelection {
    pub(crate) fn from_config(config: &HostConfig) -> Self {
        Self {
            provider: config.provider_id.clone(),
            model: config.model_id.clone(),
            reasoning_effort: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub workspace_id: String,
    pub path: String,
    pub title: String,
    pub session_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreset {
    pub id: String,
    pub trust: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip)]
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub id: String,
    pub revision: u64,
    pub objective: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_goal_rounds: Option<u64>,
    pub status: String,
}

#[derive(Clone, Debug)]
pub(crate) struct AttachmentRecord {
    pub attachment: Value,
    pub data: String,
    pub referenced_by: BTreeSet<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct QueuedPrompt {
    pub id: String,
    pub text: String,
    pub content: Vec<Value>,
    pub source: Value,
    pub fingerprint: Option<String>,
}

pub(crate) struct DriverCommand {
    pub command: LoopCommand,
    pub input_metadata: Option<Value>,
    pub acknowledgement: oneshot::Sender<Result<(), LoopControlError>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub running: bool,
    pub blank: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub model: ModelSelection,
    pub permission_preset: PermissionPreset,
    pub events: Vec<Value>,
    pub messages: Vec<AgentMessage>,
    #[serde(skip)]
    pub(crate) queue: VecDeque<QueuedPrompt>,
    #[serde(skip)]
    pub(crate) admissions: BTreeMap<String, QueuedPrompt>,
    #[serde(skip)]
    pub(crate) authoritative_seq: Option<u64>,
    #[serde(skip)]
    pub(crate) control: Option<mpsc::Sender<DriverCommand>>,
    pub(crate) next_turn: u32,
}

impl SessionRecord {
    pub(crate) fn summary(&self) -> Value {
        let mut value = json!({
            "sessionId": self.session_id,
            "updatedAt": self.updated_at,
            "running": self.running,
            "blank": self.blank,
            "cwd": self.cwd,
            "projections": {
                "asOfSeq": self.events.len() as i64 - 1,
                "values": self.projection_values(),
            },
        });
        let object = value.as_object_mut().expect("summary is an object");
        if let Some(parent) = &self.parent_session_id {
            object.insert("parentSessionId".to_owned(), json!(parent));
        }
        if let Some(origin) = &self.origin {
            object.insert("origin".to_owned(), json!(origin));
        }
        if let Some(preset) = &self.agent_preset {
            object.insert("agentPreset".to_owned(), json!(preset));
        }
        value
    }

    pub(crate) fn projection_values(&self) -> Value {
        let mut values = serde_json::Map::new();
        values.insert(
            "sessionListMetadata".to_owned(),
            json!({
                "blank": self.blank,
                "lastPromptAt": if self.blank { Value::Null } else { json!(self.updated_at) },
            }),
        );
        if let Some(title) = &self.title {
            values.insert(
                "sessionTitle".to_owned(),
                json!({"title": title, "source": {"kind": "user"}}),
            );
        }
        values.insert("permissions".to_owned(), self.permission_preset.select());
        Value::Object(values)
    }

    pub(crate) fn queue_view(&self) -> Vec<Value> {
        self.queue
            .iter()
            .map(|item| {
                json!({
                    "id": item.id,
                    "placement": "queued",
                    "message": {
                        "id": item.id,
                        "role": "user",
                        "content": item.content,
                        "source": item.source,
                    },
                })
            })
            .collect()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SettingsNamespace {
    pub ns: String,
    pub schema: Value,
    pub base: Value,
    pub value: Value,
    pub user: Value,
    pub applies: String,
    pub revision: u64,
}

impl SettingsNamespace {
    pub(crate) fn view(&self) -> Value {
        json!({
            "ns": self.ns,
            "schema": self.schema,
            "base": self.base,
            "value": self.value,
            "user": self.user,
            "applies": self.applies,
            "secrets": [],
            "revision": self.revision,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) enum PendingResponse {
    Approval {
        session_id: String,
        approval_id: String,
        call_id: String,
        tool_name: String,
        control: mpsc::Sender<DriverCommand>,
    },
}

pub(crate) struct HostState {
    pub sessions: BTreeMap<String, SessionRecord>,
    pub workspaces: BTreeMap<String, WorkspaceRecord>,
    pub workspace_order: Vec<String>,
    pub archived_sessions: BTreeSet<String>,
    pub presets: BTreeMap<String, AgentPreset>,
    pub settings: BTreeMap<String, SettingsNamespace>,
    pub credentials: BTreeMap<String, String>,
    pub goals: BTreeMap<String, GoalState>,
    pub attachments: BTreeMap<String, AttachmentRecord>,
    pub pending: BTreeMap<String, PendingResponse>,
}

impl HostState {
    pub(crate) fn new(config: &HostConfig) -> Self {
        let mut presets = BTreeMap::new();
        presets.insert(
            "coding".to_owned(),
            AgentPreset {
                id: "coding".to_owned(),
                trust: "system".to_owned(),
                is_default: true,
                name: Some("Coding Agent".to_owned()),
                description: Some("XHarness standard fourteen-tool coding agent".to_owned()),
                content: "You are a coding agent. Inspect the workspace, make precise changes, and verify your work.".to_owned(),
            },
        );
        let mut settings = BTreeMap::new();
        settings.insert(
            "xharness".to_owned(),
            SettingsNamespace {
                ns: "xharness".to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "provider": {"type": "string"},
                        "model": {"type": "string"},
                    },
                }),
                base: json!({
                    "provider": config.provider_id,
                    "model": config.model_id,
                }),
                value: json!({
                    "provider": config.provider_id,
                    "model": config.model_id,
                }),
                user: json!({}),
                applies: "restart".to_owned(),
                revision: 0,
            },
        );
        // The upstream Web shell persists its versioned first-run notice in
        // this Host-only namespace.  Keeping the namespace in the Rust Host
        // makes the repository Web usable without a Node settings service.
        settings.insert(
            "ui-onboarding".to_owned(),
            SettingsNamespace {
                ns: "ui-onboarding".to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "welcomeNoticeVersion": {"type": "string"},
                    },
                    "additionalProperties": false,
                }),
                base: json!({}),
                value: json!({}),
                user: json!({}),
                applies: "immediate".to_owned(),
                revision: 0,
            },
        );
        settings.insert(
            "permission".to_owned(),
            SettingsNamespace {
                ns: "permission".to_owned(),
                // Schemastery wire format consumed by the upstream Web
                // permission row.  The two const nodes are the complete
                // product preset catalog; Full access receives an additional
                // confirmation modal in the client plugin.
                schema: json!({
                    "uid": 4,
                    "refs": {
                        "1": {"type": "const", "meta": {"description": "Workspace write"}, "value": "workspace-write"},
                        "2": {"type": "const", "meta": {"description": "Full access"}, "value": "danger-full-access"},
                        "3": {"type": "union", "list": [1, 2]},
                        "4": {"type": "object", "dict": {"defaultPreset": 3}}
                    }
                }),
                base: json!({"defaultPreset": "workspace-write"}),
                value: json!({"defaultPreset": "workspace-write"}),
                user: json!({}),
                applies: "live".to_owned(),
                revision: 0,
            },
        );
        // The Web composer cannot start a session without at least one
        // workspace choice. The durable workspace store is still pending, so
        // always seed the configured canonical cwd as a deterministic boot
        // baseline instead of presenting an empty, apparently unclickable
        // selector after every Host restart.
        let mut workspaces = BTreeMap::new();
        let mut workspace_order = Vec::new();
        if let Ok(canonical) = std::fs::canonicalize(&config.cwd) {
            if canonical.is_dir() {
                let path = canonical.to_string_lossy().into_owned();
                let title = Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&path)
                    .to_owned();
                let now = iso_now();
                let workspace_id = "workspace-default".to_owned();
                workspaces.insert(
                    workspace_id.clone(),
                    WorkspaceRecord {
                        workspace_id: workspace_id.clone(),
                        path,
                        title,
                        session_ids: Vec::new(),
                        created_at: now.clone(),
                        updated_at: now,
                    },
                );
                workspace_order.push(workspace_id);
            }
        }
        Self {
            sessions: BTreeMap::new(),
            workspaces,
            workspace_order,
            archived_sessions: BTreeSet::new(),
            presets,
            settings,
            credentials: BTreeMap::new(),
            goals: BTreeMap::new(),
            attachments: BTreeMap::new(),
            pending: BTreeMap::new(),
        }
    }
}
