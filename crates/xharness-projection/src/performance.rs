//! Bounded, content-free reception timeline. This measures journal checkpoints,
//! NOT server decode speed. Character weights are additive across chunk splits.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};
use xharness_session::{AssistantChunk, EventData, LoggedEvent};

pub const MAX_SAMPLES: usize = 600;
pub const MAX_PHASES: usize = 128;
pub const MAX_REQUESTS: usize = 64;
pub const MAX_TURNS: usize = 4;
const MAX_PENDING: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    time_ms: u64,
    step: u32,
    attempt: u32,
    text_units: u64,
    reasoning_units: u64,
    argument_units: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Phase {
    start_ms: u64,
    end_ms: Option<u64>,
    kind: String,
    step: Option<u32>,
    attempt: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    step: u32,
    attempt: u32,
    start_ms: u64,
    first_delta_ms: Option<u64>,
    end_ms: Option<u64>,
    provider: Option<String>,
    model: Option<String>,
    reported_output_tokens: Option<u64>,
    reported_reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reception_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    estimated_units: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    estimated_reasoning_units: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Turn {
    turn: u32,
    start_ms: u64,
    end_ms: Option<u64>,
    last_ms: u64,
    truncated: bool,
    samples: VecDeque<Sample>,
    phases: VecDeque<Phase>,
    requests: VecDeque<Request>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PerformanceTimelineState {
    turns: VecDeque<Turn>,
    step: Option<u32>,
    attempt: u32,
    tools: BTreeSet<String>,
    questions: BTreeSet<String>,
    approvals: BTreeSet<String>,
    pending_overflow: bool,
    last_seq: Option<u64>,
}

// No per-delta tokenizer work, no raw text retained, no provider charge inferred.
// ASCII = one quarter token, non-ASCII = one token: explicitly an estimate.
fn units(text: &str) -> u64 {
    text.chars().fold(0u64, |n, c| {
        n.saturating_add(if c.is_ascii() { 1 } else { 4 })
    })
}
fn short(value: &str) -> String {
    value.chars().take(160).collect()
}
fn u32_field(data: &Value, key: &str) -> Option<u32> {
    u32::try_from(data.get(key)?.as_u64()?).ok()
}

impl PerformanceTimelineState {
    pub fn view(&self) -> Value {
        let measured = self
            .turns
            .iter()
            .any(|t| t.requests.iter().any(|r| r.reception_ms.is_some()));
        json!({"schemaVersion":1,"source":if measured { "provider_reception_estimate" } else { "journal_checkpoint_estimate" },"bucketMs":1000,
            "maxSamples":MAX_SAMPLES,"turns":self.turns})
    }
    fn accept(&mut self, seq: u64, time: u64) -> Option<u64> {
        if self.last_seq.is_some_and(|old| seq <= old) {
            return None;
        }
        self.last_seq = Some(seq);
        let time = self.turns.back().map_or(time, |t| time.max(t.last_ms));
        if let Some(turn) = self.turns.back_mut() {
            turn.last_ms = time;
        }
        Some(time)
    }
    fn begin_turn(&mut self, turn: u32, time: u64) {
        if self
            .turns
            .back()
            .is_some_and(|t| t.turn == turn && t.end_ms.is_none())
        {
            return;
        }
        self.finish(time);
        self.turns.push_back(Turn {
            turn,
            start_ms: time,
            end_ms: None,
            last_ms: time,
            truncated: false,
            samples: VecDeque::new(),
            phases: VecDeque::new(),
            requests: VecDeque::new(),
        });
        self.step = None;
        self.attempt = 0;
        self.tools.clear();
        self.questions.clear();
        self.approvals.clear();
        self.pending_overflow = false;
        while self.turns.len() > MAX_TURNS {
            self.turns.pop_front();
        }
        self.phase("preparing", time);
    }
    fn phase(&mut self, kind: &str, time: u64) -> bool {
        let Some(turn) = self.turns.back_mut().filter(|t| t.end_ms.is_none()) else {
            return false;
        };
        if turn
            .phases
            .back()
            .is_some_and(|p| p.kind == kind && p.step == self.step && p.attempt == self.attempt)
        {
            return false;
        }
        if let Some(prior) = turn.phases.back_mut() {
            prior.end_ms = Some(time);
        }
        turn.phases.push_back(Phase {
            start_ms: time,
            end_ms: None,
            kind: kind.into(),
            step: self.step,
            attempt: self.attempt,
        });
        self.bound();
        true
    }
    fn idle_phase(&mut self, time: u64) -> bool {
        let kind = if self.pending_overflow {
            "unknown"
        } else if !self.approvals.is_empty() {
            "approval"
        } else if !self.questions.is_empty() {
            "question"
        } else if !self.tools.is_empty() {
            "tool"
        } else {
            "between_steps"
        };
        self.phase(kind, time)
    }
    fn start_step(&mut self, turn: u32, step: u32, time: u64, retry: bool) {
        if !self
            .turns
            .back()
            .is_some_and(|t| t.turn == turn && t.end_ms.is_none())
        {
            self.begin_turn(turn, time);
        }
        if retry {
            self.attempt = self.attempt.saturating_add(1);
        } else {
            self.attempt = 0;
        }
        self.step = Some(step);
        if let Some(prior) = self.turns.back_mut().and_then(|t| t.requests.back_mut()) {
            if prior.end_ms.is_none() {
                prior.end_ms = Some(time);
            }
        }
        self.turns.back_mut().unwrap().requests.push_back(Request {
            step,
            attempt: self.attempt,
            start_ms: time,
            first_delta_ms: None,
            end_ms: None,
            provider: None,
            model: None,
            reported_output_tokens: None,
            reported_reasoning_tokens: None,
            reception_ms: None,
            estimated_units: None,
            estimated_reasoning_units: None,
        });
        self.phase("waiting_first_token", time);
        self.bound();
    }
    fn matches(&self, turn: u32, step: u32) -> bool {
        self.step == Some(step)
            && self
                .turns
                .back()
                .is_some_and(|t| t.turn == turn && t.end_ms.is_none())
    }
    fn delta(&mut self, turn: u32, step: u32, kind: &str, text: &str, time: u64) -> bool {
        if text.is_empty() || !self.matches(turn, step) {
            return false;
        }
        let changed = self.phase(kind, time);
        if self
            .turns
            .back()
            .and_then(|t| t.requests.back())
            .is_some_and(|r| r.reception_ms.is_some())
        {
            return changed;
        }
        let active = self.turns.back_mut().unwrap();
        if let Some(request) = active.requests.back_mut() {
            request.first_delta_ms.get_or_insert(time);
        }
        let bucket = time / 1000 * 1000;
        let new = !active
            .samples
            .back()
            .is_some_and(|s| s.time_ms == bucket && s.step == step && s.attempt == self.attempt);
        if new {
            active.samples.push_back(Sample {
                time_ms: bucket,
                step,
                attempt: self.attempt,
                text_units: 0,
                reasoning_units: 0,
                argument_units: 0,
            });
        }
        let sample = active.samples.back_mut().unwrap();
        let counter = match kind {
            "reasoning" => &mut sample.reasoning_units,
            "arguments" => &mut sample.argument_units,
            _ => &mut sample.text_units,
        };
        *counter = counter.saturating_add(units(text));
        self.bound();
        // Other deltas in this second mutate the private counter, not a whole
        // public JSON snapshot. Next second/phase/boundary flushes the remainder.
        new || changed
    }
    fn route(&mut self, provider: &str, model: &str) -> bool {
        if let Some(request) = self.turns.back_mut().and_then(|t| t.requests.back_mut()) {
            request.provider = Some(short(provider));
            request.model = Some(short(model));
            true
        } else {
            false
        }
    }
    fn usage(&mut self, turn: u32, step: u32, value: Option<&Value>, time: u64) -> bool {
        if !self.matches(turn, step) {
            return false;
        }
        if let Some(request) = self.turns.back_mut().and_then(|t| t.requests.back_mut()) {
            if request.reception_ms.is_none() {
                request.end_ms = Some(time);
            }
            // Adapter normalization has already made these buckets disjoint.
            request.reported_output_tokens = value
                .and_then(|v| v.get("output_tokens").or_else(|| v.get("outputTokens")))
                .and_then(Value::as_u64);
            request.reported_reasoning_tokens = value
                .and_then(|v| {
                    v.get("reasoning_tokens")
                        .or_else(|| v.get("reasoningTokens"))
                })
                .and_then(Value::as_u64);
        }
        self.idle_phase(time);
        true
    }
    fn reception(&mut self, turn: u32, step: u32, data: &xharness_session::ModelReception) -> bool {
        if !self.matches(turn, step) || data.attempt != self.attempt {
            return false;
        }
        let active = self.turns.back_mut().expect("matching turn");
        let Some(request) = active.requests.back_mut() else {
            return false;
        };
        if request.reception_ms.is_none() {
            // Replace, do not append to, pre-checkpoint journal estimates.
            active
                .samples
                .retain(|s| s.step != step || s.attempt != data.attempt);
        }
        request.start_ms = data.start_ms;
        request.first_delta_ms = data.first_delta_ms;
        request.reception_ms = Some(data.reception_ms);
        request.estimated_units = Some(data.estimated_units);
        request.estimated_reasoning_units = Some(data.estimated_reasoning_units);
        if data.finished {
            request.end_ms = Some(data.start_ms.saturating_add(data.elapsed_ms));
            request.reported_output_tokens = data.output_tokens;
            request.reported_reasoning_tokens = data.reasoning_tokens;
        }
        for sample in &data.samples {
            if let Some(prior) = active.samples.back_mut().filter(|s| {
                s.time_ms == sample.time_ms && s.step == step && s.attempt == data.attempt
            }) {
                prior.text_units = prior.text_units.saturating_add(sample.text_units);
                prior.reasoning_units =
                    prior.reasoning_units.saturating_add(sample.reasoning_units);
                prior.argument_units = prior.argument_units.saturating_add(sample.argument_units);
            } else {
                active.samples.push_back(Sample {
                    time_ms: sample.time_ms,
                    step,
                    attempt: data.attempt,
                    text_units: sample.text_units,
                    reasoning_units: sample.reasoning_units,
                    argument_units: sample.argument_units,
                });
            }
        }
        self.bound();
        true
    }
    fn pending(&mut self, kind: &str, id: &str, add: bool, time: u64) -> bool {
        let set = match kind {
            "approval" => &mut self.approvals,
            "question" => &mut self.questions,
            _ => &mut self.tools,
        };
        if add {
            if set.len() >= MAX_PENDING || id.len() > 512 {
                self.pending_overflow = true;
            } else {
                set.insert(id.into());
            }
        } else {
            set.remove(id);
        }
        self.idle_phase(time)
    }
    fn finish(&mut self, time: u64) -> bool {
        let Some(turn) = self.turns.back_mut().filter(|t| t.end_ms.is_none()) else {
            return false;
        };
        turn.end_ms = Some(time);
        if let Some(phase) = turn.phases.back_mut() {
            phase.end_ms = Some(time);
        }
        if let Some(request) = turn.requests.back_mut() {
            request.end_ms.get_or_insert(time);
        }
        self.step = None;
        self.tools.clear();
        self.questions.clear();
        self.approvals.clear();
        self.pending_overflow = false;
        true
    }
    fn bound(&mut self) {
        for (limit, kind) in [(MAX_SAMPLES, 0), (MAX_PHASES, 1), (MAX_REQUESTS, 2)] {
            loop {
                let count: usize = self
                    .turns
                    .iter()
                    .map(|t| match kind {
                        0 => t.samples.len(),
                        1 => t.phases.len(),
                        _ => t.requests.len(),
                    })
                    .sum();
                if count <= limit {
                    break;
                }
                for turn in &mut self.turns {
                    let removed = match kind {
                        0 => turn.samples.pop_front().is_some(),
                        1 => turn.phases.pop_front().is_some(),
                        _ => turn.requests.pop_front().is_some(),
                    };
                    if removed {
                        turn.truncated = true;
                        break;
                    }
                }
            }
        }
    }
    /// Exact same reducer for typed restart and authoritative live events.
    pub fn apply_logged(&mut self, event: &LoggedEvent) -> bool {
        let Some(time) = self.accept(event.seq, event.timestamp_ms) else {
            return false;
        };
        match event.data() {
            EventData::TurnStart { turn } => {
                self.begin_turn(turn.saturating_sub(1), time);
                true
            }
            EventData::StepStart { turn, step } => {
                self.start_step(turn.saturating_sub(1), *step, time, false);
                true
            }
            EventData::RequestHeader { header } => self.route(&header.provider, &header.model),
            EventData::ModelReception {
                turn,
                step,
                reception,
            } => self.reception(turn.saturating_sub(1), *step, reception),
            EventData::AssistantChunk { turn, step, chunk } => match chunk {
                AssistantChunk::TextDelta(text) => {
                    self.delta(turn.saturating_sub(1), *step, "output", text, time)
                }
                AssistantChunk::ReasoningDelta(text) => {
                    self.delta(turn.saturating_sub(1), *step, "reasoning", text, time)
                }
                AssistantChunk::ToolCallDelta {
                    arguments_delta, ..
                } => self.delta(
                    turn.saturating_sub(1),
                    *step,
                    "arguments",
                    arguments_delta,
                    time,
                ),
                _ => false,
            },
            EventData::AssistantMessage {
                turn, step, usage, ..
            } => self.usage(turn.saturating_sub(1), *step, usage.as_ref(), time),
            EventData::ToolCall { call, .. } => self.pending("tool", &call.id, true, time),
            EventData::ToolResult { result, .. } => {
                self.pending("tool", &result.call_id, false, time)
            }
            EventData::ApprovalAsked { id, .. } => self.pending("approval", id, true, time),
            EventData::ApprovalDecided { id, .. } => self.pending("approval", id, false, time),
            EventData::QuestionRequested { invocation } => {
                self.pending("question", &invocation.interaction_id, true, time)
            }
            EventData::QuestionResolved { interaction_id, .. }
            | EventData::QuestionCancelled { interaction_id, .. }
            | EventData::QuestionDeferred { interaction_id } => {
                self.pending("question", interaction_id, false, time)
            }
            EventData::LlmRetry { .. } => self.phase("retry", time),
            EventData::LlmRetryStarted { turn, step, .. } => {
                self.start_step(turn.saturating_sub(1), *step, time, true);
                true
            }
            EventData::CompactionStart { .. } => self.phase("compaction", time),
            EventData::CompactionEnd { .. } | EventData::StepEnd { .. } => self.idle_phase(time),
            EventData::TurnEnd { .. } => self.finish(time),
            _ => false,
        }
    }
    /// Compatibility for non-authoritative embeddings; never reads tool text.
    pub fn apply(&mut self, event: &Value) -> bool {
        let Some(seq) = event.get("seq").and_then(Value::as_u64) else {
            return false;
        };
        let Some(time) = event
            .get("time")
            .and_then(Value::as_u64)
            .and_then(|t| self.accept(seq, t))
        else {
            return false;
        };
        let Some(data) = event.get("data") else {
            return false;
        };
        let turn = u32_field(data, "turn");
        let step = u32_field(data, "step");
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "model/reception" => {
                match (
                    u32_field(data, "turn"),
                    u32_field(data, "step"),
                    data.get("reception")
                        .and_then(|v| serde_json::from_value(v.clone()).ok()),
                ) {
                    (Some(t), Some(s), Some(r)) => self.reception(t, s, &r),
                    _ => false,
                }
            }

            "turn/start" => {
                if let Some(turn) = turn {
                    self.begin_turn(turn, time);
                    return true;
                }
                false
            }
            "step/start" | "llm/retry-started" => {
                if let Some((turn, step)) = turn.zip(step) {
                    self.start_step(turn, step, time, event["type"] == "llm/retry-started");
                    return true;
                }
                false
            }
            "request/header" => {
                let header = &data["header"];
                let config = header.get("config").unwrap_or(header);
                self.route(
                    config["provider"].as_str().unwrap_or("unknown"),
                    config["model"].as_str().unwrap_or("unknown"),
                )
            }
            "assistant/chunk" => {
                let chunk = &data["chunk"];
                let kind = match chunk["type"].as_str() {
                    Some("text-delta") => "output",
                    Some("reasoning-delta") => "reasoning",
                    Some("tool-call-delta") => "arguments",
                    _ => return false,
                };
                turn.zip(step).is_some_and(|(turn, step)| {
                    self.delta(
                        turn,
                        step,
                        kind,
                        chunk
                            .get(if kind == "arguments" {
                                "argumentsDelta"
                            } else {
                                "text"
                            })
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        time,
                    )
                })
            }
            "assistant/message" => turn
                .zip(step)
                .is_some_and(|(turn, step)| self.usage(turn, step, data.get("usage"), time)),
            "tool/call" => data["callId"]
                .as_str()
                .is_some_and(|id| self.pending("tool", id, true, time)),
            "tool/result" => data
                .pointer("/message/source/callId")
                .and_then(Value::as_str)
                .is_some_and(|id| self.pending("tool", id, false, time)),
            "approval/asked" => data["id"]
                .as_str()
                .is_some_and(|id| self.pending("approval", id, true, time)),
            "approval/decided" => data["id"]
                .as_str()
                .is_some_and(|id| self.pending("approval", id, false, time)),
            "llm/retry" => self.phase("retry", time),
            "compaction/start" => self.phase("compaction", time),
            "compaction/end" | "step/end" => self.idle_phase(time),
            "turn/end" => self.finish(time),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{Message, Revision, SessionEvent, TurnEndReason};
    fn log(seq: u64, time: u64, data: EventData) -> LoggedEvent {
        LoggedEvent {
            seq,
            timestamp_ms: time,
            revision: Revision::ZERO,
            event: SessionEvent::new(data),
        }
    }
    fn start() -> PerformanceTimelineState {
        let mut s = PerformanceTimelineState::default();
        s.apply_logged(&log(0, 1000, EventData::TurnStart { turn: 1 }));
        s.apply_logged(&log(1, 1100, EventData::StepStart { turn: 1, step: 1 }));
        s
    }
    #[test]
    fn transport_samples_replace_buffer_release_and_survive_rebuild() {
        let reception = xharness_session::ModelReception {
            attempt: 0,
            start_ms: 1100,
            first_delta_ms: Some(3100),
            elapsed_ms: 5000,
            reception_ms: 3000,
            estimated_units: 8,
            estimated_reasoning_units: 0,
            finished: true,
            output_tokens: Some(288),
            reasoning_tokens: Some(12),
            samples: vec![
                xharness_session::ReceptionSample {
                    time_ms: 3000,
                    argument_units: 4,
                    ..Default::default()
                },
                xharness_session::ReceptionSample {
                    time_ms: 5000,
                    argument_units: 4,
                    ..Default::default()
                },
            ],
        };
        let events = [
            log(0, 1000, EventData::TurnStart { turn: 1 }),
            log(1, 1100, EventData::StepStart { turn: 1, step: 1 }),
            log(
                2,
                1200,
                EventData::RequestHeader {
                    header: xharness_session::RequestHeader::new("test-provider", "test-model"),
                },
            ),
            log(
                3,
                6100,
                EventData::ModelReception {
                    turn: 1,
                    step: 1,
                    reception,
                },
            ),
            text(4, 6112, "buffered payload"),
            log(
                5,
                6112,
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("done"),
                    usage: Some(json!({"output_tokens":288,"reasoning_tokens":12})),
                },
            ),
        ];
        let mut hot = PerformanceTimelineState::default();
        let mut cold = PerformanceTimelineState::default();
        for e in &events {
            hot.apply_logged(e);
        }
        cold = serde_json::from_value(serde_json::to_value(cold).unwrap()).unwrap();
        for e in &events {
            cold.apply_logged(e);
        }
        assert_eq!(hot.view(), cold.view());
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../protocol/fixtures/performance-reception-v1.json");
        if std::env::var_os("XHARNESS_UPDATE_PERFORMANCE_FIXTURE").is_some() {
            std::fs::write(
                &fixture,
                serde_json::to_string_pretty(&hot.view()).unwrap() + "\n",
            )
            .unwrap();
        }
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
        assert_eq!(hot.view(), value);

        assert_eq!(hot.view()["source"], "provider_reception_estimate");
        assert_eq!(hot.view()["turns"][0]["requests"][0]["receptionMs"], 3000);
        assert_eq!(hot.view()["turns"][0]["requests"][0]["endMs"], 6100);
        assert_eq!(
            hot.view()["turns"][0]["samples"].as_array().unwrap().len(),
            2
        );
        assert_eq!(hot.view()["turns"][0]["samples"][0]["timeMs"], 3000);
    }
    fn text(seq: u64, time: u64, value: &str) -> LoggedEvent {
        log(
            seq,
            time,
            EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta(value.into()),
            },
        )
    }
    #[test]
    fn fragment_weights_do_not_count_chunks_and_same_second_does_not_republish() {
        let mut split = start();
        let mut whole = start();
        assert!(split.apply_logged(&text(2, 1300, "ab")));
        assert!(!split.apply_logged(&text(3, 1300, "cd你好")));
        whole.apply_logged(&text(2, 1300, "abcd你好"));
        assert_eq!(split.view(), whole.view());
        assert_eq!(split.view()["turns"][0]["samples"][0]["textUnits"], 12);
        assert!(!split.apply_logged(&text(3, 1300, "duplicate")));
    }
    #[test]
    fn sparse_intervals_remain_missing_not_fabricated_zero_or_average() {
        let mut s = start();
        s.apply_logged(&text(2, 1300, "abcd"));
        s.apply_logged(&text(3, 6300, "efgh"));
        assert_eq!(s.turns[0].samples.len(), 2);
        assert_eq!(s.turns[0].samples[1].time_ms, 6000);
        s.apply_logged(&log(
            4,
            6400,
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message: Message::assistant("abcdefgh"),
                usage: Some(json!({"output_tokens":99,"reasoning_tokens":12})),
            },
        ));
        assert_eq!(s.turns[0].requests[0].reported_output_tokens, Some(99));
        assert_eq!(
            s.turns[0].samples[0].text_units, 4,
            "final usage must not rescale estimates into fake measured bins"
        );
    }
    #[test]
    fn no_chunks_means_no_curve_and_missing_usage_remains_unknown() {
        let mut s = start();
        s.apply_logged(&log(
            2,
            1300,
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message: Message::assistant("unrecorded text"),
                usage: None,
            },
        ));
        assert!(s.turns[0].samples.is_empty());
        assert_eq!(s.turns[0].requests[0].reported_output_tokens, None);
    }
    #[test]
    fn concurrent_tools_and_human_waits_do_not_close_early() {
        let mut s = start();
        s.pending("tool", "a", true, 1300);
        s.pending("tool", "b", true, 1400);
        s.pending("approval", "a", true, 1500);
        s.pending("approval", "b", true, 1600);
        s.pending("approval", "a", false, 1700);
        assert_eq!(s.turns[0].phases.back().unwrap().kind, "approval");
        s.pending("approval", "b", false, 1800);
        assert_eq!(s.turns[0].phases.back().unwrap().kind, "tool");
        s.pending("tool", "a", false, 1900);
        assert_eq!(s.turns[0].phases.back().unwrap().kind, "tool");
        s.pending("question", "q", true, 2000);
        s.pending("question", "q", false, 2100);
        s.pending("tool", "b", false, 2200);
        assert_eq!(s.turns[0].phases.back().unwrap().kind, "between_steps");
    }
    #[test]
    fn retries_split_attempts_clock_regression_clamps_and_end_flushes() {
        let mut s = start();
        s.apply_logged(&text(2, 1300, "abcd"));
        s.start_step(0, 1, 2300, true);
        s.apply_logged(&text(3, 2400, "abcdefgh"));
        s.apply_logged(&text(4, 2300, "ij"));
        assert_eq!(s.turns[0].samples.back().unwrap().time_ms, 2000);
        assert_eq!(s.turns[0].samples[1].attempt, 1);
        assert!(s.apply_logged(&log(
            5,
            2500,
            EventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Cancelled
            }
        )));
        assert!(!s.apply_logged(&text(6, 2600, "late")));
        assert_eq!(s.turns[0].samples[1].text_units, 10);
    }
    #[test]
    fn long_goals_have_global_bounds_and_never_keep_contents() {
        let mut s = start();
        for i in 2..10002 {
            s.apply_logged(&text(i, i * 1000, "private-source-do-not-retain"));
        }
        assert_eq!(s.turns[0].samples.len(), MAX_SAMPLES);
        assert!(s.turns[0].truncated);
        assert!(!s.view().to_string().contains("private-source"));
        for i in 0..2000 {
            s.start_step(0, i, i as u64 * 1000 + 20_000_000, false);
            s.phase("tool", 20_000_001 + i as u64 * 1000);
        }
        assert!(s.turns.iter().map(|t| t.requests.len()).sum::<usize>() <= MAX_REQUESTS);
        assert!(s.turns.iter().map(|t| t.phases.len()).sum::<usize>() <= MAX_PHASES);
        assert!(s.view().to_string().len() < 150_000);
    }
    #[test]
    fn restart_serialization_matches_uninterrupted_and_legacy_cache_is_accepted() {
        let mut s = start();
        s.apply_logged(&text(2, 1300, "abcd"));
        let mut restored: PerformanceTimelineState =
            serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        for event in [
            text(3, 2100, "hello"),
            log(
                4,
                2300,
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                },
            ),
        ] {
            s.apply_logged(&event);
            restored.apply_logged(&event);
        }
        assert_eq!(s.view(), restored.view());
        let mut legacy =
            serde_json::to_value(crate::metrics::MetricsProjectionState::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("performance");
        let metrics: crate::metrics::MetricsProjectionState =
            serde_json::from_value(legacy).unwrap();
        assert_eq!(metrics.performance_timeline()["turns"], json!([]));
    }
    #[test]
    fn web_and_durable_stream_paths_have_identical_contract() {
        let mut a = start();
        let mut b = PerformanceTimelineState::default();
        b.apply(&json!({"seq":0,"time":1000,"type":"turn/start","data":{"turn":0}}));
        b.apply(&json!({"seq":1,"time":1100,"type":"step/start","data":{"turn":0,"step":1}}));
        a.apply_logged(&text(2, 1300, "abcd你好"));
        b.apply(&json!({"seq":2,"time":1300,"type":"assistant/chunk","data":{"turn":0,"step":1,"chunk":{"type":"text-delta","text":"abcd你好"}}}));
        assert_eq!(a.view(), b.view());
    }
    #[test]
    fn shared_wire_fixture_is_produced_by_the_real_host_reducer() {
        let mut s = start();
        s.route("test-provider", "test-model");
        s.apply_logged(&log(
            2,
            1400,
            EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::ReasoningDelta("thinking".into()),
            },
        ));
        s.apply_logged(&text(3, 2200, "abcd你好"));
        s.apply_logged(&text(4, 3200, "abcdefgh"));
        s.apply_logged(&log(
            5,
            3500,
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message: Message::assistant("abcd你好abcdefgh"),
                usage: Some(json!({"output_tokens":9,"reasoning_tokens":2})),
            },
        ));
        s.apply_logged(&log(
            6,
            3600,
            EventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
            },
        ));
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../protocol/fixtures/performance-timeline-v1.json");
        if std::env::var_os("XHARNESS_UPDATE_PERFORMANCE_FIXTURE").is_some() {
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&s.view()).unwrap() + "\n",
            )
            .unwrap();
        }
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(s.view(), fixture);
    }
}
