//! Provider-neutral, session-scoped attachments. Logs contain references only.
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
pub use xharness_session::{AttachmentRef, ContentBlock};

pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 16 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    #[error("invalid image: {0}")]
    Invalid(String),
    #[error("attachment unavailable in this session; reattach the image")]
    Unavailable,
    #[error("attachment storage error: {0}")]
    Storage(String),
}
fn storage(e: impl std::fmt::Display) -> AttachmentError {
    AttachmentError::Storage(e.to_string())
}

#[derive(Clone, Debug)]
pub struct Upload {
    pub media_type: String,
    pub data: Vec<u8>,
}
impl Upload {
    pub fn from_base64(media_type: &str, data: &str) -> Result<Self, AttachmentError> {
        if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(AttachmentError::Invalid("image exceeds 20 MiB".into()));
        }
        let data = STANDARD
            .decode(data)
            .map_err(|_| AttachmentError::Invalid("malformed base64".into()))?;
        Ok(Self {
            media_type: media_type.into(),
            data,
        })
    }
}
#[derive(Clone, Debug)]
pub struct ResolvedAttachment {
    pub reference: AttachmentRef,
    pub data: Arc<Vec<u8>>,
}
impl ResolvedAttachment {
    /// Called only by wire adapters, never persisted in a transcript.
    pub fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.reference.media_type,
            STANDARD.encode(self.data.as_slice())
        )
    }
    pub fn base64(&self) -> String {
        STANDARD.encode(self.data.as_slice())
    }
}

#[async_trait]
pub trait AttachmentStore: Send + Sync + std::fmt::Debug {
    async fn put(&self, session_id: &str, upload: Upload)
        -> Result<AttachmentRef, AttachmentError>;
    async fn resolve(
        &self,
        session_id: &str,
        id: &str,
    ) -> Result<ResolvedAttachment, AttachmentError>;
}

fn validate(session: &str, upload: Upload) -> Result<ResolvedAttachment, AttachmentError> {
    if session.is_empty() || upload.data.is_empty() || upload.data.len() > MAX_IMAGE_BYTES {
        return Err(AttachmentError::Invalid("empty or oversized upload".into()));
    }
    let format = image::guess_format(&upload.data)
        .map_err(|_| AttachmentError::Invalid("unrecognized image".into()))?;
    let media = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        ImageFormat::Gif => "image/gif",
        _ => return Err(AttachmentError::Invalid("unsupported media type".into())),
    };
    if media != upload.media_type {
        return Err(AttachmentError::Invalid(
            "declared MIME does not match image".into(),
        ));
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&upload.data), format)
        .into_dimensions()
        .map_err(|e| AttachmentError::Invalid(e.to_string()))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(AttachmentError::Invalid("image exceeds pixel limit".into()));
    }
    let mut reader = ImageReader::with_format(Cursor::new(&upload.data), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| AttachmentError::Invalid(e.to_string()))?;
    let reference = AttachmentRef {
        id: format!("{:x}", Sha256::digest(&upload.data)),
        session_id: session.into(),
        media_type: media.into(),
        bytes: upload.data.len() as u64,
        width,
        height,
    };
    Ok(ResolvedAttachment {
        reference,
        data: Arc::new(upload.data),
    })
}

#[derive(Debug, Default)]
pub struct MemoryAttachmentStore {
    entries: Mutex<BTreeMap<(String, String), ResolvedAttachment>>,
}
#[async_trait]
impl AttachmentStore for MemoryAttachmentStore {
    async fn put(&self, session: &str, upload: Upload) -> Result<AttachmentRef, AttachmentError> {
        let session = session.to_owned();
        let item = tokio::task::spawn_blocking(move || validate(&session, upload))
            .await
            .map_err(storage)??;
        self.entries.lock().map_err(storage)?.insert(
            (item.reference.session_id.clone(), item.reference.id.clone()),
            item.clone(),
        );
        Ok(item.reference)
    }
    async fn resolve(
        &self,
        session: &str,
        id: &str,
    ) -> Result<ResolvedAttachment, AttachmentError> {
        self.entries
            .lock()
            .map_err(storage)?
            .get(&(session.into(), id.into()))
            .cloned()
            .ok_or(AttachmentError::Unavailable)
    }
}

