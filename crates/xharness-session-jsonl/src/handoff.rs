//! Native-owner, quiesced session handoff. Not an RPC or a transcript import.
//! Hash receipts detect mismatch, not owner impersonation: callers must retain
//! both data-directory ownership leases and an authenticated owner transport.
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
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use xharness_session::{ContentBlock, EventData, InboxTarget, RequestHeader, ToolArchiveRef};

pub const MAX_HANDOFF_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 50_000;
type TransferResult<T> = Result<T, StoreError>;
fn reject<T>() -> TransferResult<T> {
    Err(backend_message(
        "session handoff rejected; retain native state for recovery",
    ))
}
pub fn digest(value: &impl Serialize) -> TransferResult<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(value).map_err(|_| backend_message("handoff encoding failed"))?
        )
    ))
}
fn key(value: &str) -> bool {
    ToolArchiveRef::validate_key(value).is_ok()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceCheckpoint {
    pub binding: String,
    pub generation: u64,
    pub manifest: String,
    // Complete receipts/decisions, not just coincidentally equal tree hashes.
    pub transaction: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    pub owner: String,
    pub cwd: String,
    pub workspace: WorkspaceCheckpoint,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub version: u8,
    pub source: String,
    pub destination: Destination,
    pub epoch: u64,
    pub header: SessionHeader,
    pub revision: Revision,
    pub events: Vec<LoggedEvent>,
    pub tool_results: BTreeMap<String, String>,
    // Resolved optional request diagnostics and independent Harness snapshots.
    // Original event references, revisions, sequence numbers stay unchanged.
    pub requests: BTreeMap<u64, RequestResource>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestResource {
    pub audit: Option<RequestHeader>,
    pub harness: Option<RequestHeader>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub transfer: String,
    pub session: String,
    pub source: String,
    pub destination: String,
    pub epoch: u64,
    pub workspace: WorkspaceCheckpoint,
    pub restored: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Released {
    pub prepared: Prepared,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Frozen,
    Released,
    Receiving,
    Active,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fence {
    pub version: u8,
    pub owner: String,
    pub phase: Phase,
    pub prepared: Prepared,
    // Only a previously relinquished exact journal may be superseded on return.
    pub previous: Option<String>,
}
fn fence_path(path: &Path) -> PathBuf {
    path.with_extension("handoff-state")
}
fn pin_path(path: &Path) -> PathBuf {
    path.with_extension("handoff-required")
}
fn bundle_path(path: &Path, hash: &str) -> TransferResult<PathBuf> {
    if !key(hash) {
        return reject();
    }
    Ok(path.with_extension(format!("handoff-{hash}")))
}
fn read<T: DeserializeOwned>(path: &Path, max: usize) -> TransferResult<Option<T>> {
    let file = match secure_open_options().read(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(backend_error("read native handoff state", path, e)),
    };
    ensure_regular_file(&file, path, "handoff state")?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| backend_error("read handoff", path, e))?;
    if bytes.len() > max {
        return reject();
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| backend_message("invalid native handoff state"))
}
fn write(path: &Path, value: &impl Serialize) -> TransferResult<()> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| backend_message("handoff encoding failed"))?;
    if bytes.len() > MAX_HANDOFF_BYTES {
        return reject();
    }
    write_projection_file(path, &bytes, "session-handoff")
}
fn has_marker(path: &Path) -> TransferResult<bool> {
    let file = match secure_open_options().read(true).open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(backend_error("inspect handoff marker", path, e)),
    };
    ensure_regular_file(&file, path, "session header")?;
    let mut line = Vec::new();
    BufReader::new(file)
        .take(65537)
        .read_until(b'\n', &mut line)
        .map_err(|e| backend_error("read handoff header", path, e))?;
    // Recognition only, NOT journal validation or evidence of writability.
    // A miss must retain the existing authoritative parser/error (including
    // corrupt legacy records and its exact diagnostics), never mint a cache.
    if line.len() > 65536 || line.is_empty() {
        return Ok(false);
    }
    match serde_json::from_slice::<serde_json::Value>(&line) {
        Ok(value) => Ok(value.get("handoff").is_some()),
        Err(_) => Ok(false),
    }
}
pub(super) fn require_managed(path: &Path) -> TransferResult<()> {
    if state(path)?.is_none() {
        return reject();
    }
    Ok(())
}
fn state(path: &Path) -> TransferResult<Option<Fence>> {
    let value: Option<Fence> = read(&fence_path(path), 16384)?;
    if value.as_ref().is_some_and(|f| {
        f.version != 1
            || !key(&f.owner)
            || !key(&f.prepared.transfer)
            || f.prepared.epoch == 0
            || f.prepared.epoch > 128
    }) {
        return reject();
    }
    let pin = read::<String>(&pin_path(path), 128)?;
    if let Some(f) = &value {
        let expected_owner = if matches!(f.phase, Phase::Frozen | Phase::Released) {
            &f.prepared.source
        } else {
            &f.prepared.destination
        };
        if pin.as_ref().is_none_or(|p| !key(p))
            || &f.owner != expected_owner
            || path.file_stem().and_then(|s| s.to_str()) != Some(f.prepared.session.as_str())
        {
            return reject();
        }
    }
    if value.is_none() && (pin.is_some() || has_marker(path)?) {
        return reject();
    }
    Ok(value)
}
pub(super) fn require_writable(path: &Path) -> TransferResult<()> {
    match state(path)? {
        None => Ok(()),
        Some(f) if f.phase == Phase::Active => Ok(()),
        _ => reject(),
    }
}
// The pin survives ordinary deletion and detects a lost/corrupt mutable fence.
fn persist(path: &Path, f: &Fence) -> TransferResult<()> {
    if read::<String>(&pin_path(path), 128)?.is_none() {
        write(&pin_path(path), &f.prepared.transfer)?;
    }
    write(&fence_path(path), f)
}
fn snapshot(path: &Path, id: &str) -> TransferResult<Session> {
    // Do not use runtime metadata-only caches for an authoritative transfer.
    let m =
        fs::symlink_metadata(path).map_err(|e| backend_error("inspect handoff source", path, e))?;
    if m.len() > MAX_HANDOFF_BYTES as u64 {
        return reject();
    }
    let file = secure_open_options()
        .read(true)
        .open(path)
        .map_err(|e| backend_error("open handoff journal", path, e))?;
    ensure_regular_file(&file, path, "handoff journal")?;
    let mut bytes = Vec::new();
    file.take(MAX_HANDOFF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| backend_error("read handoff journal", path, e))?;
    if bytes.len() > MAX_HANDOFF_BYTES {
        return reject();
    }
    let mut expanded = 0u64;
    for line in bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        let value: serde_json::Value = serde_json::from_slice(line)
            .map_err(|_| backend_message("handoff requires a complete journal"))?;
        let n = if value["record"] == COMPRESSED_BATCH_RECORD {
            value["uncompressed_len"]
                .as_u64()
                .ok_or_else(|| backend_message("invalid compressed handoff journal"))?
        } else {
            line.len() as u64
        };
        expanded = expanded
            .checked_add(n)
            .ok_or_else(|| backend_message("handoff journal size overflow"))?;
        if expanded > MAX_HANDOFF_BYTES as u64 {
            return reject();
        }
    }
    Ok(parse_reader(path, id, BufReader::new(std::io::Cursor::new(bytes)), false)?.session)
}
fn require_source_cwd(header: &SessionHeader, expected: Option<&str>) -> TransferResult<()> {
    if let Some(expected) = expected {
        let source = header
            .cwd
            .as_ref()
            .ok_or_else(|| backend_message("handoff source workspace is unknown"))?;
        let source = fs::canonicalize(source)
            .map_err(|_| backend_message("handoff source workspace unavailable"))?;
        if source != Path::new(expected) {
            return reject();
        }
    }
    Ok(())
}
fn restored(bundle: &Bundle) -> TransferResult<Session> {
    let mut header = bundle.header.clone();
    header.cwd = Some(bundle.destination.cwd.clone());
    Ok(Session::restore(
        header,
        bundle.revision,
        bundle.events.clone(),
    )?)
}
fn session_hash(session: &Session) -> TransferResult<String> {
    digest(&(session.header(), session.revision(), session.events()))
}

