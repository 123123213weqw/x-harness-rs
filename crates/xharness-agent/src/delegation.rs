//! Protocol for delegation. Transport, tools and UI share this typed boundary;
//! implementations must reuse the durable agent inbox rather than a job queue.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentOperation {
    Start {
        task: String,
        #[serde(default)]
        label: Option<String>,
        /// User-requested selectors; Host requires per-call human confirmation for changes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
    },
    Send {
        agent_id: String,
        message: String,
    },
    Inspect {
        #[serde(default)]
        agent_id: Option<String>,
    },
    Stop {
        agent_id: String,
    },
}

impl AgentOperation {
    pub fn validate(&self) -> Result<(), String> {
        fn text(value: &str, field: &str, max: usize) -> Result<(), String> {
            if value.trim().is_empty() || value.len() > max {
                Err(format!(
                    "{field} must be non-empty and at most {max} UTF-8 bytes"
                ))
            } else {
                Ok(())
            }
        }
        match self {
            Self::Start {
                task,
                label,
                provider,
                model,
                reasoning_effort,
            } => {
                text(task, "task", 32768)?;
                if let Some(label) = label {
                    text(label, "label", 160)?;
                }
                for (value, field, max) in [
                    (provider, "provider", 128),
                    (model, "model", 512),
                    (reasoning_effort, "reasoning_effort", 128),
                ] {
                    if let Some(value) = value {
                        text(value, field, max)?;
                        if value.trim() != value || value.chars().any(char::is_control) {
                            return Err(format!("{field} must not contain control characters or surrounding whitespace"));
                        }
                    }
                }
            }
            Self::Send { agent_id, message } => {
                text(agent_id, "agent_id", 256)?;
                text(message, "message", 32768)?;
            }
            Self::Inspect { agent_id: Some(id) } | Self::Stop { agent_id: id } => {
                text(id, "agent_id", 256)?
            }
            Self::Inspect { agent_id: None } => {}
        }
        Ok(())
    }
}

/// Caller identity is host-bound, never accepted from model arguments.
#[async_trait]
pub trait DelegationRuntime: Send + Sync {
    async fn execute(
        &self,
        caller: &str,
        invocation: &str,
        operation: AgentOperation,
        cancellation: CancellationToken,
    ) -> Result<Value, String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_cross_action_fields_and_missing_arguments() {
        for value in [
            json!({"action":"start"}),
            json!({"action":"start","task":"x","agent_id":"a"}),
            json!({"action":"stop","agent_id":"a","message":"x"}),
            json!({"action":"send","agent_id":"a"}),
            json!({"action":"delete","agent_id":"a"}),
            json!({"action":"inspect","parent_id":"fake"}),
            json!({"action":"send","agent_id":"a","message":"x","model":"test"}),
            json!({"action":"inspect","provider":"test"}),
            json!({"action":"stop","agent_id":"a","reasoning_effort":"high"}),
        ] {
            assert!(serde_json::from_value::<AgentOperation>(value).is_err());
        }
    }
    #[test]
    fn model_selectors_are_optional_and_round_trip_without_a_global_effort_enum() {
        let inherited: AgentOperation =
            serde_json::from_value(json!({"action":"start","task":"inspect"})).unwrap();
        assert!(matches!(
            inherited,
            AgentOperation::Start {
                provider: None,
                model: None,
                reasoning_effort: None,
                ..
            }
        ));
        let selected = json!({"action":"start","task":"inspect","label":"review",
            "provider":"configured-provider","model":"model/v2","reasoning_effort":"vendor-level-3"});
        let op: AgentOperation = serde_json::from_value(selected.clone()).unwrap();
        op.validate().unwrap();
        assert_eq!(serde_json::to_value(op).unwrap(), selected);
        assert!(serde_json::to_value(inherited)
            .unwrap()
            .get("model")
            .is_none());
    }

    #[test]
    fn rejects_malformed_model_selectors_before_admission() {
        for (field, maximum) in [("provider", 128), ("model", 512), ("reasoning_effort", 128)] {
            for invalid in [
                "".into(),
                " ".into(),
                " x".into(),
                "x ".into(),
                "x\ny".into(),
                "x\0y".into(),
                "中".repeat(maximum / 3 + 1),
            ] {
                let mut value = json!({"action":"start","task":"inspect"});
                value[field] = json!(invalid);
                let op: AgentOperation = serde_json::from_value(value).unwrap();
                assert!(op.validate().is_err(), "accepted malformed {field}");
            }
            for invalid in [json!(42), json!([]), json!({})] {
                let mut value = json!({"action":"start","task":"inspect"});
                value[field] = invalid;
                assert!(serde_json::from_value::<AgentOperation>(value).is_err());
            }
        }
    }
    #[test]
    fn validates_all_four_actions_and_bounds() {
        for value in [
            json!({"action":"start","task":"检查中文路径"}),
            json!({"action":"send","agent_id":"a","message":"继续"}),
            json!({"action":"inspect"}),
            json!({"action":"inspect","agent_id":"a"}),
            json!({"action":"stop","agent_id":"a"}),
        ] {
            serde_json::from_value::<AgentOperation>(value)
                .unwrap()
                .validate()
                .unwrap();
        }
        assert!(AgentOperation::Start {
            task: " ".into(),
            label: None,
            provider: None,
            model: None,
            reasoning_effort: None,
        }
        .validate()
        .is_err());
        assert!(AgentOperation::Send {
            agent_id: "a".into(),
            message: "中".repeat(11000)
        }
        .validate()
        .is_err());
    }
}
