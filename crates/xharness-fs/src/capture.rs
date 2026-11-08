//! Read-only, full-content capture of an already-authorized regular-file target.
//! This is not a directory inventory, model observation, write capability,
//! atomic workspace snapshot, quiescence receipt, or completed synchronization.
//! Capture policy/exclusions must be checked by the owner BEFORE using this port.
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

use super::{FsError, FsService, FsTarget};
use std::{fmt, io};

pub const MAX_CAPTURE_FILE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("native file capture is unavailable on this platform")]
    Unsupported,
    #[error("native file capture byte limit is invalid or exceeded")]
    ByteLimit,
    #[error("native file capture requires a bounded UTF-8 relative path")]
    InvalidPath,
    #[error("native file capture target is unknown or belongs to another service")]
    ForeignTarget,
    #[error("native file capture target registry is unavailable")]
    RegistryUnavailable,
    #[error("native file capture target is busy")]
    Busy,
    #[error("native file capture target is absent")]
    Missing,
    #[error("native file capture rejects a link or unsupported filesystem node")]
    UnsupportedNode,
    #[error("native file capture cannot cross a filesystem mount")]
    CrossDevice,
    #[error("native file capture binding or content changed")]
    Changed,
    #[error("native file capture I/O failed")]
    Io(#[source] io::Error),
    #[error("native file capture filesystem verification failed")]
    Filesystem(#[source] FsError),
    #[error("native file capture allocation failed")]
    Allocation(#[source] std::collections::TryReserveError),
}

/// Immutable bytes with private native provenance. Never deserialize a browser
/// payload into this value or reuse it as a model's observed-write permission.
pub struct CapturedFile {
    contents: Vec<u8>,
    sha256: [u8; 32],
    executable: bool,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    binding: unix::CaptureBinding,
}
impl CapturedFile {
    pub fn contents(&self) -> &[u8] {
        &self.contents
    }
    pub fn sha256_hex(&self) -> String {
        super::encode_sha256(&self.sha256)
    }
    pub fn executable(&self) -> bool {
        self.executable
    }
}
impl fmt::Debug for CapturedFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedFile")
            .field("bytes", &self.contents.len())
            .field("executable", &self.executable)
            .finish_non_exhaustive()
    }
}

