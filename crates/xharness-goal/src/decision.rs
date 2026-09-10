use crate::*;

/// Pure, repeatable decision on a consistent cut. No state is changed here.
pub fn decide(o: &GoalObservation) -> Result<GoalDecision, GoalContractError> {
    let Some(g) = &o.goal else {
        return Ok(GoalDecision::Idle {
            reason: IdleReason::NoGoal,
        });
    };
    g.validate()?;
    let idle = match g.snapshot.phase {
        GoalPhase::Paused => Some(IdleReason::Paused),
        GoalPhase::Blocked => Some(IdleReason::Blocked),
        GoalPhase::Complete => Some(IdleReason::Complete),
        GoalPhase::Active => None,
    };
    if let Some(reason) = idle {
        return Ok(GoalDecision::Idle { reason });
    }
    if !g.execution_enabled {
        return Ok(GoalDecision::Idle {
            reason: IdleReason::Disabled,
        });
    }
    require(o.activation_epoch > 0, "activation_epoch")?;
    require(o.empty_report_limit > 0, "empty_report_limit")?;
    require(
        o.rounds_started <= g.snapshot.max_goal_rounds,
        "rounds_started",
    )?;
    let fence = GoalFence {
        session_revision: o.session_revision,
        goal_id: g.snapshot.id.clone(),
        goal_revision: g.snapshot.revision,
        definition_revision: g.definition_revision,
        activation_epoch: o.activation_epoch,
    };
    let wait = match o.runtime {
        RuntimeState::Running => Some(WaitReason::RuntimeBusy),
        RuntimeState::AwaitingApproval => Some(WaitReason::Approval),
        RuntimeState::AwaitingAnswer => Some(WaitReason::Answer),
        RuntimeState::NeedsRecovery => Some(WaitReason::Recovery),
        RuntimeState::Idle => None,
    };
    if let Some(reason) = wait {
        return Ok(GoalDecision::Wait { reason });
    }
    if o.pending_user_input {
        return Ok(GoalDecision::Wait {
            reason: WaitReason::UserPriority,
        });
    }
    if let Some(key) = &o.pending_intent {
        if key.goal_id != g.snapshot.id
            || key.definition_revision != g.definition_revision
            || key.activation_epoch != o.activation_epoch
        {
            return Ok(GoalDecision::DiscardPending {
                fence,
                key: key.clone(),
            });
        }
        return Ok(GoalDecision::Wait {
            reason: WaitReason::ContinuationPending,
        });
    }
    // A new definition/activation must not inherit an old completion or hard error.
    let turn = o.latest_turn.as_ref().filter(|t| {
        t.goal_id == g.snapshot.id
            && t.definition_revision == g.definition_revision
            && t.activation_epoch == o.activation_epoch
    });
    let mut reason = ContinueReason::Initial;
    let mut cause = ContinuationCause::Initial;
    if let Some(t) = turn {
        require(t.turn > 0, "turn.id")?;
        require(o.rounds_started > 0, "turn.without_started_round")?;
        let pause = match t.outcome {
            GoalTurnOutcome::Completed => None,
            GoalTurnOutcome::Cancelled => Some(PauseReason::Cancelled),
            GoalTurnOutcome::Failed => Some(PauseReason::ExecutionError),
            GoalTurnOutcome::StepLimit => Some(PauseReason::StepLimit),
            GoalTurnOutcome::OutputLimit => Some(PauseReason::OutputLimit),
            GoalTurnOutcome::OutcomeUnknown => Some(PauseReason::OutcomeUnknown),
        };
        if let Some(reason) = pause {
            return Ok(GoalDecision::Pause { fence, reason });
        }
        // Even a completion report cannot finish while required dependencies remain.
        if o.unresolved_dependencies {
            return Ok(GoalDecision::Wait {
                reason: WaitReason::Dependencies,
            });
        }
        cause = ContinuationCause::AfterTurn { turn: t.turn };
        reason = ContinueReason::MissingReport;
        if let Some(r) = &t.report {
            if r.goal_id != g.snapshot.id
                || r.definition_revision != g.definition_revision
                || r.turn != t.turn
            {
                reason = ContinueReason::StaleReport;
            } else {
                r.validate()?;
                match r.status {
                    GoalReportStatus::Progress => reason = ContinueReason::Progress,
                    GoalReportStatus::Blocked => {
                        return Ok(GoalDecision::Block {
                            fence,
                            report_id: r.report_id.clone(),
                            reason: r.blocked_reason.clone().expect("validated blocked report"),
                        })
                    }
                    GoalReportStatus::Complete => {
                        let review = o.completion_review.as_ref().filter(|v| {
                            v.goal_id == r.goal_id
                                && v.definition_revision == r.definition_revision
                                && v.report_id == r.report_id
                        });
                        match review.map(|v| v.verdict) {
                            Some(ReviewVerdict::Rejected) => {
                                reason = ContinueReason::CompletionRejected
                            }
                            None if g.verification == VerificationMode::UserConfirm => {
                                return Ok(GoalDecision::Wait {
                                    reason: WaitReason::CompletionConfirmation,
                                })
                            }
                            _ => {
                                return Ok(GoalDecision::Complete {
                                    fence,
                                    report_id: r.report_id.clone(),
                                    evidence: r.evidence.clone(),
                                })
                            }
                        }
                    }
                }
            }
        }
    }
    if o.unresolved_dependencies {
        return Ok(GoalDecision::Wait {
            reason: WaitReason::Dependencies,
        });
    }
    // This budget gates NEW work, not a valid completion at the final allowed round.
    if o.rounds_started == g.snapshot.max_goal_rounds {
        return Ok(GoalDecision::Pause {
            fence,
            reason: PauseReason::RoundBudget,
        });
    }
    if matches!(
        reason,
        ContinueReason::MissingReport | ContinueReason::StaleReport
    ) && o.empty_report_rounds >= o.empty_report_limit
    {
        return Ok(GoalDecision::Pause {
            fence,
            reason: PauseReason::ReportProtocolStalled,
        });
    }
    let key = ContinuationKey {
        goal_id: g.snapshot.id.clone(),
        definition_revision: g.definition_revision,
        activation_epoch: o.activation_epoch,
        cause,
    };
    if o.admitted_intents.contains(&key) {
        return Ok(GoalDecision::Wait {
            reason: WaitReason::AlreadyAdmitted,
        });
    }
    Ok(GoalDecision::Continue { fence, key, reason })
}
