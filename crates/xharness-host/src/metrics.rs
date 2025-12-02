use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Map, Value};
use xharness_core::TokenUsage;

/// One changed public projection produced while applying a Session event.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MetricsProjectionUpdate {
    pub(crate) key: &'static str,
    pub(crate) value: Value,
}

/// Deterministic, rebuildable metric projection over Web-compatible Session
/// events. The append-only Session remains the source of truth; this state is
/// only a Host cache used by History, Session List and live projection frames.
#[derive(Clone, Debug, Default)]
pub(crate) struct MetricsProjectionState {
    token_usage: TokenUsageProjectionState,
    session_stats: SessionStatsProjectionState,
}

impl MetricsProjectionState {
    pub(crate) fn rebuild<'a>(events: impl IntoIterator<Item = &'a Value>) -> Self {
        let mut state = Self::default();
        for event in events {
            state.apply(event);
        }
        state
    }

    /// Apply one event and return only public views that changed. In-flight
    /// boundaries such as `step/start` and `tool/call` mutate private fold
    /// state without publishing an identical zero-valued projection.
    pub(crate) fn apply(&mut self, event: &Value) -> Vec<MetricsProjectionUpdate> {
        let token_before = self.token_usage.view();
        let stats_before = self.session_stats.view();

        self.token_usage.apply(event);
        self.session_stats.apply(event);

        let token_after = self.token_usage.view();
        let stats_after = self.session_stats.view();
        let mut updates = Vec::with_capacity(2);
        if token_after != token_before {
            updates.push(MetricsProjectionUpdate {
                key: "tokenUsage",
                value: token_after,
            });
        }
        if stats_after != stats_before {
            updates.push(MetricsProjectionUpdate {
                key: "sessionStats",
                value: stats_after,
            });
        }
        updates
    }

    pub(crate) fn token_usage(&self) -> Value {
        self.token_usage.view()
    }

    pub(crate) fn session_stats(&self) -> Value {
        self.session_stats.view()
    }
}

/// Convert the provider-neutral Rust usage type at the Web boundary. Internal
/// serialization stays snake_case; the frozen DeepSeek Harness wire contract
/// is camelCase.
pub(crate) fn web_token_usage_from_core(usage: &TokenUsage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cacheReadTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
        "reasoningTokens": usage.reasoning_tokens,
    })
}

/// Normalize usage restored from Session JSON. Older XHarness logs contain
/// snake_case values while upstream-compatible logs may already be camelCase.
/// Returning `None` for malformed data prevents a bogus zero sample from
/// entering durable token accounting.
pub(crate) fn web_token_usage(usage: &Value) -> Option<Value> {
    let input_tokens = usage_u64(usage, "inputTokens", "input_tokens")?;
    let output_tokens = usage_u64(usage, "outputTokens", "output_tokens")?;
    let mut normalized = Map::new();
    normalized.insert("inputTokens".to_owned(), json!(input_tokens));
    normalized.insert("outputTokens".to_owned(), json!(output_tokens));
    insert_optional_usage(
        &mut normalized,
        usage,
        "cacheReadTokens",
        "cache_read_tokens",
    );
    insert_optional_usage(
        &mut normalized,
        usage,
        "cacheWriteTokens",
        "cache_write_tokens",
    );
    insert_optional_usage(
        &mut normalized,
        usage,
        "reasoningTokens",
        "reasoning_tokens",
    );
    Some(Value::Object(normalized))
}

fn insert_optional_usage(
    normalized: &mut Map<String, Value>,
    usage: &Value,
    camel: &'static str,
    snake: &'static str,
) {
    if let Some(value) = usage_u64(usage, camel, snake) {
        normalized.insert(camel.to_owned(), json!(value));
    }
}

