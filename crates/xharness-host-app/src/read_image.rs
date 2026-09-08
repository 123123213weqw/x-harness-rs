use serde_json::json;
use std::sync::Arc;
use xharness_attachment::MAX_IMAGE_BYTES;
use xharness_host::BasicHost;
use xharness_platform::NativePlatform;
use xharness_session::ContentBlock;
use xharness_tools::{ToolConcurrency, ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

pub(crate) fn spec(
    host: &Arc<BasicHost>,
    platform: Arc<NativePlatform>,
    session: &str,
) -> ToolSpec {
    let host = Arc::downgrade(host);
    let session = session.to_owned();
    ToolSpec::new(ToolDefinition {
        name: "read_image".into(),
        description: "Read a PNG/JPEG/WebP/GIF image and return the image itself. Requires the current model to declare image input. Files are validated and large images are normalized before the next request; do not install image libraries just to view them.".into(),
        parameters: json!({"type":"object","properties":{"file_path":{"type":"string","description":"Workspace-relative or permitted absolute image path"}},"required":["file_path"],"additionalProperties":false}),
    }, move |ctx| {
        let host = host.clone(); let platform = platform.clone(); let session = session.clone();
        async move {
            let host = host.upgrade().ok_or_else(|| ToolHandlerError::new("attachment service unavailable"))?;
            // Exact-route gate before ANY filesystem access, like upstream.
            if !host.session_accepts_images(&session).await { return Err(ToolHandlerError::new("current model does not declare image input; switch to an image-capable model")); }
            let path = ctx.arguments.get("file_path").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).ok_or_else(|| ToolHandlerError::new("file_path is required"))?.to_owned();
            if ctx.cancellation.is_cancelled() { return Err(ToolHandlerError::new("read_image cancelled")); }
            let (filesystem, target) = platform.resolve_read_file(&path).map_err(|e| ToolHandlerError::new(e.to_string()))?;
            let bytes = filesystem.read_bytes(&session, &target, MAX_IMAGE_BYTES).await.map_err(|e| ToolHandlerError::new(e.to_string()))?;
            if ctx.cancellation.is_cancelled() { return Err(ToolHandlerError::new("read_image cancelled")); }
            let media = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" } else if bytes.starts_with(&[255,216,255]) { "image/jpeg" } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { "image/gif" } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "image/webp" } else { return Err(ToolHandlerError::new("file is not a supported image")); };
            let store = host.attachment_store();
            let name = path.clone();
            let attachment = tokio::task::spawn_blocking(move || store.save_image(&bytes, media, Some(&name))).await.map_err(|e| ToolHandlerError::new(e.to_string()))?.map_err(|e| ToolHandlerError::new(e.to_string()))?;
            let text = format!("[image: {}; {} x {} pixels; {}]", serde_json::to_string(&path).unwrap(), attachment.width.unwrap_or(0), attachment.height.unwrap_or(0), attachment.attachment_id);
            // Store publication completed before this result can be journaled.
            Ok(ToolOutput { content: text.clone(), metadata: Some(json!({"path":path,"xharnessContentBlocks":[ContentBlock::Text { text }, ContentBlock::Image { attachment, data_url: None }]})) })
        }
    }).with_concurrency(ToolConcurrency::Parallel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_core::{
        IdentityContextPolicy, ModelProvider, ProviderError, ProviderRequest, ProviderStream,
    };
    use xharness_host::{HostConfig, LoopAgentRuntime, NoTools};
    use xharness_platform::PlatformConfig;
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

    struct UncalledProvider;
    #[async_trait::async_trait]
    impl ModelProvider for UncalledProvider {
        fn provider_name(&self) -> &str {
            "fixture"
        }
        async fn stream(
            &self,
            _: ProviderRequest,
            _: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            panic!("tool tests never contact a model");
        }
    }

    async fn fixture(images: bool) -> (Arc<BasicHost>, ToolExecutor) {
        let cwd = std::env::temp_dir();
        let mut config = HostConfig::new(&cwd);
        config.provider_id = "fixture".into();
        config.model_id = "fixture".into();
        let runtime = LoopAgentRuntime::new(
            "fixture",
            "fixture",
            Some(Arc::new(UncalledProvider)),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
        )
        .with_image_input(images);
        let host = BasicHost::with_agent_runtime(config, Arc::new(runtime));
        let created = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"sessionId":"image-tool-fixture","cwd":cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }), "{created:?}");
        let platform = Arc::new(NativePlatform::new(PlatformConfig::new(&cwd)).unwrap());
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(spec(&host, platform, "image-tool-fixture"))
            .await
            .unwrap();
        (host, ToolExecutor::new(registry))
    }

    #[tokio::test]
    async fn text_only_gate_precedes_file_access() {
        let (_host, executor) = fixture(false).await;
        let result = executor
            .execute(ToolRequest::new(
                "read_image",
                json!({"file_path":"file-that-does-not-exist.png"}).to_string(),
            ))
            .await;
        assert!(result
            .failure
            .unwrap()
            .message
            .contains("does not declare image input"));
    }

    #[tokio::test]
    async fn native_image_tool_returns_persistable_blocks_and_rejects_invalid_files() {
        let (host, executor) = fixture(true).await;
        let name = format!("xh-read-image-{}.png", std::process::id());
        let path = std::env::temp_dir().join(&name);
        std::fs::write(
            &path,
            include_bytes!("../../../apps/desktop/src-tauri/icons/32x32.png"),
        )
        .unwrap();
        let result = executor
            .execute(ToolRequest::new(
                "read_image",
                json!({"file_path":name}).to_string(),
            ))
            .await;
        assert!(result.is_ok(), "{result:?}");
        let output = result.output.unwrap();
        let blocks = ContentBlock::from_tool_metadata(output.metadata.as_ref());
        let ContentBlock::Image {
            attachment,
            data_url,
        } = &blocks[1]
        else {
            panic!("missing image block")
        };
        assert_eq!((attachment.width, attachment.height), (Some(32), Some(32)));
        assert!(data_url.is_none());
        assert!(!host.attachment_store().read(attachment).unwrap().is_empty());
        assert!(!serde_json::to_string(&output).unwrap().contains("base64"));
        std::fs::write(&path, b"not an image").unwrap();
        let invalid = executor
            .execute(ToolRequest::new(
                "read_image",
                json!({"file_path":name}).to_string(),
            ))
            .await;
        assert!(invalid
            .failure
            .unwrap()
            .message
            .contains("not a supported image"));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = executor
            .execute(
                ToolRequest::new("read_image", json!({"file_path":name}).to_string())
                    .with_cancellation(cancellation),
            )
            .await;
        assert!(!cancelled.is_ok());
        std::fs::remove_file(path).unwrap();
    }
}
