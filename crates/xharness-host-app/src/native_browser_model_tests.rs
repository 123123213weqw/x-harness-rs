//! Real provider HTTP bodies, not merely intermediate ToolOutput assertions.
use super::*;
use async_trait::async_trait;
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use xharness_attachments::{AttachmentStore, MemoryAttachmentStore, Upload};
use xharness_core::{AgentMessage, LoopEngine, LoopRequest, LoopStatus, Role};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
use xharness_session::Store;
use xharness_tools::{ToolExecutor, ToolHandlerError, ToolOutput, ToolRegistry};

struct Media(Arc<MemoryAttachmentStore>);
#[async_trait]
impl xharness_computer::ComputerMediaSink for Media {
    async fn supports_images(&self) -> bool {
        true
    }
    async fn project_png(
        &self,
        summary: String,
        image: xharness_computer::Screenshot,
        _: CancellationToken,
    ) -> Result<ToolOutput, ToolHandlerError> {
        let attachment = self
            .0
            .put(
                "flat-wire",
                Upload {
                    media_type: "image/png".into(),
                    data: image.png,
                },
            )
            .await
            .map_err(|e| ToolHandlerError::new(e.to_string()))?;
        let mut output = ToolOutput::text(summary);
        output.metadata = Some(
            json!({"xharnessContentBlocks":[xharness_session::ContentBlock::Image{attachment}]}),
        );
        Ok(output)
    }
}

fn calls() -> Vec<Value> {
    let mut calls = Vec::new();
    for backend in [SERVER, HEADLESS_SERVER] {
        for gateway in [false, true] {
            for code in [
                "success",
                "exception",
                "timeout",
                "lost-reply",
                "bad-receipt",
            ] {
                let arguments =
                    json!({"code":code,"args":{"nested":{"x":1},"string":"{\"isError\":true}"}});
                let (name, args) = if gateway {
                    (
                        "plugin_mcp".to_owned(),
                        json!({"action":"call","plugin":PLUGIN,"server":backend,"tool":"evaluate","arguments":arguments}),
                    )
                } else {
                    ("browser_evaluate".to_owned(), {
                        let mut args = arguments;
                        args["backend"] = json!(backend);
                        args
                    })
                };
                calls.push(json!({"id":format!("{backend}-{gateway}-{code}"),"name":name,"arguments":args.to_string()}));
            }
        }
    }
    calls.push(json!({"id":"observe","name":"browser_observe","arguments":json!({"backend":SERVER}).to_string()}));
    calls.push(json!({"id":"invalid","name":"plugin_mcp","arguments":json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"observe","arguments":{"scope":"summary"}}).to_string()}));
    calls.push(json!({"id":"schema-invalid","name":"browser_evaluate","arguments":json!({"backend":SERVER,"code":"return 1","tab_id":"forbidden"}).to_string()}));
    calls.push(json!({"id":"archived","name":"browser_evaluate","arguments":json!({"backend":SERVER,"code":"large"}).to_string()}));
    for backend in [SERVER, HEADLESS_SERVER] {
        calls.push(json!({"id":format!("screenshot-{backend}"),"name":"browser_screenshot","arguments":json!({"backend":backend}).to_string()}));
        calls.push(json!({"id":format!("screenshot-gateway-{backend}"),"name":"plugin_mcp","arguments":json!({"action":"call","plugin":PLUGIN,"server":backend,"tool":"screenshot"}).to_string()}));
    }
    calls
}

fn frame(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn reply(protocol: OpenAiProtocol, first: bool) -> String {
    if protocol == OpenAiProtocol::ChatCompletions {
        let delta = if first {
            json!({"tool_calls":calls().iter().enumerate().map(|(index,c)| json!({"index":index,"id":c["id"],"type":"function","function":{"name":c["name"],"arguments":c["arguments"]}})).collect::<Vec<_>>()})
        } else {
            json!({"content":"inspected"})
        };
        return frame(json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]}))
            + &frame(
                json!({"choices":[{"index":0,"delta":{},"finish_reason":if first {"tool_calls"}else{"stop"}}]}),
            )
            + "data: [DONE]\n\n";
    }
    let mut text = String::new();
    if first {
        for (index, c) in calls().iter().enumerate() {
            let item = json!({"id":format!("item-{index}"),"type":"function_call","call_id":c["id"],"name":c["name"],"arguments":""});
            text += &frame(
                json!({"type":"response.output_item.added","output_index":index,"item":item}),
            );
            text += &frame(
                json!({"type":"response.function_call_arguments.delta","output_index":index,"delta":c["arguments"]}),
            );
            let mut item = item;
            item["arguments"] = c["arguments"].clone();
            text += &frame(
                json!({"type":"response.output_item.done","output_index":index,"item":item}),
            );
        }
    }
    text + &frame(
        json!({"type":"response.completed","response":{"status":"completed","output":[]}}),
    )
}

