//! Ephemeral UI thumbnails. Never replace a durable attachment or model image.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use std::io::Cursor;

use image::{ImageDecoder, ImageEncoder, ImageFormat, ImageReader};

use crate::{AttachmentError, ResolvedAttachment, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS};

pub const THUMBNAIL_EDGE: u32 = 480;
pub const MAX_THUMBNAIL_BYTES: usize = 1024 * 1024;
// A dropped RPC must not release a still-running blocking decoder's permit.
static DECODE_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Debug)]
pub struct Thumbnail {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

fn invalid(reason: &str) -> AttachmentError {
    AttachmentError::Invalid(reason.into())
}

/// Bounded, non-cached derivative of an already session-authorized image.
/// Unsupported/animated images keep an explicit original-open UI instead of a
/// silently frozen poster. Busy work is retryable, not an unbounded decode queue.
pub async fn thumbnail(source: ResolvedAttachment) -> Result<Thumbnail, AttachmentError> {
    let permit = DECODE_SLOT
        .try_acquire()
        .map_err(|_| invalid("thumbnail decoder busy; retry"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        render(&source)
    })
    .await
    .map_err(|_| invalid("thumbnail decoder failed"))?
}

fn still_png(data: &[u8]) -> bool {
    let mut offset = 8usize;
    while let Some(header) = data.get(offset..offset.saturating_add(8)) {
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let Some(end) = offset
            .checked_add(length)
            .and_then(|end| end.checked_add(12))
        else {
            return false;
        };
        // Preserve uncommon color/HDR/PNG-EXIF semantics by refusing a thumbnail
        // rather than dropping metadata that this encoder cannot round-trip.
        if end > data.len()
            || matches!(
                &header[4..8],
                b"acTL" | b"gAMA" | b"cHRM" | b"cICP" | b"mDCv" | b"cLLi" | b"eXIf"
            )
        {
            return false;
        }
        if &header[4..8] == b"IEND" {
            return length == 0 && end == data.len();
        }
        offset = end;
    }
    false
}

fn render(source: &ResolvedAttachment) -> Result<Thumbnail, AttachmentError> {
    render_fit(source, THUMBNAIL_EDGE, THUMBNAIL_EDGE)
}

/// The same bounded decoder slot serves gallery tiles and workspace previews.
/// A cancelled waiter cannot release a still-running native decoder's permit.
pub async fn preview(
    source: ResolvedAttachment,
    width: u32,
    height: u32,
) -> Result<Thumbnail, AttachmentError> {
    if width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || u64::from(width) * u64::from(height) > 4 * 1024 * 1024
    {
        return Err(invalid("invalid preview pixel budget"));
    }
    let permit = DECODE_SLOT
        .try_acquire()
        .map_err(|_| invalid("thumbnail decoder busy; retry"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        render_fit(&source, width, height)
    })
    .await
    .map_err(|_| invalid("thumbnail decoder failed"))?
}

pub fn oriented_dimensions(source: &ResolvedAttachment) -> Result<(u32, u32), AttachmentError> {
    let mut decoder = ImageReader::new(Cursor::new(source.data.as_slice()))
        .with_guessed_format()
        .map_err(|_| invalid("invalid image format"))?
        .into_decoder()
        .map_err(|_| invalid("invalid image header"))?;
    let dimensions = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .map_err(|_| invalid("invalid image orientation"))?;
    use image::metadata::Orientation;
    Ok(
        if matches!(
            orientation,
            Orientation::Rotate90
                | Orientation::Rotate270
                | Orientation::Rotate90FlipH
                | Orientation::Rotate270FlipH
        ) {
            (dimensions.1, dimensions.0)
        } else {
            dimensions
        },
    )
}

fn render_fit(
    source: &ResolvedAttachment,
    max_width: u32,
    max_height: u32,
) -> Result<Thumbnail, AttachmentError> {
    let data = source.data.as_slice();
    if data.is_empty() || data.len() > MAX_IMAGE_BYTES {
        return Err(invalid("invalid thumbnail source size"));
    }
    let format = image::guess_format(data).map_err(|_| invalid("invalid thumbnail format"))?;
    match (format, source.reference.media_type.as_str()) {
        (ImageFormat::Png, "image/png") if still_png(data) => (),
        (ImageFormat::Jpeg, "image/jpeg") => (),
        _ => {
            return Err(invalid(
                "thumbnail unavailable for this format; open original",
            ))
        }
    }
    let (width, height) = ImageReader::with_format(Cursor::new(data), format)
        .into_dimensions()
        .map_err(|_| invalid("invalid thumbnail dimensions"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(invalid("thumbnail source exceeds pixel limit"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| invalid("thumbnail decoder unavailable"))?;
    let orientation = decoder
        .orientation()
        .map_err(|_| invalid("invalid image orientation"))?;
    let profile = decoder
        .icc_profile()
        .map_err(|_| invalid("invalid image color profile"))?;
    if profile
        .as_ref()
        .is_some_and(|profile| profile.len() > 64 * 1024)
    {
        return Err(invalid(
            "thumbnail color profile exceeds limit; open original",
        ));
    }
    if profile
        .as_ref()
        .is_some_and(|profile| profile.get(16..20) != Some(b"RGB "))
    {
        return Err(invalid(
            "thumbnail requires an RGB color profile; open original",
        ));
    }
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| invalid("thumbnail decode failed"))?;
    decoded.apply_orientation(orientation);
    // Do not upscale small images. Keep the bounded area-resampler instead of
    // allocating a wide floating-point intermediate plane for large rasters.
    // PNG avoids adding JPEG artifacts to screenshot text and preserves alpha.
    let source_width = decoded.width();
    let source_height = decoded.height();
    let small = if decoded.width() > max_width || decoded.height() > max_height {
        let small = decoded.thumbnail(max_width, max_height);
        drop(decoded);
        small
    } else {
        decoded
    };
    let rgba = small.into_rgba8();
    let mut data = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut data);
    if let Some(profile) = profile {
        encoder
            .set_icc_profile(profile)
            .map_err(|_| invalid("thumbnail color profile unsupported"))?;
    }
    encoder
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| invalid("thumbnail encoding failed"))?;
    if data.len()
        > if max_width <= THUMBNAIL_EDGE && max_height <= THUMBNAIL_EDGE {
            MAX_THUMBNAIL_BYTES
        } else {
            8 * 1024 * 1024
        }
    {
        return Err(invalid("thumbnail output exceeds limit"));
    }
    Ok(Thumbnail {
        data,
        width: rgba.width(),
        height: rgba.height(),
        source_width,
        source_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn source(width: u32, height: u32) -> Result<ResolvedAttachment, Box<dyn std::error::Error>> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([12, 34, 56, 78]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png)?;
        Ok(crate::validate_preview_image(crate::Upload {
            media_type: "image/png".into(),
            data: bytes.into_inner(),
        })?)
    }

    #[test]
    fn true_thumbnail_preserves_aspect_alpha_original_bytes_and_no_upscale(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for (width, height, expected) in [
            (3200, 2000, (480, 300)),
            (2000, 3200, (300, 480)),
            (32, 24, (32, 24)),
        ] {
            let source = source(width, height)?;
            let original = source.data.clone();
            let small = render(&source)?;
            assert_eq!((small.width, small.height), expected);
            assert!(small.data.len() <= MAX_THUMBNAIL_BYTES);
            let decoded = image::load_from_memory(&small.data)?.to_rgba8();
            assert_eq!(*decoded.get_pixel(0, 0), image::Rgba([12, 34, 56, 78]));
            assert_eq!(source.data.as_slice(), original.as_slice());
            assert_eq!(
                (source.reference.width, source.reference.height),
                (width, height)
            );
        }
        Ok(())
    }

    #[test]
    fn jpeg_orientation_and_icc_are_not_silently_discarded(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut data = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new(&mut data);
        // TIFF IFD0 orientation=6 (90 degrees clockwise).
        let exif = vec![
            b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        encoder.set_exif_metadata(exif)?;
        let mut profile = vec![0u8; 128];
        profile[16..20].copy_from_slice(b"RGB ");
        encoder.set_icc_profile(profile.clone())?;
        encoder.encode(
            &vec![100; 32 * 16 * 3],
            32,
            16,
            image::ExtendedColorType::Rgb8,
        )?;
        let source = crate::validate_preview_image(crate::Upload {
            media_type: "image/jpeg".into(),
            data,
        })?;
        let small = render(&source)?;
        assert_eq!((small.width, small.height), (16, 32));
        assert_eq!(oriented_dimensions(&source)?, (16, 32));
        let mut decoder =
            ImageReader::with_format(Cursor::new(small.data), ImageFormat::Png).into_decoder()?;
        assert_eq!(decoder.icc_profile()?, Some(profile));
        Ok(())
    }

    #[test]
    fn fitted_preview_preserves_full_dimensions_and_small_images(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let source = source(1600, 1000)?;
        let original = source.data.clone();
        for (w, h, expected) in [
            (600, 600, (600, 375)),
            (1200, 1200, (1200, 750)),
            (2000, 2000, (1600, 1000)),
        ] {
            let result = render_fit(&source, w, h)?;
            assert_eq!((result.width, result.height), expected);
            assert_eq!((result.source_width, result.source_height), (1600, 1000));
            assert_eq!(source.data.as_slice(), original.as_slice());
        }
        Ok(())
    }
    #[tokio::test]
    async fn preview_rejects_zero_extreme_and_overbudget_targets(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for (w, h) in [(0, 1), (1, 0), (4097, 1), (4096, 4096)] {
            assert!(preview(source(2, 2)?, w, h).await.is_err());
        }
        Ok(())
    }

    #[test]
    fn malformed_animated_or_nonimage_sources_do_not_fall_back_to_original_bytes(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let source = source(64, 32)?;
        // Insert an animation-control chunk before IEND. Detection must refuse
        // it before decoding, even when its CRC/payload is not otherwise valid.
        let mut animated = source.clone();
        let mut data = animated.data.as_ref().clone();
        data.splice(
            data.len() - 12..data.len() - 12,
            [0, 0, 0, 0, b'a', b'c', b'T', b'L', 0, 0, 0, 0],
        );
        animated.data = Arc::new(data);
        assert!(render(&animated).is_err());
        for data in [
            Vec::new(),
            b"not an image".to_vec(),
            source.data[..32].to_vec(),
        ] {
            let mut bad = source.clone();
            bad.data = Arc::new(data);
            assert!(render(&bad).is_err());
        }
        for media in ["text/plain", "image/gif", "image/webp"] {
            let mut bad = source.clone();
            bad.reference.media_type = media.into();
            assert!(render(&bad).is_err());
        }
        Ok(())
    }

    #[tokio::test]
    async fn busy_decoder_fails_closed_instead_of_queuing_more_native_work(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let permit = DECODE_SLOT.try_acquire()?;
        assert!(thumbnail(source(2, 2)?).await.is_err());
        drop(permit);
        let small = thumbnail(source(2, 2)?).await?;
        assert_eq!((small.width, small.height), (2, 2));
        Ok(())
    }
}
