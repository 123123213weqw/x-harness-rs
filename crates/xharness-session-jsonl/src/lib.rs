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
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
};

#[cfg(unix)]
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::{FileExt, OpenOptionsExt};
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};

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
const FINGERPRINT_SAMPLE_BYTES: usize = 4 * 1_024;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

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
    /// Detached logical snapshots keyed by the exact on-disk identity.  The
    /// advisory file lock still owns cross-process CAS correctness; this cache
    /// only removes the previous O(file-size) replay from every in-process
    /// append/load/checkpoint.
    cache: Arc<StdMutex<HashMap<PathBuf, CachedFile>>>,
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

#[derive(Clone, Debug)]
struct LoadedFile {
    session: Session,
    /// Prefix known to contain only accepted records.
    valid_len: u64,
    /// The accepted final record had no newline terminator.
    needs_separator: bool,
}

#[derive(Clone, Debug)]
struct CachedFile {
    fingerprint: FileFingerprint,
    loaded: LoadedFile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileFingerprint {
    dev: u64,
    ino: u64,
    len: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    sample_hash: u64,
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
            cache: Arc::new(StdMutex::new(HashMap::new())),
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
        let cache = Arc::clone(&self.cache);
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
            let mut file = match secure_open_options()
                .write(true)
                .create_new(true)
                .open(&path)
            {
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
            let fingerprint = file_fingerprint(&path)?.ok_or_else(|| {
                backend_message(format!(
                    "session {} disappeared after creation",
                    path.display()
                ))
            })?;
            cache_store(
                &cache,
                &path,
                fingerprint,
                LoadedFile {
                    session: session.clone(),
                    valid_len: fingerprint.len,
                    needs_separator: false,
                },
            )?;
            Ok(session)
        })
        .await
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        let owned_id = session_id.to_owned();
        let (path, guard) = self.locked_path(session_id).await?;
        let cache = Arc::clone(&self.cache);
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            load_file_cached(&path, &owned_id, &cache)
                .map(|loaded| loaded.map(|state| state.session))
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
        let cache = Arc::clone(&self.cache);
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            // Appends own the per-path process lock, so they can move the
            // cached snapshot out instead of cloning a potentially huge
            // Session before every stream checkpoint. A failed append may
            // simply leave the cache cold; the next operation reparses the
            // authoritative file under the same advisory lock.
            let Some(mut loaded) = take_file_cached(&path, &owned_id, &cache)? else {
                return Err(StoreError::NotFound {
                    session_id: owned_id,
                });
            };

            let actual_revision = loaded.session.revision();
            if actual_revision != expected_revision {
                let fingerprint = file_fingerprint(&path)?.ok_or_else(|| {
                    backend_message(format!(
                        "session {} disappeared during revision check",
                        path.display()
                    ))
                })?;
                cache_store(&cache, &path, fingerprint, loaded)?;
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
                let fingerprint = file_fingerprint(&path)?.ok_or_else(|| {
                    backend_message(format!(
                        "session {} disappeared during empty append",
                        path.display()
                    ))
                })?;
                cache_store(&cache, &path, fingerprint, loaded)?;
                return Ok(receipt);
            }

            let record = BatchRecord {
                record: BATCH_RECORD.to_owned(),
                previous_revision: receipt.previous_revision,
                revision: receipt.revision,
                events: receipt.events.clone(),
            };
            let bytes = encode_line(&record, &path)?;
            let mut file = secure_open_options()
                .read(true)
                .append(true)
                .open(&path)
                .map_err(|error| backend_error("open session for append", &path, error))?;
            ensure_regular_file(&file, &path, "session log")?;

            let current_len = file
                .metadata()
                .map_err(|error| backend_error("inspect session before append", &path, error))?
                .len();
            if current_len != loaded.valid_len {
                truncate_torn_tail(&path, loaded.valid_len)?;
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
            let fingerprint = fingerprint_from_metadata(
                &path,
                &file
                    .metadata()
                    .map_err(|error| backend_error("inspect appended session", &path, error))?,
            )?;
            loaded.valid_len = fingerprint.len;
            loaded.needs_separator = false;
            cache_store(&cache, &path, fingerprint, loaded)?;
            Ok(receipt)
        })
        .await
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        let owned_id = session_id.to_owned();
        let (path, guard) = self.locked_path(session_id).await?;
        let cache = Arc::clone(&self.cache);
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            let Some(loaded) = take_file_cached(&path, &owned_id, &cache)? else {
                return Err(StoreError::NotFound {
                    session_id: owned_id,
                });
            };
            let file = secure_open_options()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| {
                    backend_error("open session for durability flush", &path, error)
                })?;
            ensure_regular_file(&file, &path, "session log")?;
            file.sync_all()
                .map_err(|error| backend_error("sync session data", &path, error))?;
            sync_parent_directory(&path)?;
            let fingerprint = fingerprint_from_metadata(
                &path,
                &file
                    .metadata()
                    .map_err(|error| backend_error("inspect flushed session", &path, error))?,
            )?;
            let revision = loaded.session.revision();
            cache_store(&cache, &path, fingerprint, loaded)?;
            Ok(revision)
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
    let file = secure_open_options()
        .read(true)
        .write(true)
        .create(true)
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

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| backend_message(format!("session path {} has no parent", path.display())))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| backend_error("sync session directory", parent, error))
}

