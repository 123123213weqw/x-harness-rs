//! Crash-tolerant, append-only JSONL persistence for XHarness sessions.
//!
//! A session occupies exactly one `<id>.jsonl` file. The first record is an
//! immutable header and every later record contains one complete CAS append
//! batch. A torn, unterminated final JSON record is ignored during recovery;
//! corruption anywhere else is rejected.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use xharness_session::{
    AppendReceipt, LoggedEvent, Revision, Session, SessionEvent, SessionHeader, SessionInspection,
    Store, StoreError,
};

const FILE_FORMAT: &str = "xharness.session.jsonl";
const FILE_FORMAT_VERSION: u32 = 1;
const HEADER_RECORD: &str = "header";
const BATCH_RECORD: &str = "batch";
const FILE_SUFFIX: &str = ".jsonl";
const MAX_SESSION_ID_BYTES: usize = 200;

type SessionLock = AsyncMutex<()>;
type LockTable = StdMutex<HashMap<PathBuf, Weak<SessionLock>>>;

static PROCESS_LOCKS: OnceLock<LockTable> = OnceLock::new();

/// A filesystem-backed [`Store`] with one append-only JSONL file per session.
///
/// Clones and independently opened stores in this process share a per-file
/// mutex. A companion advisory lock serializes the same load/compare/append
/// transaction across processes, so the on-disk revision remains the
/// authoritative CAS value.
#[derive(Clone, Debug)]
pub struct JsonlSessionStore {
    root: Arc<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeaderRecord {
    record: String,
    format: String,
    format_version: u32,
    header: SessionHeader,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRecord {
    record: String,
    previous_revision: Revision,
    revision: Revision,
    events: Vec<LoggedEvent>,
}

struct LoadedFile {
    session: Session,
    /// Prefix known to contain only accepted records.
    valid_len: u64,
    /// The accepted final record had no newline terminator.
    needs_separator: bool,
}

impl JsonlSessionStore {
    /// Open (or create) a storage directory.
    ///
    /// The directory is canonicalized once so independently constructed store
    /// handles use the same process-wide lock keys.
    pub fn new(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let requested = root.as_ref();
        fs::create_dir_all(requested)
            .map_err(|error| backend_error("create storage directory", requested, error))?;
        let root = fs::canonicalize(requested)
            .map_err(|error| backend_error("canonicalize storage directory", requested, error))?;
        let metadata = fs::metadata(&root)
            .map_err(|error| backend_error("inspect storage directory", &root, error))?;
        if !metadata.is_dir() {
            return Err(backend_message(format!(
                "storage root {} is not a directory",
                root.display()
            )));
        }
        Ok(Self {
            root: Arc::new(root),
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_ref().as_path()
    }

    fn session_path(&self, session_id: &str) -> Result<PathBuf, StoreError> {
        validate_session_id(session_id)?;
        Ok(self.root.join(format!("{session_id}{FILE_SUFFIX}")))
    }

    async fn locked_path(
        &self,
        session_id: &str,
    ) -> Result<(PathBuf, OwnedMutexGuard<()>), StoreError> {
        let path = self.session_path(session_id)?;
        let lock = process_lock(&path)?;
        let guard = lock.lock_owned().await;
        Ok((path, guard))
    }
}

#[async_trait]
impl Store for JsonlSessionStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        let root = Arc::clone(&self.root);
        let mut session_ids = run_blocking(move || discover_session_ids(root.as_path())).await?;
        session_ids.sort();

        let mut headers = Vec::with_capacity(session_ids.len());
        for session_id in session_ids {
            let session = self.load(&session_id).await?.ok_or_else(|| {
                backend_message(format!(
                    "session {session_id:?} disappeared during startup enumeration"
                ))
            })?;
            headers.push(session.header().clone());
        }
        Ok(headers)
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        let session_id = header.id.clone();
        let (path, guard) = self.locked_path(&session_id).await?;
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            let session = Session::new(header)?;
            let record = HeaderRecord {
                record: HEADER_RECORD.to_owned(),
                format: FILE_FORMAT.to_owned(),
                format_version: FILE_FORMAT_VERSION,
                header: session.header().clone(),
            };
            let bytes = encode_line(&record, &path)?;
            let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    return Err(StoreError::AlreadyExists { session_id });
                }
                Err(error) => return Err(backend_error("create session", &path, error)),
            };
            if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&path);
                let _ = sync_parent_directory(&path);
                return Err(backend_error("durably write session header", &path, error));
            }
            sync_parent_directory(&path)?;
            Ok(session)
        })
        .await
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        let owned_id = session_id.to_owned();
        let (path, guard) = self.locked_path(session_id).await?;
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            load_file(&path, &owned_id).map(|loaded| loaded.map(|state| state.session))
        })
        .await
    }

    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        let owned_id = session_id.to_owned();
        let (path, guard) = self.locked_path(session_id).await?;
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            let Some(mut loaded) = load_file(&path, &owned_id)? else {
                return Err(StoreError::NotFound {
                    session_id: owned_id,
                });
            };

            let actual_revision = loaded.session.revision();
            if actual_revision != expected_revision {
                return Err(StoreError::RevisionConflict {
                    session_id: owned_id,
                    expected: expected_revision,
                    actual: actual_revision,
                });
            }

            let receipt = loaded
                .session
                .append_batch(expected_revision, events)
                .map_err(StoreError::from)?;
            if receipt.events.is_empty() {
                return Ok(receipt);
            }

            let record = BatchRecord {
                record: BATCH_RECORD.to_owned(),
                previous_revision: receipt.previous_revision,
                revision: receipt.revision,
                events: receipt.events.clone(),
            };
            let bytes = encode_line(&record, &path)?;
            let mut file = OpenOptions::new()
                .read(true)
                .append(true)
                .open(&path)
                .map_err(|error| backend_error("open session for append", &path, error))?;

            let current_len = file
                .metadata()
                .map_err(|error| backend_error("inspect session before append", &path, error))?
                .len();
            if current_len != loaded.valid_len {
                file.set_len(loaded.valid_len)
                    .map_err(|error| backend_error("truncate torn session tail", &path, error))?;
            }
            if loaded.needs_separator {
                file.write_all(b"\n").map_err(|error| {
                    backend_error("terminate prior session record", &path, error)
                })?;
            }
            file.write_all(&bytes)
                .map_err(|error| backend_error("append session batch", &path, error))?;
            file.flush()
                .map_err(|error| backend_error("flush appended session batch", &path, error))?;
            Ok(receipt)
        })
        .await
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        let owned_id = session_id.to_owned();
        let (path, guard) = self.locked_path(session_id).await?;
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            let Some(loaded) = load_file(&path, &owned_id)? else {
                return Err(StoreError::NotFound {
                    session_id: owned_id,
                });
            };
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| {
                    backend_error("open session for durability flush", &path, error)
                })?;
            file.sync_all()
                .map_err(|error| backend_error("sync session data", &path, error))?;
            sync_parent_directory(&path)?;
            Ok(loaded.session.revision())
        })
        .await
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError> {
        Ok(self
            .load(session_id)
            .await?
            .map(|session| session.inspect()))
    }
}

