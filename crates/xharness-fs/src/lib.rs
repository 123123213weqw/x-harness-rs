//! Workspace-confined filesystem operations with observed-write CAS.
//!
//! Callers first resolve an input path into an opaque [`FsTarget`]. Reads
//! record a strong version per `(session, target)`; replacement writes and
//! literal edits fail closed unless that observation is still current. New
//! files use an atomic no-replace publish. Every write uses a same-directory
//! temporary file, file `fsync`, an atomic platform rename, and directory
//! `fsync`.
//! Per-target locks make observation CAS strong among clones of one
//! [`FsService`]. Replacement races from non-cooperating external writers are
//! detected immediately before publication on a best-effort basis; Linux does
//! not provide a content-version compare-and-rename primitive.

use std::{
    collections::HashMap,
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
};

#[cfg(unix)]
use nix::{
    errno::Errno,
    fcntl::{open, openat, OFlag},
    sys::stat::{fchmod, fstat, Mode},
    unistd::{fsync, unlinkat, UnlinkatFlags},
};
#[cfg(target_os = "macos")]
use nix::{
    fcntl::{fcntl, FcntlArg},
    libc,
};
#[cfg(target_os = "linux")]
use nix::{
    fcntl::{openat2, OpenHow, ResolveFlag},
    libc,
};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::{fs::OpenOptions, os::windows::ffi::OsStrExt};
#[cfg(unix)]
use std::{
    os::fd::{AsRawFd, OwnedFd},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
#[cfg(windows)]
use xharness_win32::{copy_dacl, replace_file};

#[cfg(unix)]
type DirectoryAnchor = OwnedFd;

#[cfg(windows)]
#[derive(Debug)]
struct DirectoryAnchor {
    canonical: PathBuf,
}

static NEXT_SERVICE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

/// Opaque target identity used by observations. Its representation is not a
/// path and cannot be used to select another file.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FsTargetKey(String);

impl FsTargetKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A workspace-relative file capability. Fields are private so callers cannot
/// forge a path after validation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsTarget {
    key: FsTargetKey,
    display: String,
}

impl FsTarget {
    pub const fn key(&self) -> &FsTargetKey {
        &self.key
    }

    pub fn display(&self) -> &str {
        &self.display
    }
}

/// Strong file identity and content version.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FsVersion {
    device: u64,
    inode: u64,
    len: u64,
    modified_sec: i64,
    modified_nsec: i64,
    changed_sec: i64,
    changed_nsec: i64,
    sha256: [u8; 32],
}

impl FsVersion {
    pub const fn len(&self) -> u64 {
        self.len
    }

    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub const fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }

    pub fn sha256_hex(&self) -> String {
        encode_sha256(&self.sha256)
    }
}

