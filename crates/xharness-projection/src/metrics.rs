use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use xharness_core::TokenUsage;
use xharness_session::{AssistantChunk, EventData, LoggedEvent};

/// One changed public projection produced while applying a Session event.
#[derive(Clone, Debug, PartialEq)]
pub struct MetricsProjectionUpdate {
    pub key: &'static str,
    pub value: Value,
}

/// Deterministic, rebuildable metric projection over Web-compatible Session
/// events. The append-only Session remains the source of truth; this state is
/// only a Host cache used by History, Session List and live projection frames.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MetricsProjectionState {
    token_usage: TokenUsageProjectionState,
    daily_token_usage: DailyTokenUsageProjectionState,
    session_stats: SessionStatsProjectionState,
    context_pressure: ContextPressureProjectionState,
}

impl MetricsProjectionState {
    pub fn rebuild<'a>(events: impl IntoIterator<Item = &'a Value>) -> Self {
        let mut state = Self::default();
        for event in events {
            state.apply(event);
        }
        state
    }

    /// Rebuild metrics from the durable typed log without materializing the
    /// browser event projection. Startup uses this path before any transport
    /// exists; public JSON views are created only when a caller asks for them.
    pub fn rebuild_logged<'a>(events: impl IntoIterator<Item = &'a LoggedEvent>) -> Self {
        let mut state = Self::default();
        for event in events {
            state.apply_logged(event);
        }
        state
    }

    /// Advance a private recovery fold without materializing Web event JSON.
    pub fn apply_logged(&mut self, event: &LoggedEvent) {
        self.token_usage.apply_logged(event.data());
        self.daily_token_usage.apply_logged(event);
        self.session_stats.apply_logged(event);
        self.context_pressure.apply_logged(event.data());
    }

    /// Apply one event and return only public views that changed. In-flight
    /// boundaries such as `step/start` and `tool/call` mutate private fold
    /// state without publishing an identical zero-valued projection.
    pub fn apply(&mut self, event: &Value) -> Vec<MetricsProjectionUpdate> {
        let token_before = self.token_usage.view();
        let stats_before = self.session_stats.view();
        let pressure_before = self.context_pressure.view();

        self.token_usage.apply(event);
        let daily_changed = self.daily_token_usage.apply(event);
        self.session_stats.apply(event);
        self.context_pressure.apply(event);

        let token_after = self.token_usage.view();
        let stats_after = self.session_stats.view();
        let pressure_after = self.context_pressure.view();
        let mut updates = Vec::with_capacity(4);
        if token_after != token_before {
            updates.push(MetricsProjectionUpdate {
                key: "tokenUsage",
                value: token_after,
            });
        }
        if daily_changed {
            updates.push(MetricsProjectionUpdate {
                key: "dailyTokenUsage",
                value: self.daily_token_usage.view(),
            });
        }
        if stats_after != stats_before {
            updates.push(MetricsProjectionUpdate {
                key: "sessionStats",
                value: stats_after,
            });
        }
        if pressure_after != pressure_before {
            updates.push(MetricsProjectionUpdate {
                key: "contextPressure",
                value: pressure_after,
            });
        }
        updates
    }

    pub fn token_usage(&self) -> Value {
        self.token_usage.view()
    }

    /// UTC calendar-day usage reconstructed from immutable event timestamps.
    /// A fork-origin marker discards copied parent usage, so each provider
    /// request contributes to the account-wide profile exactly once.
    pub fn daily_token_usage(&self) -> Value {
        self.daily_token_usage.view()
    }

    pub fn session_stats(&self) -> Value {
        self.session_stats.view()
    }

    pub fn context_pressure(&self) -> Value {
        self.context_pressure.view()
    }
}

