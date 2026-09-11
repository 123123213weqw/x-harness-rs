//! Immutable per-session cold results. No model-provided paths and no overwrite.
use super::*;
use sha2::{Digest, Sha256};
use xharness_session::{ToolArchiveRef, MAX_TOOL_ARCHIVE_BYTES};

fn reject_redirect(metadata: &fs::Metadata) -> Result<(), StoreError> {
    if metadata.file_type().is_symlink() {
        return Err(backend_message("tool archive path must not be a symlink"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(backend_message(
                "tool archive path must not be a reparse point",
            ));
        }
    }
    Ok(())
}

fn directory(root: &Path, session: &str, create: bool) -> Result<Option<PathBuf>, StoreError> {
    validate_session_id(session)?;
    let mut dir = root.to_owned();
    for part in [
        "tool-results".to_owned(),
        format!("{:x}", Sha256::digest(session.as_bytes())),
    ] {
        dir.push(part);
        if create {
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let builder = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = builder;
                builder.mode(0o700);
                builder
            };
            match builder.create(&dir) {
                Ok(()) => sync_parent_directory(&dir)?,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                Err(e) => return Err(backend_error("create tool archive directory", &dir, e)),
            }
        }
        let metadata = match fs::symlink_metadata(&dir) {
            Ok(m) => m,
            Err(e) if !create && e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(backend_error("inspect tool archive directory", &dir, e)),
        };
        reject_redirect(&metadata)?;
        if !metadata.is_dir() {
            return Err(backend_message("tool archive parent is not a directory"));
        }
    }
    Ok(Some(dir))
}

fn read_file(path: &Path, key: &str) -> Result<Option<String>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(backend_error("inspect tool archive", path, e)),
    };
    reject_redirect(&metadata)?;
    let file = secure_open_options()
        .read(true)
        .open(path)
        .map_err(|e| backend_error("open tool archive", path, e))?;
    ensure_regular_file(&file, path, "tool archive")?;
    reject_redirect(
        &file
            .metadata()
            .map_err(|e| backend_message(e.to_string()))?,
    )?;
    let mut bytes = Vec::new();
    file.take(MAX_TOOL_ARCHIVE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| backend_error("read tool archive", path, e))?;
    if bytes.len() > MAX_TOOL_ARCHIVE_BYTES || format!("{:x}", Sha256::digest(&bytes)) != key {
        return Err(backend_message("tool archive integrity check failed"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|e| backend_message(e.to_string()))
}

pub(super) fn read(root: &Path, session: &str, key: &str) -> Result<Option<String>, StoreError> {
    ToolArchiveRef::validate_key(key)?;
    let Some(dir) = directory(root, session, false)? else {
        return Ok(None);
    };
    read_file(&dir.join(format!("{key}.json")), key)
}

pub(super) fn put(root: &Path, session: &str, text: &str) -> Result<ToolArchiveRef, StoreError> {
    let reference = ToolArchiveRef::for_text(text)?;
    let dir = directory(root, session, true)?.expect("created directory");
    let path = dir.join(format!("{}.json", reference.sha256));
    if read_file(&path, &reference.sha256)?.is_some() {
        return Ok(reference);
    }
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".pending-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = secure_open_options()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| backend_error("create tool archive", &tmp, e))?;
    let result = (|| {
        file.write_all(text.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| backend_error("flush tool archive", &tmp, e))?;
        // Atomic no-replace publication; an existing destination is verified below.
        match fs::hard_link(&tmp, &path) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(backend_error("publish tool archive", &path, e)),
        }
        sync_parent_directory(&path)?;
        if read_file(&path, &reference.sha256)?.is_none() {
            return Err(backend_message("published tool archive disappeared"));
        }
        Ok(reference)
    })();
    drop(file);
    // Only our exclusively created staging file; published blobs are never deleted.
    let _ = fs::remove_file(&tmp);
    result
}
