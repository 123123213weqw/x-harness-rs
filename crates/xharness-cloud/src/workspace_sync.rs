//! Pure bidirectional workspace reconciliation. A plan is NOT a filesystem
//! capability, execution lease, transfer receipt, or permission to delete files.
//! Native adapters must capture full content hashes without following symlinks,
//! apply each change with observed-version CAS, and durably reconcile partial
//! outcomes before publishing a new common base. No Host/Agent or I/O lives here.
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

use crate::{CloudError, CloudResult, Counter, ErrorCode, Id, Sha256Digest, VersionedRef};
use caseless::Caseless;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

pub const MAX_SYNC_FILES: usize = 100_000;
pub const MAX_SYNC_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SYNC_FILE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_SYNC_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_SYNC_PATH_COMPONENTS: usize = 128;

fn invalid(message: &'static str) -> CloudError {
    CloudError::new(ErrorCode::InvalidRequest, message)
}
fn conflict(message: &'static str) -> CloudError {
    CloudError::new(ErrorCode::RevisionConflict, message)
}
fn hash(domain: &[u8], value: &impl Serialize) -> CloudResult<Sha256Digest> {
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(
        serde_json::to_vec(value).map_err(|_| invalid("workspace identity encoding failed"))?,
    );
    Sha256Digest::new(format!("{:x}", hash.finalize()))
}

/// Full-content identity, not mtime or the filesystem tool's large-file sample.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncFile {
    pub sha256: Sha256Digest,
    pub bytes: Counter,
    pub executable: bool,
}
impl SyncFile {
    pub fn from_bytes(bytes: &[u8], executable: bool) -> CloudResult<Self> {
        if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
            return Err(invalid("workspace file exceeds sync byte limit"));
        }
        let file = Self {
            sha256: Sha256Digest::new(format!("{:x}", Sha256::digest(bytes)))?,
            bytes: Counter(bytes.len() as u64),
            executable,
        };
        file.validate()?;
        Ok(file)
    }
    fn validate(&self) -> CloudResult<()> {
        if self.bytes.0 > MAX_SYNC_FILE_BYTES {
            return Err(invalid("workspace file exceeds sync byte limit"));
        }
        Ok(())
    }
    pub fn verify_content(&self, bytes: &[u8]) -> CloudResult<()> {
        self.validate()?;
        if self.bytes.0 != bytes.len() as u64
            || self.sha256.as_str() != format!("{:x}", Sha256::digest(bytes))
        {
            return Err(conflict(
                "workspace content no longer matches its full hash",
            ));
        }
        Ok(())
    }
}

// Unicode canonical caseless matching, not lowercase guessing. Original path
// spelling is preserved for IO; this key is only for detecting aliases.
fn path_key(component: &str) -> String {
    component.nfd().default_case_fold().nfd().collect()
}

/// Native adapters must additionally certify the destination filesystem's own
/// name rules. Unsupported names fail capture; they must never be omitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapturePathClass {
    Include,
    Exclude,
}

/// Fixed personal capture policy: validate the original spelling, classify
/// exclusions BEFORE any native open, and never rewrite the path for I/O.
pub fn classify_capture_path(path: &str) -> CloudResult<CapturePathClass> {
    if path.is_empty() || path.len() > 4096 || path.split('/').count() > MAX_SYNC_PATH_COMPONENTS {
        return Err(invalid(
            "workspace sync requires a bounded portable relative path",
        ));
    }
    let mut excluded = false;
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > 255
            || part.ends_with(['.', ' '])
            || part.chars().any(char::is_control)
            || part.bytes().any(|b| b"\\:<>\"|?*".contains(&b))
        {
            return Err(invalid("workspace sync path is not portable"));
        }
        let lower = path_key(part);
        // Compatibility normalization is ONLY for denying device names such
        // as COM¹. Never use it to rewrite a user's actual path.
        let device_key: String = part.nfkc().default_case_fold().nfd().collect();
        let stem = device_key
            .split('.')
            .next()
            .ok_or_else(|| invalid("invalid workspace component"))?;
        if matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(invalid("workspace sync path uses a reserved device name"));
        }
        if matches!(
            lower.as_str(),
            ".git"
                | ".svn"
                | ".hg"
                | ".ssh"
                | ".aws"
                | ".azure"
                | ".gnupg"
                | "node_modules"
                | "target"
                | ".ds_store"
                | "id_rsa"
                | "id_ed25519"
                | ".envrc"
                | ".netrc"
                | ".npmrc"
                | ".pypirc"
                | ".git-credentials"
                | "credentials"
                | "credentials.json"
                | "auth.json"
                | "cookies.json"
        ) || lower == ".env"
            || lower.starts_with(".env.")
            || [".pem", ".key", ".p12", ".pfx"]
                .iter()
                .any(|s| lower.ends_with(s))
        {
            excluded = true;
        }
    }
    Ok(if excluded {
        CapturePathClass::Exclude
    } else {
        CapturePathClass::Include
    })
}