fn usage_u64(usage: &Value, camel: &str, snake: &str) -> Option<u64> {
    usage
        .get(camel)
        .or_else(|| usage.get(snake))
        .and_then(Value::as_u64)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageProjection {
    uncached_input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

impl TokenUsageProjection {
    fn from_usage(usage: &Value) -> Option<Self> {
        let normalized = web_token_usage(usage)?;
        Some(Self {
            uncached_input_tokens: normalized.get("inputTokens")?.as_u64()?,
            output_tokens: normalized.get("outputTokens")?.as_u64()?,
            cache_read_tokens: normalized
                .get("cacheReadTokens")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            cache_write_tokens: normalized
                .get("cacheWriteTokens")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        })
    }

    fn replacing(self, previous: Option<Self>, next: Self) -> Self {
        let previous = previous.unwrap_or_default();
        Self {
            uncached_input_tokens: self
                .uncached_input_tokens
                .saturating_sub(previous.uncached_input_tokens)
                .saturating_add(next.uncached_input_tokens),
            output_tokens: self
                .output_tokens
                .saturating_sub(previous.output_tokens)
                .saturating_add(next.output_tokens),
            cache_read_tokens: self
                .cache_read_tokens
                .saturating_sub(previous.cache_read_tokens)
                .saturating_add(next.cache_read_tokens),
            cache_write_tokens: self
                .cache_write_tokens
                .saturating_sub(previous.cache_write_tokens)
                .saturating_add(next.cache_write_tokens),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UsageSample {
    turn: u32,
    step: u32,
    buckets: TokenUsageProjection,
}

#[derive(Clone, Debug, Default)]
struct TokenUsageProjectionState {
    totals: TokenUsageProjection,
    last: Option<UsageSample>,
}

impl TokenUsageProjectionState {
    fn apply(&mut self, event: &Value) {
        let Some((turn, step, usage)) = usage_sample(event) else {
            return;
        };
        let Some(buckets) = TokenUsageProjection::from_usage(usage) else {
            return;
        };
        let previous = self
            .last
            .filter(|sample| sample.turn == turn && sample.step == step)
            .map(|sample| sample.buckets);
        if previous == Some(buckets) {
            return;
        }
        self.totals = self.totals.replacing(previous, buckets);
        self.last = Some(UsageSample {
            turn,
            step,
            buckets,
        });
    }

    fn view(&self) -> Value {
        serde_json::to_value(self.totals).expect("token usage projection is serializable")
    }
}

fn usage_sample(event: &Value) -> Option<(u32, u32, &Value)> {
    let data = event.get("data")?;
    let turn = value_u32(data.get("turn")?)?;
    let step = value_u32(data.get("step")?)?;
    match event.get("type")?.as_str()? {
        "assistant/chunk" => {
            let chunk = data.get("chunk")?;
            (chunk.get("type")?.as_str()? == "usage")
                .then(|| chunk.get("usage"))
                .flatten()
                .map(|usage| (turn, step, usage))
        }
        "assistant/message" => data.get("usage").map(|usage| (turn, step, usage)),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug)]
struct OpenStep {
    turn: u32,
    step: u32,
    start_time: u64,
    first_token_time: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatsProjection {
    turns: u64,
    steps: u64,
    llm_ms: u64,
    tool_ms: u64,
    ttft_ms: u64,
    ttft_steps: u64,
    decode_ms: u64,
    decode_tokens: u64,
}

#[derive(Clone, Debug, Default)]
struct SessionStatsProjectionState {
    totals: SessionStatsProjection,
    last_turn: Option<u32>,
    open_step: Option<OpenStep>,
    pending_calls: BTreeMap<String, u64>,
}

impl SessionStatsProjectionState {
    fn apply(&mut self, event: &Value) {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            return;
        };
        let Some(data) = event.get("data") else {
            return;
        };
        let time = event.get("time").and_then(Value::as_u64);
        match event_type {
            "step/start" => {
                let Some((turn, step, time)) = coordinates_with_time(data, time) else {
                    return;
                };
                self.open_step = Some(OpenStep {
                    turn,
                    step,
                    start_time: time,
                    first_token_time: None,
                });
            }
            "assistant/chunk" => {
                let Some((turn, step)) = coordinates(data) else {
                    return;
                };
                let Some(time) = time else {
                    return;
                };
                let Some(open) = self.open_step.as_mut() else {
                    return;
                };
                if open.turn != turn || open.step != step || open.first_token_time.is_some() {
                    return;
                }
                if data.get("chunk").is_some_and(is_token_delta) {
                    open.first_token_time = Some(time);
                }
            }
            "assistant/message" => {
                let Some((turn, step)) = coordinates(data) else {
                    return;
                };
                let Some(time) = time else {
                    return;
                };
                let Some(open) = self.open_step else {
                    return;
                };
                if open.turn != turn || open.step != step {
                    return;
                }
                self.totals.llm_ms = self
                    .totals
                    .llm_ms
                    .saturating_add(time.saturating_sub(open.start_time));
                if let Some(first_token_time) = open.first_token_time {
                    self.totals.ttft_ms = self
                        .totals
                        .ttft_ms
                        .saturating_add(first_token_time.saturating_sub(open.start_time));
                    self.totals.ttft_steps = self.totals.ttft_steps.saturating_add(1);
                    if let Some(output_tokens) = data
                        .get("usage")
                        .and_then(web_token_usage)
                        .and_then(|usage| usage.get("outputTokens").and_then(Value::as_u64))
                    {
                        self.totals.decode_ms = self
                            .totals
                            .decode_ms
                            .saturating_add(time.saturating_sub(first_token_time));
                        self.totals.decode_tokens =
                            self.totals.decode_tokens.saturating_add(output_tokens);
                    }
                }
                self.open_step = None;
            }
            "tool/call" => {
                let Some(time) = time else {
                    return;
                };
                let Some(call_id) = data.get("callId").and_then(Value::as_str) else {
                    return;
                };
                self.pending_calls.insert(call_id.to_owned(), time);
            }
            "tool/result" => {
                let Some(time) = time else {
                    return;
                };
                let Some(call_id) = data
                    .pointer("/message/source/callId")
                    .and_then(Value::as_str)
                else {
                    return;
                };
                let Some(dispatched) = self.pending_calls.remove(call_id) else {
                    return;
                };
                self.totals.tool_ms = self
                    .totals
                    .tool_ms
                    .saturating_add(time.saturating_sub(dispatched));
            }
            "step/end" => {
                let Some((turn, _step)) = coordinates(data) else {
                    return;
                };
                if self.last_turn != Some(turn) {
                    self.totals.turns = self.totals.turns.saturating_add(1);
                    self.last_turn = Some(turn);
                }
                self.totals.steps = self.totals.steps.saturating_add(1);
                self.open_step = None;
            }
            "turn/end" => self.pending_calls.clear(),
            _ => {}
        }
    }

    fn view(&self) -> Value {
        serde_json::to_value(&self.totals).expect("session stats projection is serializable")
    }
}

fn coordinates(data: &Value) -> Option<(u32, u32)> {
    Some((value_u32(data.get("turn")?)?, value_u32(data.get("step")?)?))
}

fn coordinates_with_time(data: &Value, time: Option<u64>) -> Option<(u32, u32, u64)> {
    let (turn, step) = coordinates(data)?;
    Some((turn, step, time?))
}

fn value_u32(value: &Value) -> Option<u32> {
    u32::try_from(value.as_u64()?).ok()
}

fn is_token_delta(chunk: &Value) -> bool {
    match chunk.get("type").and_then(Value::as_str) {
        Some("text-delta" | "reasoning-delta") => chunk
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty()),
        Some("tool-call-delta") => {
            chunk
                .get("argumentsDelta")
                .and_then(Value::as_str)
                .is_some_and(|arguments| !arguments.is_empty())
                || chunk.get("name").is_some_and(|name| !name.is_null())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(seq: u64, time: u64, event_type: &str, data: Value) -> Value {
        json!({"type": event_type, "seq": seq, "time": time, "data": data})
    }

    #[test]
    fn usage_mapper_accepts_old_snake_case_and_emits_camel_case() {
        assert_eq!(
            web_token_usage(&json!({
                "input_tokens": 10,
                "output_tokens": 4,
                "cache_read_tokens": 90,
                "cache_write_tokens": 3,
                "reasoning_tokens": 2,
            })),
            Some(json!({
                "inputTokens": 10,
                "outputTokens": 4,
                "cacheReadTokens": 90,
                "cacheWriteTokens": 3,
                "reasoningTokens": 2,
            }))
        );
    }

    #[test]
    fn token_usage_replaces_the_same_step_sample_instead_of_double_counting() {
        let chunk = event(
            1,
            10,
            "assistant/chunk",
            json!({
                "turn": 0,
                "step": 1,
                "chunk": {"type": "usage", "usage": {"inputTokens": 10, "outputTokens": 3}}
            }),
        );
        let message = event(
            2,
            11,
            "assistant/message",
            json!({
                "turn": 0,
                "step": 1,
                "usage": {"inputTokens": 12, "outputTokens": 5, "cacheReadTokens": 8}
            }),
        );
        let next = event(
            3,
            12,
            "assistant/message",
            json!({
                "turn": 0,
                "step": 2,
                "usage": {"inputTokens": 7, "outputTokens": 2, "cacheWriteTokens": 4}
            }),
        );
        let state = MetricsProjectionState::rebuild([&chunk, &message, &next]);
        assert_eq!(
            state.token_usage(),
            json!({
                "uncachedInputTokens": 19,
                "outputTokens": 7,
                "cacheReadTokens": 8,
                "cacheWriteTokens": 4,
            })
        );
    }

    #[test]
    fn session_stats_fold_first_token_decode_and_tool_wall_times() {
        let events = [
            event(1, 1_000, "step/start", json!({"turn": 0, "step": 1})),
            event(
                2,
                1_100,
                "assistant/chunk",
                json!({"turn": 0, "step": 1, "chunk": {"type": "text-delta", "index": 0, "text": ""}}),
            ),
            event(
                3,
                1_250,
                "assistant/chunk",
                json!({"turn": 0, "step": 1, "chunk": {"type": "reasoning-delta", "index": 0, "text": "x"}}),
            ),
            event(4, 1_300, "tool/call", json!({"callId": "call-1"})),
            event(
                5,
                1_500,
                "tool/result",
                json!({"message": {"source": {"kind": "tool", "callId": "call-1"}}}),
            ),
            event(
                6,
                2_000,
                "assistant/message",
                json!({"turn": 0, "step": 1, "usage": {"inputTokens": 10, "outputTokens": 30}}),
            ),
            event(7, 2_001, "step/end", json!({"turn": 0, "step": 1})),
        ];
        let state = MetricsProjectionState::rebuild(events.iter());
        assert_eq!(
            state.session_stats(),
            json!({
                "turns": 1,
                "steps": 1,
                "llmMs": 1000,
                "toolMs": 200,
                "ttftMs": 250,
                "ttftSteps": 1,
                "decodeMs": 750,
                "decodeTokens": 30,
            })
        );
    }

    #[test]
    fn missing_usage_keeps_ttft_but_does_not_invent_throughput() {
        let events = [
            event(1, 100, "step/start", json!({"turn": 0, "step": 1})),
            event(
                2,
                130,
                "assistant/chunk",
                json!({"turn": 0, "step": 1, "chunk": {"type": "text-delta", "text": "a"}}),
            ),
            event(3, 200, "assistant/message", json!({"turn": 0, "step": 1})),
            event(4, 201, "step/end", json!({"turn": 0, "step": 1})),
        ];
        let state = MetricsProjectionState::rebuild(events.iter());
        assert_eq!(
            state.session_stats(),
            json!({
                "turns": 1,
                "steps": 1,
                "llmMs": 100,
                "toolMs": 0,
                "ttftMs": 30,
                "ttftSteps": 1,
                "decodeMs": 0,
                "decodeTokens": 0,
            })
        );
    }
}
