//! Generic MCP image projection, independent of any browser implementation.
#![forbid(unsafe_code)]

use std::{io::Cursor, sync::Arc};

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_computer::{ComputerMediaSink, Screenshot};
use xharness_tools::{ToolHandlerError, ToolOutput};

const MAX_PNG: usize = 8 * 1024 * 1024;
const MAX_TEXT: usize = 64 * 1024;
// Keep a blocking decode's permit alive even if its async caller is dropped.
static IMAGE_SLOT: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();

fn failure(message: &str) -> ToolHandlerError {
    ToolHandlerError::new(format!(
        "{message}; a tool effect may already have occurred; do not replay automatically"
    ))
}

/// Convert an MCP PNG into the existing session-owned attachment path. Bytes
/// never become a ToolOutput (including error paths), and a text-only result
/// retains its original serialized contract. One image is deliberate: the
/// existing media sink projects one image atomically, not a partial batch.
pub(super) async fn project(
    mut result: Value,
    sink: Option<&dyn ComputerMediaSink>,
    cancelled: &CancellationToken,
) -> Result<ToolOutput, ToolHandlerError> {
    let mut image = None;
    let mut invalid = None;
    if let Some(content) = result.get_mut("content").and_then(Value::as_array_mut) {
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            // Replace the entire untrusted image envelope before any fallible
            // work: malformed data and extension fields cannot leak inline.
            let original = std::mem::replace(
                block,
                json!({"type":"image","mimeType":"image/png","projection":"session_attachment"}),
            );
            if image.is_some() {
                invalid = Some("MCP result contains multiple images; request one image per call");
            }
            if original.get("mimeType").and_then(Value::as_str) != Some("image/png") {
                invalid = Some("MCP image MIME type is unsupported; request image/png");
            }
            image = Some(original);
        }
    }
    let Some(mut image) = image else {
        return super::call_output(result);
    };
    if result.to_string().len() > MAX_TEXT {
        return Err(failure("MCP image metadata exceeds text budget"));
    }
    // Tool failure evidence remains authoritative, but must not serialize its
    // screenshot wire bytes into a failure message.
    if result.get("isError").is_some() && result.get("isError") != Some(&Value::Bool(false)) {
        return super::call_output(result);
    }
    let summary = result.to_string();
    let fail = |message: &str| failure(&format!("{message}; MCP evidence: {summary}"));
    if let Some(message) = invalid {
        return Err(fail(message));
    }
    if cancelled.is_cancelled() {
        return Err(fail("MCP image projection cancelled"));
    }
    let encoded = image
        .as_object_mut()
        .and_then(|object| object.remove("data"))
        .and_then(|data| match data {
            Value::String(data) => Some(data),
            _ => None,
        })
        .ok_or_else(|| fail("invalid MCP image data"))?;
    if encoded.len() > MAX_PNG.div_ceil(3) * 4 {
        return Err(fail("MCP PNG exceeds byte budget"));
    }
    let sink = sink.ok_or_else(|| fail("MCP image attachment service unavailable"))?;
    let supports_images = tokio::select! {
        biased;
        _ = cancelled.cancelled() => return Err(fail("MCP image projection cancelled")),
        supported = sink.supports_images() => supported,
    };
    if !supports_images {
        return Err(fail(
            "current model does not declare image input; use semantic observation",
        ));
    }
    let semaphore = IMAGE_SLOT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone();
    let permit = tokio::select! {
        biased;
        _ = cancelled.cancelled() => return Err(fail("MCP image projection cancelled")),
        permit = semaphore.acquire_owned() => permit.map_err(|_| fail("MCP image decoder unavailable"))?,
    };
    let decode = tokio::task::spawn_blocking(move || (validate_png(&encoded), permit));
    let (png, _permit) = tokio::select! {
        biased;
        _ = cancelled.cancelled() => return Err(fail("MCP image projection cancelled")),
        png = decode => png.map_err(|_| fail("MCP image decoder unavailable"))?,
    };
    let png = png.map_err(fail)?;
    // Preserve the exact raster dimensions. Resizing a generic screenshot
    // would silently change model pixel coordinates without a frame transform.
    let projection = sink.project_png(
        summary,
        Screenshot {
            png,
            label: "MCP image (untrusted tool evidence; original raster dimensions)".into(),
        },
        cancelled.clone(),
    );
    tokio::select! {
        biased;
        _ = cancelled.cancelled() => Err(failure("MCP image projection cancelled")),
        output = projection => output,
    }
}