fn validate_path(path: &str) -> CloudResult<()> {
    match classify_capture_path(path)? {
        CapturePathClass::Include => Ok(()),
        CapturePathClass::Exclude => Err(invalid(
            "workspace sync contains a protected or excluded path",
        )),
    }
}

/// Immutable regular-file manifest. Capture adapters apply exclusions BEFORE
/// constructing this value, and report unsupported nodes/names, never drop them.
/// No deserializer can bypass validation or silently collapse duplicate paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceManifest {
    version: u8,
    files: BTreeMap<String, SyncFile>,
}
#[derive(Serialize)]
struct ManifestEntry<'a> {
    path: &'a str,
    file: &'a SyncFile,
}
impl WorkspaceManifest {
    pub fn new(files: impl IntoIterator<Item = (String, SyncFile)>) -> CloudResult<Self> {
        let mut map = BTreeMap::new();
        let mut total = 0u64;
        let mut metadata_bytes = b"{\"version\":1,\"files\":[]}".len();
        for (path, file) in files {
            validate_path(&path)?;
            file.validate()?;
            total = total
                .checked_add(file.bytes.0)
                .ok_or_else(|| invalid("workspace byte count overflow"))?;
            if total > MAX_SYNC_TOTAL_BYTES {
                return Err(invalid("workspace exceeds total sync byte limit"));
            }
            let entry_bytes = serde_json::to_vec(&ManifestEntry {
                path: &path,
                file: &file,
            })
            .map_err(|_| invalid("workspace manifest encoding failed"))?
            .len();
            metadata_bytes = metadata_bytes
                .checked_add(entry_bytes + usize::from(!map.is_empty()))
                .ok_or_else(|| invalid("workspace metadata byte count overflow"))?;
            if metadata_bytes > MAX_SYNC_MANIFEST_BYTES {
                return Err(invalid("workspace manifest exceeds metadata byte limit"));
            }
            if map.insert(path, file).is_some() {
                return Err(invalid("workspace manifest repeats a path"));
            }
            if map.len() > MAX_SYNC_FILES {
                return Err(invalid("workspace manifest exceeds file limit"));
            }
        }
        validate_tree(map.keys().map(String::as_str))?;
        Ok(Self {
            version: 1,
            files: map,
        })
    }
    pub fn from_json(bytes: &[u8]) -> CloudResult<Self> {
        if bytes.len() > MAX_SYNC_MANIFEST_BYTES {
            return Err(invalid("workspace manifest exceeds metadata byte limit"));
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            version: u8,
            files: Vec<Entry>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Entry {
            path: String,
            file: SyncFile,
        }
        let wire: Wire =
            serde_json::from_slice(bytes).map_err(|_| invalid("invalid workspace manifest"))?;
        if wire.version != 1 {
            return Err(invalid("unsupported workspace manifest version"));
        }
        Self::new(wire.files.into_iter().map(|e| (e.path, e.file)))
    }
    /// Entries, rather than a JSON object, keep duplicate keys observable.
    pub fn to_json(&self) -> CloudResult<Vec<u8>> {
        serde_json::to_vec(self).map_err(|_| invalid("workspace manifest encoding failed"))
    }
    pub fn files(&self) -> &BTreeMap<String, SyncFile> {
        &self.files
    }
    pub fn digest(&self) -> CloudResult<Sha256Digest> {
        hash(b"xharness-workspace-manifest/v1\n", self)
    }
}
impl Serialize for WorkspaceManifest {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            version: u8,
            files: Vec<ManifestEntry<'a>>,
        }
        Wire {
            version: self.version,
            files: self
                .files
                .iter()
                .map(|(path, file)| ManifestEntry { path, file })
                .collect(),
        }
        .serialize(serializer)
    }
}