fn discover_session_ids(root: &Path) -> Result<Vec<String>, StoreError> {
    let mut session_ids = Vec::new();
    let entries = fs::read_dir(root)
        .map_err(|error| backend_error("enumerate session directory", root, error))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| backend_error("read session directory entry", root, error))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                backend_message(format!(
                    "session directory contains a non-UTF-8 JSONL filename: {}",
                    path.display()
                ))
            })?;
        let session_id = file_name
            .strip_suffix(FILE_SUFFIX)
            .expect("the JSONL extension was checked");
        validate_session_id(session_id)?;
        session_ids.push(session_id.to_owned());
    }
    Ok(session_ids)
}

async fn run_blocking<T, F>(operation: F) -> Result<T, StoreError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, StoreError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| backend_message(format!("storage worker failed: {error}")))?
}

fn process_lock(path: &Path) -> Result<Arc<SessionLock>, StoreError> {
    let table = PROCESS_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut table = table
        .lock()
        .map_err(|_| backend_message("process session-lock table is poisoned"))?;
    if let Some(lock) = table.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    table.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(AsyncMutex::new(()));
    table.insert(path.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

/// Acquire the inter-process side of the session lock. The lock file is kept
/// separate from the append-only log so creation and replacement cannot
/// silently move a held lock to a stale inode.
fn acquire_file_lock(session_path: &Path) -> Result<File, StoreError> {
    let lock_path = session_path.with_extension("lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&lock_path)
        .map_err(|error| backend_error("open session lock", &lock_path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| backend_error("inspect session lock", &lock_path, error))?;
    if !metadata.is_file() {
        return Err(backend_message(format!(
            "session lock {} is not a regular file",
            lock_path.display()
        )));
    }
    fs2::FileExt::lock_exclusive(&file)
        .map_err(|error| backend_error("lock session", &lock_path, error))?;
    Ok(file)
}

fn sync_parent_directory(path: &Path) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| backend_message(format!("session path {} has no parent", path.display())))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| backend_error("sync session directory", parent, error))
}

fn validate_session_id(session_id: &str) -> Result<(), StoreError> {
    let valid_length = !session_id.is_empty() && session_id.len() <= MAX_SESSION_ID_BYTES;
    let valid_shape = !session_id.starts_with('.')
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid_length && valid_shape {
        Ok(())
    } else {
        Err(StoreError::InvalidSessionId {
            session_id: session_id.to_owned(),
        })
    }
}

fn encode_line<T: Serialize>(record: &T, path: &Path) -> Result<Vec<u8>, StoreError> {
    let mut bytes = serde_json::to_vec(record).map_err(|error| {
        backend_message(format!("encode session record {}: {error}", path.display()))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn load_file(path: &Path, session_id: &str) -> Result<Option<LoadedFile>, StoreError> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(backend_error("inspect session path", path, error)),
    };
    if path_metadata.file_type().is_symlink() {
        return Err(corrupt(path, 1, "session path must not be a symbolic link"));
    }
    if !path_metadata.is_file() {
        return Err(corrupt(path, 1, "session path is not a regular file"));
    }

    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(backend_error("open session", path, error)),
    };
    let metadata = file
        .metadata()
        .map_err(|error| backend_error("inspect session", path, error))?;
    if !metadata.is_file() {
        return Err(corrupt(path, 1, "opened session is not a regular file"));
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| backend_error("read session", path, error))?;
    parse_file(path, session_id, &bytes).map(Some)
}

fn parse_file(path: &Path, session_id: &str, bytes: &[u8]) -> Result<LoadedFile, StoreError> {
    if bytes.is_empty() {
        return Err(corrupt(path, 1, "missing header record"));
    }

    let (header_line, mut cursor, header_terminated) = next_line(bytes, 0);
    let header_record: HeaderRecord = serde_json::from_slice(header_line)
        .map_err(|error| corrupt(path, 1, format!("invalid header JSON: {error}")))?;
    validate_header_record(path, session_id, &header_record)?;
    let mut session = Session::new(header_record.header).map_err(StoreError::from)?;

    if !header_terminated {
        return Ok(LoadedFile {
            session,
            valid_len: bytes.len() as u64,
            needs_separator: true,
        });
    }

    let mut line_number = 2usize;
    let mut valid_len = cursor as u64;
    let mut needs_separator = false;
    while cursor < bytes.len() {
        let line_start = cursor;
        let (line, next_cursor, terminated) = next_line(bytes, cursor);
        cursor = next_cursor;
        if line.is_empty() {
            return Err(corrupt(path, line_number, "empty record"));
        }

        match serde_json::from_slice::<BatchRecord>(line) {
            Ok(record) => {
                apply_batch_record(path, line_number, &mut session, record)?;
                valid_len = cursor as u64;
                needs_separator = !terminated;
            }
            Err(_) if !terminated && line_start + line.len() == bytes.len() => {
                // Only a syntactically incomplete, unterminated final record
                // may be discarded. Any earlier or newline-terminated damage
                // is an authoritative corruption error.
                valid_len = line_start as u64;
                needs_separator = false;
                break;
            }
            Err(error) => {
                return Err(corrupt(
                    path,
                    line_number,
                    format!("invalid batch JSON: {error}"),
                ));
            }
        }

        line_number += 1;
    }

    Ok(LoadedFile {
        session,
        valid_len,
        needs_separator,
    })
}

fn next_line(bytes: &[u8], start: usize) -> (&[u8], usize, bool) {
    match bytes[start..].iter().position(|byte| *byte == b'\n') {
        Some(relative_end) => {
            let end = start + relative_end;
            (&bytes[start..end], end + 1, true)
        }
        None => (&bytes[start..], bytes.len(), false),
    }
}

fn validate_header_record(
    path: &Path,
    requested_id: &str,
    record: &HeaderRecord,
) -> Result<(), StoreError> {
    if record.record != HEADER_RECORD {
        return Err(corrupt(
            path,
            1,
            format!("expected {HEADER_RECORD:?} record, got {:?}", record.record),
        ));
    }
    if record.format != FILE_FORMAT {
        return Err(corrupt(
            path,
            1,
            format!("unsupported file format {:?}", record.format),
        ));
    }
    if record.format_version != FILE_FORMAT_VERSION {
        return Err(corrupt(
            path,
            1,
            format!(
                "unsupported JSONL format version {}; expected {}",
                record.format_version, FILE_FORMAT_VERSION
            ),
        ));
    }
    if record.header.id != requested_id {
        return Err(corrupt(
            path,
            1,
            format!(
                "header session id {:?} does not match requested id {requested_id:?}",
                record.header.id
            ),
        ));
    }
    Ok(())
}

fn apply_batch_record(
    path: &Path,
    line_number: usize,
    session: &mut Session,
    record: BatchRecord,
) -> Result<(), StoreError> {
    if record.record != BATCH_RECORD {
        return Err(corrupt(
            path,
            line_number,
            format!("expected {BATCH_RECORD:?} record, got {:?}", record.record),
        ));
    }
    if record.events.is_empty() {
        return Err(corrupt(path, line_number, "persisted batch is empty"));
    }
    if record.previous_revision != session.revision() {
        return Err(corrupt(
            path,
            line_number,
            format!(
                "batch previous revision {:?} is not continuous from {:?}",
                record.previous_revision,
                session.revision()
            ),
        ));
    }
    let expected_revision = record
        .previous_revision
        .get()
        .checked_add(1)
        .map(Revision)
        .ok_or_else(|| corrupt(path, line_number, "batch revision overflow"))?;
    if record.revision != expected_revision {
        return Err(corrupt(
            path,
            line_number,
            format!(
                "batch revision {:?} is not the successor of {:?}",
                record.revision, record.previous_revision
            ),
        ));
    }

    let timestamp_ms = record.events[0].timestamp_ms;
    let events = record
        .events
        .iter()
        .map(|logged| logged.event.clone())
        .collect();
    let receipt = session
        .append_batch_at(record.previous_revision, events, timestamp_ms)
        .map_err(|error| corrupt(path, line_number, format!("invalid event log: {error}")))?;
    if receipt.revision != record.revision || receipt.events != record.events {
        return Err(corrupt(
            path,
            line_number,
            "batch coordinates, timestamps, or revisions are not continuous",
        ));
    }
    Ok(())
}

fn backend_error(action: &str, path: &Path, error: std::io::Error) -> StoreError {
    backend_message(format!("{action} {}: {error}", path.display()))
}

fn backend_message(message: impl Into<String>) -> StoreError {
    StoreError::Backend {
        message: message.into(),
    }
}

fn corrupt(path: &Path, line: usize, message: impl AsRef<str>) -> StoreError {
    backend_message(format!(
        "corrupt session {} at line {line}: {}",
        path.display(),
        message.as_ref()
    ))
}