/// Latest provider prompt pressure paired with the latest known route
/// capacity. `request/context` is authoritative for new logs; the request
/// header fallback keeps pre-migration sessions useful after restart.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ContextPressureProjectionState {
    pressure_tokens: Option<u64>,
    projected_tokens: Option<u64>,
    composition: Option<Value>,
    context_window: Option<u64>,
    request_context_seen: bool,
    active: Option<(u32, u32)>,
    awaiting_request: bool,
    measurement: Value,
    phase: String,
    accuracy: String,
}
impl ContextPressureProjectionState {
    fn apply(&mut self, event: &Value) {
        let Some(data) = event.get("data") else {
            return;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "step/start" => self.step_started(
                data["turn"]
                    .as_u64()
                    .zip(data["step"].as_u64())
                    .map(|(turn, step)| (turn as u32, step as u32)),
            ),
            "request/header" => self.request_started(
                data.pointer("/header/options/tokenBudget"),
                data.pointer("/header/options/measurement"),
                data.pointer("/header/options/contextComposition"),
            ),
            "request/context" => self.request_context(
                data.get("contextWindow")
                    .or_else(|| data.get("context_window"))
                    .and_then(Value::as_u64),
            ),
            "session/model-selected" => self.model_selected(),
            "assistant/chunk" | "assistant/message" => {
                let Some((turn, step, usage)) = usage_sample(event) else {
                    return;
                };
                self.usage(turn, step, usage);
            }
            "tool/result" | "user/message" | "compaction/summary" => self.history_changed(),
            "turn/end" => self.turn_ended(),
            _ => {}
        }
    }

    fn apply_logged(&mut self, event: &EventData) {
        match event {
            EventData::StepStart { turn, step } => {
                self.step_started(Some((web_turn(*turn), *step)))
            }
            EventData::RequestHeader { header } => self.request_started(
                header.options.get("tokenBudget"),
                header.options.get("measurement"),
                header.options.get("contextComposition"),
            ),
            EventData::RequestContext { context_window, .. } => {
                self.request_context(*context_window)
            }
            EventData::SessionModelSelected { .. } => self.model_selected(),
            EventData::AssistantChunk {
                turn,
                step,
                chunk: AssistantChunk::Usage(usage),
            }
            | EventData::AssistantMessage {
                turn,
                step,
                usage: Some(usage),
                ..
            } => self.usage(web_turn(*turn), *step, usage),
            EventData::ToolResult { .. }
            | EventData::UserMessage { .. }
            | EventData::CompactionSummary { .. } => self.history_changed(),
            EventData::TurnEnd { .. } => self.turn_ended(),
            _ => {}
        }
    }

    fn step_started(&mut self, active: Option<(u32, u32)>) {
        self.awaiting_request = false;
        self.measurement = Value::Null;
        self.accuracy.clear();
        self.active = active;
        self.pressure_tokens = None;
        self.projected_tokens = None;
        self.composition = None;
        self.phase = "preparing".into();
    }

    fn request_started(
        &mut self,
        budget: Option<&Value>,
        measurement: Option<&Value>,
        composition: Option<&Value>,
    ) {
        self.awaiting_request = false;
        self.composition = composition.cloned();
        self.projected_tokens = budget
            .and_then(|value| {
                value
                    .pointer("/estimate/totalInputTokens")
                    .or_else(|| value.pointer("/estimate/total_input_tokens"))
            })
            .and_then(Value::as_u64);
        self.accuracy = budget
            .and_then(|value| value["accuracy"].as_str())
            .unwrap_or("estimated")
            .into();
        self.measurement = measurement.cloned().unwrap_or_else(|| {
            json!({
                "turn": self.active.map(|active| active.0),
                "step": self.active.map(|active| active.1),
                "source": "legacy_request",
            })
        });
        self.pressure_tokens = None;
        self.phase = "in_flight".into();
        if !self.request_context_seen {
            self.context_window = budget
                .and_then(|value| {
                    value
                        .get("contextWindowTokens")
                        .or_else(|| value.get("context_window_tokens"))
                })
                .and_then(Value::as_u64);
        }
    }

    fn request_context(&mut self, context_window: Option<u64>) {
        self.request_context_seen = true;
        self.context_window = context_window;
    }

    fn model_selected(&mut self) {
        self.pressure_tokens = None;
        self.projected_tokens = None;
        self.composition = None;
        self.active = None;
        self.awaiting_request = true;
        self.measurement = Value::Null;
        self.phase = "model_changed".into();
        self.context_window = None;
        self.request_context_seen = false;
    }

