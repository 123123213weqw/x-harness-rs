//! Native composition of fixed personal capture policy and pure sync metadata.
//! Opt-in synchronous port only: no RPC, scheduler, execution lease or sync apply.
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

use sha2::{Digest, Sha256};
use xharness_cloud::{
    workspace_sync::{
        classify_capture_path, validate_capture_tree, CapturePathClass, SyncFile, WorkspaceManifest,
    },
    CloudError, Counter, Id, Sha256Digest, VersionedRef,
};
use xharness_fs::{
    inventory::{
        InventoryDecision, InventoryError, InventoryLimits, InventoryPolicy, PolicyError,
        WorkspaceInventory,
    },
    FsService,
};

const POLICY_ID: &str = "personal-workspace-capture";
// Exact table versions and exclusion/portable-path rules are part of policy.
const POLICY_VERSION: &str = "v2-sync-reserved-unicode16-fold-unicode17-nfd";
struct PersonalPolicy;
impl InventoryPolicy for PersonalPolicy {
    fn identity(&self) -> [u8; 32] {
        Sha256::digest(format!(
            "xharness-inventory-policy\n{POLICY_ID}\n{POLICY_VERSION}\n"
        ))
        .into()
    }
    fn classify(&self, relative: &str) -> Result<InventoryDecision, PolicyError> {
        match classify_capture_path(relative)? {
            CapturePathClass::Include => Ok(InventoryDecision::Include),
            CapturePathClass::Exclude => Ok(InventoryDecision::Exclude),
        }
    }
}

#[derive(Debug)]
pub enum WorkspaceInventoryError {
    Native(InventoryError),
    Policy(CloudError),
}
impl std::fmt::Display for WorkspaceInventoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Native(_) => "native workspace inventory failed",
            Self::Policy(_) => "workspace inventory policy or manifest validation failed",
        })
    }
}
impl std::error::Error for WorkspaceInventoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Native(error) => error,
            Self::Policy(error) => error,
        })
    }
}
impl From<InventoryError> for WorkspaceInventoryError {
    fn from(error: InventoryError) -> Self {
        Self::Native(error)
    }
}
impl From<CloudError> for WorkspaceInventoryError {
    fn from(error: CloudError) -> Self {
        Self::Policy(error)
    }
}

/// No public constructor/deserializer: metadata JSON is not native provenance.
pub struct CapturedWorkspaceInventory {
    native: WorkspaceInventory,
    manifest: WorkspaceManifest,
}
impl CapturedWorkspaceInventory {
    pub fn usage(&self) -> xharness_fs::inventory::InventoryUsage {
        self.native.usage()
    }
    pub fn manifest(&self) -> &WorkspaceManifest {
        &self.manifest
    }
    pub fn policy_ref(&self) -> Result<VersionedRef, WorkspaceInventoryError> {
        policy_ref()
    }
    pub fn excluded_entries(&self) -> usize {
        self.native.excluded_entries()
    }
    /// Includes empty directories as native witnesses; the current pure sync
    /// manifest still represents regular files only, not directory apply jobs.
    pub fn directories(&self) -> impl Iterator<Item = &str> {
        self.native.directories()
    }
    pub fn revalidate(&self, service: &FsService) -> Result<(), WorkspaceInventoryError> {
        service.revalidate_inventory(&self.native, &PersonalPolicy)?;
        Ok(())
    }
}
impl std::fmt::Debug for CapturedWorkspaceInventory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapturedWorkspaceInventory")
            .field("files", &self.native.files().len())
            .field("excluded_entries", &self.excluded_entries())
            .finish_non_exhaustive()
    }
}
pub fn policy_ref() -> Result<VersionedRef, WorkspaceInventoryError> {
    Ok(VersionedRef {
        id: Id::new(POLICY_ID)?,
        version: Id::new(POLICY_VERSION)?,
    })
}

pub fn capture_workspace_inventory(
    service: &FsService,
    limits: InventoryLimits,
) -> Result<CapturedWorkspaceInventory, WorkspaceInventoryError> {
    let native = service.capture_inventory(&PersonalPolicy, limits)?;
    validate_capture_tree(
        native
            .files()
            .iter()
            .map(|file| (file.path(), false))
            .chain(native.directories().map(|path| (path, true))),
    )?;
    let files = native
        .files()
        .iter()
        .map(|file| {
            Ok((
                file.path().to_owned(),
                SyncFile {
                    sha256: Sha256Digest::new(file.sha256_hex())?,
                    bytes: Counter(file.bytes()),
                    executable: file.executable(),
                },
            ))
        })
        .collect::<Result<Vec<_>, CloudError>>()?;
    let manifest = WorkspaceManifest::new(files)?;
    Ok(CapturedWorkspaceInventory { native, manifest })
}
