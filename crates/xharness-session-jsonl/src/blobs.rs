//! Shared immutable content-addressed blob I/O; capture policy lives in callers.
use super::*;

fn reject_redirect(metadata: &fs::Metadata) -> Result<(), StoreError> {
    if metadata.file_type().is_symlink() {
        return Err(backend_message("snapshot path must not be a symlink"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(backend_message("snapshot path must not be a reparse point"));
        }
    }
    Ok(())
}

/// Names are internal namespace constants or generated digests, never paths.
pub(super) fn directory(
    root: &Path,
    name: &str,
    create: bool,
) -> Result<Option<PathBuf>, StoreError> {
    let dir = root.join(name);
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
            Err(e) => return Err(backend_error("create snapshot directory", &dir, e)),
        }
    }
    let metadata = match fs::symlink_metadata(&dir) {
        Ok(m) => m,
        Err(e) if !create && e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(backend_error("inspect snapshot directory", &dir, e)),
    };
    reject_redirect(&metadata)?;
    if !metadata.is_dir() {
        return Err(backend_message("snapshot parent is not a directory"));
    }
    #[cfg(unix)]
    if create {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| backend_error("secure snapshot directory", &dir, e))?;
        }
    }
    Ok(Some(dir))
}

fn path(dir: &Path, key: &str) -> Result<PathBuf, StoreError> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(backend_message("invalid audit digest"));
    }
    Ok(dir.join(format!("{key}.json")))
}
pub(super) fn read(dir: &Path, key: &str, max_blob: u64) -> Result<Vec<u8>, StoreError> {
    let p = path(dir, key)?;
    let metadata =
        fs::symlink_metadata(&p).map_err(|e| backend_error("inspect snapshot", &p, e))?;
    reject_redirect(&metadata)?;
    if !metadata.is_file() || metadata.len() > max_blob {
        return Err(backend_message(
            "snapshot blob must be a bounded regular file",
        ));
    }
    let file = secure_open_options()
        .read(true)
        .open(&p)
        .map_err(|e| backend_error("open audit", &p, e))?;
    ensure_regular_file(&file, &p, "snapshot blob")?;
    reject_redirect(
        &file
            .metadata()
            .map_err(|e| backend_error("inspect snapshot blob", &p, e))?,
    )?;
    let mut bytes = Vec::new();
    file.take(max_blob + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| backend_error("read audit", &p, e))?;
    if bytes.len() as u64 > max_blob || format!("{:x}", Sha256::digest(&bytes)) != key {
        return Err(backend_message("audit blob size or digest mismatch"));
    }
    Ok(bytes)
}
pub(super) fn put<T: Serialize>(
    dir: &Path,
    value: &T,
    max_blob: u64,
) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|e| backend_message(e.to_string()))?;
    if bytes.len() as u64 > max_blob {
        return Err(backend_message(format!(
            "snapshot blob exceeds {max_blob} bytes"
        )));
    }
    let key = format!("{:x}", Sha256::digest(&bytes));
    let p = path(dir, &key)?;
    match fs::symlink_metadata(&p) {
        Ok(metadata) => {
            reject_redirect(&metadata)?;
            read(dir, &key, max_blob)?;
            return Ok(key);
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(backend_error("inspect snapshot blob", &p, e)),
    }
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".tmp-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = secure_open_options()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| backend_error("create audit blob", &tmp, e))?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| backend_error("write audit blob", &tmp, e))?;
        drop(f);
        match fs::rename(&tmp, &p) {
            Ok(()) => {}
            Err(_) if p.exists() => {
                read(dir, &key, max_blob)?;
            }
            Err(e) => return Err(backend_error("publish audit blob", &p, e)),
        }
        sync_parent_directory(&p)?;
        Ok(key)
    })();
    let _ = fs::remove_file(tmp);
    result
}
