use std::sync::Weak;

use async_trait::async_trait;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xharness_computer::{ComputerMediaSink, Screenshot};
use xharness_host::BasicHost;
use xharness_tools::{ToolHandlerError, ToolOutput};

pub(crate) struct Sink {
    pub host: Weak<BasicHost>,
    pub session: String,
}

fn error(value: impl std::fmt::Display) -> ToolHandlerError {
    ToolHandlerError::new(value.to_string())
}

#[async_trait]
impl ComputerMediaSink for Sink {
    async fn supports_images(&self) -> bool {
        match self.host.upgrade() {
            Some(host) => host.session_accepts_images(&self.session).await,
            None => false,
        }
    }

    async fn project_png(
        &self,
        summary: String,
        screenshot: Screenshot,
        cancellation: CancellationToken,
    ) -> Result<ToolOutput, ToolHandlerError> {
        if cancellation.is_cancelled() {
            return Err(error("computer observation cancelled"));
        }
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| error("attachment service unavailable"))?;
        if !host.session_accepts_images(&self.session).await {
            return Err(error(
                "current model does not declare image input; use semantic observation",
            ));
        }
        let attachment = host
            .attachment_store()
            .put(
                &self.session,
                xharness_attachments::Upload {
                    media_type: "image/png".into(),
                    data: screenshot.png,
                },
            )
            .await
            .map_err(error)?;
        if cancellation.is_cancelled() {
            return Err(error("computer observation cancelled"));
        }
        let image_label = format!(
            "{} ({} × {} pixels)",
            screenshot.label, attachment.width, attachment.height
        );
        Ok(ToolOutput {
            content: summary.clone(),
            metadata: Some(json!({
                "xharnessContentBlocks": [
                    xharness_session::ContentBlock::Text { text: summary },
                    xharness_session::ContentBlock::Text { text: image_label },
                    xharness_session::ContentBlock::Image { attachment }
                ]
            })),
            command_failure: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_host::{HostConfig, ModelRegistry, ModelSettingsBackend, NoTools};
    use xharness_session::ContentBlock;
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            Self::new_at(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )
        }
        fn new_at(timestamp: u128) -> Self {
            // Wall-clock precision is not a uniqueness guarantee, especially
            // for parallel macOS tests. Each guard must own a distinct root.
            static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "xh-computer-media-{}-{}-{}",
                std::process::id(),
                timestamp,
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct Settings;
    #[async_trait]
    impl ModelSettingsBackend for Settings {
        async fn prepare(&self, _: &serde_json::Value) -> Result<ModelRegistry, String> {
            Err("unused".into())
        }
        fn activate(&self, _: ModelRegistry) {}
        async fn credential_info(&self, _: &str) -> Result<serde_json::Value, String> {
            Err("unused".into())
        }
        async fn set_credential(
            &self,
            _: &str,
            _: &str,
            _: &serde_json::Value,
        ) -> Result<ModelRegistry, String> {
            Err("unused".into())
        }
        async fn unset_credential(
            &self,
            _: &str,
            _: &serde_json::Value,
        ) -> Result<ModelRegistry, String> {
            Err("unused".into())
        }
        async fn discover(
            &self,
            _: &serde_json::Value,
            _: &serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            Err("unused".into())
        }
    }
    async fn fixture(root: &Root, images: bool) -> (Arc<BasicHost>, Sink) {
        let mut config = HostConfig::new(&root.0);
        config.home = root.0.clone();
        config.provider_id = "p".into();
        config.model_id = "m".into();
        config.attachment_store = Arc::new(
            xharness_attachments::FileAttachmentStore::new(root.0.join("attachments")).unwrap(),
        );
        let host = BasicHost::new(config, None, Arc::new(NoTools));
        host.install_model_settings(Arc::new(Settings),json!({"providers":{"p":{"baseURL":"http://127.0.0.1:1","api":"openai-completions","models":[{"id":"m","imageInput":images}]}}})).await.unwrap();
        let result = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"cwd":root.0}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(created),
        } = result
        else {
            panic!("create failed");
        };
        let sink = Sink {
            host: Arc::downgrade(&host),
            session: created["sessionId"].as_str().unwrap().to_owned(),
        };
        (host, sink)
    }
    fn png() -> Screenshot {
        Screenshot {
            png: include_bytes!("../../xharness-attachments/tests/fixtures/red-blue.png").to_vec(),
            label: "Windows desktop observation".into(),
        }
    }
    #[test]
    fn same_clock_tick_roots_cannot_collide_or_remove_each_others_files() {
        let first = Root::new_at(123);
        let retained = first.0.join("retained");
        std::fs::write(&retained, "first fixture").unwrap();
        let second = Root::new_at(123);
        assert_ne!(first.0, second.0);
        drop(second);
        assert_eq!(std::fs::read_to_string(retained).unwrap(), "first fixture");
    }
    #[tokio::test]
    async fn computer_png_uses_durable_session_scoped_reference_not_inline_history_bytes() {
        let root = Root::new();
        let (host, sink) = fixture(&root, true).await;
        assert!(sink.supports_images().await);
        let output = sink
            .project_png("observed desktop".into(), png(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(output.content, "observed desktop");
        let serialized = serde_json::to_string(&output.metadata).unwrap();
        assert!(!serialized.contains("data:image") && !serialized.contains("iVBOR"));
        let metadata: Option<serde_json::Value> = serde_json::from_str(&serialized).unwrap();
        let blocks = ContentBlock::from_tool_metadata(metadata.as_ref());
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "observed desktop"));
        let ContentBlock::Image { attachment } = &blocks[2] else {
            panic!("image missing");
        };
        assert_eq!(attachment.session_id, sink.session);
        assert_eq!((attachment.width, attachment.height), (64, 32));
        let store = host.attachment_store();
        let first = store.resolve(&sink.session, &attachment.id).await.unwrap();
        assert_eq!(first.data.as_slice(), png().png);
        assert!(store
            .resolve("other-session", &attachment.id)
            .await
            .is_err());
        drop(first);
        drop(store);
        drop(output);
        drop(host);
        let reopened =
            xharness_attachments::FileAttachmentStore::new(root.0.join("attachments")).unwrap();
        let restored = xharness_attachments::AttachmentStore::resolve(
            &reopened,
            &sink.session,
            &attachment.id,
        )
        .await
        .unwrap();
        assert_eq!(restored.reference, *attachment);
        assert_eq!(restored.data.as_slice(), png().png);
        // This proves sink persistence/projection, not installed GUI/JSONL E2E.
    }
    #[tokio::test]
    async fn unsupported_or_cancelled_computer_capture_cannot_be_projected() {
        let root = Root::new();
        let (_host, sink) = fixture(&root, false).await;
        assert!(!sink.supports_images().await);
        assert!(sink
            .project_png("summary".into(), png(), CancellationToken::new())
            .await
            .is_err());
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(sink
            .project_png("summary".into(), png(), cancel)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn lost_host_and_invalid_png_fail_without_plaintext_fallback() {
        let root = Root::new();
        let (host, sink) = fixture(&root, true).await;
        assert!(sink
            .project_png(
                "summary".into(),
                Screenshot {
                    png: b"not a PNG".to_vec(),
                    label: "invalid".into()
                },
                CancellationToken::new()
            )
            .await
            .is_err());
        drop(host);
        assert!(!sink.supports_images().await);
        assert!(sink
            .project_png("summary".into(), png(), CancellationToken::new())
            .await
            .is_err());
    }

    #[derive(Default)]
    struct MediaProvider {
        requests: std::sync::Mutex<Vec<xharness_core::ProviderRequest>>,
    }
    #[async_trait]
    impl xharness_core::ModelProvider for MediaProvider {
        async fn stream(
            &self,
            request: xharness_core::ProviderRequest,
            _: CancellationToken,
        ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
            use xharness_core::{FinishReason, ProviderEvent};
            let first = request.step == 1;
            self.requests.lock().unwrap().push(request);
            let events = if first {
                vec![
                    Ok(ProviderEvent::ToolCallDelta {
                        index: 0,
                        id: "computer-image-call".into(),
                        name: "computer".into(),
                        arguments_delta: r#"{"action":"observe","include_screenshot":true}"#.into(),
                    }),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::ToolCalls),
                        usage: None,
                        provider_items: Vec::new(),
                    }),
                ]
            } else {
                vec![
                    Ok(ProviderEvent::TextDelta("image observed".into())),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::Stop),
                        usage: None,
                        provider_items: Vec::new(),
                    }),
                ]
            };
            Ok(Box::pin(futures::stream::iter(events)))
        }
    }
    struct MediaDriver(Arc<AtomicU64>);
    #[async_trait]
    impl xharness_computer::ComputerDriver for MediaDriver {
        async fn execute(
            &self,
            request: xharness_computer::ComputerRequest,
            _: CancellationToken,
        ) -> Result<xharness_computer::ComputerOutput, xharness_computer::ComputerError> {
            assert_eq!(request.action, xharness_computer::ComputerAction::Observe);
            assert_eq!(request.include_screenshot, Some(true));
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(xharness_computer::ComputerOutput {
                value: json!({"frame_id":"fixture-frame","observed":true}),
                screenshot: Some(png()),
            })
        }
    }
    #[derive(Default)]
    struct MediaTools {
        host: std::sync::OnceLock<Weak<BasicHost>>,
        calls: Arc<AtomicU64>,
    }
    #[async_trait]
    impl xharness_host::SessionToolFactory for MediaTools {
        async fn executor(
            &self,
            session_id: &str,
            _: &str,
            _: xharness_host::PermissionPreset,
        ) -> Result<xharness_tools::ToolExecutor, String> {
            let registry = Arc::new(xharness_tools::ToolRegistry::new());
            registry
                .register(
                    xharness_computer::ComputerTool::new(Arc::new(MediaDriver(self.calls.clone())))
                        .with_media_sink(Arc::new(Sink {
                            host: self.host.get().unwrap().clone(),
                            session: session_id.into(),
                        }))
                        .spec(),
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(xharness_tools::ToolExecutor::new(registry))
        }
    }
    async fn rpc(
        host: &BasicHost,
        method: RpcMethod,
        value: serde_json::Value,
    ) -> serde_json::Value {
        let result = host
            .call(
                RpcId::new(method.to_string()),
                method,
                value,
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success { value: Some(value) } = result else {
            panic!("{method}: {result:?}");
        };
        xharness_api::protocol::TypedRpcResponse::decode(method, &value).unwrap();
        value
    }
    fn durable_config(root: &Root) -> HostConfig {
        let mut config = HostConfig::new(&root.0);
        config.home = root.0.clone();
        config.provider_id = "p".into();
        config.model_id = "m".into();
        config.attachment_store = Arc::new(
            xharness_attachments::FileAttachmentStore::new(root.0.join("attachments")).unwrap(),
        );
        config
    }
    #[tokio::test]
    async fn registered_computer_image_survives_host_history_and_restart_without_replay() {
        use xharness_host::{AgentRuntime, DurableLoopAgentRuntime};
        use xharness_session::{EventData, Store};
        let root = Root::new();
        let store = Arc::new(
            xharness_session_jsonl::JsonlSessionStore::new(root.0.join("sessions")).unwrap(),
        );
        let provider = Arc::new(MediaProvider::default());
        let tools = Arc::new(MediaTools::default());
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "p",
            "m",
            Some(provider.clone()),
            tools.clone(),
            Arc::new(xharness_core::IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            128,
        ));
        let host = BasicHost::with_agent_runtime(durable_config(&root), runtime.clone());
        tools.host.set(Arc::downgrade(&host)).unwrap();
        host.install_model_settings(Arc::new(Settings), json!({"providers":{"p":{"baseURL":"http://127.0.0.1:1","api":"openai-completions","models":[{"id":"m","imageInput":true}]}}})).await.unwrap();
        let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":root.0})).await;
        let sid = created["sessionId"].as_str().unwrap();
        rpc(&host, RpcMethod::SessionPrompt, json!({"sessionId":sid,"mode":"queue","content":[{"type":"text","text":"observe the fixture image"}]})).await;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let session = store.load(sid).await.unwrap().unwrap();
                if session
                    .events()
                    .iter()
                    .any(|e| matches!(e.data(), EventData::TurnEnd { .. }))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("computer turn did not settle");
        let attachment = {
            let requests = provider.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            let message = requests[1]
                .messages
                .iter()
                .find(|m| m.role == xharness_core::Role::Tool)
                .unwrap();
            assert!(message.content.contains("fixture-frame"));
            let ContentBlock::Image { attachment } = &message.content_blocks[2] else {
                panic!("provider image missing")
            };
            attachment.clone()
        };
        let live = rpc(&host, RpcMethod::SessionHistory, json!({"sessionId":sid})).await;
        let encoded = serde_json::to_string(&live).unwrap();
        assert!(encoded.contains(&attachment.id));
        assert!(!encoded.contains("data:image") && !encoded.contains("iVBOR"));
        assert!(runtime
            .shutdown(std::time::Duration::from_secs(2))
            .await
            .is_graceful());
        store.flush(sid).await.unwrap();
        let sid = sid.to_owned();
        let calls = tools.calls.clone();
        drop(host);
        drop(runtime);
        drop(tools);
        drop(store);
        let reopened = Arc::new(
            xharness_session_jsonl::JsonlSessionStore::new(root.0.join("sessions")).unwrap(),
        );
        let restored_runtime = Arc::new(DurableLoopAgentRuntime::new(
            "p",
            "m",
            None,
            Arc::new(NoTools),
            Arc::new(xharness_core::IdentityContextPolicy),
            reopened.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            128,
        ));
        let restored =
            BasicHost::with_agent_runtime(durable_config(&root), restored_runtime.clone());
        restored
            .restore_from_store_with_policy(
                reopened,
                xharness_host::RecoveryPolicy::PauseIncompleteTools,
            )
            .await
            .unwrap();
        let history = rpc(
            &restored,
            RpcMethod::SessionHistory,
            json!({"sessionId":sid}),
        )
        .await;
        assert_eq!(live["events"], history["events"]);
        let image = rpc(
            &restored,
            RpcMethod::SessionAttachment,
            json!({"sessionId":sid,"attachmentId":attachment.id}),
        )
        .await;
        let bytes = restored
            .attachment_store()
            .resolve(&sid, &attachment.id)
            .await
            .unwrap();
        assert_eq!(image["data"], bytes.base64());
        assert_eq!(bytes.data.as_slice(), png().png);
        assert_eq!(
            calls.load(Ordering::Relaxed),
            1,
            "history must not reexecute computer input"
        );
        assert!(restored_runtime
            .shutdown(std::time::Duration::from_secs(2))
            .await
            .is_graceful());
        // Uses a fixture PNG and driver: validates the real Host/tool/JSONL/RPC
        // seams, but is not installed Windows GUI or screen-capture acceptance.
    }
}
