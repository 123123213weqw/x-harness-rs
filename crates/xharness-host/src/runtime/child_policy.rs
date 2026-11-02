//! Admission and runtime application of durable, opt-in child limits.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]
use super::*;
use std::collections::BTreeSet;

pub(super) async fn tool_names(
    factory: &dyn SessionToolFactory,
    id: &str,
    cwd: &str,
    permission: PermissionPreset,
) -> Result<Vec<String>, String> {
    let executor = factory.executor(id, cwd, permission).await?;
    // Deployment validation is never weakened by child-specific restrictions.
    // Host-owned tools are added by build_request; only history is unconditional.
    let mut names: BTreeSet<_> = executor
        .registry()
        .definitions()
        .await
        .into_iter()
        .map(|d| d.name)
        .collect();
    if factory.allows_host_tool("history") {
        names.insert("history".into());
    }
    Ok(names.into_iter().collect())
}

pub(super) fn admission_wait(session: Option<&Session>) -> Result<Option<Duration>, String> {
    let Some(state) = session.and_then(xharness_session::agent_policy) else {
        return Ok(None);
    };
    if state.remaining_steps() == Some(0) {
        return Err("agent max_steps budget exhausted; create a new child for a new task".into());
    }
    let remaining = state.policy.remaining_ms(crate::state::now_ms())?;
    if remaining == Some(0) {
        return Err("agent timeout_seconds budget exceeded before execution".into());
    }
    Ok(remaining.map(Duration::from_millis))
}

pub(super) fn preparation_wait(session: Option<&Session>) -> Result<Option<Duration>, String> {
    let Some(state) = session.and_then(xharness_session::agent_policy) else {
        return Ok(None);
    };
    // Recovery may need to close an existing approval at the exhausted boundary.
    // Preparation runs no tools/models and gets a bounded cleanup grace only.
    if state.open_turn_steps > 0 {
        return Ok(state
            .policy
            .remaining_ms(crate::state::now_ms())?
            .map(|ms| Duration::from_millis(ms.max(5_000))));
    }
    admission_wait(session)
}

pub(super) fn apply_request_policy(
    request: &mut LoopRequest,
    session: Option<&Session>,
) -> Result<(), String> {
    let Some(state) = session.and_then(xharness_session::agent_policy) else {
        return Ok(());
    };
    state.policy.remaining_ms(crate::state::now_ms())?;
    request.execution_deadline_ms = state.policy.deadline_unix_ms;
    if let Some(remaining) = state.remaining_steps() {
        let cap = remaining.saturating_add(state.open_turn_steps);
        if cap == 0 {
            return Err("agent max_steps budget exhausted before execution".into());
        }
        request.config.max_steps =
            usize::try_from(cap).map_err(|_| "agent step limit overflow".to_owned())?;
    }
    Ok(())
}

impl DurableTurnFactory {
    pub(super) async fn parent_tools(&self, parent_id: &str) -> Result<BTreeSet<String>, String> {
        let (cwd, permission) =
            if let Some(host) = self.goals.host.get().and_then(std::sync::Weak::upgrade) {
                let state = host.state.read().await;
                let parent = state
                    .sessions
                    .get(parent_id)
                    .ok_or("parent no longer exists")?;
                (parent.cwd.clone(), parent.execution_permission())
            } else {
                let sessions = self.sessions.read().await;
                let parent = sessions
                    .get(parent_id)
                    .ok_or("parent capability configuration is unavailable")?;
                (parent.cwd.clone(), parent.permission)
            };
        Ok(
            tool_names(self.tool_factory.as_ref(), parent_id, &cwd, permission)
                .await?
                .into_iter()
                .collect(),
        )
    }
}
