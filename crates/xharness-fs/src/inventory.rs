//! Bounded, read-only inventory under an established native root capability.
//! This is a stable observation, NOT an atomic snapshot, write grant, deletion
//! receipt, workspace admission lease, or authorization for browser paths.
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

use crate::FsService;
use std::{error::Error, fmt, io};

pub type PolicyError = Box<dyn Error + Send + Sync>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InventoryDecision {
    Include,
    Exclude,
}

/// Trusted native owner policy, never a deserialized browser-selected callback.
/// Classify every name BEFORE opening it. Identity must bind the exact policy.
pub trait InventoryPolicy {
    fn identity(&self) -> [u8; 32];
    fn classify(&self, relative: &str) -> Result<InventoryDecision, PolicyError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InventoryLimits {
    pub entries: usize,
    pub files: usize,
    pub directories: usize,
    pub metadata_bytes: usize,
    pub file_bytes: usize,
    pub total_bytes: u64,
    pub depth: usize,
}
impl Default for InventoryLimits {
    fn default() -> Self {
        Self {
            entries: 100_000,
            files: 100_000,
            directories: 10_000,
            metadata_bytes: 16 * 1024 * 1024,
            file_bytes: 512 * 1024 * 1024,
            total_bytes: 8 * 1024 * 1024 * 1024,
            depth: 128,
        }
    }
}
impl InventoryLimits {
    fn validate(self) -> Result<Self, InventoryError> {
        let hard = Self::default();
        if self.entries > hard.entries
            || self.files > hard.files
            || self.directories == 0
            || self.directories > hard.directories
            || self.metadata_bytes < 256
            || self.metadata_bytes > hard.metadata_bytes
            || self.file_bytes > hard.file_bytes
            || self.total_bytes > hard.total_bytes
            || self.depth > hard.depth
        {
            return Err(InventoryError::InvalidLimits);
        }
        Ok(self)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum InventoryError {
    #[error("native directory inventory is unavailable on this platform")]
    Unsupported,
    #[error("native directory inventory limits are invalid")]
    InvalidLimits,
    #[error("native directory inventory limit exceeded")]
    Limit,
    #[error("native directory inventory requires bounded UTF-8 relative names")]
    InvalidPath,
    #[error("native directory inventory rejects links or unsupported nodes")]
    UnsupportedNode,
    #[error("native directory inventory cannot cross a filesystem mount")]
    CrossDevice,
    #[error("native directory inventory changed during observation")]
    Changed,
    #[error("native directory inventory belongs to another service or policy")]
    ForeignInventory,
    #[error("native directory inventory policy rejected a path")]
    Policy(#[source] PolicyError),
    #[error("native directory inventory I/O failed")]
    Io(#[source] io::Error),
    #[error("native directory enumeration failed")]
    Directory(#[source] Box<dyn Error + Send + Sync>),
    #[error("native directory root verification failed")]
    Filesystem(#[source] crate::FsError),
    #[error("native directory inventory allocation failed")]
    Allocation(#[source] std::collections::TryReserveError),
}

#[derive(PartialEq, Eq)]
pub struct InventoryFile {
    path: String,
    sha256: [u8; 32],
    bytes: u64,
    executable: bool,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    stamp: unix::Stamp,
}
impl InventoryFile {
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn sha256_hex(&self) -> String {
        crate::encode_sha256(&self.sha256)
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
    pub fn executable(&self) -> bool {
        self.executable
    }
}
impl fmt::Debug for InventoryFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InventoryFile")
            .field("bytes", &self.bytes)
            .field("executable", &self.executable)
            .finish_non_exhaustive()
    }
}

pub struct WorkspaceInventory {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    snapshot: unix::Snapshot,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    service_id: u64,
    policy_id: [u8; 32],
    limits: InventoryLimits,
}
impl WorkspaceInventory {
    pub fn files(&self) -> &[InventoryFile] {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            &self.snapshot.files
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            &[]
        }
    }
    pub fn directories(&self) -> impl Iterator<Item = &str> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            self.snapshot
                .directories
                .iter()
                .filter(|(p, _)| !p.is_empty())
                .map(|(p, _)| p.as_str())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            std::iter::empty()
        }
    }
    pub fn excluded_entries(&self) -> usize {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            self.snapshot.excluded.len()
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            0
        }
    }
    pub fn policy_identity(&self) -> [u8; 32] {
        self.policy_id
    }
    pub fn limits(&self) -> InventoryLimits {
        self.limits
    }
}
impl fmt::Debug for WorkspaceInventory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkspaceInventory")
            .field("files", &self.files().len())
            .field("excluded_entries", &self.excluded_entries())
            .finish_non_exhaustive()
    }
}

impl FsService {
    /// Synchronous full-hash two-pass observation; creates no detached worker.
    /// Owners must bound blocking scheduling/concurrency and quiesce writers
    /// before using this as input to a later apply/handoff protocol.
    pub fn capture_inventory(
        &self,
        policy: &impl InventoryPolicy,
        limits: InventoryLimits,
    ) -> Result<WorkspaceInventory, InventoryError> {
        let limits = limits.validate()?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            unix::capture(self, policy, limits, || {})
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (policy, limits);
            Err(InventoryError::Unsupported)
        }
    }
    pub fn revalidate_inventory(
        &self,
        inventory: &WorkspaceInventory,
        policy: &impl InventoryPolicy,
    ) -> Result<(), InventoryError> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            unix::revalidate(self, inventory, policy)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (inventory, policy);
            Err(InventoryError::Unsupported)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::*;
    use crate::{
        canonical_fd_path,
        directory_stream::{self, DirectoryError},
        MetadataStamp,
    };
    use nix::{
        errno::Errno,
        fcntl::{openat, OFlag},
        sys::stat::Mode,
    };
    use sha2::{Digest, Sha256};
    #[cfg(target_os = "macos")]
    use std::path::Component;
    use std::{
        fs::{File, Metadata},
        io::Read,
        os::unix::fs::MetadataExt,
        path::Path,
    };

