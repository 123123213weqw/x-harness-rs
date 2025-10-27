use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use xharness_core::{AgentMessage, LoopCommand, LoopControlError};

use crate::HostConfig;

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
}

pub(crate) struct DriverCommand {
    pub command: LoopCommand,
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
    pub events: Vec<Value>,
    pub messages: Vec<AgentMessage>,
    #[serde(skip)]
    pub(crate) queue: VecDeque<QueuedPrompt>,
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
                value: json!({}),
                user: json!({}),
                applies: "immediate".to_owned(),
                revision: 0,
            },
        );
        Self {
            sessions: BTreeMap::new(),
            workspaces: BTreeMap::new(),
            workspace_order: Vec::new(),
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
