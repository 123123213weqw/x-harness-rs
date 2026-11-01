//! Native file reading belongs to deployment, not the reusable Host or browser.
use base64::{engine::general_purpose::STANDARD, Engine};
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
    let pdf = prefix.starts_with(b"%PDF-");
    let bytes = fs
        .read_preview_bytes(
            &target,
            if media.is_some() || pdf {
                MAX_DISPLAY_IMAGE_BYTES
            } else {
                MAX_TEXT_BYTES
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let display = path.to_string_lossy().into_owned();
    if pdf {
        return tokio::task::spawn_blocking(move || {
            let _permit = permit;
            DisplayFile::Pdf {
                path: display,
                data_base64: STANDARD.encode(bytes),
            }
        })
        .await
        .map_err(|error| error.to_string());
    }
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
/// Card metadata never reads an Office/archive/media file wholesale. Only an
/// explicitly requested, small raster thumbnail enters the bounded decoder.
pub(crate) async fn inspect(
    platform: &NativePlatform,
    path: &Path,
    thumbnail: bool,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<xharness_api::display::DisplayInspection, String> {
    let (fs, target) = platform
        .resolve_read_file(path)
        .map_err(|e| e.to_string())?;
    let mut sample = fs
        .inspect_preview(&target, 4096)
        .await
        .map_err(|e| e.to_string())?;
    if thumbnail && image_media(&sample.prefix).is_some() && sample.bytes <= 2 * 1024 * 1024 {
        sample = fs
            .inspect_preview(&target, 2 * 1024 * 1024)
            .await
            .map_err(|e| e.to_string())?;
    }
    let display = path.to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        inspect_sample(display, sample, thumbnail)
    })
    .await
    .map_err(|e| e.to_string())
}
fn inspect_sample(
    path: String,
    sample: xharness_fs::PreviewInspection,
    want_thumbnail: bool,
) -> xharness_api::display::DisplayInspection {
    use std::io::Cursor;
    use xharness_api::display::{DisplayInspection, DisplayPreviewKind as Kind, DisplayThumbnail};
    let image = image_media(&sample.prefix).is_some();
    let pdf = sample.prefix.starts_with(b"%PDF-");
    let limit = if image || pdf {
        MAX_DISPLAY_IMAGE_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    let utf8 = match std::str::from_utf8(&sample.prefix) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    };
    let text = utf8 && !sample.prefix.contains(&0) && !sample.prefix.starts_with(b"PK");
    let ext = Path::new(&path)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let preview = if !image && !pdf && !text {
        Kind::Unsupported
    } else if sample.bytes > limit as u64 {
        Kind::TooLarge
    } else if image {
        Kind::Image
    } else if pdf {
        Kind::Pdf
    } else if matches!(ext.as_str(), "md" | "markdown" | "mdown") {
        Kind::Markdown
    } else {
        Kind::Text
    };
    let mut result = DisplayInspection {
        path,
        bytes: sample.bytes,
        preview,
        modified_ms: sample.modified_ms,
        width: None,
        height: None,
        thumbnail: None,
    };
    if !image {
        return result;
    }
    let Ok(format) = image::guess_format(&sample.prefix) else {
        return result;
    };
    let Ok((width, height)) =
        image::ImageReader::with_format(Cursor::new(&sample.prefix), format).into_dimensions()
    else {
        return result;
    };
    result.width = Some(width);
    result.height = Some(height);
    if u64::from(width) * u64::from(height) > 16 * 1024 * 1024 || width == 0 || height == 0 {
        result.preview = Kind::Unsupported;
        return result;
    }
    if !want_thumbnail
        || sample.bytes != sample.prefix.len() as u64
        || sample.bytes > 2 * 1024 * 1024
        || u64::from(width) * u64::from(height) > 4 * 1024 * 1024
    {
        return result;
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(sample.prefix), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(32 * 1024 * 1024);
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    reader.limits(limits);
    if let Ok(decoded) = reader.decode() {
        let small = decoded.thumbnail(96, 96);
        let mut output = Cursor::new(Vec::new());
        if small.write_to(&mut output, image::ImageFormat::Png).is_ok()
            && output.get_ref().len() <= 48 * 1024
        {
            result.thumbnail = Some(DisplayThumbnail {
                data_base64: STANDARD.encode(output.into_inner()),
                width: small.width(),
                height: small.height(),
            });
        }
    }
    result
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
