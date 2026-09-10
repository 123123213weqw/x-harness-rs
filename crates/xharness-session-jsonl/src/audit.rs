//! Lossless, content-addressed request snapshots. Only references enter the hot journal.
//! Shared messages/tools/system prompts are written once; old JSONL remains untouched.
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use xharness_session::{EventData, Message, RequestHeader};
const MAX_BLOB: u64 = 128 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    header: RequestHeader,
    input: Vec<String>,
    tools: String,
    system: String,
}
fn directory(root: &Path) -> Result<PathBuf, StoreError> {
    let dir = root.join("request-audit");
    match fs::create_dir(&dir) {
        Ok(()) => {
            sync_parent_directory(&dir)?;
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(backend_error("create audit directory", &dir, e)),
    }
    let m = fs::symlink_metadata(&dir)
        .map_err(|e| backend_error("inspect audit directory", &dir, e))?;
    if m.file_type().is_symlink() || !m.is_dir() {
        return Err(backend_message("audit directory must be a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| backend_error("secure audit directory", &dir, e))?;
    }
    Ok(dir)
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
fn read(dir: &Path, key: &str) -> Result<Vec<u8>, StoreError> {
    let p = path(dir, key)?;
    if fs::symlink_metadata(&p)
        .map_err(|e| backend_error("inspect audit", &p, e))?
        .file_type()
        .is_symlink()
    {
        return Err(backend_message("audit blob must not be a symlink"));
    }
    let file = secure_open_options()
        .read(true)
        .open(&p)
        .map_err(|e| backend_error("open audit", &p, e))?;
    ensure_regular_file(&file, &p, "audit blob")?;
    let mut bytes = Vec::new();
    file.take(MAX_BLOB + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| backend_error("read audit", &p, e))?;
    if bytes.len() as u64 > MAX_BLOB || format!("{:x}", Sha256::digest(&bytes)) != key {
        return Err(backend_message("audit blob size or digest mismatch"));
    }
    Ok(bytes)
}
fn put<T: Serialize>(dir: &Path, value: &T) -> Result<String, StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|e| backend_message(e.to_string()))?;
    if bytes.len() as u64 > MAX_BLOB {
        return Err(backend_message("audit blob exceeds 128 MiB"));
    }
    let key = format!("{:x}", Sha256::digest(&bytes));
    let p = path(dir, &key)?;
    if p.exists() {
        read(dir, &key)?;
        return Ok(key);
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
                read(dir, &key)?;
            }
            Err(e) => return Err(backend_error("publish audit blob", &p, e)),
        }
        sync_parent_directory(&p)?;
        Ok(key)
    })();
    let _ = fs::remove_file(tmp);
    result
}
pub(super) fn compact(header: &mut RequestHeader, reference: Value) {
    let input_count = header.input.len();
    let tool_count = header.tools.len();
    header.input.clear();
    header.input.shrink_to_fit();
    header.tools.clear();
    header.tools.shrink_to_fit();
    header.system = None;
    if let Some(Value::Object(context)) = header.options.get_mut("context") {
        if let Some(Value::Array(edits)) = context.remove("edits") {
            context.insert("edit_count".into(), json!(edits.len()));
        }
    }
    header.options.insert("auditSnapshot".into(), reference);
    header
        .options
        .insert("inputMessageCount".into(), json!(input_count));
    header.options.insert("toolCount".into(), json!(tool_count));
}
pub(super) fn archive(root: &Path, header: RequestHeader) -> Result<RequestHeader, StoreError> {
    struct SizeGuard(u64);
    impl Write for SizeGuard {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len() as u64);
            if self.0 > MAX_BLOB {
                return Err(std::io::Error::other("request audit exceeds 128 MiB"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(SizeGuard(0), &header).map_err(|e| backend_message(e.to_string()))?;
    let dir = directory(root)?;
    let mut meta = header.clone();
    meta.input.clear();
    meta.tools.clear();
    meta.system = None;
    let input = header
        .input
        .iter()
        .map(|m| put(&dir, m))
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = Manifest {
        version: 1,
        header: meta,
        input,
        tools: put(&dir, &header.tools)?,
        system: put(&dir, &header.system)?,
    };
    let key = put(&dir, &manifest)?;
    let mut result = header;
    compact(
        &mut result,
        json!({"kind":"archive","version":1,"sha256":key}),
    );
    Ok(result)
}
pub(super) fn expand(root: &Path, header: RequestHeader) -> Result<RequestHeader, StoreError> {
    let Some(reference) = header.options.get("auditSnapshot") else {
        return Ok(header);
    };
    if reference["kind"] != "archive" {
        return Ok(header);
    }
    if reference["version"] != 1 {
        return Err(backend_message("unsupported audit snapshot version"));
    }
    let key = reference["sha256"]
        .as_str()
        .ok_or_else(|| backend_message("missing audit digest"))?;
    let dir = directory(root)?;
    let mut manifest: Manifest =
        serde_json::from_slice(&read(&dir, key)?).map_err(|e| backend_message(e.to_string()))?;
    if manifest.version != 1 {
        return Err(backend_message("unsupported audit manifest version"));
    }
    let mut total = 0usize;
    for key in manifest.input {
        let bytes = read(&dir, &key)?;
        total = total.saturating_add(bytes.len());
        if total as u64 > MAX_BLOB {
            return Err(backend_message("audit request exceeds 128 MiB"));
        }
        manifest.header.input.push(
            serde_json::from_slice::<Message>(&bytes)
                .map_err(|e| backend_message(e.to_string()))?,
        );
    }
    manifest.header.tools = serde_json::from_slice(&read(&dir, &manifest.tools)?)
        .map_err(|e| backend_message(e.to_string()))?;
    manifest.header.system = serde_json::from_slice(&read(&dir, &manifest.system)?)
        .map_err(|e| backend_message(e.to_string()))?;
    Ok(manifest.header)
}
pub(super) fn elide(event: &mut LoggedEvent) {
    if let EventData::RequestHeader { header } = &mut event.event.0 {
        if !header.options.contains_key("auditSnapshot") {
            compact(header, json!({"kind":"legacy_jsonl","seq":event.seq}));
        }
    }
}
