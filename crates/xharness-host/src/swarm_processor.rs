//! Pure Swarm control-plane decisions; no actors, model calls or dispatch policy.
#![forbid(unsafe_code)]
use std::collections::BTreeMap;
use xharness_control::{
    validate_swarm_change, SwarmChange, SwarmMember, SwarmSnapshot, SwarmStatus,
};

pub(crate) struct SwarmProcessor;
impl SwarmProcessor {
    pub(crate) fn create(
        id: String,
        owner: String,
        workspace: String,
        objective: String,
    ) -> SwarmChange {
        SwarmChange::Created {
            id,
            owner_session_id: owner,
            workspace,
            objective,
        }
    }
    pub(crate) fn transition(
        id: String,
        expected_revision: u64,
        status: SwarmStatus,
    ) -> SwarmChange {
        SwarmChange::StatusChanged {
            id,
            expected_revision,
            status,
        }
    }
    pub(crate) fn dispatch(id: String, expected_revision: u64, enabled: bool) -> SwarmChange {
        SwarmChange::DispatchChanged {
            id,
            expected_revision,
            enabled,
        }
    }
    pub(crate) fn attach(
        id: String,
        expected_revision: u64,
        session_id: String,
        assignment: String,
    ) -> SwarmChange {
        SwarmChange::MemberAttached {
            id,
            expected_revision,
            member: SwarmMember {
                session_id,
                assignment,
            },
        }
    }
    pub(crate) fn task(
        id: String,
        expected_revision: u64,
        change: xharness_control::SwarmTaskChange,
    ) -> SwarmChange {
        SwarmChange::TaskChanged {
            id,
            expected_revision,
            change,
        }
    }
    pub(crate) fn validate(
        swarms: &BTreeMap<String, SwarmSnapshot>,
        change: &SwarmChange,
    ) -> Result<(), String> {
        validate_swarm_change(swarms, change).map_err(|e| e.to_string())
    }
    pub(crate) fn owned<'a>(
        swarms: &'a BTreeMap<String, SwarmSnapshot>,
        id: &str,
        owner: &str,
    ) -> Result<&'a SwarmSnapshot, String> {
        swarms
            .get(id)
            .filter(|s| s.owner_session_id == owner)
            .ok_or_else(|| "Swarm not found for this owner".into())
    }
}