    fn usage(&mut self, turn: u32, step: u32, usage: &Value) {
        if self.awaiting_request || self.active.is_some_and(|active| active != (turn, step)) {
            return;
        }
        let Some(usage) = TokenUsageProjection::from_usage(usage) else {
            return;
        };
        self.pressure_tokens = Some(
            usage
                .uncached_input_tokens
                .saturating_add(usage.cache_read_tokens)
                .saturating_add(usage.cache_write_tokens),
        );
        if self.phase != "history_changed" {
            self.phase = "measured".into();
        }
    }

    fn history_changed(&mut self) {
        self.phase = "history_changed".into();
    }

    fn turn_ended(&mut self) {
        if self.pressure_tokens.is_none() {
            self.phase = "unmeasured".into();
        }
    }
    fn view(&self) -> Value {
        let mut v = Map::new();
        if let Some(n) = self.pressure_tokens {
            v.insert("pressureTokens".into(), json!(n));
            v.insert("pressureAccuracy".into(), json!("provider_reported"));
        }
        if let Some(n) = self.projected_tokens {
            v.insert("projectedTokens".into(), json!(n));
            v.insert("projectedAccuracy".into(), json!(self.accuracy));
        }
        if let Some(n) = self.context_window {
            v.insert("contextWindow".into(), json!(n));
        }
        if let Some(composition) = &self.composition {
            v.insert("composition".into(), composition.clone());
        }
        if !v.is_empty() {
            v.insert("measurement".into(), self.measurement.clone());
            v.insert("phase".into(), json!(self.phase));
            v.insert(
                "accuracy".into(),
                json!(if self.pressure_tokens.is_some() {
                    "provider_reported"
                } else {
                    &self.accuracy
                }),
            );
        }
        Value::Object(v)
    }
}

