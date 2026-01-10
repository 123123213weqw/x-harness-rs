use std::time::{Duration, Instant};

use serde_json::{json, Value};
use xharness_context::{
    ContextPolicy, ContextRequest, IdentityContextPolicy, ToolResultPruningContextPolicy,
};
use xharness_session::{Message, MessageRole, ToolCall};
use xharness_token::{ConservativeByteMeter, TokenEstimateRequest, TokenMeter};

const TOOL_CALLS: usize = 32;
const FILE_BYTES: usize = 16 * 1_024;
const REASONING_BYTES: usize = 2 * 1_024;
const ITERATIONS: usize = 100;

fn fixture() -> Vec<Message> {
    let mut messages = Vec::with_capacity(TOOL_CALLS * 4 + 1);
    for index in 0..TOOL_CALLS {
        let call_id = format!("provider-write-{index}");
        let arguments_json = json!({
            "path": format!("artifact-{index}.txt"),
            "content": "x".repeat(FILE_BYTES),
        })
        .to_string();
        messages.push(Message::user(format!("write artifact {index}")));
        messages.push(Message {
            role: MessageRole::Assistant,
            reasoning: "r".repeat(REASONING_BYTES),
            tool_calls: vec![ToolCall {
                id: format!("execution-write-{index}"),
                provider_call_id: Some(call_id.clone()),
                index: 0,
                name: "write".to_owned(),
                arguments_json: arguments_json.clone(),
            }],
            provider_items: vec![
                json!({"type":"reasoning","opaque":index}),
                json!({
                    "type":"function_call",
                    "call_id":call_id,
                    "name":"write",
                    "arguments":arguments_json,
                }),
            ],
            ..Message::default()
        });
        messages.push(Message::tool(
            call_id,
            json!({
                "ok": true,
                "content": {"bytes_written": FILE_BYTES, "index": index},
                "error": "",
                "truncated": false,
            })
            .to_string(),
        ));
        messages.push(Message::assistant(format!("artifact {index} completed")));
    }
    messages.push(Message::user("summarize the completed batch"));
    messages
}

fn serialized_messages(messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| serde_json::to_value(message).unwrap())
        .collect()
}

fn estimate(messages: &[Message]) -> u64 {
    ConservativeByteMeter
        .estimate(&TokenEstimateRequest {
            provider: "ablation".to_owned(),
            model: Some("fixture".to_owned()),
            conversation_messages: serialized_messages(messages),
            ..TokenEstimateRequest::default()
        })
        .unwrap()
        .total_input_tokens
}

async fn elapsed<P: ContextPolicy>(policy: &P, source: &[Message]) -> Duration {
    let started = Instant::now();
    for _ in 0..ITERATIONS {
        let surface = policy
            .prepare(ContextRequest::new(source.to_vec()))
            .await
            .unwrap();
        std::hint::black_box(surface);
    }
    started.elapsed()
}

#[tokio::test]
async fn many_completed_tool_calls_are_smaller_deterministic_and_replay_safe() {
    let source = fixture();
    let identity = IdentityContextPolicy
        .prepare(ContextRequest::new(source.clone()))
        .await
        .unwrap();
    let policy = ToolResultPruningContextPolicy::default();
    let projected = policy
        .prepare(ContextRequest::new(source.clone()))
        .await
        .unwrap();
    let repeated = policy
        .prepare(ContextRequest::new(source.clone()))
        .await
        .unwrap();

    assert_eq!(projected, repeated, "projection must be deterministic");
    assert_eq!(projected.messages.len(), identity.messages.len());
    assert_eq!(projected.source_message_count, source.len());
    projected.validate().unwrap();

    let original_bytes = serde_json::to_vec(&identity.messages).unwrap().len();
    let projected_bytes = serde_json::to_vec(&projected.messages).unwrap().len();
    let original_estimate = estimate(&identity.messages);
    let projected_estimate = estimate(&projected.messages);
    assert!(
        projected_bytes * 5 < original_bytes,
        "the P0 surface should be at least 5x smaller"
    );
    assert!(projected_estimate * 5 < original_estimate);

    let mut observed_calls = 0;
    let mut observed_results = 0;
    for message in &projected.messages {
        for call in &message.tool_calls {
            observed_calls += 1;
            let arguments: Value = serde_json::from_str(&call.arguments_json).unwrap();
            assert_eq!(
                arguments["_xharness_history_projection"]["format"],
                "tool_arguments_pruned/v1"
            );
            let expected_provider_id = format!("provider-write-{}", observed_calls - 1);
            assert_eq!(call.provider_id(), expected_provider_id);
        }
        if message.role == MessageRole::Tool {
            observed_results += 1;
        }
        if message.role == MessageRole::Assistant && !message.tool_calls.is_empty() {
            assert!(message.reasoning.is_empty());
            assert!(!message.provider_items.is_empty());
            assert_eq!(
                message.provider_items[1]["arguments"],
                message.tool_calls[0].arguments_json
            );
        }
    }
    assert_eq!(observed_calls, TOOL_CALLS);
    assert_eq!(observed_results, TOOL_CALLS);

    let identity_elapsed = elapsed(&IdentityContextPolicy, &source).await;
    let projected_elapsed = elapsed(&policy, &source).await;
    println!(
        "context-p0-ablation tool_calls={TOOL_CALLS} iterations={ITERATIONS} original_bytes={original_bytes} projected_bytes={projected_bytes} reduction_pct={:.2} original_estimate={} projected_estimate={} identity_prepare_ms={:.3} projected_prepare_ms={:.3}",
        100.0 * (original_bytes - projected_bytes) as f64 / original_bytes as f64,
        original_estimate,
        projected_estimate,
        identity_elapsed.as_secs_f64() * 1_000.0,
        projected_elapsed.as_secs_f64() * 1_000.0,
    );
}
