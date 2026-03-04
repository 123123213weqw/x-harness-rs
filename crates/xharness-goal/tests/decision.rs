use std::collections::BTreeSet;
use xharness_goal::*;

fn observation() -> GoalObservation {
    GoalObservation {
        goal: Some(GoalDefinition {
            snapshot: GoalSnapshot {
                id: "g".into(),
                revision: 1,
                objective: "完成任务并通过测试".into(),
                phase: GoalPhase::Active,
                blocked_reason: None,
                max_goal_rounds: 256,
            },
            definition_revision: 1,
            acceptance_criteria: vec!["测试通过".into()],
            execution_enabled: true,
            verification: VerificationMode::AgentReport,
        }),
        session_revision: Revision(10),
        activation_epoch: 1,
        runtime: RuntimeState::Idle,
        pending_user_input: false,
        unresolved_dependencies: false,
        rounds_started: 0,
        latest_turn: None,
        completion_review: None,
        pending_intent: None,
        admitted_intents: BTreeSet::new(),
        empty_report_rounds: 0,
        empty_report_limit: 3,
    }
}
fn report(status: GoalReportStatus) -> GoalReport {
    GoalReport {
        goal_id: "g".into(),
        definition_revision: 1,
        turn: 7,
        report_id: "r".into(),
        status,
        summary: "阶段报告".into(),
        remaining: vec![],
        evidence: vec![GoalEvidence::ToolResult {
            execution_id: "e".into(),
        }],
        blocked_reason: (status == GoalReportStatus::Blocked).then(|| GoalBlockReason {
            code: "missing_input".into(),
            message: "需要用户输入".into(),
        }),
    }
}
fn settled(status: Option<GoalReportStatus>) -> GoalObservation {
    let mut o = observation();
    o.rounds_started = 1;
    o.latest_turn = Some(GoalTurnResult {
        goal_id: "g".into(),
        definition_revision: 1,
        activation_epoch: 1,
        turn: 7,
        outcome: GoalTurnOutcome::Completed,
        report: status.map(report),
    });
    o
}
fn decision(o: &GoalObservation) -> GoalDecision {
    decide(o).unwrap()
}
fn key(o: &GoalObservation) -> ContinuationKey {
    match decision(o) {
        GoalDecision::Continue { key, .. } => key,
        d => panic!("{d:?}"),
    }
}
fn review(verdict: ReviewVerdict) -> CompletionReview {
    CompletionReview {
        goal_id: "g".into(),
        definition_revision: 1,
        report_id: "r".into(),
        verdict,
    }
}

