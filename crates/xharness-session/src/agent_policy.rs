//! Opt-in child execution constraints, reconstructed from the ownership scope.
//! No timer/task, tool execution or model-specific policy lives in this module.
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

use crate::{EventData, Session};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_AGENT_STEPS: u32 = 10_000;
pub const MAX_AGENT_TIMEOUT_SECONDS: u32 = 86_400;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentExecutionPolicy {
    pub admitted_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_unix_ms: Option<u64>,
    /// Missing inherits; an explicitly empty list grants no tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_allowlist: Option<Vec<String>>,
}

pub fn validate_agent_options(
    max_steps: Option<u32>,
    timeout_seconds: Option<u32>,
    tools: Option<&[String]>,
) -> Result<(), String> {
    if max_steps.is_some_and(|n| n == 0 || n > MAX_AGENT_STEPS) {
        return Err("max_steps must be between 1 and 10000".into());
    }
    if timeout_seconds.is_some_and(|n| n == 0 || n > MAX_AGENT_TIMEOUT_SECONDS) {
        return Err("timeout_seconds must be between 1 and 86400".into());
    }
    if let Some(tools) = tools {
        let mut seen = BTreeSet::new();
        if tools.len() > 128
            || tools.iter().any(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                    || !seen.insert(name)
            })
        {
            return Err("tool_allowlist must contain at most 128 unique valid tool names".into());
        }
    }
    Ok(())
}

impl AgentExecutionPolicy {
    pub fn admit(
        max_steps: Option<u32>,
        timeout_seconds: Option<u32>,
        tool_allowlist: Option<Vec<String>>,
        now_ms: u64,
    ) -> Result<Option<Self>, String> {
        validate_agent_options(max_steps, timeout_seconds, tool_allowlist.as_deref())?;
        if max_steps.is_none() && timeout_seconds.is_none() && tool_allowlist.is_none() {
            return Ok(None);
        }
        let deadline_unix_ms = timeout_seconds
            .map(|s| {
                now_ms
                    .checked_add(u64::from(s) * 1000)
                    .ok_or_else(|| "agent deadline overflow".to_owned())
            })
            .transpose()?;
        Ok(Some(Self {
            admitted_at_ms: now_ms,
            max_steps,
            timeout_seconds,
            deadline_unix_ms,
            tool_allowlist,
        }))
    }
    pub fn validate(&self) -> Result<(), String> {
        validate_agent_options(
            self.max_steps,
            self.timeout_seconds,
            self.tool_allowlist.as_deref(),
        )?;
        let expected = self
            .timeout_seconds
            .map(|s| {
                self.admitted_at_ms
                    .checked_add(u64::from(s) * 1000)
                    .ok_or_else(|| "agent deadline overflow".to_owned())
            })
            .transpose()?;
        if expected != self.deadline_unix_ms {
            return Err("agent deadline disagrees with its admitted timeout".into());
        }
        Ok(())
    }
    /// Refuse a backwards clock instead of granting a fresh timeout on restore.
    pub fn remaining_ms(&self, now_ms: u64) -> Result<Option<u64>, String> {
        self.validate()?;
        if self.deadline_unix_ms.is_some() && now_ms < self.admitted_at_ms {
            return Err(
                "agent timeout clock moved backwards; explicit human intervention required".into(),
            );
        }
        Ok(self
            .deadline_unix_ms
            .map(|deadline| deadline.saturating_sub(now_ms)))
    }
}

pub struct AgentPolicyState<'a> {
    pub policy: &'a AgentExecutionPolicy,
    pub parent_session_id: &'a str,
    pub steps_used: u32,
    pub open_turn_steps: u32,
}
impl AgentPolicyState<'_> {
    pub fn remaining_steps(&self) -> Option<u32> {
        self.policy
            .max_steps
            .map(|n| n.saturating_sub(self.steps_used))
    }
    /// A new ownership branch cannot refund steps or move the deadline forward.
    pub fn for_revert(&self) -> Result<AgentExecutionPolicy, String> {
        let mut policy = self.policy.clone();
        policy.max_steps = self.remaining_steps();
        if policy.max_steps == Some(0) {
            return Err("agent max_steps budget exhausted; revert cannot replenish it".into());
        }
        policy.validate()?;
        Ok(policy)
    }
}

