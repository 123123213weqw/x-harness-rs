//! Immutable attachment bytes; session journals contain references, not paths or payloads.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use xharness_session::AttachmentRef;

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_IMAGES: usize = 20;
pub const MAX_PROMPT_IMAGE_BYTES: usize = 200 * 1024 * 1024;
pub const MAX_INLINE_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PIXELS: u64 = 64_000_000;
const MAX_DIMENSION: u32 = 8192;
const NORMALIZED_PIXELS: u64 = 4_000_000;
const NORMALIZED_BYTES: usize = 4 * 1024 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error("{0}")]
    Invalid(String),
    #[error("attachment storage: {0}")]
    Io(#[from] std::io::Error),
}
type Result<T> = std::result::Result<T, AttachmentError>;
fn invalid(message: impl Into<String>) -> AttachmentError {
    AttachmentError::Invalid(message.into())
}

#[derive(Debug, Default)]
pub struct AttachmentStore {
    root: Option<PathBuf>,
    memory: Mutex<BTreeMap<String, Vec<u8>>>,
    request_cache: Mutex<BTreeMap<String, (String, Vec<u8>)>>,
}

impl AttachmentStore {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        Ok(Self {
            root: Some(fs::canonicalize(root)?),
            ..Self::default()
        })
    }

    pub fn root_path(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    pub fn decode_base64(data: &str, limit: usize) -> Result<Vec<u8>> {
        if data.len() > limit.saturating_add(2) / 3 * 4 {
            return Err(invalid("attachment exceeds the upload byte limit"));
        }
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| invalid("invalid attachment base64"))?;
        if bytes.len() > limit {
            return Err(invalid("attachment exceeds the upload byte limit"));
        }
        Ok(bytes)
    }

    pub fn encode_base64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    pub fn save_image(
        &self,
        bytes: &[u8],
        declared: &str,
        name: Option<&str>,
    ) -> Result<AttachmentRef> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(invalid("image is empty or exceeds 20 MiB"));
        }
        let format = image_format(declared)?;
        if image::guess_format(bytes).ok() != Some(format) {
            return Err(invalid("image media type does not match its contents"));
        }
        let mut decoded = decode_image(bytes, format)?;
        decoded = resize_pixels(decoded, NORMALIZED_PIXELS);
        let (media_type, normalized) = encode_bounded(&decoded, NORMALIZED_BYTES)?;
        let mut reference = self.save_bytes(&normalized, &media_type, name)?;
        reference.width = Some(decoded.width());
        reference.height = Some(decoded.height());
        Ok(reference)
    }

    pub fn save_file(
        &self,
        bytes: &[u8],
        media_type: &str,
        name: Option<&str>,
    ) -> Result<AttachmentRef> {
        // The current JSON RPC transport is bounded. No extension allowlist and
        // no document parsing: ordinary files are preserved byte for byte.
        if bytes.len() > MAX_INLINE_FILE_BYTES {
            return Err(invalid("file exceeds the 32 MiB inline transport limit"));
        }
        self.save_bytes(bytes, media_type, name)
    }

    fn save_bytes(
        &self,
        bytes: &[u8],
        media_type: &str,
        name: Option<&str>,
    ) -> Result<AttachmentRef> {
        if media_type.len() > 128 || media_type.chars().any(char::is_control) {
            return Err(invalid("invalid attachment media type"));
        }
        let id = format!("sha256:{:x}", Sha256::digest(bytes));
        let reference = AttachmentRef {
            attachment_id: id.clone(),
            media_type: if media_type.is_empty() {
                "application/octet-stream".into()
            } else {
                media_type.to_owned()
            },
            bytes: bytes.len() as u64,
            name: name.map(safe_filename),
            width: None,
            height: None,
        };
        match &self.root {
            Some(root) => {
                let digest = digest(&id)?;
                let dir = root.join("objects").join(&digest[..2]);
                fs::create_dir_all(&dir)?;
                let dir = checked_dir(root, &dir)?;
                publish(&dir.join(digest), bytes)?;
            }
            None => {
                self.memory
                    .lock()
                    .unwrap()
                    .entry(id)
                    .or_insert_with(|| bytes.to_vec());
            }
        }
        Ok(reference)
    }

    pub fn read(&self, reference: &AttachmentRef) -> Result<Vec<u8>> {
        let digest = digest(&reference.attachment_id)?;
        // A forged reference must never drive an unbounded allocation.
        if reference.bytes > MAX_INLINE_FILE_BYTES.max(MAX_IMAGE_BYTES) as u64 {
            return Err(invalid("invalid attachment size"));
        }
        let bytes = match &self.root {
            Some(root) => {
                let path =
                    checked_file(root, &root.join("objects").join(&digest[..2]).join(digest))?;
                let mut bytes = Vec::new();
                File::open(path)?
                    .take(reference.bytes.saturating_add(1))
                    .read_to_end(&mut bytes)?;
                bytes
            }
            None => self
                .memory
                .lock()
                .unwrap()
                .get(&reference.attachment_id)
                .cloned()
                .ok_or_else(|| invalid("attachment was not found"))?,
        };
        if bytes.len() as u64 != reference.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != digest
        {
            return Err(invalid("attachment integrity check failed"));
        }
        Ok(bytes)
    }

    /// A verified, immutable alias retaining the safe file extension for tools.
    pub fn file_path(&self, reference: &AttachmentRef) -> Result<Option<PathBuf>> {
        let bytes = self.read(reference)?;
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let dir = root.join("files").join(digest(&reference.attachment_id)?);
        fs::create_dir_all(&dir)?;
        let dir = checked_dir(root, &dir)?;
        let path = dir.join(safe_filename(
            reference.name.as_deref().unwrap_or("attachment"),
        ));
        publish(&path, &bytes)?;
        Ok(Some(checked_file(root, &path)?))
    }

    /// Deterministic, bounded request variants. This cache is disposable.
    pub fn image_data_url(&self, reference: &AttachmentRef) -> Result<String> {
        let key = format!("v1:{}", reference.attachment_id);
        if let Some((media, bytes)) = self.request_cache.lock().unwrap().get(&key) {
            return Ok(format!("data:{media};base64,{}", STANDARD.encode(bytes)));
        }
        let bytes = self.read(reference)?;
        let image = resize_pixels(
            decode_image(&bytes, image_format(&reference.media_type)?)?,
            640_000,
        );
        let (media, bytes) = encode_bounded(&image, 1024 * 1024)?;
        let data = format!("data:{media};base64,{}", STANDARD.encode(&bytes));
        let mut cache = self.request_cache.lock().unwrap();
        if cache.len() >= 16 {
            cache.clear();
        }
        cache.insert(key, (media, bytes));
        Ok(data)
    }
}

