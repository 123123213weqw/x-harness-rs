//! Offline experiment bridge: real context projection and session-bound history.
//! JSONL on stdin/stdout; no model endpoint, credentials or production state.
#![forbid(unsafe_code)]

#[path = "../src/history_tool.rs"]
mod history_tool;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    error::Error,
    io::{self, BufRead, Write},
    sync::Arc,
};
use xharness_compaction::ToolResultPrunerConfig;
use xharness_core::{ContextPolicy, ContextRequest, ToolResultPruningContextPolicy};
use xharness_session::{
    EventData, MemorySessionStore, Message, Revision, SessionHeader, Store, ToolCall,
    ToolResultData, TurnEndReason,
};
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

struct Bridge {
    store: Arc<MemorySessionStore>,
    executors: HashMap<String, ToolExecutor>,
}

impl Bridge {
    async fn call(&mut self, v: Value) -> Result<Value> {
        let sid = v["session"].as_str().ok_or("missing session")?.to_owned();
        if v["op"] == "history" {
            let executor = self.executors.get(&sid).ok_or("unknown fixture session")?;
            return Ok(serde_json::to_value(
                executor
                    .execute(ToolRequest::new("history", v["arguments"].to_string()))
                    .await,
            )?);
        }
        if v["op"] != "init" {
            return Err("unknown operation".into());
        }
        self.store.create(SessionHeader::new(&sid)).await?;
        let task = v["task"].as_str().ok_or("missing task")?;
        let fresh = v["fresh"].as_bool().ok_or("missing fresh")?;
        let mut events = vec![
            EventData::TurnStart { turn: 1 }.into(),
            EventData::UserMessage {
                message: Message::user(task),
                surface_replace: None,
            }
            .into(),
            EventData::StepStart { turn: 1, step: 1 }.into(),
        ];
        let results = v["results"].as_array().ok_or("missing results")?;
        let mut assistant = Message::assistant("");
        let mut materialized = Vec::new();
        let mut archives = Vec::new();
        for (i, row) in results.iter().enumerate() {
            let original = row["content"].as_str().ok_or("missing result text")?;
            let reference = self.store.archive_tool_result(&sid, original).await?;
            let archive = json!({"sha256": reference.sha256, "bytes":reference.bytes, "read_with":"history", "format":"tool_result/v1"});
            let mut content: Value = serde_json::from_str(original)?;
            content
                .as_object_mut()
                .ok_or("result must be JSON object")?
                .insert("archive".into(), archive.clone());
            let call = ToolCall {
                id: format!("fixture-call-{i}"),
                provider_call_id: None,
                index: i,
                name: row["tool"].as_str().ok_or("missing tool")?.into(),
                arguments_json: row["arguments"].to_string(),
            };
            assistant.tool_calls.push(call.clone());
            materialized.push((call, content.to_string()));
            archives.push(archive);
        }
        events.push(
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message: assistant,
                usage: None,
            }
            .into(),
        );
        for (call, _) in &materialized {
            events.push(
                EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call.clone(),
                }
                .into(),
            );
        }
        for (call, content) in materialized {
            events.push(
                EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success(call.id, content),
                }
                .into(),
            );
        }
        events.push(EventData::StepEnd { turn: 1, step: 1 }.into());
        if !fresh {
            events.push(EventData::StepStart { turn: 1, step: 2 }.into());
            events.push(
                EventData::AssistantMessage {
                    turn: 1,
                    step: 2,
                    message: Message::assistant(
                        "The tool observations are recorded. No final decision has been made.",
                    ),
                    usage: None,
                }
                .into(),
            );
            events.push(EventData::StepEnd { turn: 1, step: 2 }.into());
            events.push(
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            );
            events.push(EventData::TurnStart { turn: 2 }.into());
            events.push(
                EventData::UserMessage {
                    message: Message::user(task),
                    surface_replace: None,
                }
                .into(),
            );
        }
        self.store.append(&sid, Revision::ZERO, events).await?;
        let snapshot = self.store.load(&sid).await?.ok_or("fixture vanished")?;
        let messages = snapshot.derive_messages();
        let mut surfaces = serde_json::Map::new();
        surfaces.insert("full".into(), serde_json::to_value(&messages)?);
        for (name, threshold, head, tail, fresh_limit) in [
            ("current", 8192, 4096, 1024, Some(256 * 1024)),
            ("all8k", 8192, 4096, 1024, None),
            ("all2k", 2048, 1024, 256, None),
        ] {
            let policy = ToolResultPruningContextPolicy::new(ToolResultPrunerConfig {
                threshold_chars: threshold,
                head_chars: head,
                tail_chars: tail,
            })?;
            let mut request = ContextRequest::new(messages.clone());
            if let Some(limit) = fresh_limit {
                request = request.with_tool_result_limit_bytes(limit);
            }
            surfaces.insert(
                name.into(),
                serde_json::to_value(policy.prepare(request).await?.messages)?,
            );
        }
        let registry = Arc::new(ToolRegistry::new());
        let spec = history_tool::spec(self.store.clone(), sid.clone());
        let definition = serde_json::to_value(&spec.definition)?;
        registry.register(spec).await?;
        self.executors.insert(sid, ToolExecutor::new(registry));
        Ok(
            json!({"surfaces":surfaces,"archives":archives,"history_definition":definition,"revision":snapshot.revision()}),
        )
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut bridge = Bridge {
        store: Arc::new(MemorySessionStore::default()),
        executors: HashMap::new(),
    };
    for line in io::stdin().lock().lines() {
        let line = line?;
        let answer = match bridge.call(serde_json::from_str(&line)?).await {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        println!("{answer}");
        io::stdout().flush()?;
    }
    Ok(())
}
