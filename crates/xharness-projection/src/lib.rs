//! Deterministic projection from durable, provider-neutral Session events to
//! the browser wire surface. Both live publication and history replay must use
//! this module so refresh cannot change message semantics.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use xharness_session::{
    AssistantChunk, EventData, InboxMessage, LoggedEvent, Message, MessageRole, RequestHeader,
    Session, SessionHistoryWindow, ToolOutcome, TurnEndReason,
};

pub mod metrics;
use metrics::web_token_usage;

const HISTORY_CHUNK_COALESCE_BYTES: usize = 64 * 1_024;

/// Minimal model identity required by presentation. The projection boundary
/// deliberately does not depend on Host routing, provider clients or runtime
/// configuration.
pub trait ProjectionRoute: Send + Sync {
    fn provider(&self) -> &str;
    fn model(&self) -> &str;
}

/// Canonical live/history assistant block contract. Canonical messages store
/// reasoning separately, so both projections use reasoning, text, then tool
/// slots. Cross-kind interleaving is not claimed when the durable schema does
/// not retain it.
pub fn reasoning_delta(text: &str) -> Value {
    json!({"type":"reasoning-delta", "index":0, "text":text})
}

pub fn text_delta(text: &str) -> Value {
    json!({"type":"text-delta", "index":1, "text":text})
}

pub fn tool_delta(index: usize, id: &str, name: &str, arguments: &str) -> Value {
    json!({"type":"tool-call-delta", "index":index.saturating_add(2),
        "id":id, "name":name, "argumentsDelta":arguments})
}

pub fn assistant_content(text: &str, reasoning: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    if !reasoning.is_empty() {
        blocks.push(json!({"type":"reasoning", "text":reasoning}));
    }
    if !text.is_empty() {
        blocks.push(json!({"type":"text", "text":text}));
    }
    blocks
}

/// One bounded suffix of the deterministic Web projection. Sequence numbers
/// stay identical to the append-only Session log, so eviction never changes a
/// browser cursor.
pub struct ProjectedEventTail {
    pub base_seq: u64,
    pub next_seq: u64,
    pub bytes: usize,
    pub events: Vec<Value>,
}

impl ProjectedEventTail {
    /// Create an empty live cache anchored at the authoritative durable
    /// cursor. Cold history is loaded through `session.history` on demand.
    pub fn empty_at(next_seq: u64) -> Self {
        Self {
            base_seq: next_seq,
            next_seq,
            bytes: 0,
            events: Vec::new(),
        }
    }
}

/// Cursor page returned from the authoritative append-only Session rather
/// than from the Host's bounded live tail.
pub struct ProjectedHistoryPage {
    pub events: Vec<Value>,
    pub has_more: bool,
    pub as_of_seq: Option<u64>,
}

#[derive(Clone)]
pub struct PromptView {
    pub content: Vec<Value>,
    pub source: Value,
    pub rpc_fingerprint: Option<String>,
}

/// Decode the durable inbox metadata once for both Host queue restoration and
/// browser projection. Old journals may omit the UI envelope, but an explicit
/// internal source must never be rewritten into a user draft.
pub fn project_inbox_message(input: &InboxMessage) -> PromptView {
    let metadata = input.source.as_ref();
    let content = metadata
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!({"type": "text", "text": input.message.content})]);
    let source = metadata
        .and_then(|value| value.get("source"))
        .cloned()
        .or_else(|| {
            metadata
                .filter(|value| value.get("kind").is_some())
                .cloned()
        })
        .unwrap_or_else(|| json!({"kind": "user", "restored": true}));
    let rpc_fingerprint = metadata
        .and_then(|value| value.get("rpcFingerprint"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    PromptView {
        content,
        source,
        rpc_fingerprint,
    }
}

#[derive(Default)]
pub struct ProjectionSources {
    prompts: BTreeMap<String, PromptView>,
    compaction_commands: BTreeMap<String, Option<String>>,
}

/// Prepared projection context for streaming one durable Session without
/// rebuilding prompt and request-header indexes for every event.
pub struct SessionProjector<'a> {
    route: &'a dyn ProjectionRoute,
    sources: ProjectionSources,
    initial_request_header_seq: Option<u64>,
}

impl<'a> SessionProjector<'a> {
    pub fn new(session: &Session, route: &'a dyn ProjectionRoute) -> Self {
        Self {
            route,
            sources: prompt_views(session),
            initial_request_header_seq: initial_request_header_seq(session),
        }
    }

    pub fn project(&self, event: &LoggedEvent) -> Value {
        restored_web_event(
            event,
            self.route,
            &self.sources,
            self.initial_request_header_seq,
            None,
        )
    }
}

pub fn project_session_event_range(
    session: &Session,
    route: &dyn ProjectionRoute,
    start: usize,
    end: usize,
) -> Vec<Value> {
    let prompts = prompt_views_for_range(session, start, end);
    project_session_event_range_with_prompts(session, route, &prompts, start, end)
}

/// Derive the optional upstream Tool presentation owned by one durable event.
///
/// The browser deliberately keeps event facts and their presentation apart:
/// the `session/event` envelope carries `event` plus an optional `view`.  A
/// plain `tool/call` therefore remains valid, but specialized shell rows
/// cannot expand unless the Host supplies the matching card contract.
/// Keeping this derivation beside the durable projector makes live delivery,
/// paged history and restart replay use exactly the same data.
pub fn project_session_event_view(session: &Session, event: &LoggedEvent) -> Option<Value> {
    event_view_from_sources(session.events(), &[], event)
}

pub fn project_history_window_view(
    window: &SessionHistoryWindow,
    event: &LoggedEvent,
) -> Option<Value> {
    event_view_from_sources(&window.events, &window.context, event)
}

fn event_view_from_sources(
    events: &[LoggedEvent],
    context: &[LoggedEvent],
    event: &LoggedEvent,
) -> Option<Value> {
    if let Some(view) = compaction_view(events, context, event) {
        return Some(view);
    }
    match event.data() {
        EventData::ToolCall { call, .. } => terminal_call_view(&call.name, &call.arguments_json),
        EventData::ToolResult { result, .. } => {
            let is_shell = events.iter().chain(context).any(|candidate| {
                candidate.seq < event.seq
                    && matches!(
                        candidate.data(),
                        EventData::ToolCall { call, .. }
                            if call.id == result.call_id && is_shell_tool(&call.name)
                    )
            });
            if !is_shell {
                return None;
            }
            // Older journals may predate structured Tool metadata. Their
            // model-facing result is still JSON, so retain restart
            // compatibility without changing the durable schema.
            let parsed = result
                .metadata
                .is_none()
                .then(|| serde_json::from_str::<Value>(&result.content).ok())
                .flatten();
            let metadata = result.metadata.as_ref().or(parsed.as_ref())?;
            terminal_result_view(metadata)
        }
        _ => None,
    }
}

