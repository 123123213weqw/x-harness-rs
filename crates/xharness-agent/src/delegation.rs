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
            Self::Start { task, label } => {
                text(task, "task", 32768)?;
                if let Some(label) = label {
                    text(label, "label", 160)?;
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
        ] {
            assert!(serde_json::from_value::<AgentOperation>(value).is_err());
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
            label: None
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
