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
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    };
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_host::{HostConfig, ModelRegistry, ModelSettingsBackend, NoTools};
    use xharness_session::ContentBlock;
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "xh-computer-media-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
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
}