fn validate_png(encoded: &str) -> Result<Vec<u8>, &'static str> {
    let upload = xharness_attachments::Upload::from_base64("image/png", encoded)
        .map_err(|_| "invalid MCP PNG base64")?;
    if upload.data.is_empty() || upload.data.len() > MAX_PNG {
        return Err("MCP PNG exceeds byte budget");
    }
    let (width, height) = image::ImageReader::with_format(
        Cursor::new(upload.data.as_slice()),
        image::ImageFormat::Png,
    )
    .into_dimensions()
    .map_err(|_| "invalid MCP PNG header")?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16 * 1024 * 1024
    {
        return Err("MCP PNG exceeds dimension or pixel budget");
    }
    let mut reader = image::ImageReader::with_format(
        Cursor::new(upload.data.as_slice()),
        image::ImageFormat::Png,
    );
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(80 * 1024 * 1024);
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "invalid or oversized MCP PNG")?;
    Ok(upload.data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Media {
        supported: bool,
        calls: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl ComputerMediaSink for Media {
        async fn supports_images(&self) -> bool {
            self.supported
        }
        async fn project_png(
            &self,
            summary: String,
            screenshot: Screenshot,
            cancelled: CancellationToken,
        ) -> Result<ToolOutput, ToolHandlerError> {
            assert!(!cancelled.is_cancelled());
            assert!(!summary.contains("iVBOR") && !summary.contains("data:image"));
            let attachment =
                xharness_attachments::validate_preview_image(xharness_attachments::Upload {
                    media_type: "image/png".into(),
                    data: screenshot.png,
                })
                .unwrap()
                .reference;
            assert_eq!((attachment.width, attachment.height), (64, 32));
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(ToolOutput {
                content: summary,
                metadata: Some(json!({"xharnessContentBlocks":[
                    xharness_session::ContentBlock::Image { attachment }
                ]})),
                command_failure: None,
            })
        }
    }
    fn png() -> Value {
        let upload = xharness_attachments::Upload {
            media_type: "image/png".into(),
            data: include_bytes!("../../../xharness-attachments/tests/fixtures/red-blue.png")
                .to_vec(),
        };
        json!({"type":"image","mimeType":"image/png","data":xharness_attachments::validate_preview_image(upload).unwrap().base64()})
    }
    fn media(supported: bool) -> Media {
        Media {
            supported,
            calls: AtomicUsize::new(0),
        }
    }

    #[tokio::test]
    async fn png_projects_real_image_block_without_inline_transcript_bytes() {
        let sink = media(true);
        let output = project(
            json!({"isError":false,"content":[{"type":"text","text":"frame-1"},png()]}),
            Some(&sink),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(output.content.contains("frame-1"));
        assert!(!output.content.contains("iVBOR"));
        let blocks = xharness_session::ContentBlock::from_tool_metadata(output.metadata.as_ref());
        assert!(matches!(
            &blocks[0],
            xharness_session::ContentBlock::Image { .. }
        ));
        assert_eq!(sink.calls.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn text_only_projection_is_byte_compatible_and_needs_no_image_sink() {
        for result in [
            json!({"content":[{"type":"text","text":"unchanged"}]}),
            json!({"isError":false,"structuredContent":{"ok":true},"content":[]}),
        ] {
            assert_eq!(
                project(result.clone(), None, &CancellationToken::new())
                    .await
                    .unwrap(),
                ToolOutput::text(result.to_string())
            );
        }
    }
    #[tokio::test]
    async fn invalid_or_unsupported_images_never_become_text_or_partial_projection() {
        let sink = media(true);
        for block in [
            json!({"type":"image","mimeType":"image/jpeg","data":"secretbytes"}),
            json!({"type":"image","mimeType":"image/png","data":"secretbytes"}),
            json!({"type":"image","mimeType":"image/png","data":42}),
            json!({"type":"image","mimeType":"image/png","data":"A".repeat(MAX_PNG.div_ceil(3)*4+1)}),
        ] {
            let error = project(
                json!({"content":[block]}),
                Some(&sink),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert!(!error.message.contains("secretbytes"));
            assert!(!error.retryable);
        }
        assert!(project(
            json!({"content":[png(),png()]}),
            Some(&sink),
            &CancellationToken::new()
        )
        .await
        .is_err());
        assert_eq!(sink.calls.load(Ordering::Relaxed), 0);
        assert!(project(
            json!({"content":[png()]}),
            Some(&media(false)),
            &CancellationToken::new()
        )
        .await
        .is_err());
        assert!(
            project(json!({"content":[png()]}), None, &CancellationToken::new())
                .await
                .is_err()
        );
    }
    #[test]
    fn png_validation_preserves_large_raster_and_rejects_oversized_dimensions() {
        for width in [1700, 8193] {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(width, 1)
                .write_to(&mut bytes, image::ImageFormat::Png)
                .unwrap();
            let original = bytes.into_inner();
            let encoded =
                xharness_attachments::validate_preview_image(xharness_attachments::Upload {
                    media_type: "image/png".into(),
                    data: original.clone(),
                })
                .unwrap()
                .base64();
            if width == 1700 {
                assert_eq!(
                    validate_png(&encoded).unwrap(),
                    original,
                    "image bytes and coordinate geometry must not change"
                );
            } else {
                assert!(validate_png(&encoded).unwrap_err().contains("dimension"));
            }
        }
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_pending_media_sink() {
        struct PendingMedia(Arc<tokio::sync::Notify>);
        #[async_trait::async_trait]
        impl ComputerMediaSink for PendingMedia {
            async fn supports_images(&self) -> bool {
                true
            }
            async fn project_png(
                &self,
                _: String,
                _: Screenshot,
                _: CancellationToken,
            ) -> Result<ToolOutput, ToolHandlerError> {
                self.0.notify_one();
                std::future::pending().await
            }
        }
        let notified = Arc::new(tokio::sync::Notify::new());
        let sink = PendingMedia(notified.clone());
        let cancel = CancellationToken::new();
        let cancel_after_entry = cancel.clone();
        let task = tokio::spawn(async move {
            notified.notified().await;
            cancel_after_entry.cancel();
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            project(json!({"content":[png()]}), Some(&sink), &cancel),
        )
        .await
        .unwrap()
        .unwrap_err();
        task.await.unwrap();
        assert!(result.message.contains("cancelled"));
        assert!(!result.message.contains("iVBOR"));
        assert!(!result.retryable);
    }
    #[tokio::test]
    async fn failed_tool_or_cancellation_never_project_or_expose_image_data() {
        let sink = media(true);
        let result =
            json!({"isError":true,"content":[{"type":"text","text":"effect unknown"},png()]});
        let error = project(result, Some(&sink), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.message.contains("effect unknown"));
        assert!(!error.message.contains("iVBOR"));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(project(json!({"content":[png()]}), Some(&sink), &cancel)
            .await
            .is_err());
        assert_eq!(sink.calls.load(Ordering::Relaxed), 0);
    }
}