#[test]
fn initial_decision_is_pure_and_repeatable() {
    let o = observation();
    let before = o.clone();
    assert_eq!(decision(&o), decision(&o));
    assert_eq!(o, before);
    assert!(matches!(
        decision(&o),
        GoalDecision::Continue {
            reason: ContinueReason::Initial,
            ..
        }
    ));
}
#[test]
fn absent_disabled_and_inactive_never_start() {
    let mut o = observation();
    o.goal = None;
    assert_eq!(
        decision(&o),
        GoalDecision::Idle {
            reason: IdleReason::NoGoal
        }
    );
    o = observation();
    o.goal.as_mut().unwrap().execution_enabled = false;
    assert_eq!(
        decision(&o),
        GoalDecision::Idle {
            reason: IdleReason::Disabled
        }
    );
    for (phase, reason) in [
        (GoalPhase::Paused, IdleReason::Paused),
        (GoalPhase::Blocked, IdleReason::Blocked),
        (GoalPhase::Complete, IdleReason::Complete),
    ] {
        let mut o = observation();
        let g = &mut o.goal.as_mut().unwrap().snapshot;
        g.phase = phase;
        g.blocked_reason = (phase == GoalPhase::Blocked)
            .then(|| report(GoalReportStatus::Blocked).blocked_reason.unwrap());
        assert_eq!(decision(&o), GoalDecision::Idle { reason });
    }
}
#[test]
fn runtime_wait_matrix_including_completion_claims() {
    for (runtime, reason) in [
        (RuntimeState::Running, WaitReason::RuntimeBusy),
        (RuntimeState::AwaitingApproval, WaitReason::Approval),
        (RuntimeState::AwaitingAnswer, WaitReason::Answer),
        (RuntimeState::NeedsRecovery, WaitReason::Recovery),
    ] {
        for status in [
            None,
            Some(GoalReportStatus::Progress),
            Some(GoalReportStatus::Complete),
            Some(GoalReportStatus::Blocked),
        ] {
            let mut o = settled(status);
            o.runtime = runtime;
            assert_eq!(decision(&o), GoalDecision::Wait { reason });
        }
    }
}
#[test]
fn user_input_precedes_reports_and_dependencies_block_completion() {
    let mut o = settled(Some(GoalReportStatus::Complete));
    o.pending_user_input = true;
    o.unresolved_dependencies = true;
    assert_eq!(
        decision(&o),
        GoalDecision::Wait {
            reason: WaitReason::UserPriority
        }
    );
    o.pending_user_input = false;
    assert_eq!(
        decision(&o),
        GoalDecision::Wait {
            reason: WaitReason::Dependencies
        }
    );
    let mut o = observation();
    o.unresolved_dependencies = true;
    assert_eq!(
        decision(&o),
        GoalDecision::Wait {
            reason: WaitReason::Dependencies
        }
    );
}
#[test]
fn ordinary_completed_turn_is_not_goal_completion() {
    assert!(matches!(
        decision(&settled(None)),
        GoalDecision::Continue {
            reason: ContinueReason::MissingReport,
            ..
        }
    ));
    assert!(matches!(
        decision(&settled(Some(GoalReportStatus::Progress))),
        GoalDecision::Continue {
            reason: ContinueReason::Progress,
            ..
        }
    ));
    assert!(matches!(
        decision(&settled(Some(GoalReportStatus::Blocked))),
        GoalDecision::Block { .. }
    ));
    assert!(matches!(
        decision(&settled(Some(GoalReportStatus::Complete))),
        GoalDecision::Complete { .. }
    ));
}
#[test]
fn hard_outcomes_cannot_be_overridden_by_reports() {
    for (outcome, expected) in [
        (GoalTurnOutcome::Cancelled, PauseReason::Cancelled),
        (GoalTurnOutcome::Failed, PauseReason::ExecutionError),
        (GoalTurnOutcome::StepLimit, PauseReason::StepLimit),
        (GoalTurnOutcome::OutputLimit, PauseReason::OutputLimit),
        (GoalTurnOutcome::OutcomeUnknown, PauseReason::OutcomeUnknown),
    ] {
        for status in [
            None,
            Some(GoalReportStatus::Progress),
            Some(GoalReportStatus::Complete),
            Some(GoalReportStatus::Blocked),
        ] {
            let mut o = settled(status);
            o.latest_turn.as_mut().unwrap().outcome = outcome;
            assert!(
                matches!(decision(&o), GoalDecision::Pause { reason, .. } if reason == expected)
            );
        }
    }
}
#[test]
fn confirmation_is_bound_to_the_exact_report() {
    let mut o = settled(Some(GoalReportStatus::Complete));
    o.goal.as_mut().unwrap().verification = VerificationMode::UserConfirm;
    assert_eq!(
        decision(&o),
        GoalDecision::Wait {
            reason: WaitReason::CompletionConfirmation
        }
    );
    for field in 0..3 {
        let mut r = review(ReviewVerdict::Accepted);
        match field {
            0 => r.goal_id = "other".into(),
            1 => r.definition_revision += 1,
            _ => r.report_id = "other".into(),
        }
        o.completion_review = Some(r);
        assert_eq!(
            decision(&o),
            GoalDecision::Wait {
                reason: WaitReason::CompletionConfirmation
            }
        );
    }
    o.completion_review = Some(review(ReviewVerdict::Accepted));
    assert!(matches!(decision(&o), GoalDecision::Complete { .. }));
    o.completion_review = Some(review(ReviewVerdict::Rejected));
    assert!(matches!(
        decision(&o),
        GoalDecision::Continue {
            reason: ContinueReason::CompletionRejected,
            ..
        }
    ));
    o.goal.as_mut().unwrap().verification = VerificationMode::AgentReport;
    assert!(matches!(
        decision(&o),
        GoalDecision::Continue {
            reason: ContinueReason::CompletionRejected,
            ..
        }
    ));
}
#[test]
fn stale_turns_do_not_complete_or_reapply_old_failures() {
    for field in 0..3 {
        for outcome in [GoalTurnOutcome::Completed, GoalTurnOutcome::Failed] {
            let mut o = settled(Some(GoalReportStatus::Complete));
            let t = o.latest_turn.as_mut().unwrap();
            t.outcome = outcome;
            match field {
                0 => t.goal_id = "other".into(),
                1 => t.definition_revision += 1,
                _ => t.activation_epoch += 1,
            }
            assert!(matches!(
                decision(&o),
                GoalDecision::Continue {
                    reason: ContinueReason::Initial,
                    ..
                }
            ));
        }
    }
}
#[test]
fn stale_reports_cannot_complete() {
    for field in 0..3 {
        let mut o = settled(Some(GoalReportStatus::Complete));
        let r = o.latest_turn.as_mut().unwrap().report.as_mut().unwrap();
        match field {
            0 => r.goal_id = "other".into(),
            1 => r.definition_revision += 1,
            _ => r.turn += 1,
        }
        assert!(matches!(
            decision(&o),
            GoalDecision::Continue {
                reason: ContinueReason::StaleReport,
                ..
            }
        ));
    }
}
#[test]
fn last_round_can_complete_but_cannot_start_more_work() {
    for status in [
        None,
        Some(GoalReportStatus::Progress),
        Some(GoalReportStatus::Complete),
    ] {
        let mut o = settled(status);
        o.goal.as_mut().unwrap().snapshot.max_goal_rounds = 1;
        if status == Some(GoalReportStatus::Complete) {
            assert!(matches!(decision(&o), GoalDecision::Complete { .. }));
        } else {
            assert!(matches!(
                decision(&o),
                GoalDecision::Pause {
                    reason: PauseReason::RoundBudget,
                    ..
                }
            ));
        }
    }
    let mut o = settled(Some(GoalReportStatus::Complete));
    o.goal.as_mut().unwrap().snapshot.max_goal_rounds = 1;
    o.completion_review = Some(review(ReviewVerdict::Rejected));
    assert!(matches!(
        decision(&o),
        GoalDecision::Pause {
            reason: PauseReason::RoundBudget,
            ..
        }
    ));
}
#[test]
fn duplicate_and_pending_intents_are_not_readmitted() {
    let mut o = settled(Some(GoalReportStatus::Progress));
    let k = key(&o);
    o.admitted_intents.insert(k.clone());
    assert_eq!(
        decision(&o),
        GoalDecision::Wait {
            reason: WaitReason::AlreadyAdmitted
        }
    );
    o.pending_intent = Some(k);
    assert_eq!(
        decision(&o),
        GoalDecision::Wait {
            reason: WaitReason::ContinuationPending
        }
    );
}
#[test]
fn stale_pending_intents_require_removal_before_new_admission() {
    for field in 0..3 {
        let mut o = observation();
        let mut k = key(&o);
        match field {
            0 => k.goal_id = "other".into(),
            1 => k.definition_revision += 1,
            _ => k.activation_epoch += 1,
        }
        o.pending_intent = Some(k.clone());
        assert!(matches!(decision(&o), GoalDecision::DiscardPending { key, .. } if key == k));
    }
}
#[test]
fn receipt_key_is_stable_while_fence_tracks_snapshot_revision() {
    let o = observation();
    let mut next = o.clone();
    next.session_revision = Revision(11);
    next.goal.as_mut().unwrap().snapshot.revision = 2;
    assert_eq!(key(&o), key(&next));
    assert_ne!(decision(&o), decision(&next));
    next.activation_epoch += 1;
    assert_ne!(key(&o), key(&next));
    next = o.clone();
    next.goal.as_mut().unwrap().snapshot.revision = 2;
    next.goal.as_mut().unwrap().definition_revision = 2;
    assert_ne!(key(&o), key(&next));
    assert_ne!(key(&o), key(&settled(None)));
}
#[test]
fn protocol_stall_threshold_is_explicit_not_text_similarity() {
    let mut o = settled(None);
    o.empty_report_rounds = 2;
    assert!(matches!(decision(&o), GoalDecision::Continue { .. }));
    o.empty_report_rounds = 3;
    assert!(matches!(
        decision(&o),
        GoalDecision::Pause {
            reason: PauseReason::ReportProtocolStalled,
            ..
        }
    ));
    o.latest_turn.as_mut().unwrap().report = Some(report(GoalReportStatus::Progress));
    assert!(matches!(
        decision(&o),
        GoalDecision::Continue {
            reason: ContinueReason::Progress,
            ..
        }
    ));
    o.latest_turn
        .as_mut()
        .unwrap()
        .report
        .as_mut()
        .unwrap()
        .turn = 99;
    assert!(matches!(
        decision(&o),
        GoalDecision::Pause {
            reason: PauseReason::ReportProtocolStalled,
            ..
        }
    ));
}
#[test]
fn inconsistent_observation_is_rejected() {
    for field in 0..5 {
        let mut o = settled(None);
        match field {
            0 => o.activation_epoch = 0,
            1 => o.empty_report_limit = 0,
            2 => o.rounds_started = 257,
            3 => o.rounds_started = 0,
            _ => o.latest_turn.as_mut().unwrap().turn = 0,
        }
        assert!(decide(&o).is_err());
    }
}
#[test]
fn invalid_definition_is_rejected() {
    for field in 0..7 {
        let mut o = observation();
        let g = o.goal.as_mut().unwrap();
        match field {
            0 => g.snapshot.id.clear(),
            1 => g.snapshot.objective = "  ".into(),
            2 => g.snapshot.revision = 0,
            3 => g.definition_revision = 2,
            4 => g.snapshot.max_goal_rounds = 0,
            5 => g.acceptance_criteria.push("".into()),
            _ => g.snapshot.phase = GoalPhase::Blocked,
        }
        assert!(decide(&o).is_err());
    }
}
#[test]
fn invalid_report_is_rejected_without_mutation() {
    for field in 0..7 {
        let mut o = settled(Some(GoalReportStatus::Complete));
        let r = o.latest_turn.as_mut().unwrap().report.as_mut().unwrap();
        match field {
            0 => r.report_id.clear(),
            1 => r.summary = " ".into(),
            2 => r.remaining.push("未完成".into()),
            3 => r.remaining.push("".into()),
            4 => r.blocked_reason = report(GoalReportStatus::Blocked).blocked_reason,
            5 => {
                r.evidence = vec![GoalEvidence::Artifact {
                    reference: "".into(),
                }]
            }
            _ => {
                r.evidence = vec![GoalEvidence::ToolResult {
                    execution_id: "".into(),
                }]
            }
        }
        let before = o.clone();
        assert!(decide(&o).is_err());
        assert_eq!(o, before);
    }
    let mut r = report(GoalReportStatus::Blocked);
    r.blocked_reason.as_mut().unwrap().code.clear();
    assert!(r.validate().is_err());
    r.blocked_reason = None;
    assert!(r.validate().is_err());
}
#[test]
fn contracts_roundtrip_and_reject_unknown_fields() {
    let o = settled(Some(GoalReportStatus::Complete));
    assert_eq!(
        serde_json::from_str::<GoalObservation>(&serde_json::to_string(&o).unwrap()).unwrap(),
        o
    );
    let d = decision(&o);
    assert_eq!(
        serde_json::from_str::<GoalDecision>(&serde_json::to_string(&d).unwrap()).unwrap(),
        d
    );
    let mut v = serde_json::to_value(report(GoalReportStatus::Progress)).unwrap();
    v["execute_command"] = "bad".into();
    assert!(serde_json::from_value::<GoalReport>(v).is_err());
    assert!(serde_json::from_str::<GoalEvidence>(r#"{"kind":"command","command":"bad"}"#).is_err());
}