fn encode_sha256(digest: &[u8; 32]) -> String {
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn decode_sha256(value: &str) -> Option<[u8; 32]> {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let mut output = [0u8; 32];
    for (index, slot) in output.iter_mut().enumerate() {
        let start = index * 2;
        *slot = decode_hex_nibble(bytes[start])?
            .checked_mul(16)?
            .checked_add(decode_hex_nibble(bytes[start + 1])?)?;
    }
    Some(output)
}

fn decode_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observation {
    Version(FsVersion),
    Absent,
}

/// In-process observations keyed by `(session_id, target_key)`.
#[derive(Clone, Default)]
pub struct ObservationStore {
    inner: Arc<StdMutex<HashMap<(String, FsTargetKey), Observation>>>,
}

impl ObservationStore {
    pub fn get(
        &self,
        session_id: &str,
        target_key: &FsTargetKey,
    ) -> Result<Option<Observation>, FsError> {
        validate_session_id(session_id)?;
        Ok(self
            .inner
            .lock()
            .map_err(|_| FsError::ObservationStorePoisoned)?
            .get(&(session_id.to_owned(), target_key.clone()))
            .cloned())
    }

    fn record(
        &self,
        session_id: &str,
        target_key: &FsTargetKey,
        observation: Observation,
    ) -> Result<(), FsError> {
        validate_session_id(session_id)?;
        self.inner
            .lock()
            .map_err(|_| FsError::ObservationStorePoisoned)?
            .insert((session_id.to_owned(), target_key.clone()), observation);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadLimits {
    pub max_bytes: usize,
    pub max_lines: usize,
    pub max_line_bytes: usize,
}

/// Version-bound continuation for a paged read. The cursor is opaque to the
/// model-facing tool: its embedded content hash prevents stitching pages from
/// different file versions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadCursor {
    offset: u64,
    sha256: [u8; 32],
    limits: ReadLimits,
}

impl ReadCursor {
    pub const fn offset(&self) -> u64 {
        self.offset
    }

    pub const fn limits(&self) -> ReadLimits {
        self.limits
    }

    pub fn encode(&self) -> String {
        format!(
            "v1:{}:{}:{}:{}:{}",
            self.offset,
            self.limits.max_bytes,
            self.limits.max_lines,
            self.limits.max_line_bytes,
            encode_sha256(&self.sha256)
        )
    }

    pub fn parse(value: &str) -> Result<Self, FsError> {
        let mut parts = value.split(':');
        if parts.next() != Some("v1") {
            return Err(FsError::InvalidReadCursor);
        }
        let offset = parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(FsError::InvalidReadCursor)?;
        let max_bytes = parse_cursor_usize(parts.next())?;
        let max_lines = parse_cursor_usize(parts.next())?;
        let max_line_bytes = parse_cursor_usize(parts.next())?;
        let sha256 = parts
            .next()
            .and_then(decode_sha256)
            .ok_or(FsError::InvalidReadCursor)?;
        if parts.next().is_some() {
            return Err(FsError::InvalidReadCursor);
        }
        if max_bytes == 0 || max_lines == 0 || max_line_bytes == 0 {
            return Err(FsError::InvalidReadCursor);
        }
        Ok(Self {
            offset,
            sha256,
            limits: ReadLimits {
                max_bytes,
                max_lines,
                max_line_bytes,
            },
        })
    }
}

fn parse_cursor_usize(value: Option<&str>) -> Result<usize, FsError> {
    value
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(FsError::InvalidReadCursor)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadStart {
    Byte(u64),
    Line(u64),
    Cursor(ReadCursor),
}

impl Default for ReadStart {
    fn default() -> Self {
        Self::Byte(0)
    }
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            max_bytes: 256 * 1024,
            max_lines: 2_000,
            max_line_bytes: 16 * 1024,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadDiagnostic {
    ByteLimit { limit: usize },
    LineLimit { limit: usize },
    LongLine { line: usize, limit: usize },
    InvalidUtf8 { offset: u64 },
    Utf8BoundaryTrimmed { bytes: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRead {
    pub text: String,
    pub version: FsVersion,
    pub bytes_read: u64,
    pub truncated: bool,
    pub diagnostics: Vec<ReadDiagnostic>,
    pub page_start_offset: u64,
    pub page_start_line: u64,
    pub captured_bytes: u64,
    pub total_bytes: u64,
    pub next_cursor: Option<ReadCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    File(Box<FileRead>),
    Absent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteOutcome {
    pub version: FsVersion,
    pub bytes_written: u64,
    pub created: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("session id must not be empty or contain NUL")]
    InvalidSessionId,
    #[error("invalid workspace path {display:?}: {reason}")]
    InvalidPath {
        display: String,
        reason: &'static str,
    },
    #[error("path {display:?} escapes workspace root {root}")]
    WorkspaceEscape { display: String, root: String },
    #[error("symbolic-link file targets are not permitted: {display:?}")]
    SymlinkTarget { display: String },
    #[error("target is not a regular file: {display:?}")]
    NotRegularFile { display: String },
    #[error("unknown or foreign filesystem target key {0:?}")]
    UnknownTarget(String),
    #[error("refusing to overwrite unread file {display:?}")]
    BlindOverwrite { display: String },
    #[error("filesystem observation for {display:?} is stale")]
    StaleObservation { display: String },
    #[error("file {display:?} was not found")]
    NotFound { display: String },
    #[error("literal edit search must not be empty")]
    EmptyLiteral,
    #[error("literal edit in {display:?} requires exactly one match; found {count}")]
    LiteralMatchCount { display: String, count: usize },
    #[error("literal edit requires UTF-8 text in {display:?}; invalid byte at {offset}")]
    EditInvalidUtf8 { display: String, offset: usize },
    #[error("file changed while it was being inspected: {display:?}")]
    ConcurrentModification { display: String },
    #[error("invalid read range: line numbers are one-based")]
    InvalidReadRange,
    #[error("invalid or unsupported read cursor")]
    InvalidReadCursor,
    #[error("read cursor is stale because the file content changed: {display:?}")]
    StaleReadCursor { display: String },
    #[error("observation store lock is poisoned")]
    ObservationStorePoisoned,
    #[error("filesystem worker stopped unexpectedly")]
    WorkerStopped,
    #[error("filesystem {operation} failed for {path}: {source}")]
    Io {
        operation: &'static str,
        path: String,
        #[source]
        source: io::Error,
    },
}

#[derive(Clone)]
pub struct FsService {
    inner: Arc<ServiceInner>,
}

struct ServiceInner {
    root: PathBuf,
    root_fd: Arc<DirectoryAnchor>,
    service_id: u64,
    next_target_id: AtomicU64,
    targets: StdMutex<TargetRegistry>,
    observations: ObservationStore,
}

#[derive(Default)]
struct TargetRegistry {
    by_key: HashMap<FsTargetKey, TargetRecord>,
    by_relative: HashMap<PathBuf, FsTargetKey>,
}

#[derive(Clone)]
struct TargetRecord {
    relative: PathBuf,
    display: String,
    lock: Arc<AsyncMutex<()>>,
}

struct PhysicalTarget {
    parent: PathBuf,
    parent_fd: Arc<DirectoryAnchor>,
    parent_device: u64,
    parent_inode: u64,
    file_name: OsString,
    path: PathBuf,
    display: String,
}

impl FsService {
    pub fn new(workspace_root: impl AsRef<Path>) -> Result<Self, FsError> {
        Self::with_observations(workspace_root, ObservationStore::default())
    }

    pub fn with_observations(
        workspace_root: impl AsRef<Path>,
        observations: ObservationStore,
    ) -> Result<Self, FsError> {
        let requested = workspace_root.as_ref();
        let root = fs::canonicalize(requested)
            .map_err(|source| io_error("canonicalize workspace root", requested, source))?;
        if !fs::metadata(&root)
            .map_err(|source| io_error("inspect workspace root", &root, source))?
            .is_dir()
        {
            return Err(FsError::InvalidPath {
                display: requested.to_string_lossy().into_owned(),
                reason: "workspace root is not a directory",
            });
        }
        #[cfg(unix)]
        let root_fd = open(
            &root,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| nix_io_error("open workspace root", &root, error))?;
        #[cfg(unix)]
        {
            let opened_root = canonical_fd_path(&root_fd, "verify workspace root", &root)?;
            if opened_root != root {
                return Err(FsError::ConcurrentModification {
                    display: requested.to_string_lossy().into_owned(),
                });
            }
        }
        #[cfg(windows)]
        let root_fd = DirectoryAnchor {
            canonical: root.clone(),
        };
        Ok(Self {
            inner: Arc::new(ServiceInner {
                root,
                root_fd: Arc::new(root_fd),
                service_id: NEXT_SERVICE_ID.fetch_add(1, Ordering::Relaxed),
                next_target_id: AtomicU64::new(1),
                targets: StdMutex::new(TargetRegistry::default()),
                observations,
            }),
        })
    }

    pub fn workspace_root(&self) -> &Path {
        &self.inner.root
    }

    pub fn observations(&self) -> &ObservationStore {
        &self.inner.observations
    }

    /// Resolve a workspace-relative input into an opaque file capability.
    pub fn resolve(&self, input: impl AsRef<Path>) -> Result<FsTarget, FsError> {
        let relative = normalize_relative(input.as_ref())?;
        let display = relative.to_string_lossy().into_owned();
        let provisional = TargetRecord {
            relative: relative.clone(),
            display: display.clone(),
            lock: Arc::new(AsyncMutex::new(())),
        };
        // Validate current parent containment and the existing target shape.
        let physical =
            physical_target(&self.inner.root, self.inner.root_fd.as_ref(), &provisional)?;
        validate_existing_shape(&self.inner.root, &physical)?;

        let mut targets = self
            .inner
            .targets
            .lock()
            .map_err(|_| FsError::ObservationStorePoisoned)?;
        if let Some(key) = targets.by_relative.get(&relative) {
            return Ok(FsTarget {
                key: key.clone(),
                display,
            });
        }
        let target_id = self.inner.next_target_id.fetch_add(1, Ordering::Relaxed);
        let key = FsTargetKey(format!("{:016x}-{:016x}", self.inner.service_id, target_id));
        targets.by_key.insert(key.clone(), provisional);
        targets.by_relative.insert(relative, key.clone());
        Ok(FsTarget { key, display })
    }

    pub async fn read(
        &self,
        session_id: &str,
        target: &FsTarget,
        limits: ReadLimits,
    ) -> Result<ReadOutcome, FsError> {
        self.read_page(session_id, target, ReadStart::default(), limits)
            .await
    }

    pub async fn read_page(
        &self,
        session_id: &str,
        target: &FsTarget,
        start: ReadStart,
        limits: ReadLimits,
    ) -> Result<ReadOutcome, FsError> {
        validate_session_id(session_id)?;
        let (record, guard) = self.lock_target(target).await?;
        let root = self.inner.root.clone();
        let root_fd = self.inner.root_fd.clone();
        let observations = self.inner.observations.clone();
        let session_id = session_id.to_owned();
        let key = target.key.clone();
        run_blocking(move || {
            let _guard = guard;
            let physical = physical_target(&root, root_fd.as_ref(), &record)?;
            match scan_limited(&root, &physical, start, limits)? {
                Some(read) => {
                    observations.record(
                        &session_id,
                        &key,
                        Observation::Version(read.version.clone()),
                    )?;
                    Ok(ReadOutcome::File(Box::new(read)))
                }
                None => {
                    observations.record(&session_id, &key, Observation::Absent)?;
                    Ok(ReadOutcome::Absent)
                }
            }
        })
        .await
    }

    /// Create an absent file, or replace a file whose current version was
    /// observed by this session. Blind overwrite and stale observations fail.
    /// CAS is strong among calls through clones of this service. Changes by
    /// non-cooperating external writers are rechecked immediately before the
    /// rename, but that final external check is necessarily best-effort.
    pub async fn write(
        &self,
        session_id: &str,
        target: &FsTarget,
        content: impl Into<Vec<u8>>,
    ) -> Result<WriteOutcome, FsError> {
        validate_session_id(session_id)?;
        let content = content.into();
        let (record, guard) = self.lock_target(target).await?;
        let root = self.inner.root.clone();
        let root_fd = self.inner.root_fd.clone();
        let observations = self.inner.observations.clone();
        let session_id = session_id.to_owned();
        let key = target.key.clone();
        run_blocking(move || {
            let _guard = guard;
            let physical = physical_target(&root, root_fd.as_ref(), &record)?;
            let current = current_version(&root, &physical)?;
            let observed = observations.get(&session_id, &key)?;
            let mode = authorize_write(&record.display, observed.as_ref(), current.as_ref())?;
            let outcome = atomic_publish(
                &root,
                root_fd.as_ref(),
                &record,
                &physical,
                current.as_ref(),
                mode,
                &content,
            )?;
            observations.record(
                &session_id,
                &key,
                Observation::Version(outcome.version.clone()),
            )?;
            Ok(outcome)
        })
        .await
    }

    /// Replace one uniquely matching literal in a previously observed UTF-8
    /// file, using the same version CAS and atomic publication as [`write`].
    pub async fn edit_literal(
        &self,
        session_id: &str,
        target: &FsTarget,
        old: impl Into<String>,
        new: impl Into<String>,
    ) -> Result<WriteOutcome, FsError> {
        validate_session_id(session_id)?;
        let old = old.into();
        if old.is_empty() {
            return Err(FsError::EmptyLiteral);
        }
        let new = new.into();
        let (record, guard) = self.lock_target(target).await?;
        let root = self.inner.root.clone();
        let root_fd = self.inner.root_fd.clone();
        let observations = self.inner.observations.clone();
        let session_id = session_id.to_owned();
        let key = target.key.clone();
        run_blocking(move || {
            let _guard = guard;
            let physical = physical_target(&root, root_fd.as_ref(), &record)?;
            let current = current_version(&root, &physical)?.ok_or_else(|| FsError::NotFound {
                display: record.display.clone(),
            })?;
            let observed = observations.get(&session_id, &key)?;
            match observed.as_ref() {
                Some(Observation::Version(version)) if version == &current => {}
                None => {
                    return Err(FsError::BlindOverwrite {
                        display: record.display.clone(),
                    });
                }
                _ => {
                    return Err(FsError::StaleObservation {
                        display: record.display.clone(),
                    });
                }
            }

            let (bytes, scanned_version) = read_full(&root, &physical)?;
            if scanned_version != current {
                return Err(FsError::ConcurrentModification {
                    display: record.display.clone(),
                });
            }
            let text = std::str::from_utf8(&bytes).map_err(|error| FsError::EditInvalidUtf8 {
                display: record.display.clone(),
                offset: error.valid_up_to(),
            })?;
            let count = text.match_indices(&old).count();
            if count != 1 {
                return Err(FsError::LiteralMatchCount {
                    display: record.display.clone(),
                    count,
                });
            }
            let replacement = text.replacen(&old, &new, 1).into_bytes();
            let outcome = atomic_publish(
                &root,
                root_fd.as_ref(),
                &record,
                &physical,
                Some(&current),
                PublishMode::Replace,
                &replacement,
            )?;
            observations.record(
                &session_id,
                &key,
                Observation::Version(outcome.version.clone()),
            )?;
            Ok(outcome)
        })
        .await
    }

    async fn lock_target(
        &self,
        target: &FsTarget,
    ) -> Result<(TargetRecord, OwnedMutexGuard<()>), FsError> {
        let record = self
            .inner
            .targets
            .lock()
            .map_err(|_| FsError::ObservationStorePoisoned)?
            .by_key
            .get(&target.key)
            .cloned()
            .ok_or_else(|| FsError::UnknownTarget(target.key.0.clone()))?;
        let guard = record.lock.clone().lock_owned().await;
        Ok((record, guard))
    }
}

async fn run_blocking<T, F>(operation: F) -> Result<T, FsError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FsError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| FsError::WorkerStopped)?
}

fn validate_session_id(session_id: &str) -> Result<(), FsError> {
    if session_id.is_empty() || session_id.as_bytes().contains(&0) {
        Err(FsError::InvalidSessionId)
    } else {
        Ok(())
    }
}

fn normalize_relative(input: &Path) -> Result<PathBuf, FsError> {
    let display = input.to_string_lossy().into_owned();
    #[cfg(unix)]
    let contains_nul = input.as_os_str().as_bytes().contains(&0);
    #[cfg(windows)]
    let contains_nul = input.as_os_str().encode_wide().any(|unit| unit == 0);
    if contains_nul {
        return Err(FsError::InvalidPath {
            display,
            reason: "NUL byte",
        });
    }
    let mut normalized = PathBuf::new();
    for component in input.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(FsError::InvalidPath {
                    display,
                    reason: "parent traversal",
                });
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(FsError::InvalidPath {
                    display,
                    reason: "absolute path",
                });
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(FsError::InvalidPath {
            display,
            reason: "empty file path",
        });
    }
    Ok(normalized)
}

#[cfg(unix)]
fn physical_target(
    root: &Path,
    root_fd: &OwnedFd,
    record: &TargetRecord,
) -> Result<PhysicalTarget, FsError> {
    let relative_parent = record.relative.parent().unwrap_or_else(|| Path::new(""));
    let logical_parent = root.join(relative_parent);
    let expected_parent = fs::canonicalize(&logical_parent)
        .map_err(|source| io_error("canonicalize target parent", &logical_parent, source))?;
    ensure_contained(root, &expected_parent, &record.display)?;
    let relative_open = if relative_parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        relative_parent
    };
    let parent_fd = open_parent_beneath(
        root,
        root_fd,
        relative_open,
        &logical_parent,
        &record.display,
    )?;
    let parent = canonical_fd_path(&parent_fd, "verify target parent", &logical_parent)?;
    ensure_contained(root, &parent, &record.display)?;
    if parent != expected_parent {
        return Err(FsError::ConcurrentModification {
            display: record.display.clone(),
        });
    }
    let parent_stat =
        fstat(&parent_fd).map_err(|error| nix_io_error("fstat target parent", &parent, error))?;
    #[cfg(target_os = "linux")]
    let parent_device = parent_stat.st_dev;
    #[cfg(target_os = "macos")]
    let parent_device = u64::try_from(parent_stat.st_dev).map_err(|_| {
        io_error(
            "normalize target parent device id",
            &parent,
            io::Error::new(io::ErrorKind::InvalidData, "negative device id"),
        )
    })?;
    let parent_inode = parent_stat.st_ino;
    let file_name = record
        .relative
        .file_name()
        .ok_or_else(|| FsError::InvalidPath {
            display: record.display.clone(),
            reason: "missing file name",
        })?
        .to_owned();
    let path = parent.join(&file_name);
    Ok(PhysicalTarget {
        parent,
        parent_fd: Arc::new(parent_fd),
        parent_device,
        parent_inode,
        file_name,
        path,
        display: record.display.clone(),
    })
}

#[cfg(windows)]
fn physical_target(
    root: &Path,
    _root_fd: &DirectoryAnchor,
    record: &TargetRecord,
) -> Result<PhysicalTarget, FsError> {
    let relative_parent = record.relative.parent().unwrap_or_else(|| Path::new(""));
    let logical_parent = root.join(relative_parent);
    let parent = fs::canonicalize(&logical_parent)
        .map_err(|source| io_error("canonicalize target parent", &logical_parent, source))?;
    ensure_contained(root, &parent, &record.display)?;
    let metadata = fs::metadata(&parent)
        .map_err(|source| io_error("inspect target parent", &parent, source))?;
    if !metadata.is_dir() {
        return Err(FsError::InvalidPath {
            display: record.display.clone(),
            reason: "target parent is not a directory",
        });
    }
    let file_name = record
        .relative
        .file_name()
        .ok_or_else(|| FsError::InvalidPath {
            display: record.display.clone(),
            reason: "missing file name",
        })?
        .to_owned();
    let parent_inode = windows_path_identity(&parent);
    let path = parent.join(&file_name);
    Ok(PhysicalTarget {
        parent: parent.clone(),
        parent_fd: Arc::new(DirectoryAnchor { canonical: parent }),
        parent_device: 0,
        parent_inode,
        file_name,
        path,
        display: record.display.clone(),
    })
}

#[cfg(windows)]
fn windows_path_identity(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut hasher);
    hasher.finish()
}

#[cfg(target_os = "linux")]
fn open_parent_beneath(
    root: &Path,
    root_fd: &OwnedFd,
    relative: &Path,
    logical_parent: &Path,
    display: &str,
) -> Result<OwnedFd, FsError> {
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
        .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_MAGICLINKS);
    match openat2(root_fd, relative, how) {
        Ok(fd) => Ok(fd),
        Err(Errno::EXDEV | Errno::ELOOP) => Err(FsError::WorkspaceEscape {
            display: display.to_owned(),
            root: root.display().to_string(),
        }),
        Err(error) => Err(nix_io_error(
            "open target parent beneath workspace",
            logical_parent,
            error,
        )),
    }
}