/// A self-contained presentation update for automatic or manual compaction. The end
/// update repeats the committed summary so a paged history window does not
/// need to load the start, summary and replacement events to render it.
fn compaction_view(
    events: &[LoggedEvent],
    context: &[LoggedEvent],
    event: &LoggedEvent,
) -> Option<Value> {
    match event.data() {
        EventData::CompactionStart {
            compaction_id,
            source_command_id,
            ..
        } => Some(json!({
            "for": "compaction",
            "view": {
                "schemaVersion": 1,
                "id": compaction_id,
                "sourceCommandId":source_command_id,
                "phase": "running",
                "anchorSeq": event.seq,
                "time": event.timestamp_ms,
            }
        })),
        EventData::CompactionProgress {
            compaction_id,
            source_command_id,
            progress,
            ..
        } => {
            let start = events.iter().chain(context).find(|e| e.seq < event.seq && matches!(e.data(), EventData::CompactionStart { compaction_id: id, .. } if id == compaction_id))?;
            Some(json!({"for":"compaction", "view": {
                "schemaVersion":1, "id":compaction_id, "sourceCommandId":source_command_id, "phase":"running",
                "anchorSeq":start.seq, "time":start.timestamp_ms,
                "progress":progress, "progressTime":event.timestamp_ms,
            }}))
        }
        EventData::CompactionEnd {
            compaction_id,
            source_command_id,
            error,
            ..
        } => {
            let mut start = None;
            let mut summary = None;
            let mut replacement = None;
            let mut progress = None;
            let mut sources: Vec<_> = events
                .iter()
                .chain(context)
                .filter(|e| {
                    e.seq < event.seq
                        && match e.data() {
                            EventData::CompactionStart {
                                compaction_id: id, ..
                            }
                            | EventData::CompactionSummary {
                                compaction_id: id, ..
                            }
                            | EventData::CompactionProgress {
                                compaction_id: id, ..
                            } => id == compaction_id,
                            EventData::UserMessage {
                                surface_replace: Some(replace),
                                ..
                            } => replace.compaction_id == *compaction_id,
                            _ => false,
                        }
                })
                .collect();
            sources.sort_unstable_by_key(|e| e.seq);
            sources.dedup_by_key(|e| e.seq);
            for candidate in sources.into_iter().rev() {
                match candidate.data() {
                    EventData::CompactionStart {
                        compaction_id: id, ..
                    } if id == compaction_id => {
                        start = Some(candidate);
                        break;
                    }
                    EventData::CompactionProgress {
                        progress: value, ..
                    } if progress.is_none() => {
                        progress = Some(value);
                    }
                    EventData::CompactionSummary {
                        compaction_id: id,
                        summary: text,
                        shadowed_seqs,
                        shadowed_token_count,
                        ..
                    } if id == compaction_id => {
                        summary = Some((candidate.seq, text, shadowed_seqs, shadowed_token_count));
                    }
                    EventData::UserMessage {
                        surface_replace: Some(replace),
                        ..
                    } if replace.compaction_id == *compaction_id => {
                        replacement = Some(candidate);
                    }
                    _ => {}
                }
            }
            let start = start?;
            if error.is_some() {
                return Some(json!({
                    "for": "compaction",
                    "view": {
                        "schemaVersion": 1,
                        "id": compaction_id,
                "sourceCommandId":source_command_id,
                        "phase": "failed",
                        "anchorSeq": start.seq,
                        "time": start.timestamp_ms,
                        "endedAt": event.timestamp_ms,
                        "error": error,
                        "progress": progress,
                    }
                }));
            }
            let (summary_seq, text, shadowed_seqs, shadowed_token_count) = summary?;
            let replacement = replacement?;
            Some(json!({
                "for": "compaction",
                "view": {
                    "schemaVersion": 1,
                    "id": compaction_id,
                "sourceCommandId":source_command_id,
                    "phase": "succeeded",
                    "anchorSeq": replacement.seq,
                    "time": replacement.timestamp_ms,
                    "summary": text,
                    "summaryEventSeq": summary_seq,
                    "shadowedItemCount": shadowed_seqs.len(),
                    "shadowedTokenCount": shadowed_token_count,
                    "startedAt": start.timestamp_ms,
                    "endedAt": event.timestamp_ms,
                    "progress": progress,
                }
            }))
        }
        _ => None,
    }
}

/// Recover the same optional presentation from an already projected Web
/// event. This keeps the legacy in-memory adapter and bounded tail cache
/// compatible with the authoritative durable path. It intentionally accepts
/// only the distinctive native-shell foreground-result shape, so arbitrary JSON tool
/// output cannot accidentally become executable-looking terminal chrome.
pub fn project_web_event_view(event: &Value, history: &[Value]) -> Option<Value> {
    if let Some(view) = compaction_web_view(event, history) {
        return Some(view);
    }
    match event.get("type").and_then(Value::as_str)? {
        "tool/call" => {
            let data = event.get("data")?;
            terminal_call_view(
                data.get("name")?.as_str()?,
                data.get("arguments")?.as_str()?,
            )
        }
        "tool/result" => {
            let call_id = event.pointer("/data/message/source/callId")?.as_str()?;
            let seq = event.get("seq").and_then(Value::as_u64);
            let is_shell = history.iter().rev().any(|candidate| {
                candidate.get("type").and_then(Value::as_str) == Some("tool/call")
                    && candidate.pointer("/data/callId").and_then(Value::as_str) == Some(call_id)
                    && candidate
                        .pointer("/data/name")
                        .and_then(Value::as_str)
                        .is_some_and(is_shell_tool)
                    && seq
                        .is_none_or(|seq| candidate.get("seq").and_then(Value::as_u64) < Some(seq))
            });
            if !is_shell {
                return None;
            }
            let result_text = event
                .pointer("/data/message/content/0/content/0/text")?
                .as_str()?;
            let metadata = serde_json::from_str::<Value>(result_text).ok()?;
            terminal_result_view(&metadata)
        }
        _ => None,
    }
}

