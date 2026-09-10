use crate::{goal::*, EventData, GoalChange, GoalSnapshotChange, LoggedEvent, TurnEndReason};

/// Validate each controller transition and its atomic queue/lifecycle companions.
pub(crate) fn validate(events: &[LoggedEvent]) -> Result<(), String> {
    let mut current_goal: Option<GoalSnapshotChange> = None;
    let mut previous: Option<GoalExecutionState> = None;
    let mut next_turn = Vec::<crate::InboxMessage>::new();
    let mut next_step = Vec::<crate::InboxMessage>::new();
    let mut deleted = Vec::<String>::new();
    let mut revision = crate::Revision::ZERO;
    for e in events {
        if revision != e.revision {
            revision = e.revision;
            deleted.clear();
        }
        match e.data() {
            EventData::AgentInboxSpliced {
                target,
                start,
                removed_count,
                inserted,
                ..
            } => {
                let list = match target {
                    crate::InboxTarget::NextTurn => &mut next_turn,
                    crate::InboxTarget::NextStep => &mut next_step,
                };
                let end = start
                    .checked_add(*removed_count)
                    .ok_or("goal inbox range overflow")?;
                if *start > list.len() || end > list.len() {
                    return Err("goal inbox range invalid".into());
                }
                deleted.extend(list.splice(*start..end, inserted.clone()).map(|m| m.id));
            }
            EventData::GoalChange {
                change: GoalChange::Clear(_),
            } => {
                current_goal = None;
                previous = None;
            }
            EventData::GoalChange {
                change: GoalChange::Snapshot(c),
            } => {
                if current_goal
                    .as_ref()
                    .is_some_and(|g| g.goal.id != c.goal.id)
                {
                    previous = None;
                }
                if c.version == 1 {
                    if let Some(s) = previous.as_mut() {
                        s.definition.execution_enabled = false;
                    }
                } else if !events.iter().any(|x| {
                    x.revision == e.revision && matches!(x.data(), EventData::GoalExecution { .. })
                }) {
                    return Err("v2 goal snapshot requires an atomic execution transition".into());
                }
                current_goal = Some(c.clone());
            }
            EventData::GoalExecution { change } => {
                let fail = || "invalid goal/execution transition or atomic companions".to_owned();
                let g = current_goal.as_ref().ok_or_else(fail)?;
                let s = &change.state;
                s.definition.validate().map_err(|e| e.to_string())?;
                if change.version != 2
                    || s.definition.snapshot != g.goal
                    || s.rounds_started != g.rounds_started
                    || s.activation_epoch == 0
                    || s.empty_report_limit == 0
                {
                    return Err(fail());
                }
                let batch: Vec<_> = events.iter().filter(|x| x.revision == e.revision).collect();
                if batch
                    .iter()
                    .filter(|x| matches!(x.data(), EventData::GoalExecution { .. }))
                    .count()
                    != 1
                {
                    return Err(fail());
                }
                let mut expected = if let Some(old) = &previous {
                    old.clone()
                } else {
                    s.clone()
                };
                expected.definition.snapshot = g.goal.clone();
                match change.operation {
                    GoalExecutionOperation::Enable => {
                        if s.definition.snapshot.phase != GoalPhase::Active
                            || !s.definition.execution_enabled
                            || s.running.is_some()
                            || s.pending.is_some()
                            || s.latest_turn.is_some()
                            || s.review.is_some()
                            || s.pause_reason.is_some()
                            || s.empty_report_rounds != 0
                            || s.activation_epoch
                                != previous
                                    .as_ref()
                                    .map_or(1, |p| p.activation_epoch.saturating_add(1))
                            || previous
                                .as_ref()
                                .is_some_and(|p| p.running.is_some() || p.pending.is_some())
                            || s.definition.definition_revision != g.goal.revision
                            || s.admitted
                                != previous
                                    .as_ref()
                                    .map_or_else(Default::default, |p| p.admitted.clone())
                        {
                            return Err(fail());
                        }
                        expected = s.clone();
                    }
                    GoalExecutionOperation::Enqueue => {
                        let old = previous.as_ref().ok_or_else(fail)?;
                        let p = s.pending.as_ref().ok_or_else(fail)?;
                        if !old.definition.execution_enabled
                            || g.goal.phase != GoalPhase::Active
                            || old.pending.is_some()
                            || old.running.is_some()
                            || old.admitted.contains(&p.key)
                            || old.rounds_started >= g.goal.max_goal_rounds
                            || p.message_id.is_empty()
                            || p.key.goal_id != g.goal.id
                            || p.key.definition_revision != old.definition.definition_revision
                            || p.key.activation_epoch != old.activation_epoch
                        {
                            return Err(fail());
                        }
                        if !batch.iter().any(|x| matches!(x.data(), EventData::AgentInboxSpliced { target: crate::InboxTarget::NextTurn, inserted, removed_count: 0, .. } if inserted.len() == 1 && inserted[0].id == p.message_id)) { return Err(fail()); }
                        if next_turn.len() != 1
                            || next_turn[0].id != p.message_id
                            || !next_step.is_empty()
                        {
                            return Err(fail());
                        }
                        expected.pending = Some(p.clone());
                        expected.admitted.insert(p.key.clone());
                    }
                    GoalExecutionOperation::Claim => {
                        let old = previous.as_ref().ok_or_else(fail)?;
                        let r = s.running.as_ref().ok_or_else(fail)?;
                        if !old.definition.execution_enabled
                            || g.goal.phase != GoalPhase::Active
                            || old.pending.as_ref() != Some(&r.intent)
                            || old.running.is_some()
                            || old.rounds_started >= g.goal.max_goal_rounds
                            || r.turn == 0
                        {
                            return Err(fail());
                        }
                        if !batch.iter().any(|x| matches!(x.data(), EventData::TurnStart { turn } if *turn == r.turn)) || !batch.iter().any(|x| matches!(x.data(), EventData::UserMessage { message, .. } if message.id.as_ref() == Some(&r.intent.message_id))) || !batch.iter().any(|x| matches!(x.data(), EventData::AgentInboxSpliced { target: crate::InboxTarget::NextTurn, removed_count: 1, inserted, .. } if inserted.is_empty())) { return Err(fail()); }
                        if g.goal.revision != old.definition.snapshot.revision.saturating_add(1) {
                            return Err(fail());
                        }
                        if deleted != [r.intent.message_id.clone()]
                            || !next_turn.is_empty()
                            || !next_step.is_empty()
                            || g.goal.objective != old.definition.snapshot.objective
                            || g.goal.max_goal_rounds != old.definition.snapshot.max_goal_rounds
                        {
                            return Err(fail());
                        }
                        expected.pending = None;
                        expected.running = Some(r.clone());
                        expected.rounds_started =
                            old.rounds_started.checked_add(1).ok_or_else(fail)?;
                    }
                    GoalExecutionOperation::Settle => {
                        let old = previous.as_ref().ok_or_else(fail)?;
                        let running = old.running.as_ref().ok_or_else(fail)?;
                        let t = s.latest_turn.as_ref().ok_or_else(fail)?;
                        if t.turn != running.turn
                            || t.goal_id != running.intent.key.goal_id
                            || t.definition_revision != running.intent.key.definition_revision
                            || t.activation_epoch != running.intent.key.activation_epoch
                        {
                            return Err(fail());
                        }
                        let end =
                            events.iter().rev().filter(|x| x.seq < e.seq).find_map(|x| {
                                match x.data() {
                                    EventData::TurnEnd { turn, reason } if *turn == t.turn => {
                                        Some(reason)
                                    }
                                    _ => None,
                                }
                            });
                        let outcome = end
                            .map(|end| match end {
                                TurnEndReason::Completed => GoalTurnOutcome::Completed,
                                TurnEndReason::Cancelled => GoalTurnOutcome::Cancelled,
                                TurnEndReason::Failed { .. } => GoalTurnOutcome::Failed,
                                TurnEndReason::LimitReached => GoalTurnOutcome::StepLimit,
                                TurnEndReason::MaxTokens => GoalTurnOutcome::OutputLimit,
                                TurnEndReason::Interrupted => GoalTurnOutcome::OutcomeUnknown,
                            })
                            .ok_or_else(fail)?;
                        if outcome != t.outcome {
                            return Err(fail());
                        }
                        if let Some(r) = &t.report {
                            r.validate().map_err(|e| e.to_string())?;
                            if r.goal_id != t.goal_id
                                || r.definition_revision != t.definition_revision
                                || r.turn != t.turn
                            {
                                return Err(fail());
                            }
                        }
                        let tools = events.iter().any(|x| matches!(x.data(), EventData::ToolResult { turn, .. } if *turn == t.turn));
                        expected.running = None;
                        expected.latest_turn = Some(t.clone());
                        expected.review = None;
                        expected.empty_report_rounds = if t.report.is_some() || tools {
                            0
                        } else {
                            old.empty_report_rounds.saturating_add(1)
                        };
                    }
                    GoalExecutionOperation::Discard => {
                        previous.as_ref().ok_or_else(fail)?;
                        expected.pending = None;
                    }
                    GoalExecutionOperation::Review => {
                        let old = previous.as_ref().ok_or_else(fail)?;
                        let r = old
                            .latest_turn
                            .as_ref()
                            .and_then(|t| t.report.as_ref())
                            .ok_or_else(fail)?;
                        let v = s.review.as_ref().ok_or_else(fail)?;
                        if r.status != GoalReportStatus::Complete
                            || v.goal_id != r.goal_id
                            || v.definition_revision != r.definition_revision
                            || v.report_id != r.report_id
                        {
                            return Err(fail());
                        }
                        expected.review = Some(v.clone());
                    }
                    GoalExecutionOperation::Decision => {
                        let old = previous.as_ref().ok_or_else(fail)?;
                        if s.pending.is_some()
                            || s.running.is_some()
                            || old.running.is_some()
                            || g.goal.phase == GoalPhase::Active
                        {
                            return Err(fail());
                        }
                        if matches!(g.goal.phase, GoalPhase::Complete | GoalPhase::Blocked) {
                            let t = old.latest_turn.as_ref().ok_or_else(fail)?;
                            let r = t.report.as_ref().ok_or_else(fail)?;
                            let status = if g.goal.phase == GoalPhase::Complete {
                                GoalReportStatus::Complete
                            } else {
                                GoalReportStatus::Blocked
                            };
                            if t.outcome != GoalTurnOutcome::Completed
                                || r.status != status
                                || r.goal_id != g.goal.id
                                || r.definition_revision != old.definition.definition_revision
                                || t.activation_epoch != old.activation_epoch
                            {
                                return Err(fail());
                            }
                            if status == GoalReportStatus::Complete {
                                let verdict = old
                                    .review
                                    .as_ref()
                                    .filter(|v| {
                                        v.report_id == r.report_id
                                            && v.goal_id == r.goal_id
                                            && v.definition_revision == r.definition_revision
                                    })
                                    .map(|v| v.verdict);
                                if verdict == Some(ReviewVerdict::Rejected)
                                    || (old.definition.verification
                                        == VerificationMode::UserConfirm
                                        && verdict != Some(ReviewVerdict::Accepted))
                                {
                                    return Err(fail());
                                }
                            } else if g.goal.blocked_reason != r.blocked_reason {
                                return Err(fail());
                            }
                        }
                        expected.pending = None;
                        expected.pause_reason = s.pause_reason;
                    }
                }
                if expected != *s {
                    return Err(fail());
                }
                previous = Some(s.clone());
            }
            _ => {}
        }
    }
    Ok(())
}
