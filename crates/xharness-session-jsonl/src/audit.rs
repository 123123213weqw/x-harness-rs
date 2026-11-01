//! Lossless, content-addressed request snapshots. Only references enter the hot journal.
//! Shared messages/tools/system prompts are written once; old JSONL remains untouched.
use super::*;
use serde_json::{json, Value};
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
pub(super) fn compact(header: &mut RequestHeader, reference: Value) {
    *header = header.metadata_only(reference);
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
    let dir = blobs::directory(root, "request-audit", true)?.unwrap();
    let mut meta = header.clone();
    meta.input.clear();
    meta.tools.clear();
    meta.system = None;
    let input = header
        .input
        .iter()
        .map(|m| blobs::put(&dir, m, MAX_BLOB))
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = Manifest {
        version: 1,
        header: meta,
        input,
        tools: blobs::put(&dir, &header.tools, MAX_BLOB)?,
        system: blobs::put(&dir, &header.system, MAX_BLOB)?,
    };
    let key = blobs::put(&dir, &manifest, MAX_BLOB)?;
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
    let dir = blobs::directory(root, "request-audit", true)?.unwrap();
    let mut manifest: Manifest = crate::decode_owned_json(&blobs::read(&dir, key, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    if manifest.version != 1 {
        return Err(backend_message("unsupported audit manifest version"));
    }
    let mut total = 0usize;
    for key in manifest.input {
        let bytes = blobs::read(&dir, &key, MAX_BLOB)?;
        total = total.saturating_add(bytes.len());
        if total as u64 > MAX_BLOB {
            return Err(backend_message("audit request exceeds 128 MiB"));
        }
        manifest.header.input.push(
            crate::decode_owned_json::<Message>(&bytes)
                .map_err(|e| backend_message(e.to_string()))?,
        );
    }
    manifest.header.tools =
        crate::decode_owned_json(&blobs::read(&dir, &manifest.tools, MAX_BLOB)?)
            .map_err(|e| backend_message(e.to_string()))?;
    manifest.header.system =
        crate::decode_owned_json(&blobs::read(&dir, &manifest.system, MAX_BLOB)?)
            .map_err(|e| backend_message(e.to_string()))?;
    Ok(manifest.header)
}
pub(super) fn expand_harness(
    root: &Path,
    header: RequestHeader,
) -> Result<RequestHeader, StoreError> {
    let Some(reference) = header.options.get("auditSnapshot") else {
        return Ok(header.harness_view());
    };
    if reference["kind"] != "archive" {
        return Ok(header.harness_view());
    }
    if reference["version"] != 1 {
        return Err(backend_message("unsupported audit snapshot version"));
    }
    let key = reference["sha256"]
        .as_str()
        .ok_or_else(|| backend_message("missing audit digest"))?;
    let dir = blobs::directory(root, "request-audit", false)?
        .ok_or_else(|| backend_message("audit snapshot is missing"))?;
    let manifest: Manifest = crate::decode_owned_json(&blobs::read(&dir, key, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    if manifest.version != 1 {
        return Err(backend_message("unsupported audit manifest version"));
    }
    let mut view = header.harness_view();
    view.tools = crate::decode_owned_json(&blobs::read(&dir, &manifest.tools, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    view.system = crate::decode_owned_json(&blobs::read(&dir, &manifest.system, MAX_BLOB)?)
        .map_err(|e| backend_message(e.to_string()))?;
    Ok(view)
}

pub(super) fn elide(event: &mut LoggedEvent) {
    // Checking an already-shared non-header event must not detach its payload.
    let needs_elision = matches!(event.data(), EventData::RequestHeader { header }
        if !header.options.contains_key("auditSnapshot"));
    if needs_elision {
        if let EventData::RequestHeader { header } = event.event.data_mut() {
            compact(header, json!({"kind":"legacy_jsonl","seq":event.seq}));
        }
    }
}