/// Compatibility path for an embedded, non-durable Host. Production live and
/// history use `compaction_view` on the authoritative Session.
fn compaction_web_view(event: &Value, history: &[Value]) -> Option<Value> {
    let kind = event.get("type")?.as_str()?;
    if !matches!(
        kind,
        "compaction/start" | "compaction/progress" | "compaction/end"
    ) {
        return None;
    }
    let data = event.get("data")?;
    let id = data.get("compactionId")?.as_str()?;
    let seq = event.get("seq")?.as_u64()?;
    let time = event.get("time")?.as_u64()?;
    if kind == "compaction/start" {
        return Some(json!({"for":"compaction", "view": {
            "schemaVersion":1, "id":id, "sourceCommandId":data.get("sourceCommandId"), "phase":"running",
            "anchorSeq":seq, "time":time,
        }}));
    }
    let mut start = None;
    let mut summary = None;
    let mut replacement = None;
    let mut progress = None;
    for prior in history.iter().rev() {
        if prior.get("seq").and_then(Value::as_u64) >= Some(seq) {
            continue;
        }
        let prior_data = prior.get("data");
        if progress.is_none()
            && prior.get("type").and_then(Value::as_str) == Some("compaction/progress")
            && prior.pointer("/data/compactionId").and_then(Value::as_str) == Some(id)
        {
            progress = prior.pointer("/data/progress");
        }
        if prior.get("type").and_then(Value::as_str) == Some("compaction/start")
            && prior_data
                .and_then(|data| data.get("compactionId"))
                .and_then(Value::as_str)
                == Some(id)
        {
            start = Some(prior);
            break;
        }
        if prior.get("type").and_then(Value::as_str) == Some("compaction/summary")
            && prior_data
                .and_then(|data| data.get("compactionId"))
                .and_then(Value::as_str)
                == Some(id)
        {
            summary = Some(prior);
        }
        if prior.get("type").and_then(Value::as_str) == Some("user/message")
            && prior
                .pointer("/data/source/compactionId")
                .and_then(Value::as_str)
                == Some(id)
            && prior.pointer("/surfaceOp/op").and_then(Value::as_str) == Some("replace")
        {
            replacement = Some(prior);
        }
    }
    let start = start?;
    if kind == "compaction/progress" {
        return Some(json!({"for":"compaction", "view": {
            "schemaVersion":1, "id":id, "sourceCommandId":data.get("sourceCommandId"), "phase":"running",
            "anchorSeq":start.get("seq")?.as_u64()?, "time":start.get("time")?.as_u64()?,
            "progress":data.get("progress")?, "progressTime":time,
        }}));
    }
    if data.get("error").is_some_and(|error| !error.is_null()) {
        return Some(json!({"for":"compaction", "view": {
            "schemaVersion":1, "id":id, "sourceCommandId":data.get("sourceCommandId"), "phase":"failed",
            "anchorSeq":start.get("seq")?.as_u64()?,
            "time":start.get("time")?.as_u64()?,
            "endedAt":time, "error":data.get("error"), "progress":progress,
        }}));
    }
    let summary = summary?;
    let replacement = replacement?;
    let summary_data = summary.get("data")?;
    let summary_text = summary_data
        .get("summary")?
        .as_array()?
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<String>();
    Some(json!({"for":"compaction", "view": {
        "schemaVersion":1, "id":id, "sourceCommandId":data.get("sourceCommandId"), "phase":"succeeded",
        "anchorSeq":replacement.get("seq")?.as_u64()?,
        "time":replacement.get("time")?.as_u64()?,
        "summary":summary_text,
        "summaryEventSeq":summary.get("seq")?.as_u64()?,
        "shadowedItemCount":summary_data.get("shadowedSeqs")?.as_array()?.len(),
        "shadowedTokenCount":summary_data.get("shadowedTokenCount")?.as_u64()?,
        "startedAt":start.get("time")?.as_u64()?, "endedAt":time, "progress":progress,
    }}))
}

fn terminal_call_view(name: &str, arguments_json: &str) -> Option<Value> {
    if !is_shell_tool(name) {
        return None;
    }
    let arguments = serde_json::from_str::<Value>(arguments_json).ok()?;
    let arguments = arguments.as_object()?;
    let command = arguments.get("command")?.as_str()?;
    let mut view = serde_json::Map::from_iter([
        ("card".to_owned(), json!("terminal")),
        ("title".to_owned(), json!(command)),
    ]);
    if let Some(cwd) = arguments.get("cwd").and_then(Value::as_str) {
        view.insert("cwd".to_owned(), json!(cwd));
    }
    if let Some(description) = arguments.get("description").and_then(Value::as_str) {
        view.insert("description".to_owned(), json!(description));
    }
    Some(json!({"for": "call", "view": Value::Object(view)}))
}

fn is_shell_tool(name: &str) -> bool {
    matches!(name, "bash" | "pwsh")
}

fn terminal_result_view(metadata: &Value) -> Option<Value> {
    let metadata = metadata.as_object()?;
    if metadata.get("kind").and_then(Value::as_str) != Some("foreground") {
        return None;
    }
    let stdout = metadata.get("stdout").and_then(Value::as_str)?;
    let stderr = metadata
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut output = String::with_capacity(stdout.len().saturating_add(stderr.len() + 1));
    output.push_str(stdout);
    if !stderr.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(stderr);
    }
    if metadata
        .get("stdout_truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && metadata
            .get("stdout_omitted_bytes")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        append_terminal_notice(&mut output, "[stdout truncated]");
    }
    if metadata
        .get("stderr_truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && metadata
            .get("stderr_omitted_bytes")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        append_terminal_notice(&mut output, "[stderr truncated]");
    }

    let mut view = serde_json::Map::from_iter([
        ("card".to_owned(), json!("terminal")),
        ("output".to_owned(), Value::String(output)),
    ]);
    if let Some(exit_code) = metadata.get("exit_code").and_then(Value::as_i64) {
        view.insert("exitCode".to_owned(), json!(exit_code));
    }
    if let Some(signal) = metadata.get("signal").and_then(Value::as_i64) {
        view.insert("signal".to_owned(), json!(signal));
    }
    Some(json!({"for": "result", "view": Value::Object(view)}))
}

fn append_terminal_notice(output: &mut String, notice: &str) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(notice);
    output.push('\n');
}

pub fn project_session_event_tail(
    session: &Session,
    route: &dyn ProjectionRoute,
    max_events: usize,
    max_bytes: usize,
) -> ProjectedEventTail {
    project_session_event_tail_from(session, route, 0, max_events, max_bytes)
}

