//! PR #39 image reader integrated under the existing `read` tool.
use serde_json::json;
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;
use xharness_host::BasicHost;
use xharness_platform::NativePlatform;
use xharness_tools::{ToolHandlerError, ToolOutput};
pub(crate) struct Reader {
    pub host: Weak<BasicHost>,
    pub platform: Arc<NativePlatform>,
    pub session: String,
}
fn err(e: impl std::fmt::Display) -> ToolHandlerError {
    ToolHandlerError::new(e.to_string())
}
#[async_trait::async_trait]
impl xharness_coding_tools::MediaReader for Reader {
    async fn read(
        &self,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<ToolOutput>, ToolHandlerError> {
        if cancel.is_cancelled() {
            return Err(err("read cancelled"));
        }
        let (fs, target) = self.platform.resolve_read_file(path).map_err(err)?;
        let prefix = fs
            .read_prefix(&self.session, &target, 16)
            .await
            .map_err(err)?;
        let media = if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if prefix.starts_with(&[255, 216, 255]) {
            "image/jpeg"
        } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
            "image/gif"
        } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            return Ok(None);
        };
        let host = self
            .host
            .upgrade()
            .ok_or_else(|| err("attachment service unavailable"))?;
        if !host.session_accepts_images(&self.session).await {
            return Err(err(
                "current model does not declare image input; switch to a vision model",
            ));
        }
        let data = tokio::select! {_=cancel.cancelled()=>return Err(err("read cancelled")),r=fs.read_bytes(&self.session,&target,xharness_attachments::MAX_IMAGE_BYTES)=>r.map_err(err)?};
        let r = host
            .attachment_store()
            .put(
                &self.session,
                xharness_attachments::Upload {
                    media_type: media.into(),
                    data,
                },
            )
            .await
            .map_err(err)?;
        if cancel.is_cancelled() {
            return Err(err("read cancelled"));
        }
        let text = format!(
            "Image {} ({} × {} pixels)",
            serde_json::to_string(path).unwrap(),
            r.width,
            r.height
        );
        Ok(Some(ToolOutput {
            content: text.clone(),
            metadata: Some(
                json!({"xharnessContentBlocks":[xharness_session::ContentBlock::Text{text},xharness_session::ContentBlock::Image{attachment:r}]}),
            ),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_coding_tools::MediaReader;
    use xharness_host::{HostConfig, ModelRegistry, ModelSettingsBackend, NoTools};
    use xharness_platform::PlatformConfig;
    struct Settings;
    #[async_trait::async_trait]
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
    #[tokio::test]
    async fn unified_reader_detects_bytes_gates_vision_and_uses_contained_paths() {
        let root = std::env::temp_dir().join(format!("xh-media-reader-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("screenshot"),
            include_bytes!("../../xharness-attachments/tests/fixtures/red-blue.png"),
        )
        .unwrap();
        std::fs::write(root.join("text.png"), "actually text").unwrap();
        let mut config = HostConfig::new(&root);
        config.provider_id = "p".into();
        config.model_id = "m".into();
        let host = BasicHost::new(config, None, Arc::new(NoTools));
        host.install_model_settings(Arc::new(Settings),json!({"providers":{"p":{"baseURL":"http://127.0.0.1:1","api":"openai-completions","models":[{"id":"m","imageInput":true}]}}})).await.unwrap();
        let result = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"cwd":root}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(created),
        } = result
        else {
            panic!("create failed")
        };
        let session = created["sessionId"].as_str().unwrap().to_owned();
        let reader = Reader {
            host: Arc::downgrade(&host),
            platform: Arc::new(NativePlatform::new(PlatformConfig::new(&root)).unwrap()),
            session: session.clone(),
        };
        let cancel = CancellationToken::new();
        assert!(reader.read("text.png", &cancel).await.unwrap().is_none());
        let out = reader.read("screenshot", &cancel).await.unwrap().unwrap();
        let blocks = xharness_session::ContentBlock::from_tool_metadata(out.metadata.as_ref());
        let xharness_session::ContentBlock::Image { attachment } = &blocks[1] else {
            panic!("image absent")
        };
        assert_eq!(
            host.attachment_store()
                .resolve(&session, &attachment.id)
                .await
                .unwrap()
                .data
                .as_slice(),
            include_bytes!("../../xharness-attachments/tests/fixtures/red-blue.png")
        );
        assert!(reader.read("../outside", &cancel).await.is_err());
        assert!(reader.read("missing", &cancel).await.is_err());
        let unknown = Reader {
            session: "unknown".into(),
            ..reader
        };
        assert!(unknown.read("screenshot", &cancel).await.is_err());
        cancel.cancel();
        assert!(unknown.read("text.png", &cancel).await.is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
