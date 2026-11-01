//! Durable work ownership, not a second Agent execution state machine.
use super::{text, SwarmSnapshot};
use crate::{invalid, ControlError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwarmTaskOutcome {
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SwarmTaskState {
    Pending,
    Assigned {
        worker_session_id: String,
        message_id: String,
        delivered: bool,
    },
    Settled {
        worker_session_id: String,
        message_id: String,
        turn: Option<u32>,
        outcome: SwarmTaskOutcome,
        summary: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwarmTask {
    pub id: String,
    pub title: String,
    pub instructions: String,
    pub dependencies: Vec<String>,
    /// Explicit routing only; empty keeps this task manual.
    #[serde(default)]
    pub eligible_worker_session_ids: Vec<String>,
    pub state: SwarmTaskState,
}
impl SwarmTask {
    pub fn completed(&self) -> bool {
        matches!(
            self.state,
            SwarmTaskState::Settled {
                outcome: SwarmTaskOutcome::Completed,
                ..
            }
        )
    }
    pub fn ready(&self, swarm: &SwarmSnapshot) -> bool {
        swarm.status == super::SwarmStatus::Active
            && matches!(self.state, SwarmTaskState::Pending)
            && self
                .dependencies
                .iter()
                .all(|id| swarm.tasks.get(id).is_some_and(Self::completed))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SwarmTaskChange {
    Added {
        task_id: String,
        title: String,
        instructions: String,
        dependencies: Vec<String>,
        #[serde(default)]
        eligible_worker_session_ids: Vec<String>,
    },
    Claimed {
        task_id: String,
        worker_session_id: String,
        message_id: String,
    },
    Delivered {
        task_id: String,
        message_id: String,
    },
    Settled {
        task_id: String,
        message_id: String,
        turn: Option<u32>,
        outcome: SwarmTaskOutcome,
        summary: String,
    },
}

pub(super) fn apply(
    swarm: &mut SwarmSnapshot,
    change: &SwarmTaskChange,
) -> Result<(), ControlError> {
    match change {
        SwarmTaskChange::Added {
            task_id,
            title,
            instructions,
            dependencies,
            eligible_worker_session_ids,
        } => {
            text(task_id, "task id", 256)?;
            text(title, "task title", 160)?;
            text(instructions, "task instructions", 32768)?;
            if swarm.tasks.contains_key(task_id) {
                return Err(invalid("task already exists"));
            }
            let unique: BTreeSet<_> = dependencies.iter().collect();
            // Only earlier, immutable task identities can be dependencies, so cycles are impossible.
            if unique.len() != dependencies.len()
                || dependencies.iter().any(|id| !swarm.tasks.contains_key(id))
            {
                return Err(invalid("task dependencies must be distinct existing tasks"));
            }
            let workers: BTreeSet<_> = eligible_worker_session_ids.iter().collect();
            if workers.len() != eligible_worker_session_ids.len()
                || workers.len() > 64
                || workers.iter().any(|id| !swarm.members.contains_key(*id))
            {
                return Err(invalid(
                    "eligible workers must be distinct linked team members (max 64)",
                ));
            }
            swarm.tasks.insert(
                task_id.clone(),
                SwarmTask {
                    id: task_id.clone(),
                    title: title.clone(),
                    instructions: instructions.clone(),
                    dependencies: dependencies.clone(),
                    eligible_worker_session_ids: eligible_worker_session_ids.clone(),
                    state: SwarmTaskState::Pending,
                },
            );
        }
        SwarmTaskChange::Claimed {
            task_id,
            worker_session_id,
            message_id,
        } => {
            text(message_id, "task delivery id", 256)?;
            if !swarm.members.contains_key(worker_session_id) {
                return Err(invalid("task worker is not a team member"));
            }
            if swarm.tasks.values().any(|t| matches!(&t.state,SwarmTaskState::Assigned{worker_session_id:worker,..} if worker==worker_session_id)) {
                return Err(invalid("worker already owns an unfinished task"));
            }
            if swarm.tasks.values().any(|t| match &t.state {
                SwarmTaskState::Assigned { message_id: id, .. }
                | SwarmTaskState::Settled { message_id: id, .. } => id == message_id,
                SwarmTaskState::Pending => false,
            }) {
                return Err(invalid("task delivery identity already exists"));
            }
            let task = swarm
                .tasks
                .get(task_id)
                .ok_or_else(|| invalid("task not found"))?;
            if !task.ready(swarm) {
                return Err(invalid(
                    "task is claimed, finished or blocked by dependencies",
                ));
            }
            swarm.tasks.get_mut(task_id).expect("validated task").state =
                SwarmTaskState::Assigned {
                    worker_session_id: worker_session_id.clone(),
                    message_id: message_id.clone(),
                    delivered: false,
                };
        }
        SwarmTaskChange::Delivered {
            task_id,
            message_id,
        } => {
            let task = swarm
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| invalid("task not found"))?;
            match &mut task.state {
                SwarmTaskState::Assigned {
                    message_id: id,
                    delivered,
                    ..
                } if id == message_id && !*delivered => *delivered = true,
                _ => return Err(invalid("task delivery is stale or already recorded")),
            }
        }
        SwarmTaskChange::Settled {
            task_id,
            message_id,
            turn,
            outcome,
            summary,
        } => {
            text(summary, "task result", 8192)?;
            if *outcome == SwarmTaskOutcome::Completed && turn.is_none() {
                return Err(invalid("completed task requires a worker turn reference"));
            }
            let task = swarm
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| invalid("task not found"))?;
            let worker = match &task.state {
                SwarmTaskState::Assigned {
                    worker_session_id,
                    message_id: id,
                    ..
                } if id == message_id => worker_session_id.clone(),
                _ => return Err(invalid("task result does not match an active claim")),
            };
            task.state = SwarmTaskState::Settled {
                worker_session_id: worker,
                message_id: message_id.clone(),
                turn: *turn,
                outcome: *outcome,
                summary: summary.clone(),
            };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{validate_swarm_change, SwarmChange, SwarmMember, SwarmStatus};
    use std::collections::BTreeMap;
    pub(super) fn setup() -> BTreeMap<String, SwarmSnapshot> {
        let mut teams = BTreeMap::new();
        super::super::apply(
            &mut teams,
            &SwarmChange::Created {
                id: "s".into(),
                owner_session_id: "owner".into(),
                workspace: "/work".into(),
                objective: "research".into(),
            },
        )
        .unwrap();
        for worker in ["a", "b"] {
            let r = teams["s"].revision;
            super::super::apply(
                &mut teams,
                &SwarmChange::MemberAttached {
                    id: "s".into(),
                    expected_revision: r,
                    member: SwarmMember {
                        session_id: worker.into(),
                        assignment: "research".into(),
                    },
                },
            )
            .unwrap();
        }
        teams
    }
    pub(super) fn change(
        teams: &mut BTreeMap<String, SwarmSnapshot>,
        change: SwarmTaskChange,
    ) -> Result<(), ControlError> {
        super::super::apply(
            teams,
            &SwarmChange::TaskChanged {
                id: "s".into(),
                expected_revision: teams["s"].revision,
                change,
            },
        )
    }
    pub(super) fn add(id: &str, deps: Vec<String>) -> SwarmTaskChange {
        SwarmTaskChange::Added {
            task_id: id.into(),
            title: id.into(),
            instructions: "collect evidence".into(),
            dependencies: deps,
            eligible_worker_session_ids: Vec::new(),
        }
    }
    fn claim(task: &str, worker: &str, message: &str) -> SwarmTaskChange {
        SwarmTaskChange::Claimed {
            task_id: task.into(),
            worker_session_id: worker.into(),
            message_id: message.into(),
        }
    }
    #[test]
    fn swarm_tasks_claim_once_keep_history_and_unlock_only_successful_dependencies() {
        let mut teams = setup();
        change(&mut teams, add("research", vec![])).unwrap();
        change(&mut teams, add("report", vec!["research".into()])).unwrap();
        assert!(!teams["s"].tasks["report"].ready(&teams["s"]));
        assert!(change(&mut teams, claim("report", "b", "early")).is_err());
        change(&mut teams, claim("research", "a", "m1")).unwrap();
        assert!(change(&mut teams, claim("research", "b", "m2")).is_err());
        change(&mut teams, add("other", vec![])).unwrap();
        assert!(change(&mut teams, claim("other", "a", "m3")).is_err());
        change(
            &mut teams,
            SwarmTaskChange::Settled {
                task_id: "research".into(),
                message_id: "m1".into(),
                turn: Some(7),
                outcome: SwarmTaskOutcome::Completed,
                summary: "sources saved".into(),
            },
        )
        .unwrap();
        assert!(teams["s"].tasks["report"].ready(&teams["s"]));
        assert_eq!(
            teams["s"].tasks.len(),
            3,
            "finished tasks are retained, not deleted"
        );
        change(&mut teams, claim("report", "b", "m4")).unwrap();
        assert!(
            change(&mut teams, claim("other", "a", "m1")).is_err(),
            "delivery IDs cannot be reused"
        );
        let wire = serde_json::to_value(&teams["s"]).unwrap();
        assert_eq!(
            serde_json::from_value::<SwarmSnapshot>(wire).unwrap(),
            teams["s"]
        );
    }
    #[test]
    fn swarm_tasks_reject_cycles_duplicates_nonmembers_stale_delivery_and_failed_dependency() {
        let mut teams = setup();
        assert!(change(&mut teams, add("self", vec!["self".into()])).is_err());
        change(&mut teams, add("a", vec![])).unwrap();
        assert!(change(&mut teams, add("bad", vec!["a".into(), "a".into()])).is_err());
        assert!(change(&mut teams, claim("a", "outsider", "m")).is_err());
        change(&mut teams, claim("a", "a", "m")).unwrap();
        assert!(change(
            &mut teams,
            SwarmTaskChange::Delivered {
                task_id: "a".into(),
                message_id: "wrong".into()
            }
        )
        .is_err());
        change(
            &mut teams,
            SwarmTaskChange::Delivered {
                task_id: "a".into(),
                message_id: "m".into(),
            },
        )
        .unwrap();
        change(
            &mut teams,
            SwarmTaskChange::Settled {
                task_id: "a".into(),
                message_id: "m".into(),
                turn: Some(1),
                outcome: SwarmTaskOutcome::Failed,
                summary: "request failed".into(),
            },
        )
        .unwrap();
        change(&mut teams, add("b", vec!["a".into()])).unwrap();
        assert!(!teams["s"].tasks["b"].ready(&teams["s"]));
        let before = teams.clone();
        let stale = SwarmChange::TaskChanged {
            id: "s".into(),
            expected_revision: 1,
            change: add("new", vec![]),
        };
        assert!(validate_swarm_change(&teams, &stale).is_err());
        assert_eq!(teams, before);
    }
    #[test]
    fn swarm_tasks_pause_blocks_admission_but_retains_result_acceptance_and_old_snapshot_compatibility(
    ) {
        let mut teams = setup();
        change(&mut teams, add("a", vec![])).unwrap();
        change(&mut teams, claim("a", "a", "m")).unwrap();
        let r = teams["s"].revision;
        super::super::apply(
            &mut teams,
            &SwarmChange::StatusChanged {
                id: "s".into(),
                expected_revision: r,
                status: SwarmStatus::Paused,
            },
        )
        .unwrap();
        assert!(change(&mut teams, add("new", vec![])).is_err());
        change(
            &mut teams,
            SwarmTaskChange::Settled {
                task_id: "a".into(),
                message_id: "m".into(),
                turn: Some(1),
                outcome: SwarmTaskOutcome::Completed,
                summary: "completed before pause".into(),
            },
        )
        .unwrap();
        let mut old = serde_json::to_value(&teams["s"]).unwrap();
        old.as_object_mut().unwrap().remove("tasks");
        assert!(serde_json::from_value::<SwarmSnapshot>(old)
            .unwrap()
            .tasks
            .is_empty());
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::tests::{add, change, setup};
    use super::*;
    use crate::{SwarmChange, SwarmStatus};

    #[test]
    fn swarm_auto_dispatch_old_snapshots_and_tasks_default_to_manual_and_replay_is_strict() {
        let mut teams = setup();
        change(&mut teams, add("legacy", vec![])).unwrap();
        let mut old = serde_json::to_value(&teams["s"]).unwrap();
        old.as_object_mut().unwrap().remove("autoDispatch");
        old["tasks"]["legacy"]
            .as_object_mut()
            .unwrap()
            .remove("eligibleWorkerSessionIds");
        let legacy: SwarmSnapshot = serde_json::from_value(old).unwrap();
        assert!(!legacy.auto_dispatch);
        assert!(legacy.tasks["legacy"]
            .eligible_worker_session_ids
            .is_empty());
        let revision = teams["s"].revision;
        let enable = SwarmChange::DispatchChanged {
            id: "s".into(),
            expected_revision: revision,
            enabled: true,
        };
        super::super::apply(&mut teams, &enable).unwrap();
        assert!(teams["s"].auto_dispatch);
        assert!(super::super::apply(&mut teams, &enable).is_err());
        for ids in [vec!["outsider".into()], vec!["a".into(), "a".into()]] {
            let mut task = add("invalid", vec![]);
            if let SwarmTaskChange::Added {
                eligible_worker_session_ids,
                ..
            } = &mut task
            {
                *eligible_worker_session_ids = ids;
            }
            assert!(change(&mut teams, task).is_err());
        }
        let revision = teams["s"].revision;
        super::super::apply(
            &mut teams,
            &SwarmChange::StatusChanged {
                id: "s".into(),
                expected_revision: revision,
                status: SwarmStatus::Paused,
            },
        )
        .unwrap();
        let revision = teams["s"].revision;
        super::super::apply(
            &mut teams,
            &SwarmChange::DispatchChanged {
                id: "s".into(),
                expected_revision: revision,
                enabled: false,
            },
        )
        .unwrap();
        let revision = teams["s"].revision;
        assert!(super::super::apply(
            &mut teams,
            &SwarmChange::DispatchChanged {
                id: "s".into(),
                expected_revision: revision,
                enabled: true
            }
        )
        .is_err());
    }
}
