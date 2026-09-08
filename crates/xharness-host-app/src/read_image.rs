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
            let target = platform.resolve_file(&path).map_err(|e| ToolHandlerError::new(e.to_string()))?;
            let bytes = platform.filesystem().read_bytes(&session, &target, MAX_IMAGE_BYTES).await.map_err(|e| ToolHandlerError::new(e.to_string()))?;
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