/// Convert the provider-neutral Rust usage type at the Web boundary. Internal
/// serialization stays snake_case; the frozen upstream wire contract
/// is camelCase.
pub fn web_token_usage_from_core(usage: &TokenUsage) -> Value {
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
pub fn web_token_usage(usage: &Value) -> Option<Value> {
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageProjection {
    uncached_input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

impl TokenUsageProjection {
    fn from_usage(usage: &Value) -> Option<Self> {
        Some(Self {
            uncached_input_tokens: usage_u64(usage, "inputTokens", "input_tokens")?,
            output_tokens: usage_u64(usage, "outputTokens", "output_tokens")?,
            cache_read_tokens: usage_u64(usage, "cacheReadTokens", "cache_read_tokens")
                .unwrap_or_default(),
            cache_write_tokens: usage_u64(usage, "cacheWriteTokens", "cache_write_tokens")
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct UsageSample {
    turn: u32,
    step: u32,
    buckets: TokenUsageProjection,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct TokenUsageProjectionState {
    totals: TokenUsageProjection,
    last: Option<UsageSample>,
}

impl TokenUsageProjectionState {
    fn apply(&mut self, event: &Value) {
        let Some((turn, step, usage)) = usage_sample(event) else {
            return;
        };
        self.apply_usage(turn, step, usage);
    }

    fn apply_logged(&mut self, event: &EventData) {
        match event {
            EventData::AssistantChunk {
                turn,
                step,
                chunk: AssistantChunk::Usage(usage),
            }
            | EventData::AssistantMessage {
                turn,
                step,
                usage: Some(usage),
                ..
            } => self.apply_usage(web_turn(*turn), *step, usage),
            _ => {}
        }
    }

    fn apply_usage(&mut self, turn: u32, step: u32, usage: &Value) {
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

const DAY_MS: u64 = 86_400_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct DailyUsageSample {
    turn: u32,
    step: u32,
    day_start_ms: u64,
    buckets: TokenUsageProjection,
}

/// Rebuildable UTC-day accounting. A usage chunk and the final assistant
/// message for one step are revisions of one sample, never two requests.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct DailyTokenUsageProjectionState {
    days: BTreeMap<u64, TokenUsageProjection>,
    last: Option<DailyUsageSample>,
}

impl DailyTokenUsageProjectionState {
    fn apply(&mut self, event: &Value) -> bool {
        if event.get("type").and_then(Value::as_str) == Some("xharness/internal")
            && event.pointer("/data/kind").and_then(Value::as_str) == Some("fork-origin")
        {
            return self.reset_fork();
        }
        let Some((turn, step, usage)) = usage_sample(event) else {
            return false;
        };
        let Some(time) = event.get("time").and_then(Value::as_u64) else {
            return false;
        };
        self.apply_usage(turn, step, time, usage)
    }

    fn apply_logged(&mut self, event: &LoggedEvent) -> bool {
        match event.data() {
            EventData::SessionForkOrigin { .. } => self.reset_fork(),
            EventData::AssistantChunk {
                turn,
                step,
                chunk: AssistantChunk::Usage(usage),
            }
            | EventData::AssistantMessage {
                turn,
                step,
                usage: Some(usage),
                ..
            } => self.apply_usage(web_turn(*turn), *step, event.timestamp_ms, usage),
            _ => false,
        }
    }

    fn reset_fork(&mut self) -> bool {
        let changed = !self.days.is_empty();
        self.days.clear();
        self.last = None;
        changed
    }

    fn apply_usage(&mut self, turn: u32, step: u32, time: u64, usage: &Value) -> bool {
        let Some(buckets) = TokenUsageProjection::from_usage(usage) else {
            return false;
        };
        let day_start_ms = time / DAY_MS * DAY_MS;
        let previous = self
            .last
            .filter(|sample| sample.turn == turn && sample.step == step);
        if previous
            .is_some_and(|sample| sample.day_start_ms == day_start_ms && sample.buckets == buckets)
        {
            return false;
        }
        if let Some(sample) = previous {
            if let Some(total) = self.days.get_mut(&sample.day_start_ms) {
                *total = total.replacing(Some(sample.buckets), TokenUsageProjection::default());
                if *total == TokenUsageProjection::default() {
                    self.days.remove(&sample.day_start_ms);
                }
            }
        }
        if buckets != TokenUsageProjection::default() {
            let total = self.days.entry(day_start_ms).or_default();
            *total = total.replacing(None, buckets);
        }
        self.last = Some(DailyUsageSample {
            turn,
            step,
            day_start_ms,
            buckets,
        });
        true
    }

    fn view(&self) -> Value {
        Value::Array(
            self.days
                .iter()
                .map(|(day_start_ms, buckets)| {
                    json!({
                        "dayStartMs": day_start_ms,
                        "uncachedInputTokens": buckets.uncached_input_tokens,
                        "cacheReadTokens": buckets.cache_read_tokens,
                        "cacheWriteTokens": buckets.cache_write_tokens,
                        "outputTokens": buckets.output_tokens,
                    })
                })
                .collect(),
        )
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

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct OpenStep {
    turn: u32,
    step: u32,
    start_time: u64,
    first_token_time: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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

    fn apply_logged(&mut self, event: &LoggedEvent) {
        let time = event.timestamp_ms;
        match event.data() {
            EventData::StepStart { turn, step } => {
                self.open_step = Some(OpenStep {
                    turn: web_turn(*turn),
                    step: *step,
                    start_time: time,
                    first_token_time: None,
                });
            }
            EventData::AssistantChunk { turn, step, chunk } => {
                let Some(open) = self.open_step.as_mut() else {
                    return;
                };
                if open.turn != web_turn(*turn)
                    || open.step != *step
                    || open.first_token_time.is_some()
                {
                    return;
                }
                if logged_chunk_is_token_delta(chunk) {
                    open.first_token_time = Some(time);
                }
            }
            EventData::AssistantMessage {
                turn, step, usage, ..
            } => {
                let Some(open) = self.open_step else {
                    return;
                };
                if open.turn != web_turn(*turn) || open.step != *step {
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
                    if let Some(output_tokens) = usage
                        .as_ref()
                        .and_then(TokenUsageProjection::from_usage)
                        .map(|usage| usage.output_tokens)
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
            EventData::ToolCall { call, .. } => {
                self.pending_calls.insert(call.id.clone(), time);
            }
            EventData::ToolResult { result, .. } => {
                let Some(dispatched) = self.pending_calls.remove(&result.call_id) else {
                    return;
                };
                self.totals.tool_ms = self
                    .totals
                    .tool_ms
                    .saturating_add(time.saturating_sub(dispatched));
            }
            EventData::StepEnd { turn, .. } => {
                let turn = web_turn(*turn);
                if self.last_turn != Some(turn) {
                    self.totals.turns = self.totals.turns.saturating_add(1);
                    self.last_turn = Some(turn);
                }
                self.totals.steps = self.totals.steps.saturating_add(1);
                self.open_step = None;
            }
            EventData::TurnEnd { .. } => self.pending_calls.clear(),
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

fn logged_chunk_is_token_delta(chunk: &AssistantChunk) -> bool {
    match chunk {
        AssistantChunk::TextDelta(text) | AssistantChunk::ReasoningDelta(text) => !text.is_empty(),
        // The Web projection always carries a non-null `name`, so its existing
        // token-delta classifier treats every tool-call delta as first output.
        AssistantChunk::ToolCallDelta { .. } => true,
        AssistantChunk::Usage(_) | AssistantChunk::Finish { .. } | AssistantChunk::Provider(_) => {
            false
        }
    }
}

const fn web_turn(turn: u32) -> u32 {
    turn.saturating_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{
        Message, RequestHeader, Revision, SessionEvent, ToolCall, ToolResultData,
    };

    fn event(seq: u64, time: u64, event_type: &str, data: Value) -> Value {
        json!({"type": event_type, "seq": seq, "time": time, "data": data})
    }

    fn logged(seq: u64, time: u64, event: EventData) -> LoggedEvent {
        LoggedEvent {
            seq,
            revision: Revision(seq.saturating_add(1)),
            timestamp_ms: time,
            event: SessionEvent::new(event),
        }
    }

    #[test]
    fn typed_log_rebuild_matches_the_web_metric_reducer() {
        let mut header = RequestHeader::new("test", "test-model");
        header.options.insert(
            "tokenBudget".to_owned(),
            json!({
                "contextWindowTokens": 262_144,
                "accuracy": "calibrated",
                "estimate": {"totalInputTokens": 90},
            }),
        );
        header.options.insert(
            "measurement".to_owned(),
            json!({"requestId": "request-1", "turn": 0, "step": 1}),
        );
        let first_usage = json!({
            "inputTokens": 100,
            "outputTokens": 5,
            "cacheReadTokens": 20,
            "cacheWriteTokens": 3,
        });
        let final_usage = json!({
            "inputTokens": 110,
            "outputTokens": 10,
            "cacheReadTokens": 20,
            "cacheWriteTokens": 3,
        });
        let call = ToolCall {
            id: "call-1".to_owned(),
            provider_call_id: None,
            index: 0,
            name: "read".to_owned(),
            arguments_json: "{}".to_owned(),
        };
        let durable = vec![
            logged(0, 100, EventData::StepStart { turn: 1, step: 1 }),
            logged(1, 105, EventData::RequestHeader { header }),
            logged(
                2,
                106,
                EventData::RequestContext {
                    provider: "test".to_owned(),
                    model: "test-model".to_owned(),
                    context_window: Some(53_248),
                },
            ),
            logged(
                3,
                120,
                EventData::AssistantChunk {
                    turn: 1,
                    step: 1,
                    chunk: AssistantChunk::TextDelta("first".to_owned()),
                },
            ),
            logged(
                4,
                140,
                EventData::AssistantChunk {
                    turn: 1,
                    step: 1,
                    chunk: AssistantChunk::Usage(first_usage.clone()),
                },
            ),
            logged(
                5,
                160,
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("answer"),
                    usage: Some(final_usage.clone()),
                },
            ),
            logged(
                6,
                170,
                EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call,
                },
            ),
            logged(
                7,
                200,
                EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success("call-1", "ok"),
                },
            ),
            logged(8, 210, EventData::StepEnd { turn: 1, step: 1 }),
            logged(
                9,
                215,
                EventData::UserMessage {
                    message: Message::user("next"),
                    surface_replace: None,
                },
            ),
            logged(
                10,
                220,
                EventData::TurnEnd {
                    turn: 1,
                    reason: xharness_session::TurnEndReason::Completed,
                },
            ),
        ];
        let web = vec![
            event(0, 100, "step/start", json!({"turn": 0, "step": 1})),
            event(
                1,
                105,
                "request/header",
                json!({"header": {"options": {
                    "tokenBudget": {
                        "contextWindowTokens": 262_144,
                        "accuracy": "calibrated",
                        "estimate": {"totalInputTokens": 90},
                    },
                    "measurement": {"requestId": "request-1", "turn": 0, "step": 1},
                }}}),
            ),
            event(
                2,
                106,
                "request/context",
                json!({"provider": "test", "model": "test-model", "contextWindow": 53_248}),
            ),
            event(
                3,
                120,
                "assistant/chunk",
                json!({"turn": 0, "step": 1, "chunk": {"type": "text-delta", "text": "first"}}),
            ),
            event(
                4,
                140,
                "assistant/chunk",
                json!({"turn": 0, "step": 1, "chunk": {"type": "usage", "usage": first_usage}}),
            ),
            event(
                5,
                160,
                "assistant/message",
                json!({"turn": 0, "step": 1, "usage": final_usage}),
            ),
            event(
                6,
                170,
                "tool/call",
                json!({"turn": 0, "step": 1, "callId": "call-1"}),
            ),
            event(
                7,
                200,
                "tool/result",
                json!({"turn": 0, "step": 1, "message": {"source": {"kind": "tool", "callId": "call-1"}}}),
            ),
            event(8, 210, "step/end", json!({"turn": 0, "step": 1})),
            event(9, 215, "user/message", json!({})),
            event(10, 220, "turn/end", json!({"turn": 0})),
        ];

        let typed = MetricsProjectionState::rebuild_logged(&durable);
        let projected = MetricsProjectionState::rebuild(&web);
        assert_eq!(typed.token_usage(), projected.token_usage());
        assert_eq!(typed.daily_token_usage(), projected.daily_token_usage());
        assert_eq!(typed.session_stats(), projected.session_stats());
        assert_eq!(typed.context_pressure(), projected.context_pressure());
        assert_eq!(
            typed.session_stats(),
            json!({
                "turns": 1,
                "steps": 1,
                "llmMs": 60,
                "toolMs": 30,
                "ttftMs": 20,
                "ttftSteps": 1,
                "decodeMs": 40,
                "decodeTokens": 10,
            })
        );
        assert_eq!(typed.context_pressure()["phase"], "history_changed");
    }

    #[test]
    fn daily_usage_replaces_stream_sample_across_midnight_and_excludes_fork_prefix() {
        let old = json!({"inputTokens": 30, "outputTokens": 2});
        let revised = json!({"inputTokens": 40, "outputTokens": 4});
        let next = json!({"inputTokens": 10, "outputTokens": 1});
        let durable = vec![
            logged(
                0,
                DAY_MS - 10,
                EventData::AssistantChunk {
                    turn: 1,
                    step: 1,
                    chunk: AssistantChunk::Usage(old.clone()),
                },
            ),
            logged(
                1,
                DAY_MS + 10,
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("done"),
                    usage: Some(revised.clone()),
                },
            ),
            logged(
                2,
                DAY_MS + 20,
                EventData::SessionForkOrigin {
                    parent_session_id: "parent".into(),
                    before_user_seq: None,
                },
            ),
            logged(
                3,
                DAY_MS * 2 + 10,
                EventData::AssistantMessage {
                    turn: 2,
                    step: 1,
                    message: Message::assistant("child"),
                    usage: Some(next.clone()),
                },
            ),
        ];
        let web = [
            event(
                0,
                DAY_MS - 10,
                "assistant/chunk",
                json!({"turn":0,"step":1,"chunk":{"type":"usage","usage":old}}),
            ),
            event(
                1,
                DAY_MS + 10,
                "assistant/message",
                json!({"turn":0,"step":1,"usage":revised}),
            ),
            event(
                2,
                DAY_MS + 20,
                "xharness/internal",
                json!({"kind":"fork-origin"}),
            ),
            event(
                3,
                DAY_MS * 2 + 10,
                "assistant/message",
                json!({"turn":1,"step":1,"usage":next}),
            ),
        ];
        let mut live = MetricsProjectionState::default();
        assert!(live
            .apply(&web[0])
            .iter()
            .any(|item| item.key == "dailyTokenUsage"));
        assert_eq!(live.daily_token_usage().as_array().unwrap().len(), 1);
        live.apply(&web[1]);
        assert_eq!(live.daily_token_usage().as_array().unwrap().len(), 1);
        assert_eq!(live.daily_token_usage()[0]["dayStartMs"], DAY_MS);
        assert_eq!(live.daily_token_usage()[0]["uncachedInputTokens"], 40);
        live.apply(&web[2]);
        assert_eq!(live.daily_token_usage(), json!([]));
        live.apply(&web[3]);
        let cold = MetricsProjectionState::rebuild_logged(&durable);
        assert_eq!(live.daily_token_usage(), cold.daily_token_usage());
        assert_eq!(live.daily_token_usage()[0]["dayStartMs"], DAY_MS * 2);
        assert_eq!(live.daily_token_usage()[0]["uncachedInputTokens"], 10);
    }

    #[test]
    fn context_reading_precision_is_independent_and_history_change_stays_visible() {
        for accuracy in [
            "estimated",
            "calibrated",
            "exact_request",
            "exact_tokenizer",
        ] {
            let events = [
                event(0, 0, "step/start", json!({"turn":1,"step":1})),
                event(
                    1,
                    1,
                    "request/header",
                    json!({"header":{"options":{"tokenBudget":{
                        "contextWindowTokens":1000,"accuracy":accuracy,"estimate":{"totalInputTokens":600}
                    }}}}),
                ),
                event(
                    2,
                    2,
                    "assistant/message",
                    json!({"turn":1,"step":1,"usage":{"inputTokens":200,"cacheReadTokens":100,"outputTokens":0}}),
                ),
                event(3, 3, "compaction/summary", json!({})),
                event(
                    4,
                    4,
                    "assistant/message",
                    json!({"turn":1,"step":1,"usage":{"inputTokens":200,"cacheReadTokens":100,"outputTokens":0}}),
                ),
            ];
            let rebuilt = MetricsProjectionState::rebuild(events.iter()).context_pressure();
            let mut incremental = MetricsProjectionState::default();
            for e in &events {
                incremental.apply(e);
            }
            assert_eq!(incremental.context_pressure(), rebuilt);
            assert_eq!(rebuilt["pressureAccuracy"], "provider_reported");
            assert_eq!(rebuilt["projectedAccuracy"], accuracy);
            assert_eq!(rebuilt["pressureTokens"], 300);
            assert_eq!(rebuilt["projectedTokens"], 600);
            assert_eq!(rebuilt["phase"], "history_changed");
        }
    }

    #[test]
    fn composition_follows_only_the_active_request_and_survives_replay() {
        let composition = json!({
            "systemTokens": 10, "userTokens": 20, "assistantTokens": 30,
            "toolResultTokens": 5, "toolDefinitionTokens": 10,
            "protocolTokens": 2, "totalInputTokens": 77, "accuracy": "estimated"
        });
        let events = [
            event(0, 0, "step/start", json!({"turn": 1, "step": 1})),
            event(
                1,
                1,
                "request/header",
                json!({"header":{"options":{
                    "tokenBudget":{"contextWindowTokens":1000,"estimate":{"totalInputTokens":77}},
                    "contextComposition":composition
                }}}),
            ),
        ];
        let mut live = MetricsProjectionState::default();
        for event in &events {
            live.apply(event);
        }
        assert_eq!(live.context_pressure()["composition"], composition);
        assert_eq!(
            live.context_pressure(),
            MetricsProjectionState::rebuild(events.iter()).context_pressure()
        );
        live.apply(&event(2, 2, "step/start", json!({"turn": 1, "step": 2})));
        assert!(live.context_pressure().get("composition").is_none());
        live.apply(&event(3, 3, "session/model-selected", json!({})));
        assert!(live.context_pressure().get("composition").is_none());
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
    fn context_pressure_uses_request_context_and_latest_provider_sample() {
        let header = event(
            1,
            10,
            "request/header",
            json!({"header": {"options": {"tokenBudget": {
                "contextWindowTokens": 262_144,
                "estimate": {"totalInputTokens": 1_830}
            }}}}),
        );
        let context = event(
            2,
            11,
            "request/context",
            json!({"provider": "llama.cpp-v100", "model": "qwen", "contextWindow": 53_248}),
        );
        let usage = event(
            3,
            12,
            "assistant/message",
            json!({
                "turn": 0,
                "step": 1,
                "usage": {"inputTokens": 130, "cacheReadTokens": 1_700, "cacheWriteTokens": 20, "outputTokens": 4}
            }),
        );
        let state = MetricsProjectionState::rebuild([&header, &context, &usage]);
        assert_eq!(
            state.context_pressure(),
            json!({
                "pressureTokens": 1_850,
                "pressureAccuracy": "provider_reported",
                "projectedTokens": 1_830,
                "projectedAccuracy": "estimated",
                "contextWindow": 53_248,
                "accuracy":"provider_reported", "phase":"measured", "measurement":{"source":"legacy_request","turn":null,"step":null}
            })
        );
    }

    #[test]
    fn context_pressure_recovers_legacy_capacity_from_request_header() {
        let header = event(
            1,
            10,
            "request/header",
            json!({"header": {"options": {"tokenBudget": {
                "context_window_tokens": 262_144,
                "estimate": {"total_input_tokens": 1_830}
            }}}}),
        );
        let state = MetricsProjectionState::rebuild([&header]);
        assert_eq!(
            state.context_pressure(),
            json!({"projectedTokens": 1_830, "projectedAccuracy":"estimated", "contextWindow": 262_144,"accuracy":"estimated","phase":"in_flight","measurement":{"source":"legacy_request","turn":null,"step":null}})
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
    #[test]
    fn context_samples_are_request_scoped_and_rebuildable() {
        let events = vec![
            event(1, 1, "step/start", json!({"turn":1,"step":1})),
            event(
                2,
                2,
                "request/header",
                json!({"header":{"options":{"tokenBudget":{"contextWindowTokens":1000000,"estimate":{"totalInputTokens":415395}},"measurement":{"requestId":"r1","turn":1,"step":1}}}}),
            ),
            event(
                3,
                3,
                "assistant/message",
                json!({"turn":1,"step":1,"usage":{"inputTokens":454,"cacheReadTokens":116992,"outputTokens":10}}),
            ),
        ];
        let mut s = MetricsProjectionState::rebuild(&events);
        assert_eq!(s.context_pressure()["pressureTokens"], 117446);
        s.apply(&events[2]);
        assert_eq!(s.context_pressure()["pressureTokens"], 117446);
        s.apply(&event(4, 4, "step/start", json!({"turn":1,"step":2})));
        s.apply(&events[2]);
        assert!(s.context_pressure().get("pressureTokens").is_none());
        s.apply(&event(
            5,
            5,
            "session/model-selected",
            json!({"provider":"other","model":"small"}),
        ));
        assert!(s.context_pressure().get("contextWindow").is_none());
    }
    #[test]
    fn checkpoint_roundtrip_at_every_cut_preserves_future_metric_folds() {
        let events = vec![
            json!({"type":"step/start","time":1,"data":{"turn":0,"step":1}}),
            json!({"type":"request/context","time":2,"data":{"contextWindow":8192}}),
            json!({"type":"assistant/chunk","time":3,"data":{"turn":0,"step":1,"chunk":{"type":"text-delta","text":"hello"}}}),
            json!({"type":"assistant/chunk","time":86399999,"data":{"turn":0,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":10,"cacheReadTokens":40,"cacheWriteTokens":5}}}}),
            json!({"type":"assistant/message","time":86400001,"data":{"turn":0,"step":1,"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":40,"cacheWriteTokens":5}}}),
            json!({"type":"tool/call","time":86400002,"data":{"call":{"id":"call"}}}),
            json!({"type":"tool/result","time":86400020,"data":{"result":{"callId":"call"}}}),
            json!({"type":"step/end","time":86400021,"data":{"turn":0,"step":1}}),
            json!({"type":"turn/end","time":86400022,"data":{"turn":0}}),
            json!({"type":"session/model-selected","data":{"provider":"p","model":"m"}}),
            json!({"type":"xharness/internal","data":{"kind":"fork-origin"}}),
        ];
        let full = serde_json::to_value(MetricsProjectionState::rebuild(&events)).unwrap();
        for cut in 0..=events.len() {
            let prefix = MetricsProjectionState::rebuild(&events[..cut]);
            let encoded = serde_json::to_vec(&prefix).unwrap();
            let mut recovered: MetricsProjectionState = serde_json::from_slice(&encoded).unwrap();
            for e in &events[cut..] {
                recovered.apply(e);
            }
            assert_eq!(serde_json::to_value(recovered).unwrap(), full, "cut {cut}");
        }
    }
}
