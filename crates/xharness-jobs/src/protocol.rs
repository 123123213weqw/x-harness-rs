//! Versioned producer-neutral execution projection. A Plan is not a Run.
//! References are opaque and owner-scoped; callers never infer success from
//! tool completion, timer dispatch, or plan completion.
use crate::{JobSnapshot, JobStatus};
use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Preparing,
    Queued,
    Running,
    Waiting,
    Stopping,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Incomplete,
    Unavailable,
}
impl RunState {
    pub fn from_agent(value: &str) -> Self {
        match value {
            "preparing" => Self::Preparing,
            "queued" => Self::Queued,
            "running" => Self::Running,
            "waiting" => Self::Waiting,
            "stopping" => Self::Stopping,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "incomplete" => Self::Incomplete,
            _ => Self::Unavailable,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanState {
    Scheduled,
    Overdue,
    Paused,
    Finished,
    Deleted,
    Inherited,
    Inactive,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunRef {
    Process {
        id: String,
    },
    Automation {
        #[serde(rename = "planId")]
        plan_id: String,
        #[serde(rename = "inputId")]
        input_id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunCapabilities {
    pub cancel_run: bool,
    pub read_output: bool,
    pub open_session: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRun {
    pub id: String,
    pub label: String,
    pub source_session_id: String,
    pub target_session_id: String,
    pub plan_id: Option<String>,
    pub state: RunState,
    pub reference: RunRef,
    pub capabilities: RunCapabilities,
    pub started_at_ms: Option<u64>,
    pub scheduled_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub detail: Option<String>,
}
impl JobRun {
    pub fn process(snapshot: JobSnapshot) -> Self {
        let state = match snapshot.status {
            JobStatus::Running => RunState::Running,
            JobStatus::Stopping => RunState::Stopping,
            JobStatus::Completed => RunState::Completed,
            JobStatus::Failed => RunState::Failed,
            JobStatus::Killed => RunState::Cancelled,
        };
        let id = snapshot.id.to_string();
        Self {
            reference: RunRef::Process { id: id.clone() },
            id,
            label: snapshot.label,
            source_session_id: snapshot.owner.clone(),
            target_session_id: snapshot.owner,
            plan_id: None,
            state,
            capabilities: RunCapabilities {
                cancel_run: state == RunState::Running,
                read_output: true,
                open_session: false,
            },
            started_at_ms: Some(snapshot.started_at_ms),
            scheduled_at_ms: None,
            finished_at_ms: snapshot.finished_at_ms,
            detail: snapshot.detail,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobPlan {
    pub id: String,
    pub label: String,
    pub state: PlanState,
    pub next_at: String,
    pub every_seconds: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobCatalog {
    pub version: u32,
    pub session_id: String,
    pub plans: Vec<JobPlan>,
    pub runs: Vec<JobRun>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agent_dispatch_and_unknown_states_never_mean_success() {
        assert_eq!(RunState::from_agent("queued"), RunState::Queued);
        assert_eq!(RunState::from_agent("finished"), RunState::Unavailable);
        assert_eq!(RunState::from_agent("incomplete"), RunState::Incomplete);
        assert_eq!(RunState::from_agent("failed"), RunState::Failed);
    }
}