fn validate_tree<'a>(paths: impl IntoIterator<Item = &'a str>) -> CloudResult<()> {
    validate_tree_entries(paths.into_iter().map(|path| (path, false)), false)
}

/// Validate directories too, including empty ones which are absent from a
/// regular-file manifest. bool=true denotes a directory, not a file.
pub fn validate_capture_tree<'a>(
    paths: impl IntoIterator<Item = (&'a str, bool)>,
) -> CloudResult<()> {
    validate_tree_entries(paths, true)
}

fn validate_tree_entries<'a>(
    paths: impl IntoIterator<Item = (&'a str, bool)>,
    validate_names: bool,
) -> CloudResult<()> {
    struct Node {
        spelling: String,
        file: bool,
        children: BTreeMap<String, Node>,
    }
    let mut roots = BTreeMap::<String, Node>::new();
    for (path, directory) in paths {
        if validate_names {
            validate_path(path)?;
        }
        let mut parts = path.split('/').peekable();
        let mut siblings = &mut roots;
        while let Some(part) = parts.next() {
            let file = parts.peek().is_none() && !directory;
            let node = siblings.entry(path_key(part)).or_insert_with(|| Node {
                spelling: part.into(),
                file,
                children: BTreeMap::new(),
            });
            if node.spelling != part {
                return Err(conflict("workspace paths alias across platforms"));
            }
            if node.file != file {
                return Err(conflict("workspace file conflicts with a directory path"));
            }
            siblings = &mut node.children;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceSyncScope {
    pair_id: Id,
    generation: Counter,
    local_environment: Id,
    cloud_environment: Id,
    capture_policy: VersionedRef,
}
impl WorkspaceSyncScope {
    pub fn new(
        pair_id: Id,
        generation: Counter,
        local_environment: Id,
        cloud_environment: Id,
        capture_policy: VersionedRef,
    ) -> CloudResult<Self> {
        if local_environment == cloud_environment {
            return Err(invalid("workspace sync requires two distinct environments"));
        }
        Ok(Self {
            pair_id,
            generation,
            local_environment,
            cloud_environment,
            capture_policy,
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncSide {
    Local,
    Cloud,
}

/// None -> Some is create; Some -> None is an explicitly reviewable deletion.
/// Both sides' before identities must be checked by the native CAS adapter.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceChange {
    pub side: SyncSide,
    pub path: String,
    pub before: Option<SyncFile>,
    pub after: Option<SyncFile>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceConflict {
    pub path: String,
    pub base: Option<SyncFile>,
    pub local: Option<SyncFile>,
    pub cloud: Option<SyncFile>,
}
/// Private construction and no Deserialize: a browser cannot forge an apply
/// plan or change its destination. Even a valid plan grants no native lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceSyncPlan {
    scope: WorkspaceSyncScope,
    base_sha256: Sha256Digest,
    local_sha256: Sha256Digest,
    cloud_sha256: Sha256Digest,
    changes: Vec<WorkspaceChange>,
    conflicts: Vec<WorkspaceConflict>,
    proposed_base: Option<WorkspaceManifest>,
}
impl WorkspaceSyncPlan {
    pub fn build(
        scope: WorkspaceSyncScope,
        base: &WorkspaceManifest,
        local: &WorkspaceManifest,
        cloud: &WorkspaceManifest,
    ) -> CloudResult<Self> {
        let paths: BTreeSet<_> = base
            .files
            .keys()
            .chain(local.files.keys())
            .chain(cloud.files.keys())
            .cloned()
            .collect();
        // Reject case-only renames and file/directory replacement until a native
        // rename transaction can certify them. Never turn them into blind deletes.
        validate_tree(paths.iter().map(String::as_str))?;
        let mut changes = Vec::new();
        let mut conflicts = Vec::new();
        let mut merged = Vec::new();
        for path in paths {
            let b = base.files.get(&path);
            let l = local.files.get(&path);
            let c = cloud.files.get(&path);
            let next = if l == c {
                l
            } else if l == b {
                changes.push(WorkspaceChange {
                    side: SyncSide::Local,
                    path: path.clone(),
                    before: l.cloned(),
                    after: c.cloned(),
                });
                c
            } else if c == b {
                changes.push(WorkspaceChange {
                    side: SyncSide::Cloud,
                    path: path.clone(),
                    before: c.cloned(),
                    after: l.cloned(),
                });
                l
            } else {
                conflicts.push(WorkspaceConflict {
                    path: path.clone(),
                    base: b.cloned(),
                    local: l.cloned(),
                    cloud: c.cloned(),
                });
                None
            };
            if let Some(file) = next {
                merged.push((path, file.clone()));
            }
        }
        let proposed_base = if conflicts.is_empty() {
            Some(WorkspaceManifest::new(merged)?)
        } else {
            None
        };
        Ok(Self {
            scope,
            base_sha256: base.digest()?,
            local_sha256: local.digest()?,
            cloud_sha256: cloud.digest()?,
            changes,
            conflicts,
            proposed_base,
        })
    }
    pub fn conflicts(&self) -> &[WorkspaceConflict] {
        &self.conflicts
    }
    /// All-or-nothing admission: no nonconflicting subset may be applied while
    /// any path is unresolved. A file deletion still requires explicit native
    /// approval/retention policy outside this pure plan.
    pub fn changes(&self) -> CloudResult<&[WorkspaceChange]> {
        if !self.conflicts.is_empty() {
            return Err(conflict("workspace sync has unresolved conflicts"));
        }
        Ok(&self.changes)
    }
    pub fn digest(&self) -> CloudResult<Sha256Digest> {
        hash(b"xharness-workspace-sync-plan/v1\n", self)
    }
    /// Revalidate BOTH ends, the exact pair/generation and the old common base.
    /// Passing this check is not a filesystem lock or a durable completion ack.
    pub fn check_inputs(
        &self,
        scope: &WorkspaceSyncScope,
        base: &WorkspaceManifest,
        local: &WorkspaceManifest,
        cloud: &WorkspaceManifest,
    ) -> CloudResult<()> {
        self.changes()?;
        if scope != &self.scope
            || base.digest()? != self.base_sha256
            || local.digest()? != self.local_sha256
            || cloud.digest()? != self.cloud_sha256
        {
            return Err(conflict(
                "workspace sync inputs changed; recapture both environments",
            ));
        }
        Ok(())
    }
    /// Only after native per-file completion/reconciliation, fresh observations
    /// of BOTH environments can confirm convergence. Merely building a plan or
    /// observing one side must never advance the persisted common base.
    pub fn check_converged(
        &self,
        scope: &WorkspaceSyncScope,
        local: &WorkspaceManifest,
        cloud: &WorkspaceManifest,
    ) -> CloudResult<()> {
        if scope != &self.scope {
            return Err(conflict("workspace sync scope changed"));
        }
        let base = self
            .proposed_base
            .as_ref()
            .ok_or_else(|| conflict("workspace sync has unresolved conflicts"))?;
        if local != base || cloud != base {
            return Err(conflict(
                "workspace sync has not converged on both environments",
            ));
        }
        Ok(())
    }
    /// Proposed metadata only, not a committed base or a migration receipt.
    pub fn proposed_base(&self) -> Option<&WorkspaceManifest> {
        self.proposed_base.as_ref()
    }
}