#[cfg(windows)]
fn sync_parent_directory(path: &Path) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| backend_message(format!("session path {} has no parent", path.display())))?;
    if fs::metadata(parent)
        .map_err(|error| backend_error("inspect session directory", parent, error))?
        .is_dir()
    {
        Ok(())
    } else {
        Err(backend_message(format!(
            "session directory {} is not a directory",
            parent.display()
        )))
    }
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

fn load_file_cached(
    path: &Path,
    session_id: &str,
    cache: &StdMutex<HashMap<PathBuf, CachedFile>>,
) -> Result<Option<LoadedFile>, StoreError> {
    let Some(fingerprint) = file_fingerprint(path)? else {
        cache_remove(cache, path)?;
        return Ok(None);
    };
    if let Some(loaded) = cache
        .lock()
        .map_err(|_| backend_message("session snapshot cache is poisoned"))?
        .get(path)
        .filter(|entry| entry.fingerprint == fingerprint)
        .map(|entry| entry.loaded.clone())
    {
        return Ok(Some(loaded));
    }

    let loaded = load_file(path, session_id)?;
    let Some(loaded) = loaded else {
        cache_remove(cache, path)?;
        return Ok(None);
    };
    // A cooperating writer cannot mutate the file while the caller holds the
    // advisory lock. Re-read metadata after parsing so a non-cooperating
    // replacement never poisons the cache with a stale identity.
    let fingerprint = file_fingerprint(path)?.ok_or_else(|| {
        backend_message(format!(
            "session {} disappeared while loading",
            path.display()
        ))
    })?;
    cache_store(cache, path, fingerprint, loaded.clone())?;
    Ok(Some(loaded))
}

fn take_file_cached(
    path: &Path,
    session_id: &str,
    cache: &StdMutex<HashMap<PathBuf, CachedFile>>,
) -> Result<Option<LoadedFile>, StoreError> {
    let Some(fingerprint) = file_fingerprint(path)? else {
        cache_remove(cache, path)?;
        return Ok(None);
    };
    if let Some(loaded) = cache
        .lock()
        .map_err(|_| backend_message("session snapshot cache is poisoned"))?
        .remove(path)
        .filter(|entry| entry.fingerprint == fingerprint)
        .map(|entry| entry.loaded)
    {
        return Ok(Some(loaded));
    }

    load_file(path, session_id)
}

fn cache_store(
    cache: &StdMutex<HashMap<PathBuf, CachedFile>>,
    path: &Path,
    fingerprint: FileFingerprint,
    loaded: LoadedFile,
) -> Result<(), StoreError> {
    cache
        .lock()
        .map_err(|_| backend_message("session snapshot cache is poisoned"))?
        .insert(
            path.to_owned(),
            CachedFile {
                fingerprint,
                loaded,
            },
        );
    Ok(())
}

fn cache_remove(
    cache: &StdMutex<HashMap<PathBuf, CachedFile>>,
    path: &Path,
) -> Result<(), StoreError> {
    cache
        .lock()
        .map_err(|_| backend_message("session snapshot cache is poisoned"))?
        .remove(path);
    Ok(())
}

fn file_fingerprint(path: &Path) -> Result<Option<FileFingerprint>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(backend_error("inspect session path", path, error)),
    };
    fingerprint_from_metadata(path, &metadata).map(Some)
}

