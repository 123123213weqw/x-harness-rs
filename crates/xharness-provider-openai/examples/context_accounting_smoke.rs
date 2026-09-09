//! Optional real provider regression. Secrets from stdin, synthetic tool data only.
use futures::StreamExt;
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, ModelProvider, ProviderEvent, ProviderRequest, ToolCall, ToolDefinition,
};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cfg: Value = serde_json::from_str(&input)?;
    let profile = OpenAiReasoningProfile::new(
        Some("off".into()),
        [("off".into(), json!({"thinking":{"type":"disabled"}}))],
    )?;
    let provider = OpenAiProvider::new(
        OpenAiProviderConfig::new(
            OpenAiProtocol::ChatCompletions,
            cfg["base_url"].as_str().ok_or("base_url")?,
            cfg["api_key"].as_str().ok_or("api_key")?,
            cfg["model"].as_str().ok_or("model")?,
        )
        .with_reasoning_profile(profile),
    )?;
    let tools=vec![ToolDefinition{name:"echo".into(),description:"Return the supplied integer as a deterministic fixture. Call exactly once per user request.".into(),parameters:json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]})}];
    let mut messages = vec![AgentMessage::user(format!(
        "Fixture reference, retain in context:\n{}",
        "alpha beta gamma delta\n".repeat(400)
    ))];
    let mut warmed = false;
    for step in 1..=12 {
        messages.push(AgentMessage::user(format!(
            "Call echo with n={step}. Do not answer in text."
        )));
        let r = ProviderRequest {
            messages: messages.clone(),
            tools: tools.clone(),
            step,
            reasoning_effort: None,
            max_output_tokens: Some(256),
            debug_scope: Default::default(),
        };
        let estimate = provider
            .estimate_input_tokens(&r)
            .ok_or("missing estimate")?;
        warmed |= estimate.accuracy == xharness_token::TokenCountAccuracy::Calibrated;
        let start = std::time::Instant::now();
        let mut stream = provider.stream(r, CancellationToken::new()).await?;
        let mut calls: BTreeMap<usize, ToolCall> = BTreeMap::new();
        let mut actual = 0;
        while let Some(event) = stream.next().await {
            match event? {
                ProviderEvent::ToolCallDelta {
                    index,
                    id,
                    name,
                    arguments_delta,
                } => {
                    let c = calls.entry(index).or_insert_with(|| ToolCall {
                        id: String::new(),
                        provider_call_id: None,
                        index,
                        name: String::new(),
                        arguments_json: String::new(),
                    });
                    if !id.is_empty() {
                        c.id = id;
                    }
                    if !name.is_empty() {
                        c.name = name;
                    }
                    c.arguments_json.push_str(&arguments_delta);
                }
                ProviderEvent::Completed { usage: Some(u), .. } => {
                    actual = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens
                }
                _ => {}
            }
        }
        if calls.len() != 1 || actual == 0 {
            return Err("tool/usage missing".into());
        }
        let call = calls.into_values().next().unwrap();
        let args: Value = serde_json::from_str(&call.arguments_json)?;
        if call.name != "echo" || args["n"] != step {
            return Err("wrong tool arguments".into());
        }
        let mut assistant = AgentMessage::assistant("");
        assistant.tool_calls = vec![call.clone()];
        messages.push(assistant);
        messages.push(AgentMessage::tool(call.id,json!({"ok":true,"content":json!({"exit_code":0,"stdout":format!("n={step}\n"),"stderr":""}).to_string(),"error":"","truncated":false}).to_string()));
        println!(
            "{}",
            json!({"step":step,"estimated":estimate.input_tokens,"accuracy":estimate.accuracy,"actual":actual,"elapsed_ms":start.elapsed().as_millis(),"tool_ok":true})
        );
        if estimate.input_tokens < actual {
            return Err("underestimate in synthetic regression".into());
        }
    }
    if !warmed {
        return Err("calibration did not warm up".into());
    }
    Ok(())
}