/// macOS has no `openat2(RESOLVE_BENEATH)`. Walk every component from the
/// already-open workspace directory and reject symlinks at each hop. The
/// resulting descriptor remains anchored even if another process renames a
/// parent after this function returns; the caller additionally compares its
/// canonical path and inode immediately before publication.
#[cfg(target_os = "macos")]
fn open_parent_beneath(
    root: &Path,
    root_fd: &OwnedFd,
    relative: &Path,
    logical_parent: &Path,
    display: &str,
) -> Result<OwnedFd, FsError> {
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    let mut current = openat(root_fd, Path::new("."), flags, Mode::empty())
        .map_err(|error| nix_io_error("duplicate workspace root descriptor", root, error))?;

    for component in relative.components() {
        let Component::Normal(name) = component else {
            if component == Component::CurDir {
                continue;
            }
            return Err(FsError::WorkspaceEscape {
                display: display.to_owned(),
                root: root.display().to_string(),
            });
        };
        current = match openat(&current, name, flags, Mode::empty()) {
            Ok(next) => next,
            Err(Errno::ELOOP) => {
                return Err(FsError::WorkspaceEscape {
                    display: display.to_owned(),
                    root: root.display().to_string(),
                });
            }
            Err(error) => {
                return Err(nix_io_error(
                    "open target parent beneath workspace",
                    logical_parent,
                    error,
                ));
            }
        };
    }
    Ok(current)
}

