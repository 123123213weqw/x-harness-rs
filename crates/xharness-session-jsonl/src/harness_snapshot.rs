//! Default-on, per-session system/tool snapshots. No conversation body or trace.
//! Only immutable references enter the journal. Shared system/tools deduplicate
//! independently; session deletion removes all of its blobs.
use super::*;
use serde_json::{json, Value};
use xharness_session::RequestHeader;
const MAX_BLOB: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    system: String,
    tools: String,
}
fn directory(root: &Path, session: &str, create: bool) -> Result<Option<PathBuf>, StoreError> {
    validate_session_id(session)?;
    let Some(parent) = blobs::directory(root, "harness-snapshots", create)? else {
        return Ok(None);
    };
    blobs::directory(
        &parent,
        &format!("{:x}", Sha256::digest(session.as_bytes())),
        create,
    )
}
pub(super) fn archive(
    root: &Path,
    session: &str,
    header: &RequestHeader,
) -> Result<Value, StoreError> {
    let dir = directory(root, session, true)?.unwrap();
    let manifest = Manifest {
        version: 1,
        system: blobs::put(&dir, &header.system, MAX_BLOB)?,
        tools: blobs::put(&dir, &header.tools, MAX_BLOB)?,
    };
    let key = blobs::put(&dir, &manifest, MAX_BLOB)?;
    Ok(json!({"kind":"archive", "version":1, "sha256":key}))
}
pub(super) fn expand(
    root: &Path,
    session: &str,
    header: RequestHeader,
) -> Result<RequestHeader, StoreError> {
    let Some(reference) = header.options.get("harnessSnapshot") else {
        // Pre-extraction journals may still have full audit or inline payloads.
        return audit::expand_harness(root, header);
    };
    if reference["kind"] == "omitted" {
        return Ok(header.harness_view());
    }
    if reference["kind"] != "archive" || reference["version"] != 1 {
        return Err(backend_message("unsupported Harness snapshot reference"));
    }
    let key = reference["sha256"]
        .as_str()
        .ok_or_else(|| backend_message("missing Harness digest"))?;
    let dir = directory(root, session, false)?
        .ok_or_else(|| backend_message("Harness snapshot is missing"))?;
    let manifest: Manifest = crate::decode_owned_json(&blobs::read(&dir, key, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    if manifest.version != 1 {
        return Err(backend_message("unsupported Harness snapshot version"));
    }
    let mut view = header.harness_view();
    view.system = crate::decode_owned_json(&blobs::read(&dir, &manifest.system, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    view.tools = crate::decode_owned_json(&blobs::read(&dir, &manifest.tools, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    Ok(view)
}
pub(super) fn delete(root: &Path, session: &str) -> Result<(), StoreError> {
    let Some(dir) = directory(root, session, false)? else {
        return Ok(());
    };
    fs::remove_dir_all(&dir).map_err(|e| backend_error("delete Harness snapshots", &dir, e))?;
    sync_parent_directory(&dir)
}
