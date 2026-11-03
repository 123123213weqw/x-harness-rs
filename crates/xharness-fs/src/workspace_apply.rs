//! Native owner-only cooperative workspace admission and recoverable publication.
//! Advisory locks do NOT stop arbitrary editors, escaped children or old binaries.
//! The owner must quiesce those writers. No model observation grants this lease.
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

use crate::{inventory::InventoryError, FsService};
use std::{fmt, io};

pub const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("workspace sync is unsupported on this platform")]
    Unsupported,
    #[error("workspace is busy or has an unresolved sync transaction")]
    Busy,
    #[error("invalid native sync path, record or operation identity")]
    Invalid,
    #[error("workspace sync full version changed or outcome is ambiguous")]
    Changed,
    #[error("workspace sync limit exceeded")]
    Limit,
    #[error("workspace sync I/O failed")]
    Io(#[from] io::Error),
    #[error("workspace sync containment failed")]
    Inventory(#[from] InventoryError),
    #[error("workspace sync native publication failed")]
    Filesystem(#[from] crate::FsError),
}

/// Full-content witness. `exact` includes ctime; `identity` excludes ctime,
/// because a retained inode's ctime changes during rename. Neither is a grant.
#[derive(Clone, PartialEq, Eq)]
pub struct FileWitness {
    pub exact: String,
    pub identity: String,
    pub sha256: String,
    pub bytes: u64,
    pub executable: bool,
}
impl fmt::Debug for FileWitness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FileWitness")
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}

pub struct WorkspaceUse {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    _lock: std::fs::File,
}
impl fmt::Debug for WorkspaceUse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WorkspaceUse(..)")
    }
}
pub struct StageSpec<'a> {
    pub path: &'a str,
    pub operation: &'a str,
    pub source_exact: &'a str,
    pub sha256: &'a str,
    pub bytes: u64,
    pub executable: bool,
}
pub struct SyncLease {
    service: FsService,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    root: std::fs::File,
}
impl SyncLease {
    pub fn service(&self) -> &FsService {
        &self.service
    }
}
impl FsService {
    pub fn workspace_use(&self) -> Result<WorkspaceUse, ApplyError> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let root = native::locked_root(self, false)?;
            if let Some(record) = native::read_record(self, &root, "active")? {
                if record != b"idle\n" {
                    return Err(ApplyError::Busy);
                }
            }
            Ok(WorkspaceUse { _lock: root })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Ok(WorkspaceUse {})
        }
    }
    /// Nonblocking exclusive lease, including recovery of a durable busy marker.
    /// Never acquired by browser/model paths; caller owns quiescence of external writers.
    pub fn sync_lease(&self) -> Result<SyncLease, ApplyError> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            Ok(SyncLease {
                service: self.clone(),
                root: native::locked_root(self, true)?,
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Err(ApplyError::Unsupported)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod native {
    use super::*;
    use crate::{
        canonical_fd_path,
        inventory::unix::{check_root, open_relative, root},
        publish_temp, workspace_lock, PhysicalTarget, PublishMode,
    };
    use nix::{
        errno::Errno,
        fcntl::{openat, OFlag},
        sys::stat::{mkdirat, Mode},
    };
    use sha2::{Digest, Sha256};
    use std::{
        ffi::OsStr,
        fs::File,
        io::{Read, Write},
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::Path,
        sync::Arc,
    };

    pub(super) fn locked_root(service: &FsService, exclusive: bool) -> Result<File, ApplyError> {
        let file = root(service)?;
        workspace_lock::lock(&file, exclusive).map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock {
                ApplyError::Busy
            } else {
                ApplyError::Io(error)
            }
        })?;
        check_root(service, &file)?;
        Ok(file)
    }
    fn valid(path: &str) -> Result<(), ApplyError> {
        if path.is_empty()
            || path.len() > 4096
            || path.split('/').count() > 128
            || path.split('/').any(|p| {
                p.is_empty() || p == "." || p == ".." || p.len() > 255 || p.contains(['\\', '\0'])
            })
        {
            return Err(ApplyError::Invalid);
        }
        Ok(())
    }
    fn key(key: &str) -> Result<String, ApplyError> {
        if !matches!(key, "active" | "base" | "prepared") {
            return Err(ApplyError::Invalid);
        }
        Ok(format!(".xh-sync-{key}"))
    }
    fn physical(
        service: &FsService,
        parent: &File,
        path: &str,
        name: &str,
    ) -> Result<PhysicalTarget, ApplyError> {
        check_root(service, &root(service)?)?;
        let parent_path = Path::new(path).parent().ok_or(ApplyError::Invalid)?;
        let absolute = service.inner.root.join(parent_path);
        if canonical_fd_path(parent, "verify sync parent", &absolute)? != absolute {
            return Err(ApplyError::Changed);
        }
        let metadata = parent.metadata()?;
        if !metadata.is_dir() {
            return Err(ApplyError::Changed);
        }
        Ok(PhysicalTarget {
            parent: absolute.clone(),
            parent_fd: Arc::new(parent.try_clone()?.into()),
            parent_device: metadata.dev(),
            parent_inode: metadata.ino(),
            file_name: name.into(),
            path: absolute.join(name),
            display: "native sync target".into(),
        })
    }
    fn parent(
        service: &FsService,
        root: &File,
        path: &str,
        create: bool,
    ) -> Result<File, ApplyError> {
        valid(path)?;
        let parent = Path::new(path)
            .parent()
            .and_then(Path::to_str)
            .ok_or(ApplyError::Invalid)?;
        if create {
            let mut prefix = String::new();
            let mut current = open_relative(root, service, "")?;
            for component in parent.split('/').filter(|p| !p.is_empty()) {
                match mkdirat(&current, component, Mode::from_bits_truncate(0o700)) {
                    Ok(()) => current.sync_all()?,
                    Err(Errno::EEXIST) => {}
                    Err(error) => return Err(io::Error::from_raw_os_error(error as i32).into()),
                }
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(component);
                current = open_relative(root, service, &prefix)?;
                if !current.metadata()?.is_dir() {
                    return Err(ApplyError::Changed);
                }
            }
        }
        Ok(open_relative(root, service, parent)?)
    }
    fn optional(service: &FsService, root: &File, path: &str) -> Result<Option<File>, ApplyError> {
        valid(path)?;
        match open_relative(root, service, path) {
            Ok(file) => Ok(Some(file)),
            Err(InventoryError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn witness(file: &mut File) -> Result<FileWitness, ApplyError> {
        let before = file.metadata()?;
        if !before.is_file() || before.nlink() != 1 {
            return Err(ApplyError::Changed);
        }
        if before.len() > MAX_FILE_BYTES {
            return Err(ApplyError::Limit);
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut count = 0u64;
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            count = count.checked_add(n as u64).ok_or(ApplyError::Limit)?;
            if count > MAX_FILE_BYTES {
                return Err(ApplyError::Limit);
            }
            hash.update(&buffer[..n]);
        }
        let after = file.metadata()?;
        let stamp = |m: &std::fs::Metadata| {
            (
                m.dev(),
                m.ino(),
                m.len(),
                m.mode(),
                m.nlink(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
            )
        };
        if stamp(&before) != stamp(&after) || count != before.len() {
            return Err(ApplyError::Changed);
        }
        let sha256 = format!("{:x}", hash.finalize());
        let identity = format!(
            "{:x}",
            Sha256::digest(format!(
                "xh-sync-inode-v1:{}:{}:{}:{}:{}:{}:{}:{}",
                before.dev(),
                before.ino(),
                before.len(),
                before.mode(),
                before.nlink(),
                before.mtime(),
                before.mtime_nsec(),
                sha256
            ))
        );
        let exact = format!(
            "{:x}",
            Sha256::digest(format!(
                "xh-sync-exact-v1:{identity}:{}:{}",
                before.ctime(),
                before.ctime_nsec()
            ))
        );
        Ok(FileWitness {
            exact,
            identity,
            sha256,
            bytes: count,
            executable: before.mode() & 0o111 != 0,
        })
    }
    pub(super) fn read_record(
        service: &FsService,
        root: &File,
        name: &str,
    ) -> Result<Option<Vec<u8>>, ApplyError> {
        let Some(mut file) = optional(service, root, &key(name)?)? else {
            return Ok(None);
        };
        let meta = file.metadata()?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.mode() & 0o077 != 0
            || meta.len() > MAX_RECORD_BYTES as u64
        {
            return Err(ApplyError::Invalid);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_RECORD_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(ApplyError::Limit);
        }
        Ok(Some(bytes))
    }
    fn rename(
        service: &FsService,
        parent: &File,
        path: &str,
        from: &str,
        to: &str,
        replace: bool,
    ) -> Result<(), ApplyError> {
        let target = physical(service, parent, path, to)?;
        publish_temp(
            &target,
            OsStr::new(from),
            if replace {
                PublishMode::Replace
            } else {
                PublishMode::Create
            },
        )?;
        parent.sync_all()?;
        physical(service, parent, path, to)?;
        Ok(())
    }
    impl SyncLease {
        pub fn root_identity(&self) -> Result<String, ApplyError> {
            check_root(&self.service, &self.root)?;
            let meta = self.root.metadata()?;
            Ok(format!(
                "{:x}",
                Sha256::digest(format!(
                    "xh-sync-root-v1:{}:{}:{}",
                    meta.dev(),
                    meta.ino(),
                    self.service.inner.root.display()
                ))
            ))
        }
        pub fn read_record(&self, name: &str) -> Result<Option<Vec<u8>>, ApplyError> {
            read_record(&self.service, &self.root, name)
        }
        /// Atomic replacement is ONLY for private native journal metadata, never
        /// for workspace content. Any error leaves the transaction unacknowledged.
        pub fn write_record(&self, name: &str, bytes: &[u8]) -> Result<(), ApplyError> {
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(ApplyError::Limit);
            }
            read_record(&self.service, &self.root, name)?;
            let name = key(name)?;
            let nonce = crate::NEXT_TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_nanos();
            let temp = format!(".xh-sync-record-{timestamp}-{nonce}.tmp");
            let mut file = File::from(
                openat(
                    &self.root,
                    temp.as_str(),
                    OFlag::O_WRONLY
                        | OFlag::O_CREAT
                        | OFlag::O_EXCL
                        | OFlag::O_NOFOLLOW
                        | OFlag::O_CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|e| io::Error::from_raw_os_error(e as i32))?,
            );
            file.write_all(bytes)?;
            file.sync_all()?;
            rename(&self.service, &self.root, &name, &temp, &name, true)
        }
        pub fn probe(&self, path: &str) -> Result<Option<FileWitness>, ApplyError> {
            let Some(mut file) = optional(&self.service, &self.root, path)? else {
                return Ok(None);
            };
            let result = witness(&mut file)?;
            let mut current =
                optional(&self.service, &self.root, path)?.ok_or(ApplyError::Changed)?;
            if witness(&mut current)? != result {
                return Err(ApplyError::Changed);
            }
            Ok(Some(result))
        }
        fn names(path: &str, operation: &str) -> Result<(String, String, String), ApplyError> {
            valid(path)?;
            if operation.len() != 64
                || !operation
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                return Err(ApplyError::Invalid);
            }
            let prefix = Path::new(path)
                .parent()
                .and_then(Path::to_str)
                .ok_or(ApplyError::Invalid)?;
            let prefix = if prefix.is_empty() {
                String::new()
            } else {
                format!("{prefix}/")
            };
            Ok((
                format!("{prefix}.xh-sync-{operation}.new"),
                format!("{prefix}.xh-sync-{operation}.old"),
                Path::new(path)
                    .file_name()
                    .and_then(OsStr::to_str)
                    .ok_or(ApplyError::Invalid)?
                    .into(),
            ))
        }
        /// Stage a bounded stream with whole-file verification; no workspace
        /// destination is changed. Existing stages are reconciled, not replaced.
        pub fn stage_from(
            &self,
            source: &SyncLease,
            spec: StageSpec<'_>,
        ) -> Result<FileWitness, ApplyError> {
            let StageSpec {
                path,
                operation,
                source_exact,
                sha256,
                bytes,
                executable,
            } = spec;
            let (new, _, _) = Self::names(path, operation)?;
            if bytes > MAX_FILE_BYTES {
                return Err(ApplyError::Limit);
            }
            if let Some(existing) = self.probe(&new)? {
                if existing.sha256 == sha256
                    && existing.bytes == bytes
                    && existing.executable == executable
                {
                    let file =
                        optional(&self.service, &self.root, &new)?.ok_or(ApplyError::Changed)?;
                    file.sync_all()?;
                    parent(&self.service, &self.root, path, false)?.sync_all()?;
                    let current = self.probe(&new)?.ok_or(ApplyError::Changed)?;
                    if current != existing {
                        return Err(ApplyError::Changed);
                    }
                    return Ok(current);
                }
                // A crash during staging can leave partial private bytes. Keep
                // them as evidence; never unlink or replace an unknown inode.
                // This API is only called before the stage witness is journaled.
                let source_version = source.probe(path)?.ok_or(ApplyError::Changed)?;
                if source_version.exact != source_exact {
                    return Err(ApplyError::Changed);
                }
                let directory = parent(&self.service, &self.root, path, false)?;
                let new_name = Path::new(&new)
                    .file_name()
                    .and_then(OsStr::to_str)
                    .ok_or(ApplyError::Invalid)?;
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_nanos();
                rename(
                    &self.service,
                    &directory,
                    path,
                    new_name,
                    &format!("{new_name}.partial-{nonce}"),
                    false,
                )?;
            }
            let source_version = source.probe(path)?.ok_or(ApplyError::Changed)?;
            if source_version.exact != source_exact
                || source_version.sha256 != sha256
                || source_version.bytes != bytes
                || source_version.executable != executable
            {
                return Err(ApplyError::Changed);
            }
            let parent = parent(&self.service, &self.root, path, true)?;
            let name = Path::new(&new).file_name().ok_or(ApplyError::Invalid)?;
            let mut output = File::from(
                openat(
                    &parent,
                    Path::new(name),
                    OFlag::O_WRONLY
                        | OFlag::O_CREAT
                        | OFlag::O_EXCL
                        | OFlag::O_NOFOLLOW
                        | OFlag::O_CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|e| io::Error::from_raw_os_error(e as i32))?,
            );
            let mut input =
                optional(&source.service, &source.root, path)?.ok_or(ApplyError::Changed)?;
            let count = io::copy(
                &mut Read::by_ref(&mut input).take(MAX_FILE_BYTES + 1),
                &mut output,
            )?;
            if count != bytes
                || source.probe(path)?.as_ref().map(|v| v.exact.as_str()) != Some(source_exact)
            {
                return Err(ApplyError::Changed);
            }
            output.set_permissions(std::fs::Permissions::from_mode(if executable {
                0o700
            } else {
                0o600
            }))?;
            output.sync_all()?;
            parent.sync_all()?;
            let staged = self.probe(&new)?.ok_or(ApplyError::Changed)?;
            if staged.sha256 != sha256 || staged.bytes != bytes || staged.executable != executable {
                return Err(ApplyError::Changed);
            }
            Ok(staged)
        }
        /// Recover by recorded inode+full hash. Keep old bytes, never unlink a
        /// user file. No-replace moves can briefly leave the destination absent.
        /// They intentionally do not claim POSIX content-CAS against arbitrary writers.
        pub fn publish(
            &self,
            path: &str,
            operation: &str,
            before_exact: Option<&str>,
            before_identity: Option<&str>,
            staged_identity: &str,
        ) -> Result<FileWitness, ApplyError> {
            self.publish_inner(
                path,
                operation,
                (before_exact, before_identity, staged_identity),
                &mut || Ok(()),
            )
        }
        fn publish_inner(
            &self,
            path: &str,
            operation: &str,
            versions: (Option<&str>, Option<&str>, &str),
            checkpoint: &mut impl FnMut() -> Result<(), ApplyError>,
        ) -> Result<FileWitness, ApplyError> {
            let (before_exact, before_identity, staged_identity) = versions;
            let (new, old, name) = Self::names(path, operation)?;
            if before_exact.is_some() != before_identity.is_some() {
                return Err(ApplyError::Invalid);
            }
            let target = self.probe(path)?;
            let staged = self.probe(&new)?;
            let retained = self.probe(&old)?;
            if let Some(ref target) = target {
                if target.identity == staged_identity && staged.is_none() {
                    if retained.as_ref().map(|v| v.identity.as_str()) != before_identity {
                        return Err(ApplyError::Changed);
                    }
                    return Ok(target.clone());
                }
            }
            if staged.as_ref().map(|v| v.identity.as_str()) != Some(staged_identity) {
                return Err(ApplyError::Changed);
            }
            let parent = parent(&self.service, &self.root, path, false)?;
            let old_name = Path::new(&old)
                .file_name()
                .and_then(OsStr::to_str)
                .ok_or(ApplyError::Invalid)?;
            let new_name = Path::new(&new)
                .file_name()
                .and_then(OsStr::to_str)
                .ok_or(ApplyError::Invalid)?;
            match before_exact {
                Some(exact) if retained.is_none() => {
                    if target.as_ref().map(|v| v.exact.as_str()) != Some(exact) {
                        return Err(ApplyError::Changed);
                    }
                    rename(&self.service, &parent, path, &name, old_name, false)?;
                    if self.probe(&old)?.as_ref().map(|v| v.identity.as_str()) != before_identity {
                        return Err(ApplyError::Changed);
                    }
                    checkpoint()?;
                }
                Some(_) => {
                    if target.is_some()
                        || retained.as_ref().map(|v| v.identity.as_str()) != before_identity
                    {
                        return Err(ApplyError::Changed);
                    }
                }
                None => {
                    if target.is_some() || retained.is_some() {
                        return Err(ApplyError::Changed);
                    }
                }
            }
            rename(&self.service, &parent, path, new_name, &name, false)?;
            checkpoint()?;
            let result = self.probe(path)?.ok_or(ApplyError::Changed)?;
            if result.identity != staged_identity {
                return Err(ApplyError::Changed);
            }
            Ok(result)
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        struct Fixture(std::path::PathBuf);
        impl Fixture {
            fn new() -> Self {
                let nonce = crate::NEXT_TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path = std::env::temp_dir().join(format!("xh-native-apply-{stamp}-{nonce}"));
                std::fs::create_dir(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Err(error) = std::fs::remove_dir_all(&self.0) {
                    eprintln!("native apply fixture cleanup failed: {error}");
                }
            }
        }
        #[test]
        fn recovery_after_each_namespace_move_preserves_old_inode_and_never_reapplies() {
            for cut in [1, 2] {
                let src = Fixture::new();
                let dst = Fixture::new();
                std::fs::write(src.0.join("file"), b"new").unwrap();
                std::fs::write(dst.0.join("file"), b"old").unwrap();
                let source = FsService::new(&src.0).unwrap().sync_lease().unwrap();
                let destination = FsService::new(&dst.0).unwrap().sync_lease().unwrap();
                destination
                    .write_record("active", b"pending:native-test\n")
                    .unwrap();
                let before = destination.probe("file").unwrap().unwrap();
                let from = source.probe("file").unwrap().unwrap();
                let operation = "a".repeat(64);
                let stage = destination
                    .stage_from(
                        &source,
                        StageSpec {
                            path: "file",
                            operation: &operation,
                            source_exact: &from.exact,
                            sha256: &from.sha256,
                            bytes: from.bytes,
                            executable: false,
                        },
                    )
                    .unwrap();
                let mut counter = 0;
                let result = destination.publish_inner(
                    "file",
                    &operation,
                    (Some(&before.exact), Some(&before.identity), &stage.identity),
                    &mut || {
                        counter += 1;
                        if counter == cut {
                            Err(ApplyError::Io(io::Error::from(io::ErrorKind::Interrupted)))
                        } else {
                            Ok(())
                        }
                    },
                );
                assert!(result.is_err());
                drop(destination);
                let recovered = FsService::new(&dst.0).unwrap().sync_lease().unwrap();
                let published = recovered
                    .publish(
                        "file",
                        &operation,
                        Some(&before.exact),
                        Some(&before.identity),
                        &stage.identity,
                    )
                    .unwrap();
                assert_eq!(published.identity, stage.identity);
                let again = recovered
                    .publish(
                        "file",
                        &operation,
                        Some(&before.exact),
                        Some(&before.identity),
                        &stage.identity,
                    )
                    .unwrap();
                assert_eq!(again, published);
                assert_eq!(std::fs::read(dst.0.join("file")).unwrap(), b"new");
                assert_eq!(
                    std::fs::read(dst.0.join(format!(".xh-sync-{operation}.old"))).unwrap(),
                    b"old"
                );
            }
        }
        #[test]
        fn foreign_arrival_in_gap_is_not_overwritten_even_when_bytes_match() {
            let src = Fixture::new();
            let dst = Fixture::new();
            std::fs::write(src.0.join("file"), b"new").unwrap();
            std::fs::write(dst.0.join("file"), b"old").unwrap();
            let source = FsService::new(&src.0).unwrap().sync_lease().unwrap();
            let destination = FsService::new(&dst.0).unwrap().sync_lease().unwrap();
            let before = destination.probe("file").unwrap().unwrap();
            let from = source.probe("file").unwrap().unwrap();
            let operation = "b".repeat(64);
            let stage = destination
                .stage_from(
                    &source,
                    StageSpec {
                        path: "file",
                        operation: &operation,
                        source_exact: &from.exact,
                        sha256: &from.sha256,
                        bytes: from.bytes,
                        executable: false,
                    },
                )
                .unwrap();
            let result = destination.publish_inner(
                "file",
                &operation,
                (Some(&before.exact), Some(&before.identity), &stage.identity),
                &mut || {
                    std::fs::write(dst.0.join("file"), b"new").unwrap();
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert!(destination
                .publish(
                    "file",
                    &operation,
                    Some(&before.exact),
                    Some(&before.identity),
                    &stage.identity
                )
                .is_err());
            assert_eq!(std::fs::read(dst.0.join("file")).unwrap(), b"new");
            assert!(dst.0.join(format!(".xh-sync-{operation}.new")).exists());
            assert_eq!(
                std::fs::read(dst.0.join(format!(".xh-sync-{operation}.old"))).unwrap(),
                b"old"
            );
        }
        #[test]
        fn partial_private_stage_is_preserved_and_rebuilt_before_publication() {
            let src = Fixture::new();
            let dst = Fixture::new();
            std::fs::write(src.0.join("file"), b"complete").unwrap();
            let source = FsService::new(&src.0).unwrap().sync_lease().unwrap();
            let destination = FsService::new(&dst.0).unwrap().sync_lease().unwrap();
            let from = source.probe("file").unwrap().unwrap();
            let operation = "c".repeat(64);
            let partial = dst.0.join(format!(".xh-sync-{operation}.new"));
            std::fs::write(&partial, b"interrupted").unwrap();
            let stage = destination
                .stage_from(
                    &source,
                    StageSpec {
                        path: "file",
                        operation: &operation,
                        source_exact: &from.exact,
                        sha256: &from.sha256,
                        bytes: from.bytes,
                        executable: false,
                    },
                )
                .unwrap();
            destination
                .publish("file", &operation, None, None, &stage.identity)
                .unwrap();
            assert_eq!(std::fs::read(dst.0.join("file")).unwrap(), b"complete");
            let retained: Vec<_> = std::fs::read_dir(&dst.0)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| {
                    p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .contains(".partial-")
                })
                .collect();
            assert_eq!(retained.len(), 1);
            assert_eq!(std::fs::read(&retained[0]).unwrap(), b"interrupted");
        }
        #[test]
        fn full_hash_detects_change_outside_model_sampling_and_rejects_hardlinks() {
            use std::io::{Seek, SeekFrom};
            let fixture = Fixture::new();
            let path = fixture.0.join("large");
            let file = std::fs::File::create(&path).unwrap();
            file.set_len(5 * 1024 * 1024).unwrap();
            let lease = FsService::new(&fixture.0).unwrap().sync_lease().unwrap();
            let before = lease.probe("large").unwrap().unwrap();
            let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.seek(SeekFrom::Start(321_654)).unwrap();
            file.write_all(b"changed").unwrap();
            let after = lease.probe("large").unwrap().unwrap();
            assert_ne!(before.sha256, after.sha256);
            std::fs::hard_link(&path, fixture.0.join("alias")).unwrap();
            assert!(lease.probe("large").is_err());
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl SyncLease {
    pub fn root_identity(&self) -> Result<String, ApplyError> {
        Err(ApplyError::Unsupported)
    }
    pub fn read_record(&self, _: &str) -> Result<Option<Vec<u8>>, ApplyError> {
        Err(ApplyError::Unsupported)
    }
    pub fn write_record(&self, _: &str, _: &[u8]) -> Result<(), ApplyError> {
        Err(ApplyError::Unsupported)
    }
    pub fn probe(&self, _: &str) -> Result<Option<FileWitness>, ApplyError> {
        Err(ApplyError::Unsupported)
    }
    pub fn stage_from(&self, _: &SyncLease, _: StageSpec<'_>) -> Result<FileWitness, ApplyError> {
        Err(ApplyError::Unsupported)
    }
    pub fn publish(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: Option<&str>,
        _: &str,
    ) -> Result<FileWitness, ApplyError> {
        Err(ApplyError::Unsupported)
    }
}
