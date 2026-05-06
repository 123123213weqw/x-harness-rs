//! Pure goal mutation policy.
//!
//! Session journals, receipts, pending-input invalidation and runtime wakeups
//! are adapter concerns. This module owns only validated state transitions.

use xharness_session::{GoalPhase, GoalSnapshotOperation};

use crate::GoalState;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GoalReference {
    pub(crate) id: String,
    pub(crate) revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GoalTransition {
    Pause,
    Resume,
    Complete,
}

impl GoalTransition {
    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            Self::Pause => "paused",
            Self::Resume => "active",
            Self::Complete => "complete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GoalDecisionError {
    SessionMissing,
    ExistingNonComplete,
    GoalMissing,
    StaleReference,
    EmptyObjective,
    InvalidRoundBudget,
    EmptyEdit,
    InvalidTransition {
        transition: GoalTransition,
        phase: GoalPhase,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct GoalMutation {
    pub(crate) goal: GoalState,
    pub(crate) operation: GoalSnapshotOperation,
}

pub(crate) struct GoalProcessor;

impl GoalProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create(
        session_exists: bool,
        existing: Option<&GoalState>,
        id: String,
        objective: String,
        max_goal_rounds: u64,
        now: u64,
    ) -> Result<GoalMutation, GoalDecisionError> {
        if !session_exists {
            return Err(GoalDecisionError::SessionMissing);
        }
        if existing.is_some_and(|goal| goal.phase != GoalPhase::Complete) {
            return Err(GoalDecisionError::ExistingNonComplete);
        }
        let objective = validated_objective(objective)?;
        validated_rounds(max_goal_rounds)?;
        Ok(GoalMutation {
            goal: GoalState {
                execution: None,
                id,
                revision: 1,
                objective,
                max_goal_rounds,
                phase: GoalPhase::Active,
                blocked_reason: None,
                rounds_started: 0,
                created_at: now,
                updated_at: now,
            },
            operation: GoalSnapshotOperation::Create,
        })
    }

    pub(crate) fn edit(
        current: Option<&GoalState>,
        expected: &GoalReference,
        objective: Option<String>,
        max_goal_rounds: Option<u64>,
        now: u64,
    ) -> Result<GoalMutation, GoalDecisionError> {
        if objective.is_none() && max_goal_rounds.is_none() {
            return Err(GoalDecisionError::EmptyEdit);
        }
        let mut goal = current.cloned().ok_or(GoalDecisionError::GoalMissing)?;
        require_reference(&goal, expected)?;
        if let Some(objective) = objective {
            goal.objective = validated_objective(objective)?;
        }
        if let Some(rounds) = max_goal_rounds {
            validated_rounds(rounds)?;
            goal.max_goal_rounds = rounds;
        }
        advance(&mut goal, now);
        Ok(GoalMutation {
            goal,
            operation: GoalSnapshotOperation::Edit,
        })
    }

    pub(crate) fn transition(
        current: Option<&GoalState>,
        expected: &GoalReference,
        transition: GoalTransition,
        now: u64,
    ) -> Result<GoalMutation, GoalDecisionError> {
        let mut goal = current.cloned().ok_or(GoalDecisionError::GoalMissing)?;
        require_reference(&goal, expected)?;
        let (operation, phase, valid) = match transition {
            GoalTransition::Pause => (
                GoalSnapshotOperation::Pause,
                GoalPhase::Paused,
                goal.phase == GoalPhase::Active,
            ),
            GoalTransition::Resume => (
                GoalSnapshotOperation::Resume,
                GoalPhase::Active,
                matches!(
                    goal.phase,
                    GoalPhase::Active | GoalPhase::Paused | GoalPhase::Blocked
                ) && goal.rounds_started < goal.max_goal_rounds,
            ),
            GoalTransition::Complete => (
                GoalSnapshotOperation::Complete,
                GoalPhase::Complete,
                goal.phase != GoalPhase::Complete,
            ),
        };
        if !valid {
            return Err(GoalDecisionError::InvalidTransition {
                transition,
                phase: goal.phase,
            });
        }
        goal.phase = phase;
        goal.blocked_reason = None;
        advance(&mut goal, now);
        Ok(GoalMutation { goal, operation })
    }

    pub(crate) fn clear(
        current: Option<&GoalState>,
        expected: &GoalReference,
    ) -> Result<GoalReference, GoalDecisionError> {
        let goal = current.ok_or(GoalDecisionError::GoalMissing)?;
        require_reference(goal, expected)?;
        Ok(GoalReference {
            id: goal.id.clone(),
            revision: goal.revision.saturating_add(1),
        })
    }
}

fn validated_objective(objective: String) -> Result<String, GoalDecisionError> {
    if objective.trim().is_empty() {
        Err(GoalDecisionError::EmptyObjective)
    } else {
        Ok(objective)
    }
}

fn validated_rounds(rounds: u64) -> Result<(), GoalDecisionError> {
    if rounds == 0 {
        Err(GoalDecisionError::InvalidRoundBudget)
    } else {
        Ok(())
    }
}

fn require_reference(goal: &GoalState, expected: &GoalReference) -> Result<(), GoalDecisionError> {
    if goal.id == expected.id && goal.revision == expected.revision {
        Ok(())
    } else {
        Err(GoalDecisionError::StaleReference)
    }
}

fn advance(goal: &mut GoalState, now: u64) {
    goal.revision = goal.revision.saturating_add(1);
    goal.updated_at = now.max(goal.updated_at);
}

#[cfg(test)]
mod tests {
    use xharness_session::GoalBlockReason;

    use super::*;

    fn goal(phase: GoalPhase) -> GoalState {
        GoalState {
            execution: None,
            id: "g".to_owned(),
            revision: 7,
            objective: "ship".to_owned(),
            phase,
            blocked_reason: Some(GoalBlockReason {
                code: "wait".to_owned(),
                message: "waiting".to_owned(),
            }),
            max_goal_rounds: 9,
            rounds_started: 3,
            created_at: 10,
            updated_at: 20,
        }
    }

    fn reference() -> GoalReference {
        GoalReference {
            id: "g".to_owned(),
            revision: 7,
        }
    }

    #[test]
    fn create_validates_session_existing_goal_objective_and_budget() {
        assert_eq!(
            GoalProcessor::create(false, None, "g".into(), "x".into(), 1, 10).unwrap_err(),
            GoalDecisionError::SessionMissing
        );
        assert_eq!(
            GoalProcessor::create(
                true,
                Some(&goal(GoalPhase::Active)),
                "g".into(),
                "x".into(),
                1,
                10
            )
            .unwrap_err(),
            GoalDecisionError::ExistingNonComplete
        );
        assert_eq!(
            GoalProcessor::create(true, None, "g".into(), " ".into(), 1, 10).unwrap_err(),
            GoalDecisionError::EmptyObjective
        );
        assert_eq!(
            GoalProcessor::create(true, None, "g".into(), "x".into(), 0, 10).unwrap_err(),
            GoalDecisionError::InvalidRoundBudget
        );
    }

    #[test]
    fn edit_is_revision_fenced_and_monotonic() {
        let mutation = GoalProcessor::edit(
            Some(&goal(GoalPhase::Active)),
            &reference(),
            Some("new".to_owned()),
            Some(12),
            19,
        )
        .unwrap();
        assert_eq!(mutation.goal.revision, 8);
        assert_eq!(mutation.goal.updated_at, 20);
        assert_eq!(mutation.goal.objective, "new");
        assert_eq!(mutation.goal.max_goal_rounds, 12);
        let mut stale = reference();
        stale.revision = 6;
        assert_eq!(
            GoalProcessor::edit(Some(&goal(GoalPhase::Active)), &stale, None, Some(2), 30)
                .unwrap_err(),
            GoalDecisionError::StaleReference
        );
    }

    #[test]
    fn transition_matrix_preserves_budget_and_clears_block_reason() {
        let paused = GoalProcessor::transition(
            Some(&goal(GoalPhase::Active)),
            &reference(),
            GoalTransition::Pause,
            30,
        )
        .unwrap();
        assert_eq!(paused.goal.phase, GoalPhase::Paused);
        assert!(paused.goal.blocked_reason.is_none());

        let complete = goal(GoalPhase::Complete);
        assert!(matches!(
            GoalProcessor::transition(Some(&complete), &reference(), GoalTransition::Complete, 30),
            Err(GoalDecisionError::InvalidTransition { .. })
        ));

        let mut exhausted = goal(GoalPhase::Paused);
        exhausted.rounds_started = exhausted.max_goal_rounds;
        assert!(matches!(
            GoalProcessor::transition(Some(&exhausted), &reference(), GoalTransition::Resume, 30),
            Err(GoalDecisionError::InvalidTransition { .. })
        ));
    }

    #[test]
    fn clear_returns_only_the_next_fenced_reference() {
        let cleared = GoalProcessor::clear(Some(&goal(GoalPhase::Paused)), &reference()).unwrap();
        assert_eq!(cleared.id, "g");
        assert_eq!(cleared.revision, 8);
    }
}
