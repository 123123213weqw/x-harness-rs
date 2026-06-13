//! Test-only state-space sketch for the Host/Agent handoff. This is an
//! executable specification, not a second production scheduler.
use std::collections::{HashSet, VecDeque};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Phase {
    Idle,
    Running,
    Stopping,
    Compacting,
    Recovering,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Activity {
    None,
    Model,
    Tool,
    Question,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Gate {
    Open,
    Paused,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct State {
    phase: Phase,
    activity: Activity,
    queued: bool,
    gate: Gate,
}

impl State {
    const fn new(phase: Phase, activity: Activity, queued: bool, gate: Gate) -> Self {
        Self {
            phase,
            activity,
            queued,
            gate,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Event {
    UserPrompt,
    ToolFinished,
    QuestionAnswered,
    TurnFinished,
    UserStop,
    CompactRequested,
    CompactFinished,
    ProcessRestart,
    RestoreIncompleteTool,
}

fn candidate_events(state: State) -> Vec<Event> {
    use Activity::{Question, Tool};
    use Event::*;
    use Phase::{Compacting, Idle, Recovering, Running, Stopping};
    let mut events = vec![UserPrompt];
    match state.phase {
        Idle => events.push(CompactRequested),
        Running => {
            events.extend([TurnFinished, UserStop, CompactRequested, ProcessRestart]);
            if state.activity == Tool {
                events.push(ToolFinished);
            }
            if state.activity == Question {
                events.push(QuestionAnswered);
            }
        }
        Stopping => events.extend([TurnFinished, ProcessRestart]),
        Compacting => events.extend([CompactFinished, ProcessRestart]),
        Recovering => events.push(RestoreIncompleteTool),
    }
    events
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
    StartTurn,
    Enqueue,
    ContinueTurn,
    FinishTurn,
    StopTurn,
    StartCompaction,
    FinishCompaction,
    Recover,
    PauseUnresolvedTool,
    Reject,
    Undefined,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Decision {
    kind: Kind,
    rule_id: String,
    next: Option<State>,
}

fn decision(kind: Kind, rule_id: impl Into<String>, next: Option<State>) -> Decision {
    Decision {
        kind,
        rule_id: rule_id.into(),
        next,
    }
}

/// Deliberately partial: a missing rule is reported, never silently mapped
/// onto an existing behavior. Covered rules mirror the listed live tests.
fn evaluate(state: State, event: Event) -> Decision {
    use Activity::{Model, None as NoActivity, Question, Tool};
    use Event::*;
    use Gate::{Open, Paused};
    use Kind::*;
    use Phase::{Compacting, Idle, Recovering, Running, Stopping};

    match (state.phase, state.activity, state.gate, event) {
        (Idle, NoActivity, Open, UserPrompt) => decision(
            StartTurn,
            "idle_user_starts_turn",
            Some(State::new(Running, Model, false, Open)),
        ),
        (Running, _, _, UserPrompt) => decision(
            Enqueue,
            "busy_user_joins_next_turn",
            Some(State {
                queued: true,
                ..state
            }),
        ),
        (Running, Tool, _, ToolFinished) => decision(
            ContinueTurn,
            "tool_result_keeps_current_turn",
            Some(State {
                activity: Model,
                ..state
            }),
        ),
        (Running, Question, _, QuestionAnswered) => decision(
            ContinueTurn,
            "answer_resumes_current_turn",
            Some(State {
                activity: Model,
                ..state
            }),
        ),
        (Running, Model | NoActivity, Open, TurnFinished) => decision(
            FinishTurn,
            "completed_turn_drains_next_turn",
            Some(if state.queued {
                State::new(Running, Model, false, Open)
            } else {
                State::new(Idle, NoActivity, false, Open)
            }),
        ),
        (Running, _, _, UserStop) => decision(
            StopTurn,
            "stop_settles_current_turn",
            Some(State {
                phase: Stopping,
                gate: Paused,
                ..state
            }),
        ),
        (Stopping, _, Paused, TurnFinished) => decision(
            FinishTurn,
            "stopped_turn_preserves_queued_user",
            Some(if state.queued {
                State::new(Running, Model, false, Open)
            } else {
                State::new(Idle, NoActivity, false, Paused)
            }),
        ),
        (Idle, NoActivity, Open, CompactRequested) => decision(
            StartCompaction,
            "idle_manual_compaction",
            Some(State::new(Compacting, NoActivity, state.queued, Open)),
        ),
        (Compacting, NoActivity, _, CompactFinished) if !state.queued => decision(
            FinishCompaction,
            "idle_compaction_finishes",
            Some(State::new(Idle, NoActivity, false, Open)),
        ),
        (Running, Tool, _, ProcessRestart) => decision(
            Recover,
            "restart_enters_incomplete_tool_recovery",
            Some(State::new(Recovering, Tool, state.queued, Paused)),
        ),
        (Recovering, Tool, Paused, RestoreIncompleteTool) => decision(
            PauseUnresolvedTool,
            "host_restore_pauses_incomplete_tool",
            Some(State::new(Idle, NoActivity, state.queued, Paused)),
        ),
        (Idle, _, _, TurnFinished) | (_, _, _, ToolFinished) if state.activity != Tool => {
            decision(Reject, "event_has_no_matching_active_work", None)
        }
        (_, _, _, QuestionAnswered) if state.activity != Question => {
            decision(Reject, "answer_has_no_pending_question", None)
        }
        _ => decision(Undefined, format!("unhandled/{state:?}/{event:?}"), None),
    }
}

#[derive(Clone, Copy)]
struct Profile {
    name: &'static str,
    state: State,
    event: Event,
    expected: Kind,
    rule_id: &'static str,
}

const PROFILES: [Profile; 8] = [
    Profile {
        name: "idle prompt",
        state: State::new(Phase::Idle, Activity::None, false, Gate::Open),
        event: Event::UserPrompt,
        expected: Kind::StartTurn,
        rule_id: "idle_user_starts_turn",
    },
    Profile {
        name: "running model prompt",
        state: State::new(Phase::Running, Activity::Model, false, Gate::Open),
        event: Event::UserPrompt,
        expected: Kind::Enqueue,
        rule_id: "busy_user_joins_next_turn",
    },
    Profile {
        name: "running tool prompt",
        state: State::new(Phase::Running, Activity::Tool, false, Gate::Open),
        event: Event::UserPrompt,
        expected: Kind::Enqueue,
        rule_id: "busy_user_joins_next_turn",
    },
    Profile {
        name: "running tool settles",
        state: State::new(Phase::Running, Activity::Tool, true, Gate::Open),
        event: Event::ToolFinished,
        expected: Kind::ContinueTurn,
        rule_id: "tool_result_keeps_current_turn",
    },
    Profile {
        name: "question answered",
        state: State::new(Phase::Running, Activity::Question, false, Gate::Open),
        event: Event::QuestionAnswered,
        expected: Kind::ContinueTurn,
        rule_id: "answer_resumes_current_turn",
    },
    Profile {
        name: "stopped queued turn",
        state: State::new(Phase::Stopping, Activity::Model, true, Gate::Paused),
        event: Event::TurnFinished,
        expected: Kind::FinishTurn,
        rule_id: "stopped_turn_preserves_queued_user",
    },
    Profile {
        name: "completed turn drains queue",
        state: State::new(Phase::Running, Activity::Model, true, Gate::Open),
        event: Event::TurnFinished,
        expected: Kind::FinishTurn,
        rule_id: "completed_turn_drains_next_turn",
    },
    Profile {
        name: "crashed tool restored",
        state: State::new(Phase::Recovering, Activity::Tool, false, Gate::Paused),
        event: Event::RestoreIncompleteTool,
        expected: Kind::PauseUnresolvedTool,
        rule_id: "host_restore_pauses_incomplete_tool",
    },
];

pub(super) fn assert_profile(name: &str) {
    let profile = PROFILES
        .iter()
        .find(|profile| profile.name == name)
        .unwrap_or_else(|| panic!("statecheck profile {name:?} is not registered"));
    let actual = evaluate(profile.state, profile.event);
    assert_eq!(actual.kind, profile.expected, "{name}");
    assert_eq!(actual.rule_id, profile.rule_id, "{name}");
    assert!(actual.next.is_some(), "{name} has no successor state");
}

fn render_profile_table() -> String {
    let mut table =
        String::from("| Profile | Event | Rule ID | Decision |\n| --- | --- | --- | --- |\n");
    for profile in PROFILES {
        table.push_str(&format!(
            "| {} | {:?} | `{}` | {:?} |\n",
            profile.name, profile.event, profile.rule_id, profile.expected
        ));
    }
    table
}

#[test]
fn decision_table_in_spec_matches_the_executable_profiles() {
    let spec = include_str!("../../../docs/specs/turn-statecheck.md");
    let table = spec
        .split_once("<!-- statecheck:begin -->")
        .expect("spec must contain table start")
        .1
        .split_once("<!-- statecheck:end -->")
        .expect("spec must contain table end")
        .0;
    assert_eq!(table.trim(), render_profile_table().trim());
}

#[test]
fn named_profiles_have_reviewable_rules() {
    for profile in PROFILES {
        assert_profile(profile.name);
    }
}

#[test]
fn bounded_reachable_enumeration_reports_undefined_instead_of_guessing() {
    let mut seen = HashSet::new();
    let mut frontier = VecDeque::new();
    for profile in PROFILES {
        frontier.push_back((profile.state, 0_u8));
    }
    let mut rows = 0_usize;
    let mut undefined = Vec::new();
    while let Some((state, depth)) = frontier.pop_front() {
        if !seen.insert(state) {
            continue;
        }
        for event in candidate_events(state) {
            let decision = evaluate(state, event);
            rows += 1;
            assert!(!decision.rule_id.is_empty());
            if decision.kind == Kind::Undefined {
                assert!(decision.rule_id.starts_with("unhandled/"));
                undefined.push(decision.rule_id.clone());
            }
            if depth < 3 {
                if let Some(next) = decision.next {
                    frontier.push_back((next, depth + 1));
                }
            }
        }
    }
    assert!(rows >= PROFILES.len() * 2);
    assert!(rows < 2_000, "state space should remain reviewable");
    assert!(
        !undefined.is_empty(),
        "unreviewed combinations must remain visible"
    );
    undefined.sort();
    undefined.dedup();
    println!(
        "statecheck: reachable_states={} decisions={} undefined={}",
        seen.len(),
        rows,
        undefined.len()
    );
    if std::env::var_os("XHARNESS_STATECHECK_LIST").is_some() {
        for gap in undefined {
            println!("{gap}");
        }
    }
}

#[test]
fn an_in_flight_tool_cannot_be_finished_by_ordinary_queue_admission() {
    let running = State::new(Phase::Running, Activity::Tool, false, Gate::Open);
    let queued = evaluate(running, Event::UserPrompt).next.unwrap();
    assert_eq!(queued.phase, Phase::Running);
    assert_eq!(queued.activity, Activity::Tool);
    assert!(queued.queued);
    assert_eq!(evaluate(queued, Event::TurnFinished).kind, Kind::Undefined);
    let settled = evaluate(queued, Event::ToolFinished).next.unwrap();
    assert_eq!(settled.phase, Phase::Running);
    assert_eq!(settled.activity, Activity::Model);
    assert_eq!(
        evaluate(settled, Event::TurnFinished).next.unwrap().phase,
        Phase::Running
    );
}