#[cfg(unix)]
fn ensure_contained(root: &Path, candidate: &Path, display: &str) -> Result<(), FsError> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(FsError::WorkspaceEscape {
            display: display.to_owned(),
            root: root.display().to_string(),
        })
    }
}

#[cfg(windows)]
fn ensure_contained(root: &Path, candidate: &Path, display: &str) -> Result<(), FsError> {
    let mut root_components = root.components();
    let mut candidate_components = candidate.components();
    let contained = root_components.all(|expected| {
        candidate_components.next().is_some_and(|actual| {
            expected
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&actual.as_os_str().to_string_lossy())
        })
    });
    if contained {
        Ok(())
    } else {
        Err(FsError::WorkspaceEscape {
            display: display.to_owned(),
            root: root.display().to_string(),
        })
    }
}

fn validate_existing_shape(root: &Path, target: &PhysicalTarget) -> Result<(), FsError> {
    open_regular_contained(root, target).map(|_| ())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MetadataStamp {
    device: u64,
    inode: u64,
    len: u64,
    modified_sec: i64,
    modified_nsec: i64,
    changed_sec: i64,
    changed_nsec: i64,
}

impl MetadataStamp {
    #[cfg(unix)]
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified_sec: metadata.mtime(),
            modified_nsec: metadata.mtime_nsec(),
            changed_sec: metadata.ctime(),
            changed_nsec: metadata.ctime_nsec(),
        }
    }

    #[cfg(windows)]
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        use std::time::UNIX_EPOCH;

        fn split_time(value: io::Result<std::time::SystemTime>) -> (i64, i64) {
            let duration = value
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .unwrap_or_default();
            (
                i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
                i64::from(duration.subsec_nanos()),
            )
        }

        let (modified_sec, modified_nsec) = split_time(metadata.modified());
        let (changed_sec, changed_nsec) = split_time(metadata.created());
        Self {
            device: 0,
            inode: 0,
            len: metadata.len(),
            modified_sec,
            modified_nsec,
            changed_sec,
            changed_nsec,
        }
    }

    fn into_version(self, sha256: [u8; 32]) -> FsVersion {
        FsVersion {
            device: self.device,
            inode: self.inode,
            len: self.len,
            modified_sec: self.modified_sec,
            modified_nsec: self.modified_nsec,
            changed_sec: self.changed_sec,
            changed_nsec: self.changed_nsec,
            sha256,
        }
    }
}