fn image_format(media: &str) -> Result<ImageFormat> {
    match media {
        "image/png" => Ok(ImageFormat::Png),
        "image/jpeg" => Ok(ImageFormat::Jpeg),
        "image/webp" => Ok(ImageFormat::WebP),
        "image/gif" => Ok(ImageFormat::Gif),
        _ => Err(invalid(
            "unsupported image format (PNG, JPEG, WebP and GIF are supported)",
        )),
    }
}

fn decode_image(bytes: &[u8], format: ImageFormat) -> Result<DynamicImage> {
    let reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| invalid("invalid or corrupt image"))?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(invalid("image dimensions exceed the decode limit"));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(256 * 1024 * 1024);
    decoder
        .set_limits(limits)
        .map_err(|_| invalid("image exceeds decode memory limit"))?;
    let orientation = decoder
        .orientation()
        .map_err(|_| invalid("invalid image orientation"))?;
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|_| invalid("invalid or corrupt image"))?;
    image.apply_orientation(orientation);
    Ok(if image.color().has_alpha() {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    })
}

fn resize_pixels(image: DynamicImage, budget: u64) -> DynamicImage {
    let pixels = u64::from(image.width()) * u64::from(image.height());
    if pixels <= budget {
        return image;
    }
    let factor = (budget as f64 / pixels as f64).sqrt();
    image.resize(
        (image.width() as f64 * factor).floor().max(1.0) as u32,
        (image.height() as f64 * factor).floor().max(1.0) as u32,
        image::imageops::FilterType::Triangle,
    )
}

fn encode_bounded(image: &DynamicImage, max_bytes: usize) -> Result<(String, Vec<u8>)> {
    for quality in [85, 75, 60] {
        let mut output = Cursor::new(Vec::new());
        let media = if image.color().has_alpha() {
            image
                .write_to(&mut output, ImageFormat::WebP)
                .map_err(|_| invalid("image normalization failed"))?;
            "image/webp"
        } else {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
                .encode_image(image)
                .map_err(|_| invalid("image normalization failed"))?;
            "image/jpeg"
        };
        if output.get_ref().len() <= max_bytes {
            return Ok((media.into(), output.into_inner()));
        }
    }
    Err(invalid(
        "normalized image exceeds the byte budget; use a smaller image",
    ))
}

