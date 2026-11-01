//! Incremental team metadata. Agent execution and conversations remain session-owned.
#![forbid(unsafe_code)]

mod tasks;
pub use tasks::*;

use crate::{invalid, ControlError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwarmStatus {
    Active,
    Paused,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwarmMember {
    pub session_id: String,
    /// Original delegated assignment, not a second runnable queue.
    pub assignment: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwarmSnapshot {
    pub id: String,
    pub owner_session_id: String,
    /// Canonical owner cwd captured at creation; never a new execution directory.
    pub workspace: String,
    pub objective: String,
    pub status: SwarmStatus,
    pub revision: u64,
    /// Human opt-in; old teams never acquire automatic dispatch on upgrade.
    #[serde(default)]
    pub auto_dispatch: bool,
    pub members: BTreeMap<String, SwarmMember>,
    #[serde(default)]
    pub tasks: BTreeMap<String, SwarmTask>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SwarmChange {
    Created {
        id: String,
        owner_session_id: String,
        workspace: String,
        objective: String,
    },
    StatusChanged {
        id: String,
        expected_revision: u64,
        status: SwarmStatus,
    },
    DispatchChanged {
        id: String,
        expected_revision: u64,
        enabled: bool,
    },
    TaskChanged {
        id: String,
        expected_revision: u64,
        change: SwarmTaskChange,
    },
    MemberAttached {
        id: String,
        expected_revision: u64,
        member: SwarmMember,
    },
}

fn text(value: &str, field: &str, max: usize) -> Result<(), ControlError> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(invalid(format!(
            "Swarm {field} must be nonblank, NUL-free and at most {max} UTF-8 bytes"
        )));
    }
    Ok(())
}

pub(crate) fn apply(
    swarms: &mut BTreeMap<String, SwarmSnapshot>,
    change: &SwarmChange,
) -> Result<(), ControlError> {
    match change {
        SwarmChange::Created {
            id,
            owner_session_id,
            workspace,
            objective,
        } => {
            text(id, "id", 256)?;
            text(owner_session_id, "owner", 256)?;
            text(workspace, "workspace", 32768)?;
            text(objective, "objective", 32768)?;
            if swarms.contains_key(id) {
                return Err(invalid("Swarm identity already exists"));
            }
            swarms.insert(
                id.clone(),
                SwarmSnapshot {
                    id: id.clone(),
                    owner_session_id: owner_session_id.clone(),
                    workspace: workspace.clone(),
                    objective: objective.clone(),
                    status: SwarmStatus::Active,
                    revision: 1,
                    auto_dispatch: false,
                    members: BTreeMap::new(),
                    tasks: BTreeMap::new(),
                },
            );
        }
        SwarmChange::StatusChanged {
            id,
            expected_revision,
            status,
        } => {
            let current = current(swarms, id, *expected_revision)?;
            if current.status == *status {
                return Err(invalid("Swarm status is unchanged"));
            }
            current.status = *status;
            current.revision += 1;
        }
        SwarmChange::DispatchChanged {
            id,
            expected_revision,
            enabled,
        } => {
            let current = current(swarms, id, *expected_revision)?;
            if current.auto_dispatch == *enabled {
                return Err(invalid("Swarm dispatch setting is unchanged"));
            }
            if *enabled && current.status != SwarmStatus::Active {
                return Err(invalid("Swarm must be active to enable dispatch"));
            }
            current.auto_dispatch = *enabled;
            current.revision += 1;
        }
        SwarmChange::TaskChanged {
            id,
            expected_revision,
            change,
        } => {
            let current = current(swarms, id, *expected_revision)?;
            if current.status != SwarmStatus::Active
                && !matches!(change, SwarmTaskChange::Settled { .. })
            {
                return Err(invalid("Swarm must be active to change tasks"));
            }
            tasks::apply(current, change)?;
            current.revision += 1;
        }
        SwarmChange::MemberAttached {
            id,
            expected_revision,
            member,
        } => {
            text(&member.session_id, "member id", 256)?;
            text(&member.assignment, "assignment", 32768)?;
            if swarms
                .values()
                .any(|s| s.members.contains_key(&member.session_id))
            {
                return Err(invalid("agent already belongs to a Swarm"));
            }
            let current = current(swarms, id, *expected_revision)?;
            if current.status != SwarmStatus::Active {
                return Err(invalid("Swarm must be active to attach a member"));
            }
            if member.session_id == current.owner_session_id {
                return Err(invalid("Swarm owner cannot be its own worker"));
            }
            current
                .members
                .insert(member.session_id.clone(), member.clone());
            current.revision += 1;
        }
    }
    Ok(())
}

fn current<'a>(
    swarms: &'a mut BTreeMap<String, SwarmSnapshot>,
    id: &str,
    revision: u64,
) -> Result<&'a mut SwarmSnapshot, ControlError> {
    let current = swarms
        .get_mut(id)
        .ok_or_else(|| invalid("Swarm not found"))?;
    if current.revision != revision || revision == u64::MAX {
        return Err(invalid("Swarm revision conflict"));
    }
    if current.status == SwarmStatus::Closed {
        return Err(invalid("closed Swarm is immutable"));
    }
    Ok(current)
}