#[cfg(unix)]
fn open_regular_contained(root: &Path, target: &PhysicalTarget) -> Result<Option<File>, FsError> {
    let file_fd = open_file_beneath(target)?;
    let Some(file_fd) = file_fd else {
        return Ok(None);
    };
    let opened = canonical_fd_path(&file_fd, "verify opened target", &target.path)?;
    ensure_contained(root, &opened, &target.display)?;
    let file = File::from(file_fd);
    let metadata = file
        .metadata()
        .map_err(|source| io_error("inspect opened target", &target.path, source))?;
    if !metadata.is_file() {
        return Err(FsError::NotRegularFile {
            display: target.display.clone(),
        });
    }
    Ok(Some(file))
}

#[cfg(windows)]
fn open_regular_contained(root: &Path, target: &PhysicalTarget) -> Result<Option<File>, FsError> {
    let metadata = match fs::symlink_metadata(&target.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("inspect target", &target.path, source)),
    };
    if metadata.file_type().is_symlink() {
        return Err(FsError::SymlinkTarget {
            display: target.display.clone(),
        });
    }
    if !metadata.is_file() {
        return Err(FsError::NotRegularFile {
            display: target.display.clone(),
        });
    }
    let before = fs::canonicalize(&target.path)
        .map_err(|source| io_error("canonicalize target before open", &target.path, source))?;
    ensure_contained(root, &before, &target.display)?;
    let file =
        File::open(&target.path).map_err(|source| io_error("open target", &target.path, source))?;
    let after = fs::canonicalize(&target.path)
        .map_err(|source| io_error("canonicalize target after open", &target.path, source))?;
    ensure_contained(root, &after, &target.display)?;
    if before != after {
        return Err(FsError::ConcurrentModification {
            display: target.display.clone(),
        });
    }
    Ok(Some(file))
}

#[cfg(target_os = "linux")]
fn open_file_beneath(target: &PhysicalTarget) -> Result<Option<OwnedFd>, FsError> {
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW)
        .resolve(
            ResolveFlag::RESOLVE_BENEATH
                | ResolveFlag::RESOLVE_NO_MAGICLINKS
                | ResolveFlag::RESOLVE_NO_SYMLINKS,
        );
    let file_fd = match openat2(target.parent_fd.as_ref(), target.file_name.as_os_str(), how) {
        Ok(fd) => fd,
        Err(Errno::ENOENT) => return Ok(None),
        Err(Errno::ELOOP) => {
            return Err(FsError::SymlinkTarget {
                display: target.display.clone(),
            });
        }
        Err(error) => return Err(nix_io_error("open target", &target.path, error)),
    };
    Ok(Some(file_fd))
}

#[cfg(target_os = "macos")]
fn open_file_beneath(target: &PhysicalTarget) -> Result<Option<OwnedFd>, FsError> {
    let flags = OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    match openat(
        target.parent_fd.as_ref(),
        target.file_name.as_os_str(),
        flags,
        Mode::empty(),
    ) {
        Ok(fd) => Ok(Some(fd)),
        Err(Errno::ENOENT) => Ok(None),
        Err(Errno::ELOOP) => Err(FsError::SymlinkTarget {
            display: target.display.clone(),
        }),
        Err(error) => Err(nix_io_error("open target", &target.path, error)),
    }
}

fn current_version(root: &Path, target: &PhysicalTarget) -> Result<Option<FsVersion>, FsError> {
    let Some(mut file) = open_regular_contained(root, target)? else {
        return Ok(None);
    };
    let before = MetadataStamp::from_metadata(
        &file
            .metadata()
            .map_err(|source| io_error("inspect target before hashing", &target.path, source))?,
    );
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 32 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|source| io_error("hash target", &target.path, source))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let after = MetadataStamp::from_metadata(
        &file
            .metadata()
            .map_err(|source| io_error("inspect target after hashing", &target.path, source))?,
    );
    if before != after {
        return Err(FsError::ConcurrentModification {
            display: target.display.clone(),
        });
    }
    Ok(Some(after.into_version(digest.finalize().into())))
}