fn tool_texts(
    body: &Value,
    protocol: OpenAiProtocol,
) -> std::collections::BTreeMap<String, String> {
    let items = body[if protocol == OpenAiProtocol::ChatCompletions {
        "messages"
    } else {
        "input"
    }]
    .as_array()
    .unwrap();
    items
        .iter()
        .filter_map(|m| {
            if m["role"] == "tool" {
                Some((
                    m["tool_call_id"].as_str().unwrap().into(),
                    m["content"].as_str().unwrap().into(),
                ))
            } else if m["type"] == "function_call_output" {
                Some((
                    m["call_id"].as_str().unwrap().into(),
                    m["output"].as_str().unwrap().into(),
                ))
            } else {
                None
            }
        })
        .collect()
}

#[tokio::test]
async fn native_flat_results_reach_actual_http_in_both_protocols_and_restored_history() {
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = Arc::new(NativeBrowser {
            address: listener.local_addr().unwrap(),
            token: "a".repeat(64),
            headless: false,
            images: Default::default(),
        });
        let dispatched = Arc::new(Mutex::new(Vec::new()));
        let seen = dispatched.clone();
        let bridge = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let n = stream.read_u32().await.unwrap() as usize;
                assert!(n < 64 * 1024);
                let mut bytes = vec![0; n];
                stream.read_exact(&mut bytes).await.unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(request["owner"], "flat-wire");
                seen.lock().unwrap().push(request.clone());
                let result = match request["op"].as_str().unwrap() {
                    "evaluate" => match request["arguments"]["code"].as_str().unwrap() {
                        "lost-reply" => continue,
                        "bad-receipt" => json!("not an object"),
                        "large" => {
                            json!({"ok":true,"effect":"applied","value":"汉字".repeat(10000)})
                        }
                        "exception" | "timeout" => {
                            json!({"ok":false,"effect":"unknown","status":request["arguments"]["code"],"error":{"name":"Error","message":"fixture failure"},"console":[{"level":"error","text":"evidence"}]})
                        }
                        _ => {
                            json!({"ok":true,"effect":"applied","status":"completed","value":request["arguments"]["args"],"console":[{"level":"log","text":"fixture"}]})
                        }
                    },
                    "observe" => {
                        json!({"frame_id":"b".repeat(32),"text":"fixture page","nodes":[]})
                    }
                    "screenshot" => {
                        let png = xharness_attachments::validate_preview_image(Upload {
                            media_type: "image/png".into(),
                            data: include_bytes!(
                                "../../xharness-attachments/tests/fixtures/red-blue.png"
                            )
                            .to_vec(),
                        })
                        .unwrap();
                        json!({"frame_id":"b".repeat(32),"viewport":{"width":64,"height":32},"png_base64":png.base64()})
                    }
                    other => panic!("unexpected operation {other}"),
                };
                let bytes = serde_json::to_vec(&json!({"ok":true,"result":result})).unwrap();
                stream.write_u32(bytes.len() as u32).await.unwrap();
                stream.write_all(&bytes).await.unwrap();
            }
        });
        let attachments = Arc::new(MemoryAttachmentStore::default());
        let binding = crate::plugin_mcp::bind(
            None,
            None,
            Some(native),
            None,
            "flat-wire".into(),
            true,
            Some(Arc::new(Media(attachments.clone()))),
        );
        let registry = Arc::new(ToolRegistry::new());
        registry.register(binding.spec).await.unwrap();
        for spec in binding.native_specs {
            registry.register(spec).await.unwrap();
        }
        let executor = ToolExecutor::new(registry).with_guards(vec![binding.guard]);
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().fallback(axum::routing::post(
            move |axum::Json(body): axum::Json<Value>| {
                let captured = captured.clone();
                async move {
                    let mut requests = captured.lock().unwrap();
                    requests.push(body);
                    (
                        [("content-type", "text/event-stream")],
                        reply(protocol, requests.len() == 1),
                    )
                }
            },
        ));
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", http.local_addr().unwrap());
        let http = tokio::spawn(async move {
            axum::serve(http, router).await.unwrap();
        });
        let provider = Arc::new(
            OpenAiProvider::new(OpenAiProviderConfig::new(
                protocol,
                url,
                "fixture-only",
                "fixture",
            ))
            .unwrap()
            .with_attachments(attachments)
            .with_image_support(Some(true)),
        );
        let store = Arc::new(xharness_session::MemorySessionStore::default());
        let mut request = LoopRequest::new(
            provider.clone(),
            vec![AgentMessage::user("inspect fixtures")],
        );
        request.tool_executor = Some(executor.clone());
        request.session_id = Some("flat-wire".into());
        request.journal_store = Some(store.clone());
        request.config.tool_result_limit_bytes = 8192;
        let mut run = LoopEngine.start(request);
        let mut failed = 0;
        while let Some(event) = run.next().await {
            if let xharness_core::LoopEventKind::ToolCompleted { result, .. } = event.kind {
                if !result.ok {
                    failed += 1;
                }
            }
        }
        let result = run.result().await;
        assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
        assert_eq!(failed, 18);
        let bodies = requests.lock().unwrap().clone();
        assert_eq!(bodies.len(), 2);
        let texts = tool_texts(&bodies[1], protocol);
        assert_eq!(texts.len(), calls().len());
        for (id, text) in &texts {
            let root: Value = serde_json::from_str(text).unwrap();
            assert!(root["ok"].is_boolean(), "{id}: {root}");
            assert!(
                root.get("isError").is_none()
                    && (root.get("content").is_none() || root["content"] == ""),
                "{id}: {root}"
            );
            assert!(!text.contains("png_base64") && !text.contains("iVBOR"));
            if id.ends_with("-success") {
                assert_eq!(root["ok"], true);
                assert_eq!(root["value"]["nested"]["x"], 1);
                assert_eq!(root["value"]["string"], "{\"isError\":true}");
                assert_eq!(root["console"][0]["text"], "fixture");
            } else if id.ends_with("-exception") || id.ends_with("-timeout") {
                assert_eq!(root["ok"], false);
                assert_eq!(root["effect"], "unknown");
                assert_eq!(root["error"]["message"], "fixture failure");
            } else if id.ends_with("-lost-reply") {
                assert_eq!(root["effect"], "unknown");
                assert!(root["error"]
                    .as_str()
                    .unwrap()
                    .contains("do not replay automatically"));
            }
        }
        let invalid: Value = serde_json::from_str(&texts["invalid"]).unwrap();
        assert_eq!(invalid["effect"], "not_started");
        assert_eq!(invalid["code"], "invalid_browser_arguments");
        assert!(invalid["inputSchema"].is_object());
        assert_eq!(
            serde_json::from_str::<Value>(&texts["observe"]).unwrap()["text"],
            "fixture page"
        );
        assert_eq!(
            dispatched.lock().unwrap().len(),
            26,
            "no validation dispatch or replay"
        );
        let archived: Value = serde_json::from_str(&texts["archived"]).unwrap();
        assert_eq!(archived["ok"], true);
        assert_eq!(archived["truncated"], true);
        assert_eq!(archived["reduction"]["strategy"], "root_fields/v1");
        let raw = store
            .tool_result_archive("flat-wire", archived["archive"]["sha256"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        let original: xharness_core::ToolResult = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&original.content).unwrap()["value"],
            "汉字".repeat(10000)
        );
        // Images stay real provider image blocks, not base64 inside tool text.
        assert!(bodies[1].to_string().contains("data:image/png;base64,"));
        let history = store
            .load("flat-wire")
            .await
            .unwrap()
            .unwrap()
            .derive_messages();
        assert_eq!(
            history.iter().filter(|m| m.role == Role::Tool).count(),
            texts.len()
        );
        let mut restored =
            LoopRequest::new(provider, vec![AgentMessage::user("inspect saved results")]);
        restored.session_id = Some("flat-wire".into());
        restored.journal_store = Some(store);
        restored.tool_executor = Some(executor);
        let mut run = LoopEngine.start(restored);
        while run.next().await.is_some() {}
        assert_eq!(run.result().await.status, LoopStatus::Completed);
        assert_eq!(tool_texts(&requests.lock().unwrap()[2], protocol), texts);
        bridge.abort();
        http.abort();
        assert!(bridge.await.unwrap_err().is_cancelled());
        assert!(http.await.unwrap_err().is_cancelled());
    }
}
