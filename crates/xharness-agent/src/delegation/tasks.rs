//! Model-facing board commands; no storage, dispatch or tenant identity arguments.
#![forbid(unsafe_code)]
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskReviewOutcome {
    Completed,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTaskCommand {
    List {
        #[serde(default)]
        include_settled: bool,
        #[serde(default)]
        after_task_id: Option<String>,
        #[serde(default = "page_size")]
        limit: usize,
    },
    Add {
        expected_revision: u64,
        title: String,
        instructions: String,
        #[serde(default)]
        dependencies: Vec<String>,
        #[serde(default)]
        eligible_worker_session_ids: Vec<String>,
    },
    Assign {
        expected_revision: u64,
        task_id: String,
        worker_session_id: String,
    },
    Review {
        expected_revision: u64,
        task_id: String,
        execution_ref: String,
        outcome: TaskReviewOutcome,
        summary: String,
    },
}
fn page_size() -> usize {
    20
}
impl AgentTaskCommand {
    pub(crate) fn validate(&self) -> Result<(), String> {
        fn text(value: &str, max: usize) -> Result<(), String> {
            if value.trim().is_empty() || value.len() > max || value.contains('\0') {
                Err("invalid task text or identity".into())
            } else {
                Ok(())
            }
        }
        match self {
            Self::List {
                limit,
                after_task_id,
                ..
            } => {
                if !(1..=50).contains(limit) {
                    return Err("task list limit must be between 1 and 50".into());
                }
                if let Some(id) = after_task_id {
                    text(id, 256)?;
                }
            }
            Self::Add {
                expected_revision,
                title,
                instructions,
                dependencies,
                eligible_worker_session_ids,
            } => {
                if *expected_revision == 0 {
                    return Err("task mutation requires a board revision".into());
                }
                text(title, 160)?;
                text(instructions, 32768)?;
                if eligible_worker_session_ids.len() > 64 {
                    return Err("at most 64 eligible workers per task".into());
                }
                for id in eligible_worker_session_ids {
                    text(id, 256)?;
                }
                for id in dependencies {
                    text(id, 256)?;
                }
            }
            Self::Assign {
                expected_revision,
                task_id,
                worker_session_id,
            } => {
                if *expected_revision == 0 {
                    return Err("task mutation requires a board revision".into());
                }
                text(task_id, 256)?;
                text(worker_session_id, 256)?;
            }
            Self::Review {
                expected_revision,
                task_id,
                execution_ref,
                summary,
                ..
            } => {
                if *expected_revision == 0 {
                    return Err("task mutation requires a board revision".into());
                }
                text(task_id, 256)?;
                text(execution_ref, 256)?;
                text(summary, 8192)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::AgentOperation;
    use serde_json::json;
    #[test]
    fn swarm_review_summary_matches_durable_result_byte_limit() {
        for (summary, valid) in [
            ("a".repeat(8192), true),
            ("a".repeat(8193), false),
            ("é".repeat(4096), true),
            ("é".repeat(4097), false),
        ] {
            let operation: AgentOperation = serde_json::from_value(json!({
                "action": "tasks",
                "swarm_id": "s",
                "command": {
                    "action": "review",
                    "expected_revision": 1,
                    "task_id": "task",
                    "execution_ref": "execution",
                    "outcome": "completed",
                    "summary": summary
                }
            }))
            .unwrap();
            assert_eq!(operation.validate().is_ok(), valid);
        }
    }
    #[test]
    fn swarm_commands_are_strict_and_do_not_accept_caller_or_execution_forgery_fields() {
        for command in [
            json!({"action":"list","owner_session_id":"other"}),
            json!({"action":"set_dispatch","enabled":true}),
            json!({"action":"list","task_id":"wrong-action"}),
            json!({"action":"add","expected_revision":1,"title":"x","instructions":"y","worker_session_id":"x"}),
            json!({"action":"assign","expected_revision":1,"task_id":"x"}),
            json!({"action":"review","expected_revision":1,"task_id":"x","execution_ref":"r","outcome":"completed","summary":"x","turn":1}),
            json!({"action":"review","expected_revision":1,"task_id":"x","execution_ref":"r","outcome":"running","summary":"x"}),
        ] {
            assert!(serde_json::from_value::<AgentOperation>(
                json!({"action":"tasks","swarm_id":"s","command":command})
            )
            .is_err());
        }
        assert!(serde_json::from_value::<AgentOperation>(json!({"action":"tasks","swarm_id":"s","owner_session_id":"other","command":{"action":"list"}})).is_err());
    }
    #[test]
    fn swarm_commands_validate_each_shape_and_default_bounded_reads() {
        for command in [
            json!({"action":"list"}),
            json!({"action":"add","expected_revision":1,"title":"x","instructions":"y","dependencies":["d"],"eligible_worker_session_ids":["w"]}),
            json!({"action":"assign","expected_revision":1,"task_id":"x","worker_session_id":"w"}),
            json!({"action":"review","expected_revision":1,"task_id":"x","execution_ref":"r","outcome":"completed","summary":"evidence"}),
        ] {
            let operation: AgentOperation =
                serde_json::from_value(json!({"action":"tasks","swarm_id":"s","command":command}))
                    .unwrap();
            operation.validate().unwrap();
        }
        let operation: AgentOperation = serde_json::from_value(
            json!({"action":"tasks","swarm_id":"s","command":{"action":"list"}}),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(operation).unwrap()["command"]["limit"],
            20
        );
    }
    #[test]
    fn swarm_commands_reject_invalid_limits_revisions_and_text_before_admission() {
        for command in [
            json!({"action":"list","limit":0}),
            json!({"action":"list","limit":51}),
            json!({"action":"assign","expected_revision":0,"task_id":"x","worker_session_id":"w"}),
            json!({"action":"add","expected_revision":1,"title":" ","instructions":"x"}),
            json!({"action":"review","expected_revision":1,"task_id":"x","execution_ref":"\u{0000}","outcome":"failed","summary":"x"}),
        ] {
            let operation: AgentOperation =
                serde_json::from_value(json!({"action":"tasks","swarm_id":"s","command":command}))
                    .unwrap();
            assert!(operation.validate().is_err());
        }
    }
}