#[derive(Clone, Debug)]
pub struct FileAttachmentStore {
    root: Arc<PathBuf>,
    gate: Arc<Mutex<()>>,
}
fn private_dir(path: &Path) -> Result<(), AttachmentError> {
    if let Ok(m) = std::fs::symlink_metadata(path) {
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err(AttachmentError::Unavailable);
        }
    }
    std::fs::create_dir_all(path).map_err(storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(storage)?;
    }
    Ok(())
}
impl FileAttachmentStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, AttachmentError> {
        let root = root.into();
        private_dir(&root)?;
        Ok(Self {
            root: Arc::new(std::fs::canonicalize(root).map_err(storage)?),
            gate: Arc::new(Mutex::new(())),
        })
    }
    fn path(&self, session: &str, id: &str) -> Result<PathBuf, AttachmentError> {
        if session.is_empty()
            || id.len() != 64
            || !id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(AttachmentError::Unavailable);
        }
        Ok(self
            .root
            .join(format!("{:x}", Sha256::digest(session.as_bytes())))
            .join(id))
    }
    fn read(&self, session: &str, id: &str) -> Result<ResolvedAttachment, AttachmentError> {
        let path = self.path(session, id)?;
        for p in [path.parent().unwrap(), path.as_path()] {
            let m = std::fs::symlink_metadata(p).map_err(|_| AttachmentError::Unavailable)?;
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err(AttachmentError::Unavailable);
            }
        }
        let read = |name: &str, max: usize| -> Result<Vec<u8>, AttachmentError> {
            let file = path.join(name);
            let m = std::fs::symlink_metadata(&file).map_err(|_| AttachmentError::Unavailable)?;
            if !m.is_file() || m.file_type().is_symlink() || m.len() > max as u64 {
                return Err(AttachmentError::Unavailable);
            }
            let mut data = Vec::new();
            std::fs::File::open(file)
                .map_err(storage)?
                .take((max + 1) as u64)
                .read_to_end(&mut data)
                .map_err(storage)?;
            if data.len() > max {
                return Err(AttachmentError::Unavailable);
            }
            Ok(data)
        };
        let reference: AttachmentRef =
            serde_json::from_slice(&read("metadata.json", 4096)?).map_err(storage)?;
        let data = read("image", MAX_IMAGE_BYTES)?;
        if reference.id != id
            || reference.session_id != session
            || reference.bytes != data.len() as u64
            || format!("{:x}", Sha256::digest(&data)) != id
        {
            return Err(AttachmentError::Unavailable);
        }
        Ok(ResolvedAttachment {
            reference,
            data: Arc::new(data),
        })
    }
    fn write(&self, item: ResolvedAttachment) -> Result<AttachmentRef, AttachmentError> {
        let _guard = self.gate.lock().map_err(storage)?;
        let r = &item.reference;
        let dest = self.path(&r.session_id, &r.id)?;
        private_dir(dest.parent().unwrap())?;
        if dest.exists() {
            let existing = self.read(&r.session_id, &r.id)?;
            if existing.reference != *r {
                return Err(AttachmentError::Unavailable);
            }
            return Ok(r.clone());
        }
        let temp = dest.with_file_name(format!(
            ".tmp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(storage)?
                .as_nanos()
        ));
        std::fs::create_dir(&temp).map_err(storage)?;
        private_dir(&temp)?;
        let result = (|| {
            for (name, bytes) in [
                ("image", item.data.as_slice()),
                (
                    "metadata.json",
                    serde_json::to_vec(r).map_err(storage)?.as_slice(),
                ),
            ] {
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(temp.join(name)).map_err(storage)?;
                file.write_all(bytes).map_err(storage)?;
                file.sync_all().map_err(storage)?;
            }
            #[cfg(unix)]
            std::fs::File::open(&temp)
                .map_err(storage)?
                .sync_all()
                .map_err(storage)?;
            std::fs::rename(&temp, &dest).map_err(storage)?;
            #[cfg(unix)]
            std::fs::File::open(dest.parent().unwrap())
                .map_err(storage)?
                .sync_all()
                .map_err(storage)?;
            Ok(r.clone())
        })();
        if temp.exists() {
            let _ = std::fs::remove_dir_all(temp);
        }
        result
    }
}
#[async_trait]
impl AttachmentStore for FileAttachmentStore {
    async fn put(&self, session: &str, upload: Upload) -> Result<AttachmentRef, AttachmentError> {
        let this = self.clone();
        let session = session.to_owned();
        tokio::task::spawn_blocking(move || this.write(validate(&session, upload)?))
            .await
            .map_err(storage)?
    }
    async fn resolve(
        &self,
        session: &str,
        id: &str,
    ) -> Result<ResolvedAttachment, AttachmentError> {
        let this = self.clone();
        let session = session.to_owned();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || this.read(&session, &id))
            .await
            .map_err(storage)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Upload {
        let mut data = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(3, 2, image::Rgba([255, 0, 0, 255]))
            .write_to(&mut data, ImageFormat::Png)
            .unwrap();
        Upload {
            media_type: "image/png".into(),
            data: data.into_inner(),
        }
    }
    fn temp() -> PathBuf {
        // Wall-clock resolution is not a uniqueness guarantee on every OS.
        // Parallel tests mutate/delete their directories, so collisions can
        // make a valid attachment disappear during the deduplication test.
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "xh-attachments-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    #[test]
    fn parallel_test_paths_are_unique() {
        let threads: Vec<_> = (0..16)
            .map(|_| std::thread::spawn(|| (0..256).map(|_| temp()).collect::<Vec<_>>()))
            .collect();
        let paths: Vec<_> = threads
            .into_iter()
            .flat_map(|t| t.join().unwrap())
            .collect();
        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(unique.len(), paths.len());
    }
    #[tokio::test]
    async fn durable_roundtrip_restart_scope_integrity_and_dedup() {
        let root = temp();
        let store = FileAttachmentStore::new(&root).unwrap();
        let r = store.put("session/a", png()).await.unwrap();
        assert_eq!((r.width, r.height), (3, 2));
        assert_eq!(store.put("session/a", png()).await.unwrap(), r);
        drop(store);
        let store = FileAttachmentStore::new(&root).unwrap();
        assert_eq!(
            store
                .resolve("session/a", &r.id)
                .await
                .unwrap()
                .data
                .as_slice(),
            png().data
        );
        assert!(store.resolve("other", &r.id).await.is_err());
        assert!(store
            .resolve("session/a", "../../metadata.json")
            .await
            .is_err());
        let file = store.path("session/a", &r.id).unwrap().join("image");
        std::fs::write(file, b"bad").unwrap();
        assert!(store.resolve("session/a", &r.id).await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn malformed_mime_empty_and_invalid_base64_fail_without_admission() {
        let store = MemoryAttachmentStore::default();
        assert!(Upload::from_base64("image/png", "%%").is_err());
        let mut p = png();
        p.media_type = "image/jpeg".into();
        assert!(store.put("s", p).await.is_err());
        assert!(store
            .put(
                "s",
                Upload {
                    media_type: "image/png".into(),
                    data: vec![]
                }
            )
            .await
            .is_err());
        assert!(store
            .put(
                "s",
                Upload {
                    media_type: "image/png".into(),
                    data: vec![1, 2, 3]
                }
            )
            .await
            .is_err());
        assert!(store
            .put(
                "s",
                Upload {
                    media_type: "image/png".into(),
                    data: vec![0; MAX_IMAGE_BYTES + 1]
                }
            )
            .await
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symbolic_links_cannot_replace_payload_or_root() {
        use std::os::unix::fs::symlink;
        let root = temp();
        let store = FileAttachmentStore::new(&root).unwrap();
        let r = store.put("s", png()).await.unwrap();
        let file = store.path("s", &r.id).unwrap().join("image");
        std::fs::remove_file(&file).unwrap();
        symlink("/etc/passwd", file).unwrap();
        assert!(store.resolve("s", &r.id).await.is_err());
        let alias = temp();
        symlink(&root, &alias).unwrap();
        assert!(FileAttachmentStore::new(&alias).is_err());
        std::fs::remove_file(alias).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