pub fn safe_filename(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let mut name: String = leaf
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    name = name.trim_end_matches([' ', '.']).to_owned();
    while name.len() > 220 {
        name.pop();
    }
    if name.is_empty() {
        name = "attachment".into();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        name.insert(0, '_');
    }
    name
}

fn digest(id: &str) -> Result<&str> {
    let hash = id
        .strip_prefix("sha256:")
        .ok_or_else(|| invalid("invalid attachment id"))?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid("invalid attachment id"));
    }
    Ok(hash)
}

fn checked_dir(root: &Path, path: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with(root) {
        return Err(invalid("attachment path escaped its store"));
    }
    Ok(canonical)
}
fn checked_file(root: &Path, path: &Path) -> Result<PathBuf> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid("attachment object must not be a symlink"));
    }
    let canonical = checked_dir(root, path)?;
    if !fs::metadata(&canonical)?.is_file() {
        return Err(invalid("attachment object is not a regular file"));
    }
    Ok(canonical)
}

fn publish(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(invalid("attachment object must not be a symlink"));
        }
        let mut existing = Vec::new();
        File::open(path)?
            .take(bytes.len() as u64 + 1)
            .read_to_end(&mut existing)?;
        if existing != bytes {
            return Err(invalid("existing attachment object is corrupt"));
        }
        return Ok(());
    }
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let outcome = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(true);
        file.set_permissions(permissions)?;
        drop(file);
        // Same-filesystem hard link is atomic and never overwrites a winner.
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => publish(path, bytes),
            Err(error) => Err(error.into()),
        }
    })();
    // The temporary is our exact create_new path, never a caller-controlled glob.
    // Windows read-only links cannot be unlinked until their attribute is reset.
    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)]
    // Windows file attribute, never Unix mode bits.
    if let Ok(metadata) = fs::metadata(&temporary) {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&temporary, permissions);
    }
    let _ = fs::remove_file(&temporary);
    #[cfg(windows)]
    if outcome.is_ok() {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions)?;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> {
        let image = DynamicImage::new_rgba8(2, 3);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    #[test]
    fn normalized_images_have_real_dimensions_and_verifiable_data() {
        let store = AttachmentStore::default();
        let image = store
            .save_image(&png(), "image/png", Some("screenshot.png"))
            .unwrap();
        assert_eq!((image.width, image.height), (Some(2), Some(3)));
        assert!(image.attachment_id.starts_with("sha256:"));
        assert!(store
            .image_data_url(&image)
            .unwrap()
            .starts_with("data:image/webp;base64,"));
        assert_eq!(
            image,
            store
                .save_image(&png(), "image/png", Some("screenshot.png"))
                .unwrap()
        );
        assert!(store.save_image(b"fake", "image/png", None).is_err());
        assert!(store.save_image(&png(), "image/jpeg", None).is_err());
    }
    #[test]
    fn generic_bytes_survive_reopen_and_paths_are_safe() {
        let root = std::env::temp_dir().join(format!(
            "xharness-attachment-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let store = AttachmentStore::new(&root).unwrap();
        let reference = store
            .save_file(
                b"pdf bytes verbatim",
                "application/pdf",
                Some("C:\\secret\\report.pdf"),
            )
            .unwrap();
        assert_eq!(reference.name.as_deref(), Some("report.pdf"));
        drop(store);
        let reopened = AttachmentStore::new(&root).unwrap();
        assert_eq!(reopened.read(&reference).unwrap(), b"pdf bytes verbatim");
        assert!(reopened
            .file_path(&reference)
            .unwrap()
            .unwrap()
            .ends_with("report.pdf"));
        let mut forged = reference.clone();
        forged.attachment_id = "../../outside".into();
        assert!(reopened.read(&forged).is_err());
        forged = reference;
        forged.bytes += 1;
        assert!(reopened.read(&forged).is_err());
    }
    #[test]
    fn filename_and_base64_validation() {
        assert_eq!(safe_filename("../../CON.txt"), "_CON.txt");
        assert_eq!(safe_filename("a\\b/c?.txt"), "c_.txt");
        assert_eq!(safe_filename(".."), "attachment");
        assert!(AttachmentStore::decode_base64("not base64!", 100).is_err());
        assert!(AttachmentStore::decode_base64("YWI=", 1).is_err());
    }
}