impl FsService {
    /// Synchronous, read-only native port: no detached worker is created.
    /// An async owner must run/observe its own bounded blocking worker. Dropping
    /// that owner's future is NOT evidence that a capture worker has stopped.
    /// Busy cooperating writers fail admission rather than waiting indefinitely.
    pub fn capture_file(
        &self,
        target: &FsTarget,
        byte_limit: usize,
    ) -> Result<CapturedFile, CaptureError> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            unix::capture(self, target, byte_limit)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (target, byte_limit);
            Err(CaptureError::Unsupported)
        }
    }

    /// Rehash through a fresh strict handle and verify private target identity,
    /// mode and link count too. Passing is an observation, NOT a filesystem lock
    /// or proof that later writes/transfer have completed.
    pub fn revalidate_capture(
        &self,
        target: &FsTarget,
        captured: &CapturedFile,
    ) -> Result<(), CaptureError> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            unix::revalidate(self, target, captured)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (target, captured);
            Err(CaptureError::Unsupported)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::{CaptureError, CapturedFile, FsService, FsTarget, MAX_CAPTURE_FILE_BYTES};
    use crate::{canonical_fd_path, FsTargetKey, MetadataStamp, TargetRecord};
    use nix::{
        errno::Errno,
        fcntl::{openat, OFlag},
        sys::stat::Mode,
    };
    use sha2::{Digest, Sha256};
    use std::{
        fs::{File, Metadata},
        io::{self, Read},
        os::unix::fs::MetadataExt,
        path::{Component, Path},
    };
    use tokio::sync::OwnedMutexGuard;

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Stamp {
        metadata: MetadataStamp,
        mode: u32,
        links: u64,
    }
    impl Stamp {
        fn new(metadata: &Metadata) -> Self {
            Self {
                metadata: MetadataStamp::from_metadata(metadata),
                mode: metadata.mode(),
                links: metadata.nlink(),
            }
        }
    }
    pub(super) struct CaptureBinding {
        service_id: u64,
        target: FsTargetKey,
        stamp: Stamp,
    }
    struct Scan {
        contents: Vec<u8>,
        sha256: [u8; 32],
        executable: bool,
        stamp: Stamp,
    }

    fn admitted(
        service: &FsService,
        target: &FsTarget,
    ) -> Result<(TargetRecord, OwnedMutexGuard<()>), CaptureError> {
        let record = service
            .inner
            .targets
            .lock()
            .map_err(|_| CaptureError::RegistryUnavailable)?
            .by_key
            .get(&target.key)
            .cloned()
            .ok_or(CaptureError::ForeignTarget)?;
        let guard = record
            .lock
            .clone()
            .try_lock_owned()
            .map_err(|_| CaptureError::Busy)?;
        Ok((record, guard))
    }
    fn syscall(error: Errno) -> CaptureError {
        match error {
            Errno::EXDEV => CaptureError::CrossDevice,
            Errno::ELOOP | Errno::ENOTDIR => CaptureError::UnsupportedNode,
            Errno::ENOENT => CaptureError::Missing,
            _ => CaptureError::Io(io::Error::from_raw_os_error(error as i32)),
        }
    }
    fn metadata(file: &File) -> Result<Metadata, CaptureError> {
        file.metadata().map_err(CaptureError::Io)
    }
    fn strict_file(service: &FsService, relative: &Path) -> Result<File, CaptureError> {
        let text = relative.to_str().ok_or(CaptureError::InvalidPath)?;
        if text.is_empty()
            || text.len() > 4096
            || relative.components().count() > 128
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(name) if name.len() <= 255))
        {
            return Err(CaptureError::InvalidPath);
        }
        let root = File::from(
            openat(
                service.inner.root_fd.as_ref(),
                Path::new("."),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
                Mode::empty(),
            )
            .map_err(syscall)?,
        );
        let root_path = canonical_fd_path(&root, "verify capture root", &service.inner.root)
            .map_err(CaptureError::Filesystem)?;
        if root_path != service.inner.root {
            return Err(CaptureError::Changed);
        }
        let root_device = metadata(&root)?.dev();
        // NONBLOCK precedes the regular-file check: a substituted FIFO must
        // never hang open(2). NO_XDEV also rejects same-device bind mounts.
        let flags = OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK;
        #[cfg(target_os = "linux")]
        let file = {
            use nix::fcntl::{openat2, OpenHow, ResolveFlag};
            let how = OpenHow::new().flags(flags).resolve(
                ResolveFlag::RESOLVE_BENEATH
                    | ResolveFlag::RESOLVE_NO_MAGICLINKS
                    | ResolveFlag::RESOLVE_NO_SYMLINKS
                    | ResolveFlag::RESOLVE_NO_XDEV,
            );
            File::from(openat2(&root, relative, how).map_err(syscall)?)
        };
        #[cfg(target_os = "macos")]
        let file = {
            let mut parent = root;
            let mut parts = relative.components().peekable();
            while let Some(part) = parts.next() {
                if parts.peek().is_none() {
                    break;
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
                if metadata(&parent)?.dev() != root_device {
                    return Err(CaptureError::CrossDevice);
                }
            }
            let name = relative.file_name().ok_or(CaptureError::InvalidPath)?;
            File::from(openat(&parent, Path::new(name), flags, Mode::empty()).map_err(syscall)?)
        };
        let info = metadata(&file)?;
        if !info.is_file() || info.nlink() != 1 {
            return Err(CaptureError::UnsupportedNode);
        }
        if info.dev() != root_device {
            return Err(CaptureError::CrossDevice);
        }
        Ok(file)
    }

    fn scan(
        service: &FsService,
        record: &TargetRecord,
        byte_limit: usize,
        collect: bool,
        after_read: impl FnOnce(),
    ) -> Result<Scan, CaptureError> {
        if byte_limit > MAX_CAPTURE_FILE_BYTES {
            return Err(CaptureError::ByteLimit);
        }
        let mut file = strict_file(service, &record.relative)?;
        let before = Stamp::new(&metadata(&file)?);
        if before.metadata.len > byte_limit as u64 {
            return Err(CaptureError::ByteLimit);
        }
        let mut sha256 = Sha256::new();
        let mut contents = Vec::new();
        let mut count = 0usize;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let remaining = byte_limit - count;
            let wanted = buffer.len().min(remaining + 1);
            let read = file.read(&mut buffer[..wanted]).map_err(CaptureError::Io)?;
            if read == 0 {
                break;
            }
            if read > remaining {
                return Err(CaptureError::ByteLimit);
            }
            count += read;
            sha256.update(&buffer[..read]);
            if collect {
                contents
                    .try_reserve(read)
                    .map_err(CaptureError::Allocation)?;
                contents.extend_from_slice(&buffer[..read]);
            }
        }
        after_read();
        let after = Stamp::new(&metadata(&file)?);
        // Reopen via the original root capability, not a stored absolute path.
        // A stable old descriptor does not prove the current name still binds it.
        let current = Stamp::new(&metadata(&strict_file(service, &record.relative)?)?);
        if before != after || before != current || count as u64 != before.metadata.len {
            return Err(CaptureError::Changed);
        }
        Ok(Scan {
            contents,
            sha256: sha256.finalize().into(),
            executable: before.mode & 0o111 != 0,
            stamp: before,
        })
    }
    pub(super) fn capture(
        service: &FsService,
        target: &FsTarget,
        byte_limit: usize,
    ) -> Result<CapturedFile, CaptureError> {
        let (record, _guard) = admitted(service, target)?;
        let scan = scan(service, &record, byte_limit, true, || {})?;
        Ok(CapturedFile {
            contents: scan.contents,
            sha256: scan.sha256,
            executable: scan.executable,
            binding: CaptureBinding {
                service_id: service.inner.service_id,
                target: target.key.clone(),
                stamp: scan.stamp,
            },
        })
    }
    pub(super) fn revalidate(
        service: &FsService,
        target: &FsTarget,
        captured: &CapturedFile,
    ) -> Result<(), CaptureError> {
        if captured.binding.service_id != service.inner.service_id
            || captured.binding.target != target.key
        {
            return Err(CaptureError::ForeignTarget);
        }
        let (record, _guard) = admitted(service, target)?;
        let scan = match scan(service, &record, captured.contents.len(), false, || {}) {
            // The bound here is the old observation's exact length. Growth is
            // stale input, not permission to widen the caller's transfer budget.
            Err(CaptureError::ByteLimit) => return Err(CaptureError::Changed),
            result => result?,
        };
        if scan.stamp != captured.binding.stamp || scan.sha256 != captured.sha256 {
            return Err(CaptureError::Changed);
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            sync::atomic::{AtomicU64, Ordering},
            time::{SystemTime, UNIX_EPOCH},
        };
        static NEXT: AtomicU64 = AtomicU64::new(0);

        #[test]
        fn replacement_after_read_cannot_be_acknowledged_as_current() {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "xh-capture-hook-{nonce}-{}",
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::write(root.join("file"), b"before").unwrap();
            let service = FsService::new(&root).unwrap();
            let target = service.resolve("file").unwrap();
            let (record, _guard) = admitted(&service, &target).unwrap();
            assert!(matches!(
                service.capture_file(&target, 1024),
                Err(CaptureError::Busy)
            ));
            let result = scan(&service, &record, 1024, true, || {
                fs::rename(root.join("file"), root.join("old")).unwrap();
                fs::write(root.join("file"), b"before").unwrap();
            });
            assert!(matches!(result, Err(CaptureError::Changed)));
            fs::remove_dir_all(root).unwrap();
        }
    }
}