fn fingerprint_from_metadata(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<FileFingerprint, StoreError> {
    if metadata.file_type().is_symlink() {
        return Err(corrupt(path, 1, "session path must not be a symbolic link"));
    }
    if !metadata.is_file() {
        return Err(corrupt(path, 1, "session path is not a regular file"));
    }
    #[cfg(unix)]
    let identity = (
        metadata.dev(),
        metadata.ino(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    );
    #[cfg(windows)]
    let identity = {
        let modified = system_time_parts(metadata.modified());
        let created = system_time_parts(metadata.created());
        (0, 0, modified.0, modified.1, created.0, created.1)
    };
    Ok(FileFingerprint {
        dev: identity.0,
        ino: identity.1,
        len: metadata.len(),
        modified_seconds: identity.2,
        modified_nanoseconds: identity.3,
        changed_seconds: identity.4,
        changed_nanoseconds: identity.5,
        sample_hash: sample_file_hash(path, metadata.len())?,
    })
}

#[cfg(windows)]
fn system_time_parts(value: std::io::Result<SystemTime>) -> (i64, i64) {
    let Ok(value) = value else {
        return (0, 0);
    };
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => (
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
            i64::from(duration.subsec_nanos()),
        ),
        Err(error) => {
            let duration = error.duration();
            (
                -i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
                -i64::from(duration.subsec_nanos()),
            )
        }
    }
}

/// Metadata catches normal cooperating appends in O(1). A small positional
/// sample also invalidates rapid same-length rewrites on filesystems whose
/// timestamp granularity cannot distinguish two writes. Sampling remains
/// bounded (at most 12 KiB) and therefore cannot regress into full-log replay.
fn sample_file_hash(path: &Path, len: u64) -> Result<u64, StoreError> {
    let file = secure_open_options()
        .read(true)
        .open(path)
        .map_err(|error| backend_error("open session fingerprint sample", path, error))?;
    ensure_regular_file(&file, path, "session log")?;
    let sample_len = u64::try_from(FINGERPRINT_SAMPLE_BYTES).expect("sample size fits in u64");
    let offsets = [
        0,
        (len / 2).saturating_sub(sample_len / 2),
        len.saturating_sub(sample_len),
    ];
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut buffer = [0u8; FINGERPRINT_SAMPLE_BYTES];
    for offset in offsets {
        for byte in offset.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        let count = read_file_at(&file, &mut buffer, offset)
            .map_err(|error| backend_error("read session fingerprint sample", path, error))?;
        for byte in &buffer[..count] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        hash ^= u64::try_from(count).expect("sample count fits in u64");
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    Ok(hash)
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

    let mut file = match secure_open_options().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(backend_error("open session", path, error)),
    };
    ensure_regular_file(&file, path, "session log")?;

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
    let header = header_record.header;

    if !header_terminated {
        return Ok(LoadedFile {
            session: Session::new(header).map_err(StoreError::from)?,
            valid_len: bytes.len() as u64,
            needs_separator: true,
        });
    }

    let mut revision = Revision::ZERO;
    let mut events = Vec::new();
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
                extend_batch_record(path, line_number, &mut revision, &mut events, record)?;
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

    // Validate the complete logical cut exactly once. Replaying every JSONL
    // batch through Session::append_batch_at revalidated the full prefix for
    // each line and made cold restore quadratic in the number of checkpoints.
    let session = Session::restore(header, revision, events).map_err(|error| {
        corrupt(
            path,
            line_number.saturating_sub(1),
            format!("invalid event log: {error}"),
        )
    })?;
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

fn extend_batch_record(
    path: &Path,
    line_number: usize,
    revision: &mut Revision,
    events: &mut Vec<LoggedEvent>,
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
    if record.previous_revision != *revision {
        return Err(corrupt(
            path,
            line_number,
            format!(
                "batch previous revision {:?} is not continuous from {:?}",
                record.previous_revision, revision
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

    events.extend(record.events);
    *revision = record.revision;
    Ok(())
}

fn backend_error(action: &str, path: &Path, error: std::io::Error) -> StoreError {
    backend_message(format!("{action} {}: {error}", path.display()))
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

fn truncate_torn_tail(path: &Path, valid_len: u64) -> Result<(), StoreError> {
    // Windows append-only handles have FILE_APPEND_DATA but not the
    // FILE_WRITE_DATA access required by SetEndOfFile. Keep the append handle
    // open for append semantics and use a short-lived writable handle for
    // crash-tail repair. The per-path and inter-process locks serialize all
    // cooperating writers around both operations.
    let file = secure_open_options()
        .write(true)
        .open(path)
        .map_err(|error| backend_error("open session for tail repair", path, error))?;
    ensure_regular_file(&file, path, "session log")?;
    file.set_len(valid_len)
        .map_err(|error| backend_error("truncate torn session tail", path, error))
}

fn ensure_regular_file(file: &File, path: &Path, label: &str) -> Result<(), StoreError> {
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

#[cfg(unix)]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    file.read_at(buffer, offset)
}

#[cfg(windows)]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    file.seek_read(buffer, offset)
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