fn read_full(root: &Path, target: &PhysicalTarget) -> Result<(Vec<u8>, FsVersion), FsError> {
    let mut file = open_regular_contained(root, target)?.ok_or_else(|| FsError::NotFound {
        display: target.display.clone(),
    })?;
    let before = MetadataStamp::from_metadata(
        &file
            .metadata()
            .map_err(|source| io_error("inspect target before read", &target.path, source))?,
    );
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|source| io_error("read target", &target.path, source))?;
    let after = MetadataStamp::from_metadata(
        &file
            .metadata()
            .map_err(|source| io_error("inspect target after read", &target.path, source))?,
    );
    if before != after {
        return Err(FsError::ConcurrentModification {
            display: target.display.clone(),
        });
    }
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    Ok((bytes, after.into_version(digest)))
}

fn scan_limited(
    root: &Path,
    target: &PhysicalTarget,
    start: ReadStart,
    limits: ReadLimits,
) -> Result<Option<FileRead>, FsError> {
    if matches!(&start, ReadStart::Line(0)) {
        return Err(FsError::InvalidReadRange);
    }
    let limits = match &start {
        ReadStart::Cursor(cursor) => cursor.limits,
        _ => limits,
    };
    let Some(mut file) = open_regular_contained(root, target)? else {
        return Ok(None);
    };
    let before = MetadataStamp::from_metadata(
        &file
            .metadata()
            .map_err(|source| io_error("inspect target before read", &target.path, source))?,
    );
    let mut digest = Sha256::new();
    let mut capture = LimitedCapture::new(limits);
    let mut bytes_read = 0u64;
    let mut source_line = 1u64;
    let mut page_start = None;
    let mut buffer = [0u8; 32 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|source| io_error("read target", &target.path, source))?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(count as u64);
        digest.update(&buffer[..count]);
        let chunk_start = bytes_read.saturating_sub(count as u64);
        for (index, byte) in buffer[..count].iter().enumerate() {
            let source_offset = chunk_start.saturating_add(index as u64);
            let selected = match &start {
                ReadStart::Byte(offset) => source_offset >= *offset,
                ReadStart::Line(line) => source_line >= *line,
                ReadStart::Cursor(cursor) => source_offset >= cursor.offset,
            };
            if selected && !capture.stopped {
                page_start.get_or_insert((source_offset, source_line));
                capture.push_byte(*byte);
            }
            if *byte == b'\n' {
                source_line = source_line.saturating_add(1);
            }
        }
    }
    let after = MetadataStamp::from_metadata(
        &file
            .metadata()
            .map_err(|source| io_error("inspect target after read", &target.path, source))?,
    );
    if before != after {
        return Err(FsError::ConcurrentModification {
            display: target.display.clone(),
        });
    }
    let version = after.into_version(digest.finalize().into());
    if let ReadStart::Cursor(cursor) = &start {
        if cursor.sha256 != *version.sha256() {
            return Err(FsError::StaleReadCursor {
                display: target.display.clone(),
            });
        }
    }
    let (page_start_offset, page_start_line) = page_start.unwrap_or((bytes_read, source_line));
    let raw_captured_bytes = capture.bytes.len() as u64;
    let (text, mut utf8_diagnostics, captured_bytes) =
        decode_capture(capture.bytes, capture.stopped);
    capture.diagnostics.append(&mut utf8_diagnostics);
    let continuation_bytes = if captured_bytes == 0 {
        raw_captured_bytes
    } else {
        captured_bytes
    };
    let next_offset = page_start_offset.saturating_add(continuation_bytes);
    let next_cursor = (capture.stopped && next_offset < bytes_read).then(|| ReadCursor {
        offset: next_offset,
        sha256: *version.sha256(),
        limits,
    });
    Ok(Some(FileRead {
        text,
        version,
        bytes_read,
        truncated: capture.stopped,
        diagnostics: capture.diagnostics,
        page_start_offset,
        page_start_line,
        captured_bytes,
        total_bytes: bytes_read,
        next_cursor,
    }))
}

struct LimitedCapture {
    limits: ReadLimits,
    bytes: Vec<u8>,
    completed_lines: usize,
    current_line_bytes: usize,
    stopped: bool,
    diagnostics: Vec<ReadDiagnostic>,
}

impl LimitedCapture {
    fn new(limits: ReadLimits) -> Self {
        Self {
            limits,
            bytes: Vec::with_capacity(limits.max_bytes.min(16 * 1024)),
            completed_lines: 0,
            current_line_bytes: 0,
            stopped: false,
            diagnostics: Vec::new(),
        }
    }

    fn push_byte(&mut self, byte: u8) {
        if self.stopped {
            return;
        }
        if self.completed_lines >= self.limits.max_lines {
            self.stop(ReadDiagnostic::LineLimit {
                limit: self.limits.max_lines,
            });
            return;
        }
        if self.bytes.len() >= self.limits.max_bytes {
            self.stop(ReadDiagnostic::ByteLimit {
                limit: self.limits.max_bytes,
            });
            return;
        }
        if byte != b'\n' && self.current_line_bytes >= self.limits.max_line_bytes {
            self.stop(ReadDiagnostic::LongLine {
                line: self.completed_lines + 1,
                limit: self.limits.max_line_bytes,
            });
            return;
        }
        self.bytes.push(byte);
        if byte == b'\n' {
            self.completed_lines += 1;
            self.current_line_bytes = 0;
        } else {
            self.current_line_bytes += 1;
        }
    }

    fn stop(&mut self, diagnostic: ReadDiagnostic) {
        self.stopped = true;
        self.diagnostics.push(diagnostic);
    }
}

fn decode_capture(bytes: Vec<u8>, was_truncated: bool) -> (String, Vec<ReadDiagnostic>, u64) {
    let mut output = String::new();
    let mut diagnostics = Vec::new();
    let mut cursor = 0usize;
    let mut consumed = bytes.len();
    while cursor < bytes.len() {
        match std::str::from_utf8(&bytes[cursor..]) {
            Ok(valid) => {
                output.push_str(valid);
                break;
            }
            Err(error) => {
                let valid_end = cursor + error.valid_up_to();
                // SAFETY is avoided deliberately: the validator guarantees
                // this prefix and `from_utf8` makes the invariant explicit.
                output.push_str(
                    std::str::from_utf8(&bytes[cursor..valid_end])
                        .expect("UTF-8 validator returned a valid prefix"),
                );
                match error.error_len() {
                    Some(invalid_len) => {
                        diagnostics.push(ReadDiagnostic::InvalidUtf8 {
                            offset: valid_end as u64,
                        });
                        output.push('\u{fffd}');
                        cursor = valid_end + invalid_len;
                    }
                    None if was_truncated => {
                        consumed = valid_end;
                        diagnostics.push(ReadDiagnostic::Utf8BoundaryTrimmed {
                            bytes: bytes.len() - valid_end,
                        });
                        break;
                    }
                    None => {
                        diagnostics.push(ReadDiagnostic::InvalidUtf8 {
                            offset: valid_end as u64,
                        });
                        output.push('\u{fffd}');
                        break;
                    }
                }
            }
        }
    }
    (output, diagnostics, consumed as u64)
}