/// Rebuild only the live suffix that was already resident in the Host. A
/// restored authoritative session anchors this floor at its durable cursor,
/// so synchronization cannot eagerly materialize cold history.
pub fn project_session_event_tail_from(
    session: &Session,
    route: &dyn ProjectionRoute,
    min_seq: u64,
    max_events: usize,
    max_bytes: usize,
) -> ProjectedEventTail {
    let end = session.events().len();
    let floor = usize::try_from(min_seq).unwrap_or(end).min(end);
    let prompts = prompt_views_for_range(session, floor, end);
    let initial_request_header_seq = initial_request_header_seq(session);
    let completed_steps = completed_assistant_steps(session);
    let max_events = max_events.max(1);
    let max_bytes = max_bytes.max(1);
    let mut reversed = Vec::new();
    let mut bytes = 0usize;

    for event in session.events()[floor..end].iter().rev().take(max_events) {
        let projected = restored_web_event(
            event,
            route,
            &prompts,
            initial_request_header_seq,
            Some(&completed_steps),
        );
        // Keep the release-proven encoding path here. A streaming byte counter
        // saves one short-lived buffer, but Windows crash dumps from v0.2.21
        // repeatedly faulted while this projection was being serialized. Cold
        // history is no longer eagerly projected, so the temporary buffer is
        // bounded by the live tail and is the safer tradeoff.
        let event_bytes = serde_json::to_vec(&projected)
            .map(|encoded| encoded.len())
            .unwrap_or(max_bytes.saturating_add(1));
        if event_bytes > max_bytes.saturating_sub(bytes) {
            break;
        }
        bytes = bytes.saturating_add(event_bytes);
        reversed.push(projected);
    }
    reversed.reverse();
    let start = end.saturating_sub(reversed.len());
    ProjectedEventTail {
        base_seq: u64::try_from(start).unwrap_or(u64::MAX),
        next_seq: session.next_seq(),
        bytes,
        events: reversed,
    }
}

pub fn project_session_history(
    session: &Session,
    route: &dyn ProjectionRoute,
    before_seq: Option<u64>,
    max_messages: usize,
) -> ProjectedHistoryPage {
    let end = before_seq
        .and_then(|seq| usize::try_from(seq).ok())
        .map_or(session.events().len(), |seq| {
            seq.min(session.events().len())
        });
    let mut start = end;
    let mut messages = 0usize;
    while start > 0 && messages < max_messages.max(1) {
        start -= 1;
        if matches!(
            session.events()[start].data(),
            EventData::UserMessage { .. }
                | EventData::AssistantMessage { .. }
                | EventData::ToolResult { .. }
        ) {
            messages += 1;
        }
    }
    ProjectedHistoryPage {
        events: project_session_history_range(session, route, start, end),
        has_more: start > 0,
        as_of_seq: session.next_seq().checked_sub(1),
    }
}

fn project_session_event_range_with_prompts(
    session: &Session,
    route: &dyn ProjectionRoute,
    prompts: &ProjectionSources,
    start: usize,
    end: usize,
) -> Vec<Value> {
    let end = end.min(session.events().len());
    let start = start.min(end);
    let initial_request_header_seq = initial_request_header_seq(session);
    session.events()[start..end]
        .iter()
        .map(|event| restored_web_event(event, route, prompts, initial_request_header_seq, None))
        .collect()
}

pub fn project_session_history_range(
    session: &Session,
    route: &dyn ProjectionRoute,
    start: usize,
    end: usize,
) -> Vec<Value> {
    let end = end.min(session.events().len());
    let start = start.min(end);
    let prompts = prompt_views_for_range(session, start, end);
    let initial_request_header_seq = initial_request_header_seq(session);
    let completed_steps = completed_assistant_steps(session);
    project_history_events(
        &session.events()[start..end],
        route,
        &prompts,
        initial_request_header_seq,
        &completed_steps,
    )
}

fn project_history_events(
    events: &[LoggedEvent],
    route: &dyn ProjectionRoute,
    prompts: &ProjectionSources,
    initial_request_header_seq: Option<u64>,
    completed_steps: &BTreeSet<(u32, u32)>,
) -> Vec<Value> {
    let mut projected = Vec::new();
    for event in events {
        if is_folded_assistant_chunk(event, completed_steps) {
            continue;
        }
        let next = restored_web_event(event, route, prompts, initial_request_header_seq, None);
        if projected
            .last_mut()
            .is_some_and(|prior| merge_projected_history_chunk(prior, &next))
        {
            continue;
        }
        projected.push(next);
    }
    projected
}

/// Same history reducer over a bounded storage cut. No partial `Session` is
/// constructed: this view is deliberately unable to drive recovery or tools.
pub fn project_history_window(
    window: &SessionHistoryWindow,
    route: &dyn ProjectionRoute,
) -> Vec<Value> {
    let mut sources = window
        .context
        .iter()
        .chain(&window.events)
        .collect::<Vec<_>>();
    sources.sort_unstable_by_key(|e| e.seq);
    let prompts = prompt_views_for_events(&window.events, sources.into_iter());
    let completed = window.completed_steps.iter().copied().collect();
    project_history_events(
        &window.events,
        route,
        &prompts,
        window.initial_request_header_seq,
        &completed,
    )
}

/// History does not need one browser event per provider token. Preserve the
/// complete partial text and its order while bounding each synthetic payload;
/// live authoritative projection still uses exact durable sequence events.
fn merge_projected_history_chunk(prior: &mut Value, next: &Value) -> bool {
    if prior.get("type") != Some(&Value::String("assistant/chunk".to_owned()))
        || next.get("type") != Some(&Value::String("assistant/chunk".to_owned()))
    {
        return false;
    }

    let Some(prior_data) = prior.get_mut("data").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(next_data) = next.get("data").and_then(Value::as_object) else {
        return false;
    };
    if prior_data.get("turn") != next_data.get("turn")
        || prior_data.get("step") != next_data.get("step")
    {
        return false;
    }

    let Some(prior_chunk) = prior_data.get_mut("chunk").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(next_chunk) = next_data.get("chunk").and_then(Value::as_object) else {
        return false;
    };
    let kind = prior_chunk.get("type").and_then(Value::as_str);
    if !matches!(kind, Some("text-delta" | "reasoning-delta"))
        || kind != next_chunk.get("type").and_then(Value::as_str)
    {
        return false;
    }
    let Some(prior_text) = prior_chunk.get("text").and_then(Value::as_str) else {
        return false;
    };
    let Some(next_text) = next_chunk.get("text").and_then(Value::as_str) else {
        return false;
    };
    if prior_text.len().saturating_add(next_text.len()) > HISTORY_CHUNK_COALESCE_BYTES {
        return false;
    }
    let mut merged = String::with_capacity(prior_text.len().saturating_add(next_text.len()));
    merged.push_str(prior_text);
    merged.push_str(next_text);
    prior_chunk.insert("text".to_owned(), Value::String(merged));
    true
}

fn completed_assistant_steps(session: &Session) -> BTreeSet<(u32, u32)> {
    session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            EventData::AssistantMessage { turn, step, .. } => Some((*turn, *step)),
            _ => None,
        })
        .collect()
}

