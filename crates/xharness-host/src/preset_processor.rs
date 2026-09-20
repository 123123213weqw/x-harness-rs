//! Pure Agent Preset application decisions.
//!
//! The RPC adapter owns Host locks, receipt replay and durable Session commits.
//! This processor receives a detached view and decides reads, collection
//! mutations and Session selection events without depending on the Host aggregate.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};
use xharness_session::EventData as SessionEventData;

use crate::state::AgentPreset;

#[derive(Clone, Debug)]
pub(crate) struct PresetSessionView {
    pub(crate) running: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct PresetStateView {
    pub(crate) presets: BTreeMap<String, AgentPreset>,
    pub(crate) default_agent_preset: String,
    pub(crate) sessions: BTreeMap<String, PresetSessionView>,
}

#[derive(Debug)]
pub(crate) struct PresetSelection {
    pub(crate) agent_preset: String,
    pub(crate) response: Value,
    pub(crate) session_events: Vec<SessionEventData>,
}

#[derive(Debug)]
pub(crate) struct PresetInsert {
    pub(crate) preset: AgentPreset,
    pub(crate) response: Value,
}

#[derive(Debug)]
pub(crate) struct PresetRemoval {
    pub(crate) agent_preset: String,
    pub(crate) response: Value,
}

pub(crate) struct PresetProcessor {
    state: PresetStateView,
}

impl PresetProcessor {
    pub(crate) fn new(state: PresetStateView) -> Self {
        Self { state }
    }

    pub(crate) fn list(&self) -> Value {
        json!({
            "presets": self.state.presets.values().map(|preset| {
                let mut preset = preset.clone();
                preset.is_default = preset.id == self.state.default_agent_preset;
                preset
            }).collect::<Vec<_>>(),
            "authorable": true,
            "hasDocument": false,
        })
    }

    pub(crate) fn select(
        &self,
        session_id: &str,
        agent_preset: &str,
    ) -> Result<PresetSelection, RpcError> {
        if !self.state.presets.contains_key(agent_preset) {
            return Err(preset_not_found(agent_preset));
        }
        let session = self
            .state
            .sessions
            .get(session_id)
            .ok_or_else(|| session_not_found(session_id))?;
        if session.running {
            return Err(rpc_error(
                RpcErrorCode::AgentBusy,
                "cannot switch presets while the session is running",
                json!({"reason": "session-running"}),
            ));
        }
        Ok(PresetSelection {
            agent_preset: agent_preset.to_owned(),
            response: json!({"agentPreset": agent_preset}),
            session_events: vec![SessionEventData::AgentPresetSelected {
                agent_preset: agent_preset.to_owned(),
            }],
        })
    }

    pub(crate) fn read(&self, id: &str) -> Result<Value, RpcError> {
        let preset = self
            .state
            .presets
            .get(id)
            .ok_or_else(|| preset_not_found(id))?;
        Ok(json!({
            "agentPreset": preset.id,
            "trust": preset.trust,
            "content": preset.content,
            "name": preset.name,
            "description": preset.description,
        }))
    }

    pub(crate) fn copy(
        &self,
        from: &str,
        id: String,
        name: Option<String>,
    ) -> Result<PresetInsert, RpcError> {
        let source = self
            .state
            .presets
            .get(from)
            .cloned()
            .ok_or_else(|| preset_not_found(from))?;
        if self.state.presets.contains_key(&id) {
            return Err(rpc_error(
                RpcErrorCode::AgentPresetConflict,
                "agent preset id already exists",
                json!({"agentPreset": id}),
            ));
        }
        let response = json!({"agentPreset": id});
        Ok(PresetInsert {
            preset: AgentPreset {
                id,
                trust: "user".to_owned(),
                is_default: false,
                name: name.or(source.name),
                description: source.description,
                content: source.content,
            },
            response,
        })
    }

    pub(crate) fn open_document(&self, id: &str) -> Result<Value, RpcError> {
        if !self.state.presets.contains_key(id) {
            return Err(preset_not_found(id));
        }
        Ok(json!({"opened": false, "path": ""}))
    }