#[derive(Clone, Copy)]
enum PublishMode {
    Create,
    Replace,
}

fn authorize_write(
    display: &str,
    observed: Option<&Observation>,
    current: Option<&FsVersion>,
) -> Result<PublishMode, FsError> {
    match (observed, current) {
        (None | Some(Observation::Absent), None) => Ok(PublishMode::Create),
        (Some(Observation::Version(observed)), Some(current)) if observed == current => {
            Ok(PublishMode::Replace)
        }
        (None, Some(_)) => Err(FsError::BlindOverwrite {
            display: display.to_owned(),
        }),
        _ => Err(FsError::StaleObservation {
            display: display.to_owned(),
        }),
    }
}

fn atomic_publish(
    root: &Path,
    root_fd: &DirectoryAnchor,
    record: &TargetRecord,
    original_target: &PhysicalTarget,
    baseline: Option<&FsVersion>,
    mode: PublishMode,
    content: &[u8],
) -> Result<WriteOutcome, FsError> {
    // The parent is canonicalized again immediately before any write-side
    // filesystem mutation. A swapped parent symlink cannot redirect the temp.
    let target = physical_target(root, root_fd, record)?;
    if !same_physical_parent(&target, original_target)
        || target.file_name != original_target.file_name
    {
        return Err(FsError::StaleObservation {
            display: record.display.clone(),
        });
    }
    let current = current_version(root, &target)?;
    if current.as_ref() != baseline {
        return Err(FsError::StaleObservation {
            display: record.display.clone(),
        });
    }

    let mode_bits = match mode {
        PublishMode::Create => 0o600,
        PublishMode::Replace => {
            let original = open_regular_contained(root, &target)?.ok_or_else(|| {
                FsError::StaleObservation {
                    display: record.display.clone(),
                }
            })?;
            replacement_mode(&original).map_err(|source| {
                io_error("inspect replacement permissions", &target.path, source)
            })?
        }
    };
    let (temp_name, temp_path, mut temp_file) = create_temp(&target, mode_bits)?;
    let mut temp_guard = TempGuard::new(
        target.parent_fd.clone(),
        temp_name.clone(),
        temp_path.clone(),
    );
    #[cfg(windows)]
    if matches!(mode, PublishMode::Replace) {
        copy_dacl(&target.path, &temp_path).map_err(|source| {
            io_error(
                "copy replacement DACL to atomic temp",
                &temp_path,
                io::Error::other(source),
            )
        })?;
    }
    temp_file
        .write_all(content)
        .map_err(|source| io_error("write atomic temp", &temp_path, source))?;
    temp_file
        .sync_all()
        .map_err(|source| io_error("fsync atomic temp", &temp_path, source))?;
    drop(temp_file);

    // Recheck both logical containment and the observed version after the temp
    // is durable, narrowing external TOCTOU before the atomic publication.
    let final_target = physical_target(root, root_fd, record)?;
    if !same_physical_parent(&final_target, &target) || final_target.file_name != target.file_name {
        return Err(FsError::StaleObservation {
            display: record.display.clone(),
        });
    }
    let final_current = current_version(root, &target)?;
    if final_current.as_ref() != baseline {
        return Err(FsError::StaleObservation {
            display: record.display.clone(),
        });
    }

    publish_temp(&target, &temp_name, mode)?;
    temp_guard.disarm();
    sync_directory(target.parent_fd.as_ref(), &target.parent)?;
    let version = current_version(root, &target)?.ok_or_else(|| FsError::NotFound {
        display: record.display.clone(),
    })?;
    Ok(WriteOutcome {
        version,
        bytes_written: content.len() as u64,
        created: matches!(mode, PublishMode::Create),
    })
}

#[cfg(unix)]
fn replacement_mode(file: &File) -> io::Result<u32> {
    Ok(file.metadata()?.permissions().mode())
}

#[cfg(windows)]
fn replacement_mode(_file: &File) -> io::Result<u32> {
    Ok(0)
}

#[cfg(unix)]
fn sync_directory(anchor: &DirectoryAnchor, path: &Path) -> Result<(), FsError> {
    fsync(anchor).map_err(|error| nix_io_error("fsync target directory", path, error))
}