fn is_folded_assistant_chunk(event: &LoggedEvent, completed_steps: &BTreeSet<(u32, u32)>) -> bool {
    matches!(
        event.data(),
        EventData::AssistantChunk { turn, step, .. }
            if completed_steps.contains(&(*turn, *step))
    )
}

pub fn initial_request_header_seq(session: &Session) -> Option<u64> {
    session.events().iter().find_map(|event| {
        matches!(event.data(), EventData::RequestHeader { .. }).then_some(event.seq)
    })
}

pub fn prompt_views(session: &Session) -> ProjectionSources {
    prompt_views_for_range(session, 0, session.events().len())
}

fn prompt_views_for_range(session: &Session, start: usize, end: usize) -> ProjectionSources {
    let end = end.min(session.events().len());
    let start = start.min(end);
    prompt_views_for_events(&session.events()[start..end], session.events().iter())
}

fn prompt_views_for_events<'a>(
    events: &[LoggedEvent],
    sources: impl Iterator<Item = &'a LoggedEvent>,
) -> ProjectionSources {
    let mut wanted_prompts = BTreeSet::new();
    let mut wanted_compactions = BTreeSet::new();
    for event in events {
        match event.data() {
            EventData::UserMessage {
                message,
                surface_replace,
            } => {
                if message.role == MessageRole::User {
                    if let Some(id) = message.id.as_ref() {
                        wanted_prompts.insert(id.clone());
                    }
                }
                if let Some(replace) = surface_replace {
                    wanted_compactions.insert(replace.compaction_id.clone());
                }
            }
            EventData::AssistantMessage { message, .. } if message.role == MessageRole::User => {
                if let Some(id) = message.id.as_ref() {
                    wanted_prompts.insert(id.clone());
                }
            }
            _ => {}
        }
    }

    let mut prompts = ProjectionSources::default();
    for event in sources {
        if let EventData::CompactionStart {
            compaction_id,
            source_command_id,
            ..
        } = event.data()
        {
            if wanted_compactions.contains(compaction_id) {
                prompts
                    .compaction_commands
                    .insert(compaction_id.clone(), source_command_id.clone());
            }
        }
        let EventData::AgentInboxSpliced { inserted, .. } = event.data() else {
            continue;
        };
        for input in inserted {
            if !wanted_prompts.contains(&input.id) {
                continue;
            }
            prompts
                .prompts
                .insert(input.id.clone(), project_inbox_message(input));
        }
    }
    prompts
}