pub fn agent_policy(session: &Session) -> Option<AgentPolicyState<'_>> {
    let (scope, parent_session_id, policy) =
        session
            .events()
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, event)| match event.data() {
                EventData::AgentDelegated {
                    parent_session_id,
                    policy,
                    ..
                } => Some(
                    policy
                        .as_ref()
                        .map(|policy| (index, parent_session_id.as_str(), policy)),
                ),
                EventData::SessionForkOrigin { .. } => Some(None),
                _ => None,
            })??;
    let events = &session.events()[scope..];
    let steps: BTreeSet<_> = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::StepStart { turn, step } => Some((*turn, *step)),
            _ => None,
        })
        .collect();
    let open_turn = events
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::TurnStart { turn } => Some(Some(*turn)),
            EventData::TurnEnd { .. } => Some(None),
            _ => None,
        })
        .flatten();
    let open_turn_steps = open_turn
        .and_then(|turn| {
            steps
                .iter()
                .filter(|(t, _)| *t == turn)
                .map(|(_, step)| *step)
                .max()
        })
        .unwrap_or(0);
    Some(AgentPolicyState {
        policy,
        parent_session_id,
        steps_used: u32::try_from(steps.len()).unwrap_or(u32::MAX),
        open_turn_steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionHeader, TurnEndReason};
    #[test]
    fn opt_in_empty_tools_and_deadline_are_not_defaults_or_reset_on_read() {
        assert!(AgentExecutionPolicy::admit(None, None, None, 100)
            .unwrap()
            .is_none());
        let p = AgentExecutionPolicy::admit(Some(2), Some(10), Some(vec![]), 100)
            .unwrap()
            .unwrap();
        assert_eq!(p.deadline_unix_ms, Some(10100));
        assert_eq!(p.remaining_ms(9100).unwrap(), Some(1000));
        assert_eq!(p.remaining_ms(11100).unwrap(), Some(0));
        assert!(p.remaining_ms(99).is_err());
        assert_eq!(p.tool_allowlist, Some(vec![]));
        let mut invalid = p.clone();
        invalid.deadline_unix_ms = Some(20100);
        assert!(invalid.validate().is_err());
        assert!(AgentExecutionPolicy::admit(None, Some(1), None, u64::MAX).is_err());
    }
    #[test]
    fn options_reject_zero_overflow_duplicates_and_wildcards() {
        for (steps, timeout) in [
            (Some(0), None),
            (Some(10001), None),
            (None, Some(0)),
            (None, Some(86401)),
        ] {
            assert!(validate_agent_options(steps, timeout, None).is_err());
        }
        for names in [vec!["read", "read"], vec!["*"], vec!["read "]] {
            assert!(validate_agent_options(
                None,
                None,
                Some(&names.into_iter().map(String::from).collect::<Vec<_>>())
            )
            .is_err());
        }
    }
    #[test]
    fn cumulative_steps_survive_restore_and_an_ordinary_fork_removes_ownership() {
        let policy = AgentExecutionPolicy::admit(Some(2), None, None, 100).unwrap();
        let mut s = Session::new(SessionHeader::new("child")).unwrap();
        s.append_batch(
            s.revision(),
            vec![
                EventData::AgentDelegated {
                    parent_session_id: "parent".into(),
                    invocation_id: "inv".into(),
                    task: "task".into(),
                    policy,
                }
                .into(),
                EventData::TurnStart { turn: 1 }.into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
                EventData::TurnStart { turn: 2 }.into(),
                EventData::StepStart { turn: 2, step: 1 }.into(),
            ],
        )
        .unwrap();
        let restored =
            Session::restore(s.header().clone(), s.revision(), s.events().to_vec()).unwrap();
        let state = agent_policy(&restored).unwrap();
        assert_eq!(state.steps_used, 2);
        assert_eq!(state.open_turn_steps, 1);
        assert_eq!(state.remaining_steps(), Some(0));
        assert!(state.for_revert().is_err());
        s.append_batch(
            s.revision(),
            vec![
                EventData::StepEnd { turn: 2, step: 1 }.into(),
                EventData::TurnEnd {
                    turn: 2,
                    reason: TurnEndReason::Completed,
                }
                .into(),
                EventData::SessionForkOrigin {
                    parent_session_id: "child".into(),
                    before_user_seq: None,
                }
                .into(),
            ],
        )
        .unwrap();
        assert!(agent_policy(&s).is_none());
    }
}