    #[derive(PartialEq, Eq)]
    pub(super) struct Stamp {
        metadata: MetadataStamp,
        mode: u32,
        links: u64,
    }
    impl Stamp {
        fn new(m: &Metadata) -> Self {
            Self {
                metadata: MetadataStamp::from_metadata(m),
                mode: m.mode(),
                links: m.nlink(),
            }
        }
    }
    #[derive(PartialEq, Eq)]
    pub(super) struct Snapshot {
        pub(super) files: Vec<InventoryFile>,
        pub(super) directories: Vec<(String, Stamp)>,
        pub(super) excluded: Vec<String>,
    }
    fn stat(file: &File) -> Result<Metadata, InventoryError> {
        file.metadata().map_err(InventoryError::Io)
    }
    fn syscall(error: Errno) -> InventoryError {
        match error {
            Errno::EXDEV => InventoryError::CrossDevice,
            Errno::ELOOP | Errno::ENOTDIR => InventoryError::UnsupportedNode,
            _ => InventoryError::Io(io::Error::from_raw_os_error(error as i32)),
        }
    }
    fn root(service: &FsService) -> Result<File, InventoryError> {
        let file = File::from(
            openat(
                service.inner.root_fd.as_ref(),
                Path::new("."),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
                Mode::empty(),
            )
            .map_err(syscall)?,
        );
        check_root(service, &file)?;
        Ok(file)
    }
    fn check_root(service: &FsService, file: &File) -> Result<(), InventoryError> {
        if canonical_fd_path(file, "verify inventory root", &service.inner.root)
            .map_err(InventoryError::Filesystem)?
            != service.inner.root
        {
            return Err(InventoryError::Changed);
        }
        Ok(())
    }
    fn open_relative(root: &File, service: &FsService, path: &str) -> Result<File, InventoryError> {
        let flags = OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK;
        let relative = if path.is_empty() {
            Path::new(".")
        } else {
            Path::new(path)
        };
        #[cfg(target_os = "linux")]
        let file = {
            use nix::fcntl::{openat2, OpenHow, ResolveFlag};
            let how = OpenHow::new().flags(flags).resolve(
                ResolveFlag::RESOLVE_BENEATH
                    | ResolveFlag::RESOLVE_NO_MAGICLINKS
                    | ResolveFlag::RESOLVE_NO_SYMLINKS
                    | ResolveFlag::RESOLVE_NO_XDEV,
            );
            File::from(openat2(root, relative, how).map_err(syscall)?)
        };
        #[cfg(target_os = "macos")]
        let file = {
            let mut parent = root.try_clone().map_err(InventoryError::Io)?;
            let mut prefix = service.inner.root.clone();
            let mut parts = relative.components().peekable();
            while let Some(part) = parts.next() {
                if parts.peek().is_none() {
                    break;
                }
                if !matches!(part, Component::Normal(_)) {
                    return Err(InventoryError::InvalidPath);
                }
                parent = File::from(
                    openat(
                        &parent,
                        Path::new(part.as_os_str()),
                        flags | OFlag::O_DIRECTORY,
                        Mode::empty(),
                    )
                    .map_err(syscall)?,
                );
                prefix.push(part.as_os_str());
                if stat(&parent)?.dev() != stat(root)?.dev() {
                    return Err(InventoryError::CrossDevice);
                }
                if canonical_fd_path(&parent, "verify inventory parent", &prefix)
                    .map_err(InventoryError::Filesystem)?
                    != prefix
                {
                    return Err(InventoryError::Changed);
                }
            }
            let name = if path.is_empty() {
                std::ffi::OsStr::new(".")
            } else {
                relative.file_name().ok_or(InventoryError::InvalidPath)?
            };
            File::from(openat(&parent, Path::new(name), flags, Mode::empty()).map_err(syscall)?)
        };
        if stat(&file)?.dev() != stat(root)?.dev() {
            return Err(InventoryError::CrossDevice);
        }
        let expected = service.inner.root.join(path);
        if canonical_fd_path(&file, "verify inventory node", &expected)
            .map_err(InventoryError::Filesystem)?
            != expected
        {
            return Err(InventoryError::Changed);
        }
        Ok(file)
    }
    fn full_hash(file: &mut File, limit: usize) -> Result<([u8; 32], u64), InventoryError> {
        let mut count = 0usize;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let remaining = limit - count;
            let wanted = buffer.len().min(remaining + 1);
            let read = file
                .read(&mut buffer[..wanted])
                .map_err(InventoryError::Io)?;
            if read == 0 {
                break;
            }
            if read > remaining {
                return Err(InventoryError::Limit);
            }
            count += read;
            hash.update(&buffer[..read]);
        }
        Ok((hash.finalize().into(), count as u64))
    }
    struct Scan<'a, P> {
        service: &'a FsService,
        root: File,
        policy: &'a P,
        limits: InventoryLimits,
        snapshot: Snapshot,
        entries: usize,
        metadata_bytes: usize,
        total: u64,
    }
    impl<P: InventoryPolicy> Scan<'_, P> {
        fn reserve<T>(list: &mut Vec<T>) -> Result<(), InventoryError> {
            list.try_reserve(1).map_err(InventoryError::Allocation)
        }
        fn walk(&mut self, path: &str, mut file: File, depth: usize) -> Result<(), InventoryError> {
            let info = stat(&file)?;
            let before = Stamp::new(&info);
            if info.is_dir() {
                if self.snapshot.directories.len() == self.limits.directories {
                    return Err(InventoryError::Limit);
                }
                let directory_index = self.snapshot.directories.len();
                Self::reserve(&mut self.snapshot.directories)?;
                self.snapshot.directories.push((path.to_owned(), before));
                let names = match directory_stream::list(
                    file.try_clone().map_err(InventoryError::Io)?.into(),
                    self.limits.entries - self.entries,
                ) {
                    Ok(names) => names,
                    Err(DirectoryError::Limit) => return Err(InventoryError::Limit),
                    Err(error) => return Err(InventoryError::Directory(Box::new(error))),
                };
                self.entries += names.len();
                for name in names {
                    let name = name.to_str().ok_or(InventoryError::InvalidPath)?;
                    if name.is_empty()
                        || name.len() > 255
                        || name.contains('/')
                        || name.contains('\0')
                    {
                        return Err(InventoryError::InvalidPath);
                    }
                    let child = if path.is_empty() {
                        name.to_owned()
                    } else {
                        format!("{path}/{name}")
                    };
                    if child.len() > 4096 || depth + 1 > self.limits.depth {
                        return Err(InventoryError::Limit);
                    }
                    self.metadata_bytes = self
                        .metadata_bytes
                        .checked_add(child.len() + 256)
                        .ok_or(InventoryError::Limit)?;
                    if self.metadata_bytes > self.limits.metadata_bytes {
                        return Err(InventoryError::Limit);
                    }
                    match self
                        .policy
                        .classify(&child)
                        .map_err(InventoryError::Policy)?
                    {
                        InventoryDecision::Exclude => {
                            Self::reserve(&mut self.snapshot.excluded)?;
                            self.snapshot.excluded.push(child);
                        }
                        InventoryDecision::Include => {
                            let opened = open_relative(&self.root, self.service, &child)?;
                            self.walk(&child, opened, depth + 1)?;
                        }
                    }
                }
                let after = Stamp::new(&stat(&file)?);
                let current = Stamp::new(&stat(&open_relative(&self.root, self.service, path)?)?);
                let original = &self
                    .snapshot
                    .directories
                    .get(directory_index)
                    .ok_or(InventoryError::Changed)?
                    .1;
                if original != &after || original != &current {
                    return Err(InventoryError::Changed);
                }
            } else if info.is_file() && info.nlink() == 1 {
                if self.snapshot.files.len() == self.limits.files
                    || info.len() > self.limits.file_bytes as u64
                {
                    return Err(InventoryError::Limit);
                }
                let remaining = self.limits.total_bytes - self.total;
                if info.len() > remaining {
                    return Err(InventoryError::Limit);
                }
                let byte_limit = usize::try_from(remaining.min(self.limits.file_bytes as u64))
                    .map_err(|_| InventoryError::Limit)?;
                let (sha256, bytes) = full_hash(&mut file, byte_limit)?;
                if before != Stamp::new(&stat(&file)?)
                    || bytes != info.len()
                    || before != Stamp::new(&stat(&open_relative(&self.root, self.service, path)?)?)
                {
                    return Err(InventoryError::Changed);
                }
                self.total = self.total.checked_add(bytes).ok_or(InventoryError::Limit)?;
                if self.total > self.limits.total_bytes {
                    return Err(InventoryError::Limit);
                }
                Self::reserve(&mut self.snapshot.files)?;
                self.snapshot.files.push(InventoryFile {
                    path: path.to_owned(),
                    sha256,
                    bytes,
                    executable: info.mode() & 0o111 != 0,
                    stamp: before,
                });
            } else {
                return Err(InventoryError::UnsupportedNode);
            }
            Ok(())
        }
    }
    fn scan(
        service: &FsService,
        policy: &impl InventoryPolicy,
        limits: InventoryLimits,
    ) -> Result<Snapshot, InventoryError> {
        let root = root(service)?;
        let directory = open_relative(&root, service, "")?;
        let mut scan = Scan {
            service,
            root,
            policy,
            limits,
            snapshot: Snapshot {
                files: Vec::new(),
                directories: Vec::new(),
                excluded: Vec::new(),
            },
            entries: 0,
            metadata_bytes: 256,
            total: 0,
        };
        scan.walk("", directory, 0)?;
        check_root(service, &scan.root)?;
        Ok(scan.snapshot)
    }
    pub(super) fn capture(
        service: &FsService,
        policy: &impl InventoryPolicy,
        limits: InventoryLimits,
        after_first: impl FnOnce(),
    ) -> Result<WorkspaceInventory, InventoryError> {
        let policy_id = policy.identity();
        let first = scan(service, policy, limits)?;
        after_first();
        let second = scan(service, policy, limits)?;
        if first != second || policy.identity() != policy_id {
            return Err(InventoryError::Changed);
        }
        Ok(WorkspaceInventory {
            snapshot: second,
            service_id: service.inner.service_id,
            policy_id,
            limits,
        })
    }
    pub(super) fn revalidate(
        service: &FsService,
        inventory: &WorkspaceInventory,
        policy: &impl InventoryPolicy,
    ) -> Result<(), InventoryError> {
        if inventory.service_id != service.inner.service_id
            || inventory.policy_id != policy.identity()
        {
            return Err(InventoryError::ForeignInventory);
        }
        if scan(service, policy, inventory.limits)? != inventory.snapshot
            || policy.identity() != inventory.policy_id
        {
            return Err(InventoryError::Changed);
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            path::PathBuf,
            sync::atomic::{AtomicU64, Ordering},
        };
        static NEXT: AtomicU64 = AtomicU64::new(0);
        struct Fixture(PathBuf);
        impl Fixture {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "xh-inventory-hook-{}-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Err(error) = fs::remove_dir_all(&self.0) {
                    eprintln!("inventory hook fixture cleanup failed: {error}");
                }
            }
        }
        struct All;
        impl InventoryPolicy for All {
            fn identity(&self) -> [u8; 32] {
                [1; 32]
            }
            fn classify(&self, _: &str) -> Result<InventoryDecision, PolicyError> {
                Ok(InventoryDecision::Include)
            }
        }
        #[test]
        fn changes_between_complete_passes_never_return_a_partial_success() {
            for operation in 0..5 {
                let outer = Fixture::new();
                let root = outer.0.join("root");
                fs::create_dir(&root).unwrap();
                fs::write(root.join("file"), b"before").unwrap();
                let service = FsService::new(&root).unwrap();
                let result = capture(
                    &service,
                    &All,
                    InventoryLimits::default(),
                    || match operation {
                        0 => fs::write(root.join("file"), b"after!").unwrap(),
                        1 => fs::write(root.join("new"), b"added").unwrap(),
                        2 => fs::remove_file(root.join("file")).unwrap(),
                        3 => {
                            fs::rename(root.join("file"), root.join("retained")).unwrap();
                            fs::write(root.join("file"), b"before").unwrap();
                        }
                        _ => {
                            fs::rename(&root, outer.0.join("old")).unwrap();
                            fs::create_dir(&root).unwrap();
                        }
                    },
                );
                assert!(
                    matches!(result, Err(InventoryError::Changed)),
                    "operation={operation}: {result:?}"
                );
            }
        }
        #[test]
        fn changing_policy_identity_cannot_certify_an_inventory() {
            struct Changing(AtomicU64);
            impl InventoryPolicy for Changing {
                fn identity(&self) -> [u8; 32] {
                    [self.0.fetch_add(1, Ordering::Relaxed) as u8; 32]
                }
                fn classify(&self, _: &str) -> Result<InventoryDecision, PolicyError> {
                    Ok(InventoryDecision::Include)
                }
            }
            let root = Fixture::new();
            let service = FsService::new(&root.0).unwrap();
            assert!(matches!(
                service.capture_inventory(&Changing(AtomicU64::new(0)), Default::default()),
                Err(InventoryError::Changed)
            ));
        }
    }
}