pub fn restored_web_event(
    event: &LoggedEvent,
    route: &dyn ProjectionRoute,
    prompts: &ProjectionSources,
    initial_request_header_seq: Option<u64>,
    fold_completed_chunks: Option<&BTreeSet<(u32, u32)>>,
) -> Value {
    if fold_completed_chunks.is_some_and(|completed| is_folded_assistant_chunk(event, completed)) {
        return json!({
            "type": "xharness/internal",
            "seq": event.seq,
            "time": event.timestamp_ms,
            "data": {"kind": "folded-assistant-chunk"},
            "hidden": true,
        });
    }
    if matches!(event.data(), EventData::SessionTitleGeneration { .. }) {
        return json!({"type":"xharness/internal", "seq":event.seq, "time":event.timestamp_ms, "data":{"kind":"title-generation"}, "hidden":true});
    }
    if matches!(event.data(), EventData::SessionForkOrigin { .. }) {
        return json!({"type":"xharness/internal", "seq":event.seq, "time":event.timestamp_ms, "data":{"kind":"fork-origin"}, "hidden":true});
    }
    if matches!(
        event.data(),
        EventData::ExecutionCheckpoint { notice: None, .. }
    ) {
        return json!({"type":"xharness/internal", "seq":event.seq, "time":event.timestamp_ms, "data":{"kind":"execution-checkpoint-state"}, "hidden":true});
    }
    let (event_type, data, surface_op) = match event.data() {
        EventData::ExecutionCheckpoint { turn, notice, .. } => (
            "run/checkpoint".into(),
            web_execution_notice(web_turn(*turn), notice.as_ref()),
            None,
        ),
        EventData::SessionTitleGeneration { .. }
        | EventData::SessionForkOrigin { .. }
        | EventData::AgentDelegationFailure { .. }
        | EventData::AgentFailureDelivered { .. }
        | EventData::AgentDelegated { .. }
        | EventData::AgentDispatchPaused { .. }
        | EventData::AgentSettlementDelivered { .. }
        | EventData::AgentPresetSelected { .. }
        | EventData::SessionModelSelected { .. }
        | EventData::ApprovalAsked { .. }
        | EventData::ApprovalDecided { .. }
        | EventData::PermissionPreset { .. }
        | EventData::SandboxMode { .. }
        | EventData::ApprovalPolicy { .. }
        | EventData::CommandRun { .. }
        | EventData::CommandDone { .. }
        | EventData::SessionTitle { .. }
        | EventData::GoalExecution { .. }
        | EventData::GoalChange { .. }
        | EventData::ScheduleChange { .. }
        | EventData::PlanMode { .. }
        | EventData::CompactionPrune { .. }
        | EventData::RequestContext { .. } => tagged_event_data(event.data()),
        EventData::LlmRetry { turn, .. } | EventData::LlmRetryStarted { turn, .. } => {
            let (kind, mut data, surface) = tagged_event_data(event.data());
            // Retry updates must share their start/end's zero-based Web turn.
            // Passing the durable turn through attaches them to the next turn,
            // where history replay sees an update before its start.
            data["turn"] = json!(web_turn(*turn));
            (kind, data, surface)
        }
        EventData::CompactionSummary { summary, usage, .. } => {
            let (kind, mut data, surface) = tagged_event_data(event.data());
            data["summary"] = json!([{"type":"text", "text":summary}]);
            if let Some(usage) = usage.as_ref().and_then(web_token_usage) {
                data["usage"] = usage;
            }
            (kind, data, surface)
        }
        EventData::CompactionStart { turn, .. }
        | EventData::CompactionEnd { turn, .. }
        | EventData::CompactionProgress { turn, .. } => {
            let (kind, mut data, surface) = tagged_event_data(event.data());
            if let Some(turn) = turn {
                data["turn"] = json!(web_turn(*turn));
            }
            (kind, data, surface)
        }
        EventData::RequestHeader { header } => {
            web_request_header(header, initial_request_header_seq == Some(event.seq))
        }
        EventData::AgentInboxSpliced {
            target,
            start,
            removed_count,
            inserted,
            outcome,
        } => {
            let mut data = json!({
                "target": target,
                "start": start,
                "removedCount": removed_count,
                // The Web fold spreads this field unconditionally; an empty
                // removal splice must therefore carry `[]` rather than rely on
                // the durable enum's skip-empty serialization.
                "inserted": inserted,
            });
            if let Some(outcome) = outcome {
                data.as_object_mut()
                    .expect("inbox splice data is an object")
                    .insert("outcome".to_owned(), json!(outcome));
            }
            ("agent/inbox/spliced".to_owned(), data, None)
        }
        EventData::SessionMutationCommitted { .. } => {
            return json!({
                "type": "xharness/internal",
                "seq": event.seq,
                "time": event.timestamp_ms,
                "data": {"kind": "session-mutation-receipt"},
                "hidden": true,
            });
        }
        EventData::QuestionRequested { .. }
        | EventData::QuestionDeferred { .. }
        | EventData::QuestionAnswerDelivered { .. }
        | EventData::QuestionDraftUpdated { .. }
        | EventData::QuestionResolved { .. }
        | EventData::QuestionCancelled { .. } => {
            return json!({
                "type": "xharness/internal",
                "seq": event.seq,
                "time": event.timestamp_ms,
                "data": {"kind": "user-question-lifecycle"},
                "hidden": true,
            });
        }
        EventData::TurnStart { turn } => (
            "turn/start".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "trigger": {"kind": "message", "source": {"kind": "user"}},
            }),
            None,
        ),
        EventData::TurnEnd { turn, reason } => (
            "turn/end".to_owned(),
            json!({"turn": web_turn(*turn), "reason": web_turn_end(reason)}),
            None,
        ),
        EventData::StepStart { turn, step } => (
            "step/start".to_owned(),
            json!({"turn": web_turn(*turn), "step": step}),
            None,
        ),
        EventData::StepEnd { turn, step } => (
            "step/end".to_owned(),
            json!({"turn": web_turn(*turn), "step": step}),
            None,
        ),
        EventData::UserMessage {
            message,
            surface_replace,
        } => (
            "user/message".to_owned(),
            {
                let mut data = web_message(message, route, event.seq, prompts);
                if let Some(replace) = surface_replace {
                    // Projection only: the durable message and model surface stay intact.
                    let mut source = json!({"kind":"plugin", "plugin":"compact", "compactionId":replace.compaction_id});
                    if let Some(Some(command)) =
                        prompts.compaction_commands.get(&replace.compaction_id)
                    {
                        source["sourceCommandId"] = json!(command);
                    }
                    data["source"] = source;
                }
                data
            },
            Some(surface_replace.as_ref().map_or_else(
                || json!("append"),
                |replace| {
                    json!({
                        "op": "replace",
                        "start": replace.shadowed_range.start,
                        "end": replace.shadowed_range.end,
                    })
                },
            )),
        ),
        EventData::AssistantChunk { turn, step, chunk } => (
            "assistant/chunk".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "chunk": web_assistant_chunk(chunk),
            }),
            None,
        ),
        EventData::AssistantMessage {
            turn,
            step,
            message,
            usage,
        } => {
            let mut data = json!({
                "turn": web_turn(*turn),
                "step": step,
                "message": web_message(message, route, event.seq, prompts),
            });
            if message.interrupted {
                data["interrupted"] = json!(true);
            }
            if let Some(usage) = usage.as_ref().and_then(web_token_usage) {
                data.as_object_mut()
                    .expect("assistant message data is an object")
                    .insert("usage".to_owned(), usage);
            }
            ("assistant/message".to_owned(), data, Some(json!("append")))
        }
        EventData::ToolCall { turn, step, call } => (
            "tool/call".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "callId": call.id,
                "name": call.name,
                "arguments": call.arguments_json,
            }),
            None,
        ),
        EventData::ToolResult { turn, step, result } => (
            "tool/result".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "message": {
                    "id": format!("restored-tool-{}", event.seq),
                    "role": "user",
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": result.call_id,
                        "content": web_tool_content(&result.content, result.metadata.as_ref()),
                        "isError": result.outcome != ToolOutcome::Success,
                    }],
                    "source": {"kind": "tool", "callId": result.call_id},
                },
            }),
            Some(json!("append")),
        ),
        EventData::SessionEndSeed => tagged_event_data(event.data()),
    };
    // Use the conservative construction path that predates the v0.2.21
    // Windows access violations. The extra payload clone is bounded to one
    // projected event; cold history is served page-by-page instead.
    let mut web = json!({
        "type": event_type,
        "seq": event.seq,
        "time": event.timestamp_ms,
        "data": data,
    });
    if let Some(surface_op) = surface_op {
        web.as_object_mut()
            .expect("restored event is an object")
            .insert("surfaceOp".to_owned(), surface_op);
    }
    if let EventData::UserMessage {
        surface_replace: Some(replace),
        ..
    } = event.data()
    {
        web.as_object_mut()
            .expect("restored event is an object")
            .insert("sourceEventSeqs".to_owned(), json!(replace.shadowed_seqs));
    }
    web
}

pub fn web_execution_notice(
    turn: u32,
    notice: Option<&xharness_session::ExecutionNotice>,
) -> Value {
    json!({"turn":turn,"notice":notice})
}

fn tagged_event_data(event: &EventData) -> (String, Value, Option<Value>) {
    let mut value = serde_json::to_value(event).expect("EventData is serializable");
    let object = value
        .as_object_mut()
        .expect("tagged EventData serializes as an object");
    let event_type = object
        .remove("type")
        .and_then(|value| value.as_str().map(str::to_owned))
        .expect("tagged EventData contains a type");
    let data = object.remove("data").unwrap_or(Value::Null);
    (event_type, data, None)
}

/// Project the durable provider-neutral request snapshot into the upstream Web
/// request-header shape while retaining XHarness' exact message input and
/// policy/budget audit fields as additive extensions. The ordinary Trajectory
/// client consumes `config/system/tools`; the Context Inspector consumes
/// `input/options`. Keeping both in one immutable event guarantees that the
/// two views describe the same provider call.
fn web_request_header(header: &RequestHeader, initial: bool) -> (String, Value, Option<Value>) {
    let mut config = json!({
        "provider": header.provider,
        "model": header.model,
    });
    if let Some(reasoning_effort) = &header.reasoning_effort {
        config
            .as_object_mut()
            .expect("request config is an object")
            .insert(
                "reasoningEffort".to_owned(),
                Value::String(reasoning_effort.clone()),
            );
    }

    // Ordinary live/history frames carry metadata only, including for old
    // stores. Context/Harness explicitly resolve one selected snapshot by seq.
    let mut options = header.options.clone();
    if let Some(Value::Object(context)) = options.get_mut("context") {
        if let Some(Value::Array(edits)) = context.remove("edits") {
            context.insert("edit_count".into(), json!(edits.len()));
        }
    }
    options
        .entry("inputMessageCount".into())
        .or_insert(json!(header.input.len()));
    options
        .entry("toolCount".into())
        .or_insert(json!(header.tools.len()));
    options.insert("snapshotOnDemand".into(), json!(true));
    let web_header =
        json!({"config":config,"tools":[],"input":[],"options":options,"xharnessVersion":1});

    (
        "request/header".to_owned(),
        json!({
            "header": web_header,
            "reason": if initial { "initial" } else { "change" },
        }),
        None,
    )
}