    pub(crate) fn remove(&self, id: &str) -> Result<PresetRemoval, RpcError> {
        let preset = self
            .state
            .presets
            .get(id)
            .ok_or_else(|| preset_not_found(id))?;
        if preset.trust == "system" {
            return Err(rpc_error(
                RpcErrorCode::AgentPresetReadOnly,
                "system agent presets cannot be removed",
                json!({"agentPreset": id, "reason": "system preset"}),
            ));
        }
        Ok(PresetRemoval {
            agent_preset: id.to_owned(),
            response: json!({}),
        })
    }
}

fn preset_not_found(preset: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::AgentPresetNotFound,
        format!("agent preset {preset:?} was not found"),
        json!({"agentPreset": preset}),
    )
}

fn session_not_found(session_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SessionNotFound,
        format!("session {session_id:?} was not found"),
        json!({"sessionId": session_id}),
    )
}

fn rpc_error(code: RpcErrorCode, message: impl Into<String>, details: Value) -> RpcError {
    RpcError {
        code,
        message: message.into(),
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str, trust: &str) -> AgentPreset {
        AgentPreset {
            id: id.to_owned(),
            trust: trust.to_owned(),
            is_default: false,
            name: Some(format!("{id} name")),
            description: Some(format!("{id} description")),
            content: format!("{id} content"),
        }
    }

    fn processor() -> PresetProcessor {
        PresetProcessor::new(PresetStateView {
            presets: [
                ("coding".to_owned(), preset("coding", "system")),
                ("custom".to_owned(), preset("custom", "user")),
            ]
            .into_iter()
            .collect(),
            default_agent_preset: "custom".to_owned(),
            sessions: [
                ("idle".to_owned(), PresetSessionView { running: false }),
                ("busy".to_owned(), PresetSessionView { running: true }),
            ]
            .into_iter()
            .collect(),
        })
    }

    #[test]
    fn list_marks_only_the_effective_default_without_mutating_snapshot() {
        let processor = processor();
        let listed = processor.list();
        let presets = listed["presets"].as_array().unwrap();
        assert_eq!(
            presets
                .iter()
                .filter(|item| item["isDefault"] == true)
                .count(),
            1
        );
        assert!(presets
            .iter()
            .any(|item| item["id"] == "custom" && item["isDefault"] == true));
        assert!(processor
            .state
            .presets
            .values()
            .all(|preset| !preset.is_default));
    }

    #[test]
    fn selection_validates_preset_session_and_running_state() {
        let processor = processor();
        let selected = processor.select("idle", "custom").unwrap();
        assert_eq!(selected.response, json!({"agentPreset":"custom"}));
        assert_eq!(selected.agent_preset, "custom");
        assert!(matches!(
            selected.session_events.as_slice(),
            [SessionEventData::AgentPresetSelected { agent_preset }] if agent_preset == "custom"
        ));
        assert_eq!(
            processor.select("missing", "custom").unwrap_err().code,
            RpcErrorCode::SessionNotFound
        );
        assert_eq!(
            processor.select("idle", "missing").unwrap_err().code,
            RpcErrorCode::AgentPresetNotFound
        );
        assert_eq!(
            processor.select("busy", "custom").unwrap_err().code,
            RpcErrorCode::AgentBusy
        );
    }

    #[test]
    fn copy_is_deterministic_and_conflicts_before_any_state_change() {
        let processor = processor();
        let copied = processor
            .copy("coding", "new".to_owned(), Some("New".to_owned()))
            .unwrap();
        assert_eq!(copied.response, json!({"agentPreset":"new"}));
        assert_eq!(copied.preset.id, "new");
        assert_eq!(copied.preset.trust, "user");
        assert_eq!(copied.preset.name.as_deref(), Some("New"));
        assert_eq!(copied.preset.content, "coding content");
        assert!(!processor.state.presets.contains_key("new"));
        assert_eq!(
            processor
                .copy("coding", "custom".to_owned(), None)
                .unwrap_err()
                .code,
            RpcErrorCode::AgentPresetConflict
        );
    }

    #[test]
    fn remove_rejects_system_and_plans_user_removal_without_mutating() {
        let processor = processor();
        assert_eq!(
            processor.remove("coding").unwrap_err().code,
            RpcErrorCode::AgentPresetReadOnly
        );
        let removed = processor.remove("custom").unwrap();
        assert_eq!(removed.agent_preset, "custom");
        assert_eq!(removed.response, json!({}));
        assert!(processor.state.presets.contains_key("custom"));
    }
}
