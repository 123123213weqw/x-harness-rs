//! One admission decision shared by live wake, turn handoff and recovery.
//! This is a projection of existing facts, not another persisted state machine.
#![forbid(unsafe_code)]

use xharness_session::{GoalPhase, InboxMessage, Session};

use crate::InboxProjection;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchDecision {
    Ready,
    Idle,
    Paused,
}

impl DispatchDecision {
    pub const fn can_run(self) -> bool {
        matches!(self, Self::Ready)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DispatchState {
    pub paused: bool,
    pub goal_active: bool,
    pub maintenance_pending: bool,
}

impl DispatchState {
    pub fn from_session(session: &Session) -> Self {
        Self {
            paused: session.dispatch_paused(),
            goal_active: xharness_session::goal::execution_state(session).is_some_and(|state| {
                state.definition.execution_enabled
                    && state.definition.snapshot.phase == GoalPhase::Active
            }),
            maintenance_pending: false,
        }
    }

    /// A passive next-step context alone never starts a turn. User-authored
    /// next-step input is runnable just like a queued user prompt. Explicit
    /// maintenance can run behind a closed gate without reopening that gate.
    pub fn decide(self, inbox: &InboxProjection) -> DispatchDecision {
        self.decide_inputs(!inbox.next_turn().is_empty(), inbox.has_user_input())
    }

    fn decide_inputs(self, pending_turn: bool, pending_user: bool) -> DispatchDecision {
        if self.maintenance_pending {
            DispatchDecision::Ready
        } else if self.paused {
            if pending_user {
                DispatchDecision::Ready
            } else {
                DispatchDecision::Paused
            }
        } else if pending_turn || pending_user || self.goal_active {
            DispatchDecision::Ready
        } else {
            DispatchDecision::Idle
        }
    }
}

impl InboxProjection {
    pub fn has_user_input(&self) -> bool {
        self.next_turn()
            .iter()
            .chain(self.next_step())
            .any(InboxMessage::is_user_authored)
    }

    /// Ordinary input observers must cover user steering too, but never
    /// convert passive next-step context into an independently runnable turn.
    pub fn dispatch_inputs(&self) -> impl Iterator<Item = &InboxMessage> {
        self.next_step()
            .iter()
            .filter(|input| input.is_user_authored())
            .chain(
                self.next_turn()
                    .iter()
                    .filter(|input| !crate::is_goal_message(input)),
            )
    }

    /// Recovery may observe the crash window between durable user/message and
    /// the later inbox cleanup. Match the actor's reconcile_consumed rule so
    /// those identities neither acquire another observer nor fail count checks.
    pub fn recovery_inputs<'a>(
        &'a self,
        session: &'a Session,
    ) -> impl Iterator<Item = &'a InboxMessage> {
        let consumed = session
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                xharness_session::EventData::UserMessage { message, .. } => message.id.as_deref(),
                _ => None,
            })
            .collect::<std::collections::HashSet<_>>();
        self.dispatch_inputs()
            .filter(move |input| !consumed.contains(input.id.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhausts_all_32_reduced_dispatch_combinations() {
        for bits in 0..32 {
            let paused = bits & 1 != 0;
            let goal_active = bits & 2 != 0;
            let maintenance_pending = bits & 4 != 0;
            let pending_turn = bits & 8 != 0;
            let pending_user = bits & 16 != 0;
            let state = DispatchState {
                paused,
                goal_active,
                maintenance_pending,
            };
            let decision = state.decide_inputs(pending_turn, pending_user);
            assert_eq!(
                decision.can_run(),
                maintenance_pending || pending_user || (!paused && (pending_turn || goal_active)),
                "combination {bits:05b}"
            );
            assert_eq!(
                decision == DispatchDecision::Paused,
                paused && !maintenance_pending && !pending_user,
                "combination {bits:05b}"
            );
        }
    }
}
