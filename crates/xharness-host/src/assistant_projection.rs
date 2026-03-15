//! Shared live/history Web block contract. Canonical messages store reasoning
//! separately, so both views use reasoning, text, then tool-call slots. We do
//! not claim to preserve cross-kind interleaving that the message schema lacks.
use serde_json::{json, Value};

pub(crate) fn reasoning_delta(text: &str) -> Value {
    json!({"type":"reasoning-delta", "index":0, "text":text})
}

pub(crate) fn text_delta(text: &str) -> Value {
    json!({"type":"text-delta", "index":1, "text":text})
}

pub(crate) fn tool_delta(index: usize, id: &str, name: &str, arguments: &str) -> Value {
    json!({"type":"tool-call-delta", "index":index.saturating_add(2),
        "id":id, "name":name, "argumentsDelta":arguments})
}

pub(crate) fn content(text: &str, reasoning: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    if !reasoning.is_empty() {
        blocks.push(json!({"type":"reasoning", "text":reasoning}));
    }
    if !text.is_empty() {
        blocks.push(json!({"type":"text", "text":text}));
    }
    blocks
}
