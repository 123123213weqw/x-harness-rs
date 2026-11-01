//! Opt-in accounting experiment. Sends only synthetic text and a fixture image.
use super::*;
use std::sync::Arc;
use xharness_attachments::{AttachmentStore, ContentBlock, MemoryAttachmentStore, Upload};

#[tokio::test]
#[ignore = "paid official DeepSeek accounting experiment; requires an explicit evaluation key"]
async fn live_growth_and_restart_with_images() {
    let key = std::env::var("XHARNESS_MIXED_KEY").expect("evaluation key is required");
    let dir = std::env::temp_dir().join(format!("xh-mixed-live-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let mut rows = vec![];
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let path = dir.join(format!("{}.json", protocol.as_str()));
        let store = Arc::new(MemoryAttachmentStore::default());
        let image = store
            .put(
                "synthetic-live",
                Upload {
                    media_type: "image/png".into(),
                    data: include_bytes!(
                        "../../../xharness-attachments/tests/fixtures/red-blue.png"
                    )
                    .to_vec(),
                },
            )
            .await
            .unwrap();
        let config = OpenAiProviderConfig::new(
            protocol,
            "https://api.deepseek.com",
            key.clone(),
            "deepseek-flash",
        );
        let make = || {
            OpenAiProvider::new(config.clone())
                .unwrap()
                .with_attachments(store.clone())
                .with_calibration_store(Arc::new(CalibrationStore::open(path.clone())))
        };
        let mut provider = make();
        for i in 0..10 {
            if i == 8 {
                drop(provider);
                provider = make();
            }
            let filler = "synthetic alpha beta gamma delta epsilon zeta. ".repeat(6000 + i * 20);
            let request = ProviderRequest {
                messages: vec![
                    AgentMessage::user(format!("Accounting fixture. Ignore the filler and reply only OK.\n{filler}\nCase {i}. Reply OK.")),
                    AgentMessage::user("").with_content_blocks(vec![ContentBlock::Image { attachment: image.clone() }]),
                ],
                tools: vec![], step: i + 1, reasoning_effort: None, max_output_tokens: Some(1024), debug_scope: Default::default(),
            };
            let estimate = provider.estimate_input_tokens(&request).unwrap();
            let cold = OpenAiProvider::new(config.clone())
                .unwrap()
                .estimate_input_tokens(&request)
                .unwrap();
            let mut stream = provider
                .stream(request.clone(), CancellationToken::new())
                .await
                .unwrap();
            let mut actual = None;
            while let Some(event) = stream.next().await {
                if let ProviderEvent::Completed {
                    usage: Some(usage), ..
                } = event.unwrap()
                {
                    actual = Some(
                        usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens,
                    );
                }
            }
            let actual = actual.expect("complete provider usage is required");
            rows.push(json!({"protocol":protocol.as_str(),"step":i+1,"coldEstimate":cold.input_tokens,"estimate":estimate.input_tokens,"reportedInput":actual,"afterRestart":i>=8}));
            assert!(estimate.input_tokens >= actual, "{}", rows.last().unwrap());
            if i >= 8 {
                assert!(
                    estimate.input_tokens < cold.input_tokens * 3 / 4,
                    "{}",
                    rows.last().unwrap()
                );
            }
        }
    }
    let report =
        json!({"requests":rows,"scope":"synthetic input-accounting only; not model quality"});
    if let Ok(path) = std::env::var("XHARNESS_MIXED_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    eprintln!("{report}");
    std::fs::remove_dir_all(dir).unwrap();
}
