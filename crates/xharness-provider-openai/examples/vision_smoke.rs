//! Optional real endpoint smoke. Config JSON is read from stdin; never log credentials.
//! Compile/run remotely only. Uses a synthetic fixture, never a user's attachment.
use futures::StreamExt;
use serde_json::{json, Value};
use std::{io::Read, sync::Arc};
use tokio_util::sync::CancellationToken;
use xharness_attachments::{AttachmentStore, ContentBlock, FileAttachmentStore, Upload};
use xharness_core::{AgentMessage, FinishReason, ModelProvider, ProviderEvent, ProviderRequest};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cfg: Value = serde_json::from_str(&input)?;
    let root = std::env::temp_dir().join(format!("xh-vision-smoke-{}", std::process::id()));
    let store = FileAttachmentStore::new(&root)?;
    let image = store
        .put(
            "smoke",
            Upload {
                media_type: "image/png".into(),
                data: include_bytes!("../../xharness-attachments/tests/fixtures/red-blue.png")
                    .to_vec(),
            },
        )
        .await?;
    let message=AgentMessage::user("").with_content_blocks(vec![ContentBlock::Text { text:"Identify the two solid colors in this image. Answer exactly: left=<color>, right=<color>.".into() },ContentBlock::Image { attachment:image }]);
    let serialized = serde_json::to_vec(&message)?;
    drop(store);
    let store = Arc::new(FileAttachmentStore::new(&root)?);
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        cfg["base_url"].as_str().ok_or("base_url missing")?,
        cfg["api_key"].as_str().ok_or("api_key missing")?,
        cfg["model"].as_str().ok_or("model missing")?,
    ))?
    .with_attachments(store);
    let mut messages = vec![serde_json::from_slice::<AgentMessage>(&serialized)?];
    for step in 1..=2 {
        if step == 2 {
            messages.push(AgentMessage::user(
                "Confirm the left and right colors of the same image again, using the same format.",
            ));
        }
        let request = ProviderRequest {
            messages: messages.clone(),
            tools: vec![],
            step,
            reasoning_effort: None,
            max_output_tokens: Some(4096),
            debug_scope: Default::default(),
        };
        let begin = std::time::Instant::now();
        let mut stream = provider.stream(request, CancellationToken::new()).await?;
        let mut text = String::new();
        let mut finish = None;
        while let Some(event) = stream.next().await {
            match event? {
                ProviderEvent::TextDelta(delta) => text.push_str(&delta),
                ProviderEvent::Completed { finish_reason, .. } => finish = finish_reason,
                _ => {}
            }
        }
        println!(
            "{}",
            json!({"step":step,"elapsed_ms":begin.elapsed().as_millis(),"text":text,"finish":format!("{finish:?}")})
        );
        if finish != Some(FinishReason::Stop)
            || !text.to_lowercase().contains("red")
            || !text.to_lowercase().contains("blue")
        {
            return Err("vision smoke acceptance failed".into());
        }
        messages.push(AgentMessage::assistant(text));
    }
    std::fs::remove_dir_all(root)?;
    Ok(())
}
