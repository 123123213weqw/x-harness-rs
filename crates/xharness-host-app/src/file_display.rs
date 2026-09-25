//! Native file reading belongs to deployment, not the reusable Host or browser.
use std::path::Path;
use xharness_api::display::{
    DisplayDiffSource, DisplayFile, MAX_DISPLAY_IMAGE_BYTES, MAX_TEXT_BYTES,
};
use xharness_platform::NativePlatform;

pub(crate) async fn read(
    platform: &NativePlatform,
    path: &Path,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<DisplayFile, String> {
    let (fs, target) = platform
        .resolve_read_file(path)
        .map_err(|e| e.to_string())?;
    // A UI preview is not a model read: do not authorize a later blind write
    // by inserting observations under the model session's identity.
    let prefix = fs
        .read_prefix("file-preview", &target, 16)
        .await
        .map_err(|e| e.to_string())?;
    let media = image_media(&prefix);
    let bytes = fs
        .read_preview_bytes(
            &target,
            if media.is_some() {
                MAX_DISPLAY_IMAGE_BYTES
            } else {
                MAX_TEXT_BYTES
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let display = path.to_string_lossy().into_owned();
    if let Some(media) = media {
        let image = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            xharness_attachments::validate_preview_image(xharness_attachments::Upload {
                media_type: media.into(),
                data: bytes,
            })
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        return Ok(DisplayFile::Image {
            path: display,
            media_type: image.reference.media_type.clone(),
            data_base64: image.base64(),
            width: image.reference.width,
            height: image.reference.height,
        });
    }
    let text =
        String::from_utf8(bytes).map_err(|_| "file is neither a supported image nor UTF-8 text")?;
    if text.contains('\0') {
        return Err("binary files cannot be displayed as text".into());
    }
    let extension = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(
        if matches!(extension.as_str(), "md" | "markdown" | "mdown") {
            DisplayFile::Markdown {
                path: display,
                text,
            }
        } else if matches!(extension.as_str(), "diff" | "patch") {
            DisplayFile::Diff {
                path: display,
                text,
                source: DisplayDiffSource::Patch,
            }
        } else {
            DisplayFile::Text {
                path: display,
                text,
            }
        },
    )
}
fn image_media(prefix: &[u8]) -> Option<&'static str> {
    if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if prefix.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_uses_bytes_not_a_spoofed_extension() {
        assert_eq!(image_media(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(image_media(b"<script>"), None);
        assert_eq!(image_media(b"RIFF0000WEBP"), Some("image/webp"));
        assert_eq!(image_media(b"RIFF0000WAVE"), None);
    }
}