/// Validate a proposed event with exactly the same rules used during log replay.
pub fn validate_swarm_change(
    swarms: &BTreeMap<String, SwarmSnapshot>,
    change: &SwarmChange,
) -> Result<(), ControlError> {
    let mut candidate = swarms.clone();
    apply(&mut candidate, change)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create(id: &str) -> SwarmChange {
        SwarmChange::Created {
            id: id.into(),
            owner_session_id: "owner".into(),
            workspace: "/work".into(),
            objective: "Maintain the project".into(),
        }
    }
    #[test]
    fn lifecycle_membership_and_revision_are_validated_on_replay() {
        let mut state = BTreeMap::new();
        apply(&mut state, &create("team")).unwrap();
        assert!(apply(&mut state, &create("team")).is_err());
        let attach = SwarmChange::MemberAttached {
            id: "team".into(),
            expected_revision: 1,
            member: SwarmMember {
                session_id: "child".into(),
                assignment: "Review".into(),
            },
        };
        apply(&mut state, &attach).unwrap();
        assert!(apply(&mut state, &attach).is_err());
        assert!(apply(
            &mut state,
            &SwarmChange::StatusChanged {
                id: "team".into(),
                expected_revision: 1,
                status: SwarmStatus::Paused
            }
        )
        .is_err());
        for (revision, status) in [
            (2, SwarmStatus::Paused),
            (3, SwarmStatus::Active),
            (4, SwarmStatus::Closed),
        ] {
            apply(
                &mut state,
                &SwarmChange::StatusChanged {
                    id: "team".into(),
                    expected_revision: revision,
                    status,
                },
            )
            .unwrap();
        }
        assert!(apply(
            &mut state,
            &SwarmChange::StatusChanged {
                id: "team".into(),
                expected_revision: 5,
                status: SwarmStatus::Active
            }
        )
        .is_err());
        assert_eq!(state["team"].members["child"].assignment, "Review");
    }
    #[test]
    fn malformed_and_cross_team_membership_fail_closed() {
        let mut state = BTreeMap::new();
        let mut malformed = create("a");
        if let SwarmChange::Created { objective, .. } = &mut malformed {
            *objective = " ".into();
        }
        assert!(apply(&mut state, &malformed).is_err());
        apply(&mut state, &create("a")).unwrap();
        apply(&mut state, &create("b")).unwrap();
        let member = SwarmMember {
            session_id: "child".into(),
            assignment: "work".into(),
        };
        apply(
            &mut state,
            &SwarmChange::MemberAttached {
                id: "a".into(),
                expected_revision: 1,
                member: member.clone(),
            },
        )
        .unwrap();
        assert!(apply(
            &mut state,
            &SwarmChange::MemberAttached {
                id: "b".into(),
                expected_revision: 1,
                member
            }
        )
        .is_err());
        assert!(apply(
            &mut state,
            &SwarmChange::MemberAttached {
                id: "b".into(),
                expected_revision: 1,
                member: SwarmMember {
                    session_id: "owner".into(),
                    assignment: "work".into()
                }
            }
        )
        .is_err());
    }
}