fn web_turn(turn: u32) -> u32 {
    // Durable loop turns are one-based while the upstream Web surface starts
    // at zero. Keeping this conversion here makes replay and live continuation
    // use the same browser coordinates.
    turn.saturating_sub(1)
}

pub fn web_turn_end(reason: &TurnEndReason) -> Value {
    match reason {
        TurnEndReason::Completed => json!({"kind": "completed"}),
        TurnEndReason::MaxTokens => json!({"kind": "max-tokens"}),
        TurnEndReason::Cancelled | TurnEndReason::UserInterrupted => json!({"kind": "cancelled"}),
        TurnEndReason::LimitReached => json!({"kind": "max-steps"}),
        TurnEndReason::Failed { error } => json!({
            "kind": "error",
            "error": {"code": "LOOP_FAILED", "message": error},
        }),
        TurnEndReason::Interrupted => json!({
            "kind": "error",
            "error": {
                "code": "INTERRUPTED",
                "message": "the previous Host stopped before this turn closed",
            },
        }),
    }
}

pub fn web_assistant_chunk(chunk: &AssistantChunk) -> Value {
    match chunk {
        AssistantChunk::TextDelta(text) => text_delta(text),
        AssistantChunk::ReasoningDelta(text) => reasoning_delta(text),
        AssistantChunk::ToolCallDelta {
            index,
            id,
            name,
            arguments_delta,
        } => tool_delta(*index, id, name, arguments_delta),
        AssistantChunk::Usage(usage) => web_token_usage(usage).map_or_else(
            || json!({"type": "provider", "item": {"kind": "invalid-usage"}}),
            |usage| json!({"type": "usage", "usage": usage}),
        ),
        AssistantChunk::Finish { reason } => json!({"type": "finish", "reason": reason}),
        AssistantChunk::Provider(item) => json!({"type": "provider", "item": item}),
    }
}

fn web_message(
    message: &Message,
    route: &dyn ProjectionRoute,
    seq: u64,
    prompts: &ProjectionSources,
) -> Value {
    let id = message
        .id
        .clone()
        .unwrap_or_else(|| format!("restored-{}-{seq}", message.role.as_str()));
    if message.role == MessageRole::User {
        if let Some(prompt) = prompts.prompts.get(&id) {
            return json!({
                "id": id,
                "role": "user",
                "content": prompt.content,
                "source": prompt.source,
            });
        }
    }
    let source = match message.role {
        MessageRole::Assistant => {
            json!({"kind": "model", "provider": route.provider(), "model": route.model()})
        }
        MessageRole::Tool => json!({"kind": "tool", "callId": message.tool_call_id}),
        MessageRole::System => json!({"kind": "system"}),
        MessageRole::User => json!({"kind": "user", "restored": true}),
    };
    json!({
        "id": id,
        "role": message.role.as_str(),
        "content": if message.role == MessageRole::Assistant {
            assistant_content(&message.content, &message.reasoning)
        } else {
            vec![json!({"type":"text", "text":message.content})]
        },
        "source": source,
    })
}

/// Shared durable/live attachment projection; binary payloads stay out of events.
pub fn web_tool_content(text: &str, metadata: Option<&Value>) -> Vec<Value> {
    let mut parts = vec![json!({"type":"text","text":text})];
    for b in xharness_session::ContentBlock::from_tool_metadata(metadata) {
        if let xharness_session::ContentBlock::Image { attachment: r } = b {
            parts.push(json!({"type":"image","attachment":{"attachmentId":r.id,"mediaType":r.media_type,"bytes":r.bytes,"width":r.width,"height":r.height,"reference":r}}));
        }
    }
    parts
}

#[cfg(test)]
mod projection_encoding_tests {
    use super::*;
    struct TestRoute;

    impl ProjectionRoute for TestRoute {
        fn provider(&self) -> &str {
            "test"
        }
        fn model(&self) -> &str {
            "test"
        }
    }

    #[test]
    fn projection_tail_keeps_exact_encoded_byte_boundaries() {
        let mut session =
            Session::new(xharness_session::SessionHeader::new("byte-boundary")).unwrap();
        session
            .append_batch_at(
                xharness_session::Revision::ZERO,
                vec![EventData::SessionTitle {
                    title: "你好\n\"\\".repeat(256),
                    message_seqs: Vec::new(),
                    source: xharness_session::SessionTitleSource::User,
                }
                .into()],
                1,
            )
            .unwrap();
        let route = TestRoute;
        let full = project_session_event_tail(&session, &route, 2048, usize::MAX);
        assert_eq!(full.events.len(), 1);
        let bytes = serde_json::to_vec(&full.events[0]).unwrap().len();
        for limit in [bytes - 1, bytes, bytes + 1] {
            let tail = project_session_event_tail(&session, &route, 2048, limit);
            assert_eq!(tail.next_seq, session.next_seq());
            if limit < bytes {
                assert!(tail.events.is_empty());
                assert_eq!(tail.base_seq, tail.next_seq);
                assert_eq!(tail.bytes, 0);
            } else {
                assert_eq!(tail.events, full.events);
                assert_eq!(tail.bytes, bytes);
                assert_eq!(tail.base_seq, 0);
            }
        }
    }

