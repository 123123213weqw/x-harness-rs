//! Append-only persistence for Host-global product state.
//!
//! Agent conversations remain in `xharness-session`. This log owns the
//! orthogonal control plane: workspace metadata/order, archived-session view,
//! settings documents, and generic exactly-once RPC mutation receipts. Every
//! accepted mutation appends its state events and receipt in one CAS batch.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, RwLock};

const FILE_FORMAT: &str = "xharness.host-control.jsonl";
const FILE_FORMAT_VERSION: u32 = 1;
const HEADER_RECORD: &str = "header";
const BATCH_RECORD: &str = "batch";
const LOG_FILE: &str = "host-control.jsonl";
const LOCK_FILE: &str = "host-control.lock";
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

type Sequence = u64;
type ProcessLock = AsyncMutex<()>;
type LockTable = StdMutex<HashMap<PathBuf, Weak<ProcessLock>>>;

static PROCESS_LOCKS: OnceLock<LockTable> = OnceLock::new();

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ControlRevision(pub u64);

impl ControlRevision {
    pub const ZERO: Self = Self(0);

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub workspace_id: String,
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub session_order: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsSnapshot {
    pub namespace: String,
    pub user: Value,
    pub value: Value,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationReceipt {
    pub rpc_id: String,
    pub method: String,
    pub fingerprint: String,
    pub response: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ControlEvent {
    WorkspaceDefined { workspace: WorkspaceSnapshot },
    WorkspaceRemoved { workspace_id: String },
    WorkspaceOrderSet { workspace_ids: Vec<String> },
    ArchivedSessionsSet { session_ids: Vec<String> },
    SettingsSet { settings: SettingsSnapshot },
    MutationCommitted { receipt: MutationReceipt },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoggedControlEvent {
    pub seq: Sequence,
    pub revision: ControlRevision,
    pub timestamp_ms: u64,
    pub event: ControlEvent,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ControlLog {
    revision: ControlRevision,
    events: Vec<LoggedControlEvent>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ControlAppendReceipt {
    pub previous_revision: ControlRevision,
    pub revision: ControlRevision,
    pub first_seq: Sequence,
    pub last_seq: Sequence,
    pub events: Vec<LoggedControlEvent>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ControlProjection {
    pub workspaces: BTreeMap<String, WorkspaceSnapshot>,
    pub removed_workspaces: BTreeSet<String>,
    pub workspace_order: Option<Vec<String>>,
    pub archived_sessions: Option<Vec<String>>,
    pub settings: BTreeMap<String, SettingsSnapshot>,
    pub receipts: BTreeMap<String, MutationReceipt>,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ControlError {
    #[error("host control revision conflict: expected {expected:?}, actual {actual:?}")]
    RevisionConflict {
        expected: ControlRevision,
        actual: ControlRevision,
    },
    #[error("invalid host control log: {message}")]
    InvalidLog { message: String },
    #[error("host control storage error: {message}")]
    Backend { message: String },
}

impl ControlLog {
    pub fn empty() -> Self {
        Self {
            revision: ControlRevision::ZERO,
            events: Vec::new(),
        }
    }

    pub fn restore(
        revision: ControlRevision,
        events: Vec<LoggedControlEvent>,
    ) -> Result<Self, ControlError> {
        validate_log(revision, &events)?;
        Ok(Self { revision, events })
    }

    pub const fn revision(&self) -> ControlRevision {
        self.revision
    }

    pub fn events(&self) -> &[LoggedControlEvent] {
        &self.events
    }

    pub fn next_seq(&self) -> Sequence {
        self.events.len() as Sequence
    }

    pub fn projection(&self) -> Result<ControlProjection, ControlError> {
        ControlProjection::from_events(&self.events)
    }

    pub fn append_batch(
        &mut self,
        expected_revision: ControlRevision,
        events: Vec<ControlEvent>,
    ) -> Result<ControlAppendReceipt, ControlError> {
        self.append_batch_at(expected_revision, events, unix_timestamp_ms())
    }

    pub fn append_batch_at(
        &mut self,
        expected_revision: ControlRevision,
        events: Vec<ControlEvent>,
        timestamp_ms: u64,
    ) -> Result<ControlAppendReceipt, ControlError> {
        if expected_revision != self.revision {
            return Err(ControlError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        if events.is_empty() {
            return Err(invalid("a control mutation batch must not be empty"));
        }
        let revision = ControlRevision(
            self.revision
                .0
                .checked_add(1)
                .ok_or_else(|| invalid("control revision overflow"))?,
        );
        let first_seq = self.next_seq();
        let staged = events
            .into_iter()
            .enumerate()
            .map(|(offset, event)| LoggedControlEvent {
                seq: first_seq.saturating_add(offset as u64),
                revision,
                timestamp_ms,
                event,
            })
            .collect::<Vec<_>>();
        let prospective = self
            .events
            .iter()
            .chain(&staged)
            .cloned()
            .collect::<Vec<_>>();
        validate_log(revision, &prospective)?;
        let previous_revision = self.revision;
        self.revision = revision;
        self.events.extend(staged.iter().cloned());
        Ok(ControlAppendReceipt {
            previous_revision,
            revision,
            first_seq,
            last_seq: self.next_seq().saturating_sub(1),
            events: staged,
        })
    }
}

impl ControlProjection {
    pub fn from_events(events: &[LoggedControlEvent]) -> Result<Self, ControlError> {
        let mut projection = Self::default();
        let mut settings_revisions = BTreeMap::<String, u64>::new();
        for logged in events {
            match &logged.event {
                ControlEvent::WorkspaceDefined { workspace } => {
                    validate_workspace(workspace)?;
                    if let Some(previous) = projection.workspaces.get(&workspace.workspace_id) {
                        if previous.path != workspace.path
                            || previous.created_at != workspace.created_at
                        {
                            return Err(invalid(format!(
                                "workspace {:?} changed immutable identity",
                                workspace.workspace_id
                            )));
                        }
                    }
                    if projection.workspaces.values().any(|candidate| {
                        candidate.workspace_id != workspace.workspace_id
                            && candidate.path == workspace.path
                    }) {
                        return Err(invalid(format!(
                            "workspace path {:?} is assigned more than once",
                            workspace.path
                        )));
                    }
                    projection
                        .removed_workspaces
                        .remove(&workspace.workspace_id);
                    projection
                        .workspaces
                        .insert(workspace.workspace_id.clone(), workspace.clone());
                }
                ControlEvent::WorkspaceRemoved { workspace_id } => {
                    require_nonempty(workspace_id, "workspace id")?;
                    projection.workspaces.remove(workspace_id);
                    projection.removed_workspaces.insert(workspace_id.clone());
                }
                ControlEvent::WorkspaceOrderSet { workspace_ids } => {
                    require_unique_nonempty(workspace_ids, "workspace order")?;
                    projection.workspace_order = Some(workspace_ids.clone());
                }
                ControlEvent::ArchivedSessionsSet { session_ids } => {
                    require_unique_nonempty(session_ids, "archived session list")?;
                    projection.archived_sessions = Some(session_ids.clone());
                }
                ControlEvent::SettingsSet { settings } => {
                    require_nonempty(&settings.namespace, "settings namespace")?;
                    if !settings.user.is_object() || !settings.value.is_object() {
                        return Err(invalid(format!(
                            "settings namespace {:?} must contain object values",
                            settings.namespace
                        )));
                    }
                    reject_sensitive_values(&settings.user, "settings user document")?;
                    reject_sensitive_values(&settings.value, "settings effective document")?;
                    let expected = settings_revisions
                        .get(&settings.namespace)
                        .copied()
                        .unwrap_or(0)
                        .saturating_add(1);
                    if settings.revision != expected {
                        return Err(invalid(format!(
                            "settings namespace {:?} revision must be {expected}, got {}",
                            settings.namespace, settings.revision
                        )));
                    }
                    settings_revisions.insert(settings.namespace.clone(), settings.revision);
                    projection
                        .settings
                        .insert(settings.namespace.clone(), settings.clone());
                }
                ControlEvent::MutationCommitted { receipt } => {
                    validate_receipt(receipt)?;
                    if projection
                        .receipts
                        .insert(receipt.rpc_id.clone(), receipt.clone())
                        .is_some()
                    {
                        return Err(invalid(format!(
                            "duplicate mutation receipt {:?}",
                            receipt.rpc_id
                        )));
                    }
                }
            }
        }
        Ok(projection)
    }
}

/// Stable, provider-independent request fingerprint used by every Host-global
/// mutation RPC. JSON object keys are serialized deterministically by
/// `serde_json`'s map implementation.
pub fn mutation_fingerprint(method: &str, payload: &Value) -> String {
    let encoded = serde_json::to_vec(&json!({
        "version": 1,
        "method": method,
        "payload": payload,
    }))
    .expect("JSON values always serialize");
    let digest = Sha256::digest(encoded);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

#[async_trait]
pub trait ControlStore: Send + Sync + 'static {
    async fn load(&self) -> Result<ControlLog, ControlError>;
    async fn append(
        &self,
        expected_revision: ControlRevision,
        events: Vec<ControlEvent>,
    ) -> Result<ControlAppendReceipt, ControlError>;
    async fn flush(&self) -> Result<ControlRevision, ControlError>;
}

#[derive(Clone, Default)]
pub struct MemoryControlStore {
    log: Arc<RwLock<ControlLog>>,
}

impl Default for ControlLog {
    fn default() -> Self {
        Self::empty()
    }
}

#[async_trait]
impl ControlStore for MemoryControlStore {
    async fn load(&self) -> Result<ControlLog, ControlError> {
        Ok(self.log.read().await.clone())
    }

    async fn append(
        &self,
        expected_revision: ControlRevision,
        events: Vec<ControlEvent>,
    ) -> Result<ControlAppendReceipt, ControlError> {
        self.log
            .write()
            .await
            .append_batch(expected_revision, events)
    }

    async fn flush(&self) -> Result<ControlRevision, ControlError> {
        Ok(self.log.read().await.revision())
    }
}

#[derive(Clone, Debug)]
pub struct JsonlControlStore {
    root: Arc<PathBuf>,
    log_path: Arc<PathBuf>,
    lock_path: Arc<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeaderRecord {
    record: String,
    format: String,
    format_version: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRecord {
    record: String,
    previous_revision: ControlRevision,
    revision: ControlRevision,
    events: Vec<LoggedControlEvent>,
}

struct LoadedFile {
    log: ControlLog,
    valid_len: u64,
    needs_separator: bool,
}

impl JsonlControlStore {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, ControlError> {
        let requested = root.as_ref();
        fs::create_dir_all(requested)
            .map_err(|error| backend_error("create control directory", requested, error))?;
        let root = fs::canonicalize(requested)
            .map_err(|error| backend_error("canonicalize control directory", requested, error))?;
        if !fs::metadata(&root)
            .map_err(|error| backend_error("inspect control directory", &root, error))?
            .is_dir()
        {
            return Err(backend_message(format!(
                "control root {} is not a directory",
                root.display()
            )));
        }
        Ok(Self {
            log_path: Arc::new(root.join(LOG_FILE)),
            lock_path: Arc::new(root.join(LOCK_FILE)),
            root: Arc::new(root),
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    async fn locked(&self) -> Result<(OwnedMutexGuard<()>, File), ControlError> {
        let process = process_lock(self.lock_path.as_path())?.lock_owned().await;
        let lock_path = Arc::clone(&self.lock_path);
        let file = run_blocking(move || acquire_file_lock(&lock_path)).await?;
        Ok((process, file))
    }
}

#[async_trait]
impl ControlStore for JsonlControlStore {
    async fn load(&self) -> Result<ControlLog, ControlError> {
        let (process, file_lock) = self.locked().await?;
        let path = Arc::clone(&self.log_path);
        run_blocking(move || {
            let _process = process;
            let _file_lock = file_lock;
            Ok(load_file(&path)?.map_or_else(ControlLog::empty, |loaded| loaded.log))
        })
        .await
    }

    async fn append(
        &self,
        expected_revision: ControlRevision,
        events: Vec<ControlEvent>,
    ) -> Result<ControlAppendReceipt, ControlError> {
        let (process, file_lock) = self.locked().await?;
        let path = Arc::clone(&self.log_path);
        run_blocking(move || {
            let _process = process;
            let _file_lock = file_lock;
            if !path.exists() {
                create_header(&path)?;
            }
            let mut loaded = load_file(&path)?.ok_or_else(|| {
                backend_message(format!("control log {} disappeared", path.display()))
            })?;
            let receipt = loaded.log.append_batch(expected_revision, events)?;
            let record = BatchRecord {
                record: BATCH_RECORD.to_owned(),
                previous_revision: receipt.previous_revision,
                revision: receipt.revision,
                events: receipt.events.clone(),
            };
            let encoded = encode_line(&record, &path)?;
            let mut file = secure_open_options()
                .read(true)
                .append(true)
                .open(path.as_path())
                .map_err(|error| backend_error("open control log for append", &path, error))?;
            ensure_regular_file(&file, &path, "control log")?;
            let current_len = file
                .metadata()
                .map_err(|error| backend_error("inspect control log", &path, error))?
                .len();
            if current_len != loaded.valid_len {
                truncate_torn_tail(&path, loaded.valid_len)?;
            }
            if loaded.needs_separator {
                file.write_all(b"\n")
                    .map_err(|error| backend_error("separate control records", &path, error))?;
            }
            file.write_all(&encoded)
                .and_then(|_| file.flush())
                .map_err(|error| backend_error("append control batch", &path, error))?;
            Ok(receipt)
        })
        .await
    }

    async fn flush(&self) -> Result<ControlRevision, ControlError> {
        let (process, file_lock) = self.locked().await?;
        let path = Arc::clone(&self.log_path);
        let root = Arc::clone(&self.root);
        run_blocking(move || {
            let _process = process;
            let _file_lock = file_lock;
            let Some(loaded) = load_file(&path)? else {
                return Ok(ControlRevision::ZERO);
            };
            let file = secure_open_options()
                .read(true)
                .write(true)
                .open(path.as_path())
                .map_err(|error| backend_error("sync control log", &path, error))?;
            ensure_regular_file(&file, &path, "control log")?;
            file.sync_all()
                .map_err(|error| backend_error("sync control log", &path, error))?;
            sync_directory(&root)?;
            Ok(loaded.log.revision())
        })
        .await
    }
}

fn validate_log(
    revision: ControlRevision,
    events: &[LoggedControlEvent],
) -> Result<(), ControlError> {
    if events.is_empty() {
        if revision != ControlRevision::ZERO {
            return Err(invalid("empty control log must have revision zero"));
        }
        return Ok(());
    }
    let mut active_revision = ControlRevision::ZERO;
    let mut receipts_in_revision = 0usize;
    for (index, logged) in events.iter().enumerate() {
        if logged.seq != index as u64 {
            return Err(invalid(format!(
                "sequence gap: expected {index}, got {}",
                logged.seq
            )));
        }
        if logged.revision == active_revision {
            if receipts_in_revision > 0 {
                return Err(invalid(format!(
                    "revision {:?} contains events after its mutation receipt",
                    active_revision
                )));
            }
        } else {
            if active_revision != ControlRevision::ZERO && receipts_in_revision != 1 {
                return Err(invalid(format!(
                    "revision {:?} must contain exactly one mutation receipt",
                    active_revision
                )));
            }
            let expected = active_revision
                .0
                .checked_add(1)
                .ok_or_else(|| invalid("control revision overflow"))?;
            if logged.revision != ControlRevision(expected) {
                return Err(invalid(format!(
                    "revision gap: expected {expected}, got {}",
                    logged.revision.0
                )));
            }
            active_revision = logged.revision;
            receipts_in_revision = 0;
        }
        if matches!(logged.event, ControlEvent::MutationCommitted { .. }) {
            receipts_in_revision += 1;
        }
    }
    if receipts_in_revision != 1 {
        return Err(invalid(format!(
            "revision {:?} must end with exactly one mutation receipt",
            active_revision
        )));
    }
    if active_revision != revision {
        return Err(invalid(format!(
            "header revision {revision:?} does not match final event {active_revision:?}"
        )));
    }
    ControlProjection::from_events(events)?;
    Ok(())
}

fn validate_workspace(workspace: &WorkspaceSnapshot) -> Result<(), ControlError> {
    require_nonempty(&workspace.workspace_id, "workspace id")?;
    require_nonempty(&workspace.path, "workspace path")?;
    require_nonempty(&workspace.title, "workspace title")?;
    require_nonempty(&workspace.created_at, "workspace created_at")?;
    require_nonempty(&workspace.updated_at, "workspace updated_at")?;
    require_unique_nonempty(&workspace.session_order, "workspace session order")
}

fn validate_receipt(receipt: &MutationReceipt) -> Result<(), ControlError> {
    require_nonempty(&receipt.rpc_id, "receipt rpc id")?;
    require_nonempty(&receipt.method, "receipt method")?;
    if receipt.fingerprint.len() != 64
        || !receipt
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid(
            "receipt fingerprint must be 64 lowercase hex bytes",
        ));
    }
    reject_sensitive_values(&receipt.response, "receipt response")
}

fn require_nonempty(value: &str, field: &str) -> Result<(), ControlError> {
    if value.trim().is_empty() || value.contains('\0') {
        Err(invalid(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn require_unique_nonempty(values: &[String], field: &str) -> Result<(), ControlError> {
    let mut seen = BTreeSet::new();
    for value in values {
        require_nonempty(value, field)?;
        if !seen.insert(value) {
            return Err(invalid(format!("{field} contains duplicate {value:?}")));
        }
    }
    Ok(())
}

fn reject_sensitive_values(value: &Value, context: &str) -> Result<(), ControlError> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                let sensitive = normalized.contains("password")
                    || normalized.contains("authorization")
                    || normalized.contains("apikey")
                    || normalized.ends_with("token")
                    || normalized.ends_with("secret");
                let populated = !matches!(value, Value::Null)
                    && !matches!(value, Value::String(text) if text.is_empty())
                    && !matches!(value, Value::Array(items) if items.is_empty())
                    && !matches!(value, Value::Object(items) if items.is_empty());
                if sensitive && populated {
                    return Err(invalid(format!(
                        "{context} contains forbidden credential field {key:?}"
                    )));
                }
                reject_sensitive_values(value, context)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_sensitive_values(value, context)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn load_file(path: &Path) -> Result<Option<LoadedFile>, ControlError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(backend_message(format!(
                "control log {} must not be a symbolic link",
                path.display()
            )));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(backend_message(format!(
                "control log {} is not a regular file",
                path.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(backend_error("inspect control log", path, error)),
    }
    let mut file = secure_open_options()
        .read(true)
        .open(path)
        .map_err(|error| backend_error("open control log", path, error))?;
    ensure_regular_file(&file, path, "control log")?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| backend_error("read control log", path, error))?;
    parse_file(path, &bytes).map(Some)
}

fn parse_file(path: &Path, bytes: &[u8]) -> Result<LoadedFile, ControlError> {
    let terminated = bytes.ends_with(b"\n");
    let mut cursor = 0usize;
    let mut records = Vec::<&[u8]>::new();
    while cursor < bytes.len() {
        let relative = bytes[cursor..].iter().position(|byte| *byte == b'\n');
        let (end, next) = relative.map_or((bytes.len(), bytes.len()), |offset| {
            (cursor + offset, cursor + offset + 1)
        });
        let line = &bytes[cursor..end];
        if line.is_empty() {
            return Err(backend_message(format!(
                "control log {} contains an empty record",
                path.display()
            )));
        }
        records.push(line);
        cursor = next;
    }
    if records.is_empty() {
        return Err(backend_message(format!(
            "control log {} has no header",
            path.display()
        )));
    }
    let header: HeaderRecord = serde_json::from_slice(records[0]).map_err(|error| {
        backend_message(format!("decode control header {}: {error}", path.display()))
    })?;
    if header.record != HEADER_RECORD
        || header.format != FILE_FORMAT
        || header.format_version != FILE_FORMAT_VERSION
    {
        return Err(backend_message(format!(
            "control log {} has an unsupported header",
            path.display()
        )));
    }

    let mut events = Vec::new();
    let mut revision = ControlRevision::ZERO;
    let mut accepted_records = 1usize;
    for (index, line) in records.iter().enumerate().skip(1) {
        match serde_json::from_slice::<BatchRecord>(line) {
            Ok(batch) => {
                if batch.record != BATCH_RECORD || batch.previous_revision != revision {
                    return Err(backend_message(format!(
                        "control batch {}:{} has a broken revision chain",
                        path.display(),
                        index + 1
                    )));
                }
                revision = batch.revision;
                events.extend(batch.events);
                accepted_records += 1;
            }
            Err(_) if index + 1 == records.len() && !terminated => break,
            Err(error) => {
                return Err(backend_message(format!(
                    "decode control batch {}:{}: {error}",
                    path.display(),
                    index + 1
                )));
            }
        }
    }
    let log = ControlLog::restore(revision, events)?;
    let valid_len = if accepted_records == records.len() {
        bytes.len() as u64
    } else {
        records[..accepted_records]
            .iter()
            .map(|line| line.len().saturating_add(1))
            .sum::<usize>() as u64
    };
    Ok(LoadedFile {
        log,
        valid_len,
        needs_separator: accepted_records == records.len() && !terminated,
    })
}

fn create_header(path: &Path) -> Result<(), ControlError> {
    let record = HeaderRecord {
        record: HEADER_RECORD.to_owned(),
        format: FILE_FORMAT.to_owned(),
        format_version: FILE_FORMAT_VERSION,
    };
    let encoded = encode_line(&record, path)?;
    let mut file = secure_open_options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| backend_error("create control log", path, error))?;
    if let Err(error) = file.write_all(&encoded).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(backend_error("write control header", path, error));
    }
    sync_directory(path.parent().unwrap_or_else(|| Path::new(".")))
}

fn encode_line<T: Serialize>(value: &T, path: &Path) -> Result<Vec<u8>, ControlError> {
    let mut encoded = serde_json::to_vec(value).map_err(|error| {
        backend_message(format!("encode control record {}: {error}", path.display()))
    })?;
    encoded.push(b'\n');
    Ok(encoded)
}

fn process_lock(path: &Path) -> Result<Arc<ProcessLock>, ControlError> {
    let table = PROCESS_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut table = table
        .lock()
        .map_err(|_| backend_message("control lock table is poisoned"))?;
    if let Some(lock) = table.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    table.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(AsyncMutex::new(()));
    table.insert(path.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

fn acquire_file_lock(path: &Path) -> Result<File, ControlError> {
    let file = secure_open_options()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .map_err(|error| backend_error("open control lock", path, error))?;
    if !file
        .metadata()
        .map_err(|error| backend_error("inspect control lock", path, error))?
        .is_file()
    {
        return Err(backend_message(format!(
            "control lock {} is not a regular file",
            path.display()
        )));
    }
    fs2::FileExt::lock_exclusive(&file)
        .map_err(|error| backend_error("lock control log", path, error))?;
    Ok(file)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), ControlError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| backend_error("sync control directory", path, error))
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> Result<(), ControlError> {
    if fs::metadata(path)
        .map_err(|error| backend_error("inspect control directory", path, error))?
        .is_dir()
    {
        Ok(())
    } else {
        Err(backend_message(format!(
            "control directory {} is not a directory",
            path.display()
        )))
    }
}

fn secure_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

fn truncate_torn_tail(path: &Path, valid_len: u64) -> Result<(), ControlError> {
    // Windows append-only handles cannot call SetEndOfFile. A separate
    // writable handle repairs the crash tail while the process and file locks
    // continue to serialize the complete load/compare/append transaction.
    let file = secure_open_options()
        .write(true)
        .open(path)
        .map_err(|error| backend_error("open control log for tail repair", path, error))?;
    ensure_regular_file(&file, path, "control log")?;
    file.set_len(valid_len)
        .map_err(|error| backend_error("truncate torn control tail", path, error))
}

fn ensure_regular_file(file: &File, path: &Path, label: &str) -> Result<(), ControlError> {
    let metadata = file
        .metadata()
        .map_err(|error| backend_error(&format!("inspect opened {label}"), path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(backend_message(format!(
            "{label} {} is not a regular file",
            path.display()
        )));
    }
    Ok(())
}

async fn run_blocking<T, F>(operation: F) -> Result<T, ControlError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ControlError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| backend_message(format!("control storage worker failed: {error}")))?
}

fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::InvalidLog {
        message: message.into(),
    }
}

fn backend_message(message: impl Into<String>) -> ControlError {
    ControlError::Backend {
        message: message.into(),
    }
}

fn backend_error(operation: &str, path: &Path, error: std::io::Error) -> ControlError {
    backend_message(format!("{operation} {}: {error}", path.display()))
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