/// Deliberately narrow first portable profile. No replay to "make it idle".
/// Unsupported resource/runtime ownership fails before sealing either side.
pub fn require_portable_idle(session: &Session) -> TransferResult<()> {
    if session.events().len() > MAX_EVENTS
        || !session.pending_tool_approvals().is_empty()
        || !session.pending_user_questions().is_empty()
        || !session.recoverable_user_questions().is_empty()
        || !xharness_session::incomplete_tool_calls(session.events()).is_empty()
        || !session.interrupted_compaction_recovery().is_empty()
    {
        return reject();
    }
    let mut turn = false;
    let mut commands = BTreeSet::new();
    let mut deferred = BTreeSet::new();
    let mut inbox = [Vec::<String>::new(), Vec::new()];
    for e in session.events() {
        match e.data() {
            EventData::TurnStart { .. } => turn = true,
            EventData::TurnEnd { .. } => turn = false,
            EventData::CommandRun { command_id, .. } => {
                commands.insert(command_id);
            }
            EventData::CommandDone { command_id, .. } => {
                commands.remove(command_id);
            }
            EventData::QuestionDeferred { interaction_id } => {
                deferred.insert(interaction_id);
            }
            EventData::QuestionAnswerDelivered { interaction_id } => {
                deferred.remove(interaction_id);
            }
            EventData::AgentInboxSpliced {
                target,
                start,
                removed_count,
                inserted,
                ..
            } => {
                let q = &mut inbox[usize::from(*target == InboxTarget::NextStep)];
                let end = start
                    .checked_add(*removed_count)
                    .ok_or_else(|| backend_message("invalid handoff inbox"))?;
                if end > q.len() {
                    return reject();
                }
                q.splice(*start..end, inserted.iter().map(|m| m.id.clone()));
            }
            // Cross-session/process/global dependencies have separate owners.
            // Conservatively reject even settled records in this first profile.
            EventData::AgentDelegated { .. }
            | EventData::AgentDelegationFailure { .. }
            | EventData::AgentFailureDelivered { .. }
            | EventData::AgentSettlementDelivered { .. }
            | EventData::SessionForkOrigin { .. }
            | EventData::JobContinuation { .. }
            | EventData::ScheduleChange { .. }
            | EventData::GoalExecution { .. }
            | EventData::GoalChange { .. }
            | EventData::AgentPresetSelected { .. } => return reject(),
            EventData::SessionPlanUpdated { .. }
            | EventData::ExecutionCheckpoint { .. }
            | EventData::AgentDispatchPaused { .. }
            | EventData::SessionModelSelected { .. }
            | EventData::RequestHeader { .. }
            | EventData::RequestContext { .. }
            | EventData::ApprovalAsked { .. }
            | EventData::ApprovalDecided { .. }
            | EventData::QuestionRequested { .. }
            | EventData::QuestionDraftUpdated { .. }
            | EventData::QuestionResolved { .. }
            | EventData::QuestionCancelled { .. }
            | EventData::PermissionPreset { .. }
            | EventData::SandboxMode { .. }
            | EventData::ApprovalPolicy { .. }
            | EventData::SessionTitleGeneration { .. }
            | EventData::SessionTitle { .. }
            | EventData::SessionMutationCommitted { .. }
            | EventData::PlanMode { .. }
            | EventData::LlmRetry { .. }
            | EventData::LlmRetryStarted { .. }
            | EventData::CompactionStart { .. }
            | EventData::CompactionProgress { .. }
            | EventData::CompactionSummary { .. }
            | EventData::CompactionEnd { .. }
            | EventData::CompactionPrune { .. }
            | EventData::StepStart { .. }
            | EventData::StepEnd { .. }
            | EventData::UserMessage { .. }
            | EventData::AssistantChunk { .. }
            | EventData::ModelReception { .. }
            | EventData::AssistantMessage { .. }
            | EventData::ToolCall { .. }
            | EventData::ToolResult { .. }
            | EventData::SessionEndSeed => {}
        }
        // This profile carries text only; media and opaque provider handles need
        // their own verified resource closure, not a dangling copied reference.
        let value = serde_json::to_value(e)
            .map_err(|_| backend_message("handoff event encoding failed"))?;
        require_portable_values(&value)?;
        if let EventData::ToolResult { result, .. } = e.data() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&result.content) {
                require_portable_values(&value)?;
            }
        }
    }
    if turn || !commands.is_empty() || !deferred.is_empty() || inbox.iter().any(|q| !q.is_empty()) {
        return reject();
    }
    for m in session.derive_messages() {
        if !m.provider_items.is_empty()
            || m.content_blocks
                .iter()
                .any(|b| !matches!(b, ContentBlock::Text { .. }))
        {
            return reject();
        }
    }
    Ok(())
}
fn require_portable_values(value: &serde_json::Value) -> TransferResult<()> {
    match value {
        serde_json::Value::Object(m) => {
            if m.get("provider_items")
                .or_else(|| m.get("providerItems"))
                .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
            {
                return reject();
            }
            if m.contains_key("attachment")
                || m.contains_key("attachmentId")
                || m.contains_key("attachment_id")
                || m.get("attachments")
                    .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
            {
                return reject();
            }
            for v in m.values() {
                require_portable_values(v)?;
            }
        }
        serde_json::Value::Array(a) => {
            for v in a {
                require_portable_values(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn collect(
    root: &Path,
    session: &Session,
) -> TransferResult<(BTreeMap<String, String>, BTreeMap<u64, RequestResource>)> {
    let mut results = BTreeMap::new();
    let mut requests = BTreeMap::new();
    let mut resource_bytes = 0usize;
    let mut result_bytes = 0usize;
    for e in session.events() {
        match e.data() {
            EventData::RequestHeader { header } => {
                let audit = if header
                    .options
                    .get("auditSnapshot")
                    .is_some_and(|v| v["kind"] == "archive")
                {
                    Some(audit::expand(root, header.clone())?)
                } else {
                    None
                };
                let harness = if header
                    .options
                    .get("harnessSnapshot")
                    .is_some_and(|v| v["kind"] == "archive")
                {
                    Some(harness_snapshot::expand(
                        root,
                        &session.header().id,
                        header.clone(),
                    )?)
                } else {
                    None
                };
                requests.insert(e.seq, RequestResource { audit, harness });
            }
            EventData::ToolResult { result, .. } => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&result.content) {
                    if let Some(reference) = v.get("archive") {
                        let r: ToolArchiveRef = serde_json::from_value(reference.clone())
                            .map_err(|_| backend_message("invalid handoff tool reference"))?;
                        match results.entry(r.sha256.clone()) {
                            std::collections::btree_map::Entry::Vacant(entry) => {
                                let text = results::read(root, &session.header().id, &r.sha256)?
                                    .ok_or_else(|| {
                                        backend_message("handoff tool archive missing")
                                    })?;
                                if text.len() != r.bytes {
                                    return reject();
                                }
                                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                                {
                                    require_portable_values(&value)?;
                                }
                                result_bytes = result_bytes.saturating_add(text.len());
                                entry.insert(text);
                            }
                            std::collections::btree_map::Entry::Occupied(entry) => {
                                if entry.get().len() != r.bytes {
                                    return reject();
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        // Stop at the first resource that exceeds the total wire budget; never
        // expand the rest of a long journal after the transfer is already too big.
        if let Some(r) = requests.get(&e.seq) {
            resource_bytes = resource_bytes.saturating_add(
                serde_json::to_vec(r)
                    .map_err(|_| backend_message("handoff resource encoding failed"))?
                    .len(),
            );
        }
        if resource_bytes > MAX_HANDOFF_BYTES || result_bytes > MAX_HANDOFF_BYTES - resource_bytes {
            return reject();
        }
    }
    Ok((results, requests))
}
fn validate(bundle: &Bundle) -> TransferResult<Prepared> {
    if bundle.version != 1
        || !key(&bundle.source)
        || !key(&bundle.destination.owner)
        || bundle.source == bundle.destination.owner
        || bundle.epoch == 0
        || bundle.epoch > 128
        || !key(&bundle.destination.workspace.binding)
        || !key(&bundle.destination.workspace.manifest)
        || !key(&bundle.destination.workspace.transaction)
        || bundle.destination.workspace.generation == 0
        || bundle.destination.cwd.is_empty()
        || bundle.events.len() > MAX_EVENTS
        || serde_json::to_vec(bundle)
            .map_err(|_| backend_message("handoff encoding failed"))?
            .len()
            > MAX_HANDOFF_BYTES
    {
        return reject();
    }
    validate_session_id(&bundle.header.id)?;
    let session = Session::restore(
        bundle.header.clone(),
        bundle.revision,
        bundle.events.clone(),
    )?;
    require_portable_idle(&session)?;
    for resource in bundle.requests.values() {
        require_portable_values(
            &serde_json::to_value(resource)
                .map_err(|_| backend_message("invalid handoff resource"))?,
        )?;
    }
    for (hash, text) in &bundle.tool_results {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
            require_portable_values(&value)?;
        }
        if ToolArchiveRef::for_text(text)?.sha256 != *hash {
            return reject();
        }
    }
    Ok(Prepared {
        transfer: digest(bundle)?,
        session: bundle.header.id.clone(),
        source: bundle.source.clone(),
        destination: bundle.destination.owner.clone(),
        epoch: bundle.epoch,
        workspace: bundle.destination.workspace.clone(),
        restored: session_hash(&restored(bundle)?)?,
    })
}
fn save_bundle(path: &Path, bundle: &Bundle, hash: &str) -> TransferResult<()> {
    let p = bundle_path(path, hash)?;
    if let Some(old) = read::<Bundle>(&p, MAX_HANDOFF_BYTES)? {
        if old != *bundle {
            return reject();
        }
        File::open(p)
            .and_then(|f| f.sync_all())
            .map_err(|_| backend_message("handoff durability barrier failed"))?;
        sync_parent_directory(path)
    } else {
        write(&p, bundle)
    }
}
fn saved(path: &Path, f: &Fence) -> TransferResult<Bundle> {
    let bundle: Bundle = read(&bundle_path(path, &f.prepared.transfer)?, MAX_HANDOFF_BYTES)?
        .ok_or_else(|| backend_message("handoff bundle lost"))?;
    if validate(&bundle)? != f.prepared {
        return reject();
    }
    Ok(bundle)
}
fn install_resources(root: &Path, bundle: &Bundle) -> TransferResult<()> {
    for (hash, text) in &bundle.tool_results {
        if results::put(root, &bundle.header.id, text)?.sha256 != *hash {
            return reject();
        }
    }
    let mut expected = BTreeSet::new();
    for e in &bundle.events {
        if let EventData::RequestHeader { header } = e.data() {
            expected.insert(e.seq);
            let r = bundle
                .requests
                .get(&e.seq)
                .ok_or_else(|| backend_message("handoff request closure missing"))?;
            if let Some(full) = &r.audit {
                let compact = audit::archive(root, full.clone())?;
                if compact.options.get("auditSnapshot") != header.options.get("auditSnapshot") {
                    return reject();
                }
            } else if header
                .options
                .get("auditSnapshot")
                .is_some_and(|v| v["kind"] == "archive")
            {
                return reject();
            }
            if let Some(full) = &r.harness {
                if Some(&harness_snapshot::archive(root, &bundle.header.id, full)?)
                    != header.options.get("harnessSnapshot")
                {
                    return reject();
                }
            } else if header
                .options
                .get("harnessSnapshot")
                .is_some_and(|v| v["kind"] == "archive")
            {
                return reject();
            }
        }
    }
    if bundle.requests.keys().copied().collect::<BTreeSet<_>>() != expected {
        return reject();
    }
    // Re-open every referenced archive after installation, not just supplied keys.
    let imported = restored(bundle)?;
    let (results, requests) = collect(root, &imported)?;
    if results != bundle.tool_results || requests != bundle.requests {
        return reject();
    }
    Ok(())
}

impl JsonlSessionStore {
    pub async fn handoff_status(&self, id: &str) -> TransferResult<Option<Fence>> {
        let (path, guard) = self.locked_path(id).await?;
        run_blocking(move || {
            let _guard = guard;
            let _lock = acquire_file_lock(&path)?;
            state(&path)
        })
        .await
    }
    pub async fn freeze_handoff(
        &self,
        id: &str,
        owner: String,
        destination: Destination,
    ) -> TransferResult<Bundle> {
        self.freeze_handoff_at(id, owner, destination, None).await
    }
    /// Native workspace binding must be checked under the SAME journal locks
    /// as sealing, not after a wrong-workspace session was already frozen.
    pub async fn freeze_handoff_at(
        &self,
        id: &str,
        owner: String,
        destination: Destination,
        source_cwd: Option<String>,
    ) -> TransferResult<Bundle> {
        let (path, guard) = self.locked_path(id).await?;
        let root = self.root.clone();
        let id = id.to_owned();
        run_blocking(move || {
            let _guard = guard;
            let _lock = acquire_file_lock(&path)?;
            let prior = state(&path)?;
            if let Some(f) = &prior {
                if f.owner != owner {
                    return reject();
                }
                if matches!(f.phase, Phase::Frozen | Phase::Released) {
                    let b = saved(&path, f)?;
                    require_source_cwd(&b.header, source_cwd.as_deref())?;
                    if b.destination != destination {
                        return reject();
                    }
                    persist(&path, f)?;
                    let original =
                        Session::restore(b.header.clone(), b.revision, b.events.clone())?;
                    publish_journal(&path, &original, Some(&session_hash(&original)?))?;
                    return Ok(b);
                }
                if f.phase != Phase::Active {
                    return reject();
                }
            }
            let session = snapshot(&path, &id)?;
            require_source_cwd(session.header(), source_cwd.as_deref())?;
            if let Some(f) = &prior {
                let previous = saved(&path, f)?;
                if previous.header.created_at_ms != session.header().created_at_ms
                    || previous.header.version != session.header().version
                    || !session.events().starts_with(&previous.events)
                {
                    return reject();
                }
            }
            require_portable_idle(&session)?;
            let (tool_results, requests) = collect(&root, &session)?;
            let bundle = Bundle {
                version: 1,
                source: owner.clone(),
                destination,
                epoch: prior.map_or(1, |f| f.prepared.epoch + 1),
                header: session.header().clone(),
                revision: session.revision(),
                events: session.events().to_vec(),
                tool_results,
                requests,
            };
            let prepared = validate(&bundle)?;
            save_bundle(&path, &bundle, &prepared.transfer)?;
            persist(
                &path,
                &Fence {
                    version: 1,
                    owner,
                    phase: Phase::Frozen,
                    prepared,
                    previous: None,
                },
            )?;
            publish_journal(&path, &session, Some(&session_hash(&session)?))?;
            Ok(bundle)
        })
        .await
    }
    pub async fn prepare_handoff(
        &self,
        owner: String,
        destination: Destination,
        bundle: Bundle,
    ) -> TransferResult<Prepared> {
        let prepared = validate(&bundle)?;
        if owner != destination.owner || bundle.destination != destination {
            return reject();
        }
        let (path, guard) = self.locked_path(&bundle.header.id).await?;
        let root = self.root.clone();
        run_blocking(move || {
            let _guard = guard;
            let _lock = acquire_file_lock(&path)?;
            let prior = state(&path)?;
            if let Some(f) = &prior {
                if f.owner != owner {
                    return reject();
                }
                if f.prepared == prepared && matches!(f.phase, Phase::Receiving | Phase::Active) {
                    saved(&path, f)?;
                    persist(&path, f)?;
                    return Ok(prepared);
                }
                if f.phase != Phase::Released
                    || f.prepared.destination != bundle.source
                    || bundle.epoch != f.prepared.epoch + 1
                {
                    return reject();
                }
                let previous = saved(&path, f)?;
                if previous.header.created_at_ms != bundle.header.created_at_ms
                    || previous.header.version != bundle.header.version
                    || !bundle.events.starts_with(&previous.events)
                {
                    return reject();
                }
            } else {
                if bundle.epoch != 1 {
                    return reject();
                }
                match fs::symlink_metadata(&path) {
                    Err(e) if e.kind() == ErrorKind::NotFound => {}
                    Ok(_) => return reject(),
                    Err(e) => return Err(backend_error("inspect handoff target", &path, e)),
                }
            }
            let previous = if prior.is_some() {
                Some(session_hash(&snapshot(&path, &bundle.header.id)?)?)
            } else {
                None
            };
            // Verify the complete resource closure before source relinquishment.
            // These hash-named immutable blobs are not a visible/active session.
            install_resources(&root, &bundle)?;
            save_bundle(&path, &bundle, &prepared.transfer)?;
            persist(
                &path,
                &Fence {
                    version: 1,
                    owner,
                    phase: Phase::Receiving,
                    prepared: prepared.clone(),
                    previous,
                },
            )?;
            Ok(prepared)
        })
        .await
    }
    pub async fn release_handoff(&self, prepared: Prepared) -> TransferResult<Released> {
        let (path, guard) = self.locked_path(&prepared.session).await?;
        run_blocking(move || {
            let _guard = guard;
            let _lock = acquire_file_lock(&path)?;
            let mut f =
                state(&path)?.ok_or_else(|| backend_message("handoff source is not sealed"))?;
            if f.prepared != prepared || !matches!(f.phase, Phase::Frozen | Phase::Released) {
                return reject();
            }
            let b = saved(&path, &f)?;
            let original = Session::restore(b.header.clone(), b.revision, b.events.clone())?;
            if snapshot(&path, &prepared.session)? != original {
                return reject();
            }
            f.phase = Phase::Released;
            persist(&path, &f)?;
            Ok(Released { prepared })
        })
        .await
    }
    pub async fn activate_handoff(
        &self,
        owner: String,
        destination: Destination,
        released: Released,
    ) -> TransferResult<Prepared> {
        let p = released.prepared;
        if owner != destination.owner
            || p.destination != owner
            || p.workspace != destination.workspace
        {
            return reject();
        }
        let (path, guard) = self.locked_path(&p.session).await?;
        let root = self.root.clone();
        let cache = self.cache.clone();
        run_blocking(move || {
            let _guard = guard;
            let _lock = acquire_file_lock(&path)?;
            let mut f =
                state(&path)?.ok_or_else(|| backend_message("handoff target was not prepared"))?;
            if f.owner != owner
                || f.prepared != p
                || !matches!(f.phase, Phase::Receiving | Phase::Active)
            {
                return reject();
            }
            let b = saved(&path, &f)?;
            if b.destination != destination {
                return reject();
            }
            // A completed activation receipt is historical, not a claim that
            // later user turns have not changed the now-active journal.
            if f.phase == Phase::Active {
                persist(&path, &f)?;
                return Ok(p);
            }
            install_resources(&root, &b)?;
            publish_journal(&path, &restored(&b)?, f.previous.as_deref())?;
            cache_remove(&cache, &path)?;
            f.phase = Phase::Active;
            persist(&path, &f)?;
            Ok(p)
        })
        .await
    }
}
fn publish_journal(path: &Path, session: &Session, previous: Option<&str>) -> TransferResult<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let old = snapshot(path, &session.header().id)?;
            let old_hash = session_hash(&old)?;
            if old == *session && has_marker(path)? {
                File::open(path)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| backend_message("handoff journal barrier failed"))?;
                return sync_parent_directory(path);
            }
            if previous != Some(old_hash.as_str()) {
                return reject();
            }
            let history = path.with_extension(format!("handoff-history-{old_hash}"));
            match fs::hard_link(path, &history) {
                Ok(()) => sync_parent_directory(path)?,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    if snapshot(&history, &session.header().id)? != old {
                        return reject();
                    }
                }
                Err(e) => return Err(backend_error("retain relinquished journal", &history, e)),
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound && previous.is_none() => {}
        _ => return reject(),
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "handoff-installing-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| backend_message("handoff clock unavailable"))?
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    // Every retry uses a new private stage. Interrupted stages are retained,
    // never mistaken for a committed journal or trusted by filename alone.
    {
        let mut file = secure_open_options()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| backend_error("stage handoff journal", &tmp, e))?;
        file.write_all(&encode_line(
            &HeaderRecord {
                record: HEADER_RECORD.to_owned(),
                format: FILE_FORMAT.to_owned(),
                format_version: FILE_FORMAT_VERSION,
                handoff: Some(1),
                header: session.header().clone(),
            },
            &tmp,
        )?)
        .map_err(|e| backend_error("write handoff header", &tmp, e))?;
        let mut previous_revision = Revision::ZERO;
        let mut rest = session.events();
        while let Some(first) = rest.first() {
            let count = rest
                .iter()
                .take_while(|e| e.revision == first.revision)
                .count();
            let (events, tail) = rest.split_at(count);
            file.write_all(&encode_line(
                &BatchRecord {
                    record: BATCH_RECORD.to_owned(),
                    previous_revision,
                    revision: first.revision,
                    events: events.to_vec(),
                },
                &tmp,
            )?)
            .map_err(|e| backend_error("write handoff batch", &tmp, e))?;
            previous_revision = first.revision;
            rest = tail;
        }
        file.sync_all()
            .map_err(|e| backend_error("sync handoff journal", &tmp, e))?;
    }
    if snapshot(&tmp, &session.header().id)? != *session {
        return reject();
    }
    if path.exists() {
        replace_compacted_file(path, &tmp)?;
    } else {
        fs::hard_link(&tmp, path).map_err(|e| backend_error("publish handoff journal", path, e))?;
        sync_parent_directory(path)?;
        fs::remove_file(&tmp)
            .map_err(|e| backend_error("remove completed private stage", &tmp, e))?;
    }
    sync_parent_directory(path)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use std::time::SystemTime;
    use xharness_session::{EventData as E, Message, TurnEndReason};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "xh-idle-handoff-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn store(&self, name: &str) -> JsonlSessionStore {
            JsonlSessionStore::new(self.0.join(name)).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn destination(owner: &str) -> Destination {
        Destination {
            owner: owner.repeat(64),
            cwd: format!("/native/{owner}"),
            workspace: WorkspaceCheckpoint {
                binding: "b".repeat(64),
                generation: 1,
                manifest: "c".repeat(64),
                transaction: "d".repeat(64),
            },
        }
    }
    async fn seed(store: &JsonlSessionStore) -> Session {
        let mut h = SessionHeader::new("old-session");
        h.cwd = Some("/old/mac/project".into());
        let s = store.create(h).await.unwrap();
        store
            .append(
                "old-session",
                s.revision(),
                vec![
                    E::SessionModelSelected {
                        provider: "fixture".into(),
                        model: "model".into(),
                        reasoning_effort: Some("high".into()),
                        context_window_tokens: Some(100000),
                    }
                    .into(),
                    E::PlanMode { active: true }.into(),
                    E::TurnStart { turn: 1 }.into(),
                    E::UserMessage {
                        message: Message::user("继续很久以前的任务"),
                        surface_replace: None,
                    }
                    .into(),
                    E::StepStart { turn: 1, step: 1 }.into(),
                    E::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: Message::assistant("已完成 checkpoint A"),
                        usage: None,
                    }
                    .into(),
                    E::StepEnd { turn: 1, step: 1 }.into(),
                    E::TurnEnd {
                        turn: 1,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        store.load("old-session").await.unwrap().unwrap()
    }
    #[tokio::test]
    async fn roundtrip_epochs_preserve_complete_events_and_settings_with_only_native_cwd_remapped()
    {
        let f = Fixture::new();
        let a = f.store("a");
        let b = f.store("b");
        let original = seed(&a).await;
        let bundle = a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .unwrap();
        assert_eq!(bundle.events, original.events());
        assert_eq!(bundle.revision, original.revision());
        assert!(a
            .append(
                "old-session",
                original.revision(),
                vec![E::PlanMode { active: false }.into()]
            )
            .await
            .is_err());
        assert!(a.delete_session_data("old-session").await.is_err());
        assert!(a.compress_cold_session("old-session").await.is_err());
        assert!(a.create(original.header().clone()).await.is_err());
        assert!(a.load("old-session").await.is_err());
        let p = b
            .prepare_handoff("e".repeat(64), destination("e"), bundle.clone())
            .await
            .unwrap();
        assert!(!b.session_path("old-session").unwrap().exists());
        let mut forged = p.clone();
        forged.restored = "0".repeat(64);
        assert!(a.release_handoff(forged).await.is_err());
        let release = a.release_handoff(p.clone()).await.unwrap();
        drop(a);
        drop(b);
        let a = f.store("a");
        let b = f.store("b");
        assert!(a.load("old-session").await.is_err());
        assert_eq!(
            b.activate_handoff("e".repeat(64), destination("e"), release.clone())
                .await
                .unwrap(),
            p
        );
        let imported = b.load("old-session").await.unwrap().unwrap();
        assert_eq!(imported.events(), original.events());
        assert_eq!(imported.header().cwd.as_deref(), Some("/native/e"));
        b.append(
            "old-session",
            imported.revision(),
            vec![E::PlanMode { active: false }.into()],
        )
        .await
        .unwrap();
        // Replaying an old activation never rewinds later messages/settings.
        b.activate_handoff("e".repeat(64), destination("e"), release)
            .await
            .unwrap();
        let after = b.load("old-session").await.unwrap().unwrap();
        assert!(after.revision() > imported.revision());
        let back = b
            .freeze_handoff("old-session", "e".repeat(64), destination("a"))
            .await
            .unwrap();
        assert_eq!(back.epoch, 2);
        let p2 = a
            .prepare_handoff("a".repeat(64), destination("a"), back)
            .await
            .unwrap();
        let r2 = b.release_handoff(p2).await.unwrap();
        a.activate_handoff("a".repeat(64), destination("a"), r2)
            .await
            .unwrap();
        assert_eq!(
            a.load("old-session").await.unwrap().unwrap().events(),
            after.events()
        );
        assert!(b.load("old-session").await.is_err());
        assert!(a
            .prepare_handoff("a".repeat(64), destination("a"), bundle)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn no_overwrite_wrong_binding_payload_or_resource_and_no_reset_on_lost_fence() {
        let f = Fixture::new();
        let a = f.store("a");
        let b = f.store("b");
        seed(&a).await;
        seed(&b).await;
        let bundle = a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .unwrap();
        assert!(b
            .prepare_handoff("e".repeat(64), destination("e"), bundle.clone())
            .await
            .is_err());
        let c = f.store("c");
        let mut wrong = destination("e");
        wrong.cwd = "/untrusted".into();
        assert!(c
            .prepare_handoff("e".repeat(64), wrong, bundle.clone())
            .await
            .is_err());
        let mut tampered = bundle.clone();
        tampered
            .tool_results
            .insert("f".repeat(64), "wrong hash".into());
        assert!(c
            .prepare_handoff("e".repeat(64), destination("e"), tampered)
            .await
            .is_err());
        fs::remove_file(fence_path(&a.session_path("old-session").unwrap())).unwrap();
        assert!(a.load("old-session").await.is_err());
        assert!(a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn open_turn_and_pending_inbox_are_not_repaired_or_silently_moved() {
        let f = Fixture::new();
        let a = f.store("a");
        let s = seed(&a).await;
        a.append(
            "old-session",
            s.revision(),
            vec![E::TurnStart { turn: 2 }.into()],
        )
        .await
        .unwrap();
        assert!(a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .is_err());
        assert!(a.handoff_status("old-session").await.unwrap().is_none());
        let a = f.store("b");
        let s = seed(&a).await;
        a.append(
            "old-session",
            s.revision(),
            vec![E::AgentInboxSpliced {
                target: InboxTarget::NextTurn,
                start: 0,
                removed_count: 0,
                inserted: vec![xharness_session::InboxMessage::user("pending", "hello")],
                outcome: None,
            }
            .into()],
        )
        .await
        .unwrap();
        assert!(a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn referenced_cold_tool_result_survives_handoff_and_source_removal() {
        let f = Fixture::new();
        let a = f.store("a");
        let b = f.store("b");
        let initial = seed(&a).await;
        let text = "exact large tool observation 中文".repeat(1024);
        let reference = results::put(a.root(), "old-session", &text).unwrap();
        let call = xharness_session::ToolCall {
            id: "read-1".into(),
            name: "read".into(),
            arguments_json: "{}".into(),
            ..Default::default()
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls = vec![call.clone()];
        a.append(
            "old-session",
            initial.revision(),
            vec![
                E::TurnStart { turn: 2 }.into(),
                E::StepStart { turn: 2, step: 1 }.into(),
                E::AssistantMessage {
                    turn: 2,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                E::ToolCall {
                    turn: 2,
                    step: 1,
                    call,
                }
                .into(),
                E::ToolResult {
                    turn: 2,
                    step: 1,
                    result: xharness_session::ToolResultData::success(
                        "read-1",
                        serde_json::json!({"archive":reference,"content":"reduced result"})
                            .to_string(),
                    ),
                }
                .into(),
                E::StepEnd { turn: 2, step: 1 }.into(),
                E::TurnEnd {
                    turn: 2,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
        let original = a.load("old-session").await.unwrap().unwrap();
        let bundle = a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .unwrap();
        assert_eq!(bundle.tool_results.len(), 1);
        let p = b
            .prepare_handoff("e".repeat(64), destination("e"), bundle)
            .await
            .unwrap();
        let r = a.release_handoff(p).await.unwrap();
        drop(a);
        fs::remove_dir_all(f.0.join("a")).unwrap();
        b.activate_handoff("e".repeat(64), destination("e"), r)
            .await
            .unwrap();
        assert_eq!(
            b.tool_result_archive("old-session", &reference.sha256)
                .await
                .unwrap()
                .unwrap(),
            text
        );
        assert_eq!(
            b.load("old-session").await.unwrap().unwrap().events(),
            original.events()
        );
    }
    #[tokio::test]
    async fn published_target_before_activation_is_fenced_and_lost_metadata_cannot_reopen_marker() {
        let f = Fixture::new();
        let a = f.store("a");
        let b = f.store("b");
        seed(&a).await;
        let bundle = a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .unwrap();
        let source_header: serde_json::Value = serde_json::from_str(
            fs::read_to_string(a.session_path("old-session").unwrap())
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(source_header["handoff"], 1);
        let p = b
            .prepare_handoff("e".repeat(64), destination("e"), bundle.clone())
            .await
            .unwrap();
        let release = a.release_handoff(p).await.unwrap();
        let path = b.session_path("old-session").unwrap();
        publish_journal(&path, &restored(&bundle).unwrap(), None).unwrap();
        assert!(b.load("old-session").await.is_err());
        let fingerprint = file_fingerprint(&path).unwrap();
        b.activate_handoff("e".repeat(64), destination("e"), release)
            .await
            .unwrap();
        assert_eq!(file_fingerprint(&path).unwrap(), fingerprint);
        // Even a warm cache cannot hide loss of BOTH mutable and pin metadata.
        b.load("old-session").await.unwrap();
        fs::remove_file(fence_path(&path)).unwrap();
        fs::remove_file(pin_path(&path)).unwrap();
        assert!(b.load("old-session").await.is_err());
        assert!(b
            .append(
                "old-session",
                bundle.revision,
                vec![E::PlanMode { active: false }.into()]
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn independent_harness_and_full_request_archives_survive_source_removal() {
        let f = Fixture::new();
        let a = f.store("a");
        let b = f.store("b");
        let s = seed(&a).await;
        let mut header = RequestHeader::new("fixture", "model");
        header.system = Some("system snapshot 中文".into());
        header.input = vec![Message::user("original audited input")];
        let href = harness_snapshot::archive(a.root(), "old-session", &header).unwrap();
        header.options.insert("harnessSnapshot".into(), href);
        let compact = audit::archive(a.root(), header.clone()).unwrap();
        let receipt = a
            .append(
                "old-session",
                s.revision(),
                vec![
                    E::TurnStart { turn: 2 }.into(),
                    E::StepStart { turn: 2, step: 1 }.into(),
                    E::RequestHeader { header: compact }.into(),
                    E::StepEnd { turn: 2, step: 1 }.into(),
                    E::TurnEnd {
                        turn: 2,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let seq = receipt.first_seq + 2;
        let archived =
            results::put(a.root(), "old-session", "large tool result kept verbatim").unwrap();
        // Tool archive closure validation is also independently checked, even
        // when a malicious bundle supplies an unreferenced extra object.
        let mut bundle = a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .unwrap();
        bundle
            .tool_results
            .insert(archived.sha256, "large tool result kept verbatim".into());
        assert!(b
            .prepare_handoff("e".repeat(64), destination("e"), bundle)
            .await
            .is_err());
        let bundle = a
            .freeze_handoff("old-session", "a".repeat(64), destination("e"))
            .await
            .unwrap();
        let p = b
            .prepare_handoff("e".repeat(64), destination("e"), bundle)
            .await
            .unwrap();
        let r = a.release_handoff(p).await.unwrap();
        drop(a);
        fs::remove_dir_all(f.0.join("a")).unwrap();
        b.activate_handoff("e".repeat(64), destination("e"), r)
            .await
            .unwrap();
        assert_eq!(
            b.request_header("old-session", seq).await.unwrap().unwrap(),
            header
        );
        assert_eq!(
            b.harness_header("old-session", seq)
                .await
                .unwrap()
                .unwrap()
                .system,
            header.system
        );
    }
}

#[cfg(test)]
mod legacy_header_tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    // Exact pre-feature HeaderRecord schema: older native binaries MUST reject
    // the extra field, rather than treating a migrated journal as executable.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyHeader {
        record: String,
        format: String,
        format_version: u32,
        header: SessionHeader,
    }
    #[test]
    fn migrated_header_is_not_accepted_by_legacy_native_schema() {
        let old = serde_json::json!({"record":HEADER_RECORD,"format":FILE_FORMAT,"format_version":1,"header":SessionHeader::new("s")});
        let parsed: LegacyHeader = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(parsed.record, HEADER_RECORD);
        assert_eq!(parsed.format, FILE_FORMAT);
        assert_eq!(parsed.format_version, 1);
        assert_eq!(parsed.header.id, "s");
        let mut managed = old;
        managed["handoff"] = serde_json::json!(1);
        assert!(serde_json::from_value::<LegacyHeader>(managed).is_err());
    }
}