#[cfg(windows)]
fn sync_directory(anchor: &DirectoryAnchor, path: &Path) -> Result<(), FsError> {
    if anchor.canonical != path {
        return Err(FsError::ConcurrentModification {
            display: path.display().to_string(),
        });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn publish_temp(
    target: &PhysicalTarget,
    temp_name: &std::ffi::OsStr,
    mode: PublishMode,
) -> Result<(), FsError> {
    use std::ffi::CString;

    let old_name = CString::new(temp_name.as_bytes()).map_err(|_| FsError::InvalidPath {
        display: target.display.clone(),
        reason: "NUL byte in temporary name",
    })?;
    let new_name = CString::new(target.file_name.as_bytes()).map_err(|_| FsError::InvalidPath {
        display: target.display.clone(),
        reason: "NUL byte in target name",
    })?;
    let flags = match mode {
        PublishMode::Create => libc::RENAME_NOREPLACE,
        PublishMode::Replace => 0,
    };
    // nix deliberately exposes renameat2 only for glibc targets. Calling the
    // Linux syscall directly preserves the same atomic semantics for both
    // glibc and musl release builds.
    // SAFETY: both names are live NUL-terminated strings and the directory
    // descriptor remains owned by `target` for the duration of the syscall.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            target.parent_fd.as_raw_fd(),
            old_name.as_ptr(),
            target.parent_fd.as_raw_fd(),
            new_name.as_ptr(),
            flags,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let source = io::Error::last_os_error();
    if source.raw_os_error() == Some(libc::EEXIST) {
        Err(FsError::StaleObservation {
            display: target.display.clone(),
        })
    } else {
        Err(io_error("publish atomic rename", &target.path, source))
    }
}

#[cfg(target_os = "macos")]
fn publish_temp(
    target: &PhysicalTarget,
    temp_name: &std::ffi::OsStr,
    mode: PublishMode,
) -> Result<(), FsError> {
    use std::ffi::CString;

    let old_name = CString::new(temp_name.as_bytes()).map_err(|_| FsError::InvalidPath {
        display: target.display.clone(),
        reason: "NUL byte in temporary name",
    })?;
    let new_name = CString::new(target.file_name.as_bytes()).map_err(|_| FsError::InvalidPath {
        display: target.display.clone(),
        reason: "NUL byte in target name",
    })?;
    let flags = match mode {
        PublishMode::Create => libc::RENAME_EXCL,
        PublishMode::Replace => 0,
    };
    // SAFETY: both path pointers are live NUL-terminated byte strings and the
    // directory descriptors remain owned by `target` for the whole call.
    let result = unsafe {
        libc::renameatx_np(
            target.parent_fd.as_raw_fd(),
            old_name.as_ptr(),
            target.parent_fd.as_raw_fd(),
            new_name.as_ptr(),
            flags,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let source = io::Error::last_os_error();
    if source.raw_os_error() == Some(libc::EEXIST) {
        Err(FsError::StaleObservation {
            display: target.display.clone(),
        })
    } else {
        Err(io_error("publish atomic rename", &target.path, source))
    }
}

#[cfg(windows)]
fn publish_temp(
    target: &PhysicalTarget,
    temp_name: &std::ffi::OsStr,
    mode: PublishMode,
) -> Result<(), FsError> {
    let temp_path = target.parent.join(temp_name);
    let result = match mode {
        PublishMode::Create => fs::rename(&temp_path, &target.path),
        PublishMode::Replace => replace_file(&target.path, &temp_path),
    };
    result.map_err(|source| {
        if source.kind() == io::ErrorKind::AlreadyExists {
            FsError::StaleObservation {
                display: target.display.clone(),
            }
        } else {
            io_error("publish atomic replacement", &target.path, source)
        }
    })
}

fn same_physical_parent(left: &PhysicalTarget, right: &PhysicalTarget) -> bool {
    left.parent == right.parent
        && left.parent_device == right.parent_device
        && left.parent_inode == right.parent_inode
}

#[cfg(unix)]
fn create_temp(parent: &PhysicalTarget, mode: u32) -> Result<(OsString, PathBuf, File), FsError> {
    for _ in 0..32 {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let name = OsString::from(format!(".xharness-tmp-{}-{id:016x}", std::process::id()));
        let path = parent.parent.join(&name);
        let flags =
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        match openat(
            parent.parent_fd.as_ref(),
            name.as_os_str(),
            flags,
            permission_mode(mode),
        ) {
            Ok(fd) => {
                fchmod(&fd, permission_mode(mode))
                    .map_err(|error| nix_io_error("set atomic temp permissions", &path, error))?;
                return Ok((name, path, File::from(fd)));
            }
            Err(Errno::EEXIST) => continue,
            Err(error) => return Err(nix_io_error("create atomic temp", &path, error)),
        }
    }
    Err(io_error(
        "create atomic temp",
        &parent.parent,
        io::Error::new(io::ErrorKind::AlreadyExists, "temporary-name exhaustion"),
    ))
}

#[cfg(windows)]
fn create_temp(parent: &PhysicalTarget, _mode: u32) -> Result<(OsString, PathBuf, File), FsError> {
    for _ in 0..32 {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let name = OsString::from(format!(".xharness-tmp-{}-{id:016x}", std::process::id()));
        let path = parent.parent.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((name, path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(io_error("create atomic temp", &path, source)),
        }
    }
    Err(io_error(
        "create atomic temp",
        &parent.parent,
        io::Error::new(io::ErrorKind::AlreadyExists, "temporary-name exhaustion"),
    ))
}

#[cfg(target_os = "linux")]
fn permission_mode(mode: u32) -> Mode {
    Mode::from_bits_truncate(mode & 0o7777)
}

#[cfg(target_os = "macos")]
fn permission_mode(mode: u32) -> Mode {
    Mode::from_bits_truncate((mode & 0o7777) as u16)
}

struct TempGuard {
    #[cfg(unix)]
    parent_fd: Arc<DirectoryAnchor>,
    #[cfg(unix)]
    name: OsString,
    path: Option<PathBuf>,
}

impl TempGuard {
    fn new(parent_fd: Arc<DirectoryAnchor>, name: OsString, path: PathBuf) -> Self {
        #[cfg(windows)]
        let _ = (&parent_fd, &name);
        Self {
            #[cfg(unix)]
            parent_fd,
            #[cfg(unix)]
            name,
            path: Some(path),
        }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            if self.path.take().is_some() {
                let _ = unlinkat(
                    self.parent_fd.as_ref(),
                    self.name.as_os_str(),
                    UnlinkatFlags::NoRemoveDir,
                );
            }
        }
        #[cfg(windows)]
        {
            if let Some(path) = self.path.take() {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> FsError {
    FsError::Io {
        operation,
        path: path.display().to_string(),
        source,
    }
}

#[cfg(unix)]
fn nix_io_error(operation: &'static str, path: &Path, error: Errno) -> FsError {
    io_error(operation, path, io::Error::from_raw_os_error(error as i32))
}

#[cfg(target_os = "linux")]
fn canonical_fd_path(
    fd: &impl AsRawFd,
    operation: &'static str,
    diagnostic_path: &Path,
) -> Result<PathBuf, FsError> {
    fs::canonicalize(format!("/proc/self/fd/{}", fd.as_raw_fd()))
        .map_err(|source| io_error(operation, diagnostic_path, source))
}

#[cfg(target_os = "macos")]
fn canonical_fd_path(
    fd: &impl std::os::fd::AsFd,
    operation: &'static str,
    diagnostic_path: &Path,
) -> Result<PathBuf, FsError> {
    let mut path = PathBuf::new();
    fcntl(fd, FcntlArg::F_GETPATH(&mut path))
        .map_err(|error| nix_io_error(operation, diagnostic_path, error))?;
    fs::canonicalize(&path).map_err(|source| io_error(operation, diagnostic_path, source))
}