    #[test]
    fn compaction_presentation_is_identical_live_and_in_paged_history() {
        use xharness_session::{Revision, SequenceRange, SessionHeader, SurfaceReplace};

        let mut session = Session::new(SessionHeader::new("compact-view")).unwrap();
        session
            .append_batch_at(
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("large history"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::CompactionStart {
                        compaction_id: "compact-1".into(),
                        source_command_id: None,
                        turn: Some(1),
                    }
                    .into(),
                ],
                1,
            )
            .unwrap();
        let range = SequenceRange { start: 1, end: 1 };
        session
            .append_batch_at(
                Revision(1),
                vec![
                    EventData::CompactionSummary {
                        compaction_id: "compact-1".into(),
                        source_command_id: None,
                        summary: "摘要 🧪".into(),
                        shadowed_range: range,
                        shadowed_seqs: vec![1],
                        shadowed_token_count: 128,
                        provider: "test".into(),
                        model: "test".into(),
                        max_tokens: Some(64),
                        usage: None,
                    }
                    .into(),
                    EventData::UserMessage {
                        message: Message::user("checkpoint"),
                        surface_replace: Some(SurfaceReplace {
                            compaction_id: "compact-1".into(),
                            shadowed_range: range,
                            shadowed_seqs: vec![1],
                        }),
                    }
                    .into(),
                    EventData::CompactionEnd {
                        compaction_id: "compact-1".into(),
                        source_command_id: None,
                        turn: Some(1),
                        error: None,
                    }
                    .into(),
                ],
                2,
            )
            .unwrap();
        let projected =
            project_session_event_range(&session, &TestRoute, 0, session.events().len());
        let start_view = project_session_event_view(&session, &session.events()[3]).unwrap();
        let end_view = project_session_event_view(&session, &session.events()[6]).unwrap();
        assert_eq!(start_view["view"]["phase"], "running");
        assert_eq!(end_view["view"]["phase"], "succeeded");
        assert_eq!(end_view["view"]["summary"], "摘要 🧪");
        assert_eq!(end_view["view"]["shadowedItemCount"], 1);
        assert_eq!(end_view["view"]["anchorSeq"], 5);
        assert_eq!(
            project_web_event_view(&projected[3], &projected),
            Some(start_view)
        );
        assert_eq!(
            project_web_event_view(&projected[6], &projected),
            Some(end_view)
        );
        let window = SessionHistoryWindow {
            next_seq: session.next_seq(),
            has_more: true,
            events: vec![session.events()[6].clone()],
            context: vec![
                session.events()[5].clone(),
                session.events()[3].clone(),
                session.events()[4].clone(),
            ],
            initial_request_header_seq: None,
            completed_steps: Vec::new(),
        };
        assert_eq!(
            project_history_window_view(&window, &window.events[0]),
            project_session_event_view(&session, &session.events()[6])
        );
        // A history page containing only the terminal event still has a
        // complete summary because it is projected from the durable Session.
        assert_eq!(
            project_session_event_view(&session, &session.events()[6]).unwrap()["view"]["summary"],
            "摘要 🧪"
        );
    }

    #[test]
    fn progress_snapshot_is_identical_live_web_paged_and_restarted() {
        use xharness_session::{CompactionProgress, CompactionStage, Revision, SessionHeader};
        for source_command_id in [None, Some("cmd".to_string())] {
            let mut session = Session::new(SessionHeader::new("compact-progress")).unwrap();
            session
                .append_batch_at(
                    Revision::ZERO,
                    vec![
                        EventData::TurnStart { turn: 1 }.into(),
                        EventData::CompactionStart {
                            compaction_id: "c".into(),
                            source_command_id: source_command_id.clone(),
                            turn: Some(1),
                        }
                        .into(),
                        EventData::CompactionProgress {
                            compaction_id: "c".into(),
                            source_command_id: source_command_id.clone(),
                            turn: Some(1),
                            progress: CompactionProgress {
                                stage: CompactionStage::Retrying,
                                calls: 3,
                                completed_parts: 1,
                                splits: 1,
                                retries: 2,
                                delay_ms: Some(8000),
                                input_tokens_before: Some(180000),
                                input_tokens_after: None,
                            },
                        }
                        .into(),
                    ],
                    1000,
                )
                .unwrap();
            session
                .append_batch_at(
                    Revision(1),
                    vec![EventData::CompactionEnd {
                        compaction_id: "c".into(),
                        source_command_id: source_command_id.clone(),
                        turn: Some(1),
                        error: Some("fixture permanent error".into()),
                    }
                    .into()],
                    2000,
                )
                .unwrap();
            let web = project_session_event_range(&session, &TestRoute, 0, session.events().len());
            let restarted = Session::restore(
                session.header().clone(),
                session.revision(),
                session.events().to_vec(),
            )
            .unwrap();
            for index in [2, 3] {
                let live = project_session_event_view(&session, &session.events()[index]).unwrap();
                assert_eq!(live["view"]["anchorSeq"], 1);
                assert_eq!(live["view"]["time"], 1000);
                assert_eq!(live["view"]["progress"]["retries"], 2);
                assert_eq!(
                    project_session_event_view(&restarted, &restarted.events()[index]),
                    Some(live.clone())
                );
                assert_eq!(
                    project_web_event_view(&web[index], &web),
                    Some(live.clone())
                );
                let window = SessionHistoryWindow {
                    next_seq: session.next_seq(),
                    has_more: true,
                    events: vec![session.events()[index].clone()],
                    context: session.events()[1..index].to_vec(),
                    initial_request_header_seq: None,
                    completed_steps: vec![],
                };
                assert_eq!(
                    project_history_window_view(&window, &window.events[0]),
                    Some(live)
                );
                assert_eq!(web[index]["data"]["turn"], 0);
            }
            assert_eq!(
                project_session_event_view(&session, &session.events()[3]).unwrap()["view"]
                    ["error"],
                "fixture permanent error"
            );
        }
    }

    #[test]
    fn failed_compaction_projects_terminal_state_without_a_checkpoint() {
        use xharness_session::{Revision, SessionHeader};

        let mut session = Session::new(SessionHeader::new("compact-failed-view")).unwrap();
        session
            .append_batch_at(
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("large history"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::CompactionStart {
                        compaction_id: "failed".into(),
                        source_command_id: None,
                        turn: Some(1),
                    }
                    .into(),
                    EventData::CompactionEnd {
                        compaction_id: "failed".into(),
                        source_command_id: None,
                        turn: Some(1),
                        error: Some("network closed".into()),
                    }
                    .into(),
                ],
                1,
            )
            .unwrap();
        let events = project_session_event_range(&session, &TestRoute, 0, session.events().len());
        let terminal = project_session_event_view(&session, &session.events()[3]).unwrap();
        assert_eq!(terminal["view"]["phase"], "failed");
        assert_eq!(terminal["view"]["anchorSeq"], 2);
        assert!(terminal["view"].get("summary").is_none());
        assert_eq!(project_web_event_view(&events[3], &events), Some(terminal));
        let window = SessionHistoryWindow {
            next_seq: session.next_seq(),
            has_more: true,
            events: vec![session.events()[3].clone()],
            context: vec![session.events()[2].clone()],
            initial_request_header_seq: None,
            completed_steps: Vec::new(),
        };
        assert_eq!(
            project_history_window_view(&window, &window.events[0]),
            project_session_event_view(&session, &session.events()[3])
        );
    }
}
