//! Opt-in native two-endpoint executor. No browser-selected root or RPC, and no
//! automatic session migration. Both FsServices must be native owner configured,
//! mounted locally (including an explicitly certified remote filesystem adapter).
//! This synchronous port is NOT yet a cloud transport or a UI enablement flag.
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

use crate::workspace_inventory::{
    capture_workspace_inventory, policy_ref, WorkspaceInventoryError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use xharness_cloud::{
    workspace_sync::{
        SyncFile, SyncSide, WorkspaceManifest, WorkspaceSyncPlan, WorkspaceSyncScope,
    },
    CloudError, Counter, Id,
};
use xharness_fs::{
    inventory::InventoryLimits,
    workspace_apply::{ApplyError, FileWitness, StageSpec, SyncLease},
    FsService,
};

const MAX_CHANGES: usize = 128;
#[derive(Debug)]
pub enum ExecutorError {
    Native(ApplyError),
    Inventory(WorkspaceInventoryError),
    Domain(CloudError),
    Encoding(serde_json::Error),
    Utf8(std::string::FromUtf8Error),
    Entropy(getrandom::Error),
    InvalidState,
    DeletionDisabled,
    BatchLimit,
    Interrupted,
}
impl std::fmt::Display for ExecutorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Native(_) => "native workspace sync failed",
            Self::Inventory(_) => "workspace sync inventory failed",
            Self::Domain(_) => "workspace sync plan validation failed",
            Self::Encoding(_) => "workspace sync journal encoding failed",
            Self::Utf8(_) => "workspace sync manifest encoding failed",
            Self::Entropy(_) => "workspace sync transaction entropy failed",
            Self::InvalidState => "workspace sync journal, binding or generation mismatch",
            Self::DeletionDisabled => "workspace sync deletion is disabled; no changes applied",
            Self::BatchLimit => "workspace sync batch exceeds native admission limits",
            Self::Interrupted => "workspace sync interrupted; durable recovery is required",
        })
    }
}
impl std::error::Error for ExecutorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Native(e) => Some(e),
            Self::Inventory(e) => Some(e),
            Self::Domain(e) => Some(e),
            Self::Encoding(e) => Some(e),
            Self::Utf8(e) => Some(e),
            // getrandom::Error has no std::error::Error implementation in this feature set.
            _ => None,
        }
    }
}
impl From<ApplyError> for ExecutorError {
    fn from(e: ApplyError) -> Self {
        Self::Native(e)
    }
}
impl From<WorkspaceInventoryError> for ExecutorError {
    fn from(e: WorkspaceInventoryError) -> Self {
        Self::Inventory(e)
    }
}
impl From<CloudError> for ExecutorError {
    fn from(e: CloudError) -> Self {
        Self::Domain(e)
    }
}
impl From<serde_json::Error> for ExecutorError {
    fn from(e: serde_json::Error) -> Self {
        Self::Encoding(e)
    }
}

type SyncResult<T> = std::result::Result<T, ExecutorError>;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    version: u8,
    pair: String,
    local_environment: String,
    cloud_environment: String,
    local_root: String,
    cloud_root: String,
    policy: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Base {
    binding: Binding,
    generation: u64,
    manifest: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Witness {
    exact: String,
    identity: String,
}
impl From<FileWitness> for Witness {
    fn from(v: FileWitness) -> Self {
        Self {
            exact: v.exact,
            identity: v.identity,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    cloud: bool,
    path: String,
    id: String,
    before: Option<Witness>,
    source: Witness,
    after: SyncFile,
    staged: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Round {
    binding: Binding,
    id: String,
    old_base: Base,
    proposed: String,
    operations: Vec<Operation>,
    decision: Option<Base>,
}

/// Owner fault/test observation seam, never a remote/model-provided callback.
/// A false return simulates losing the reply AFTER the named durable action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checkpoint {
    Intent,
    Stage,
    Publish,
    Prepared,
    Decision,
    CloudBase,
    BothBases,
    CloudReleased,
}
#[derive(Debug)]
pub struct SyncReport {
    pub generation: u64,
    pub applied_files: usize,
    pub recovered: bool,
    pub common_base_sha256: String,
}

/// Root authority is supplied by native composition, not deserialized metadata.
/// The owner must drain managed sessions and independently quiesce other writers.
/// Nonblocking leases reject busy workspaces; this never kills tasks or switches UI.
pub struct WorkspacePair<'a> {
    local: &'a FsService,
    cloud: &'a FsService,
    pair: Id,
    local_environment: Id,
    cloud_environment: Id,
}
impl<'a> WorkspacePair<'a> {
    pub fn new(
        local: &'a FsService,
        cloud: &'a FsService,
        pair: Id,
        local_environment: Id,
        cloud_environment: Id,
    ) -> SyncResult<Self> {
        if local_environment == cloud_environment
            || local.workspace_root().starts_with(cloud.workspace_root())
            || cloud.workspace_root().starts_with(local.workspace_root())
        {
            return Err(ExecutorError::InvalidState);
        }
        Ok(Self {
            local,
            cloud,
            pair,
            local_environment,
            cloud_environment,
        })
    }
    pub fn synchronize(&self) -> SyncResult<SyncReport> {
        self.synchronize_observed(|_| true)
    }
    pub fn synchronize_observed(
        &self,
        mut observer: impl FnMut(Checkpoint) -> bool,
    ) -> SyncResult<SyncReport> {
        let local = self.local.sync_lease()?;
        let cloud = self.cloud.sync_lease()?;
        let binding = self.binding(&local, &cloud)?;
        if binding.local_root == binding.cloud_root {
            return Err(ExecutorError::InvalidState);
        }
        let active = local.read_record("active")?;
        let recovered = active.as_ref().is_some_and(|a| a != b"idle\n");
        let mut round = if recovered {
            let round: Round =
                serde_json::from_slice(active.as_deref().ok_or(ExecutorError::InvalidState)?)?;
            self.validate_round(&binding, &round)?;
            round
        } else {
            if cloud
                .read_record("active")?
                .as_ref()
                .is_some_and(|a| a != b"idle\n")
            {
                return Err(ExecutorError::InvalidState);
            }
            self.plan(&local, &cloud, binding.clone())?
        };
        let marker = format!("pending:{}\n", round.id).into_bytes();
        if let Some(active) = cloud.read_record("active")? {
            if active != b"idle\n" && active != marker {
                return Err(ExecutorError::InvalidState);
            }
        }
        if round.decision.is_none() {
            for endpoint in [&local, &cloud] {
                let base = load::<Base>(endpoint, "base")?;
                if !(base.as_ref() == Some(&round.old_base)
                    || (base.is_none() && round.old_base.generation == 0))
                {
                    return Err(ExecutorError::InvalidState);
                }
            }
        }
        // Intent must be durable before any stage, directory or user-file effect.
        store(&local, "active", &round)?;
        cloud.write_record("active", &marker)?;
        checkpoint(&mut observer, Checkpoint::Intent)?;
        if round.decision.is_none() {
            for index in 0..round.operations.len() {
                let op = round
                    .operations
                    .get(index)
                    .ok_or(ExecutorError::InvalidState)?
                    .clone();
                let (destination, source) = if op.cloud {
                    (&cloud, &local)
                } else {
                    (&local, &cloud)
                };
                let staged = if let Some(staged) = op.staged {
                    staged
                } else {
                    // No destination mutation is authorized by a mere manifest hash.
                    let current = destination.probe(&op.path)?;
                    if current.as_ref().map(|v| v.exact.as_str())
                        != op.before.as_ref().map(|v| v.exact.as_str())
                    {
                        return Err(ExecutorError::InvalidState);
                    }
                    let staged = destination.stage_from(
                        source,
                        StageSpec {
                            path: &op.path,
                            operation: &op.id,
                            source_exact: &op.source.exact,
                            sha256: op.after.sha256.as_str(),
                            bytes: op.after.bytes.0,
                            executable: op.after.executable,
                        },
                    )?;
                    round
                        .operations
                        .get_mut(index)
                        .ok_or(ExecutorError::InvalidState)?
                        .staged = Some(staged.identity.clone());
                    store(&local, "active", &round)?;
                    checkpoint(&mut observer, Checkpoint::Stage)?;
                    staged.identity
                };
                destination.publish(
                    &op.path,
                    &op.id,
                    op.before.as_ref().map(|v| v.exact.as_str()),
                    op.before.as_ref().map(|v| v.identity.as_str()),
                    &staged,
                )?;
                checkpoint(&mut observer, Checkpoint::Publish)?;
            }
            let local_inventory =
                capture_workspace_inventory(local.service(), InventoryLimits::default())?;
            let cloud_inventory =
                capture_workspace_inventory(cloud.service(), InventoryLimits::default())?;
            let proposed = WorkspaceManifest::from_json(round.proposed.as_bytes())?;
            if local_inventory.manifest() != &proposed || cloud_inventory.manifest() != &proposed {
                return Err(ExecutorError::InvalidState);
            }
            // Revalidate both full captures immediately before preparing a base.
            local_inventory.revalidate(local.service())?;
            cloud_inventory.revalidate(cloud.service())?;
            let next = Base {
                binding,
                generation: round
                    .old_base
                    .generation
                    .checked_add(1)
                    .ok_or(ExecutorError::InvalidState)?,
                manifest: round.proposed.clone(),
            };
            store(&local, "prepared", &next)?;
            store(&cloud, "prepared", &next)?;
            checkpoint(&mut observer, Checkpoint::Prepared)?;
            round.decision = Some(next);
            // Durable commit decision precedes either endpoint base finalization.
            store(&local, "active", &round)?;
            checkpoint(&mut observer, Checkpoint::Decision)?;
        }
        let decision = round.decision.as_ref().ok_or(ExecutorError::InvalidState)?;
        self.validate_commit(&local, &cloud, &round, decision)?;
        store(&cloud, "base", decision)?;
        checkpoint(&mut observer, Checkpoint::CloudBase)?;
        store(&local, "base", decision)?;
        checkpoint(&mut observer, Checkpoint::BothBases)?;
        // Both bases are now durable. Releasing endpoints is not a distributed
        // atomic namespace switch; a crash here only needs idempotent finalization.
        cloud.write_record("active", b"idle\n")?;
        checkpoint(&mut observer, Checkpoint::CloudReleased)?;
        local.write_record("active", b"idle\n")?;
        Ok(SyncReport {
            generation: decision.generation,
            applied_files: round.operations.len(),
            recovered,
            common_base_sha256: WorkspaceManifest::from_json(decision.manifest.as_bytes())?
                .digest()?
                .as_str()
                .into(),
        })
    }
    fn binding(&self, local: &SyncLease, cloud: &SyncLease) -> SyncResult<Binding> {
        Ok(Binding {
            version: 1,
            pair: self.pair.as_str().into(),
            local_environment: self.local_environment.as_str().into(),
            cloud_environment: self.cloud_environment.as_str().into(),
            local_root: local.root_identity()?,
            cloud_root: cloud.root_identity()?,
            policy: serde_json::to_string(&policy_ref()?)?,
        })
    }
    fn scope(&self, generation: u64) -> SyncResult<WorkspaceSyncScope> {
        Ok(WorkspaceSyncScope::new(
            self.pair.clone(),
            Counter(generation),
            self.local_environment.clone(),
            self.cloud_environment.clone(),
            policy_ref()?,
        )?)
    }
    fn plan(&self, local: &SyncLease, cloud: &SyncLease, binding: Binding) -> SyncResult<Round> {
        let local_base = load::<Base>(local, "base")?;
        let cloud_base = load::<Base>(cloud, "base")?;
        let old_base = match (local_base, cloud_base) {
            (None, None) => Base {
                binding: binding.clone(),
                generation: 0,
                manifest: manifest_json(&WorkspaceManifest::new([])?)?,
            },
            (Some(l), Some(c)) if l == c && l.binding == binding => l,
            _ => return Err(ExecutorError::InvalidState),
        };
        let base = WorkspaceManifest::from_json(old_base.manifest.as_bytes())?;
        let l = capture_workspace_inventory(local.service(), InventoryLimits::default())?;
        let c = capture_workspace_inventory(cloud.service(), InventoryLimits::default())?;
        let scope = self.scope(old_base.generation)?;
        let plan = WorkspaceSyncPlan::build(scope.clone(), &base, l.manifest(), c.manifest())?;
        plan.check_inputs(&scope, &base, l.manifest(), c.manifest())?;
        let changes = plan.changes()?;
        if changes.iter().any(|c| c.after.is_none()) {
            return Err(ExecutorError::DeletionDisabled);
        }
        if changes.len() > MAX_CHANGES {
            return Err(ExecutorError::BatchLimit);
        }
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(ExecutorError::Entropy)?;
        let id = format!("{:x}", Sha256::digest(entropy));
        let mut operations = Vec::new();
        for (index, change) in changes.iter().enumerate() {
            let is_cloud = change.side == SyncSide::Cloud;
            let (destination, source) = if is_cloud {
                (cloud, local)
            } else {
                (local, cloud)
            };
            let before = destination.probe(&change.path)?;
            if !matches_file(before.as_ref(), change.before.as_ref()) {
                return Err(ExecutorError::InvalidState);
            }
            let after = change
                .after
                .as_ref()
                .ok_or(ExecutorError::DeletionDisabled)?;
            let source = source
                .probe(&change.path)?
                .ok_or(ExecutorError::InvalidState)?;
            if !matches_file(Some(&source), Some(after)) {
                return Err(ExecutorError::InvalidState);
            }
            operations.push(Operation {
                cloud: is_cloud,
                path: change.path.clone(),
                id: format!("{:x}", Sha256::digest(format!("{id}:{index}"))),
                before: before.map(Into::into),
                source: source.into(),
                after: after.clone(),
                staged: None,
            });
        }
        let proposed = plan.proposed_base().ok_or(ExecutorError::InvalidState)?;
        preflight_tree(&l, proposed, &operations, false)?;
        preflight_tree(&c, proposed, &operations, true)?;
        l.revalidate(local.service())?;
        c.revalidate(cloud.service())?;
        let round = Round {
            binding,
            id,
            old_base,
            proposed: manifest_json(plan.proposed_base().ok_or(ExecutorError::InvalidState)?)?,
            operations,
            decision: None,
        };
        // Reserve worst-case stage receipts AND the eventual commit decision
        // before the first effect, not halfway through a nearly full journal.
        let mut largest = round.clone();
        for op in &mut largest.operations {
            op.staged = Some("f".repeat(64));
        }
        largest.decision = Some(Base {
            binding: largest.binding.clone(),
            generation: largest
                .old_base
                .generation
                .checked_add(1)
                .ok_or(ExecutorError::InvalidState)?,
            manifest: largest.proposed.clone(),
        });
        if serde_json::to_vec(&largest)?.len() > xharness_fs::workspace_apply::MAX_RECORD_BYTES {
            return Err(ExecutorError::BatchLimit);
        }
        Ok(round)
    }
    fn validate_round(&self, binding: &Binding, round: &Round) -> SyncResult<()> {
        if &round.binding != binding
            || round.old_base.binding != *binding
            || round.operations.len() > MAX_CHANGES
            || round.id.len() != 64
            || !round.id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(ExecutorError::InvalidState);
        }
        let proposed = WorkspaceManifest::from_json(round.proposed.as_bytes())?;
        WorkspaceManifest::from_json(round.old_base.manifest.as_bytes())?;
        let mut paths = std::collections::BTreeSet::new();
        for (index, op) in round.operations.iter().enumerate() {
            if !paths.insert(&op.path)
                || op.id != format!("{:x}", Sha256::digest(format!("{}:{index}", round.id)))
                || proposed.files().get(&op.path) != Some(&op.after)
            {
                return Err(ExecutorError::InvalidState);
            }
        }
        Ok(())
    }
    fn validate_commit(
        &self,
        local: &SyncLease,
        cloud: &SyncLease,
        round: &Round,
        decision: &Base,
    ) -> SyncResult<()> {
        if decision.binding != round.binding
            || decision.manifest != round.proposed
            || Some(decision.generation) != round.old_base.generation.checked_add(1)
        {
            return Err(ExecutorError::InvalidState);
        }
        for lease in [local, cloud] {
            if load::<Base>(lease, "prepared")?.as_ref() != Some(decision) {
                return Err(ExecutorError::InvalidState);
            }
            let base = load::<Base>(lease, "base")?;
            if !(base.is_none() && round.old_base.generation == 0)
                && base.as_ref() != Some(&round.old_base)
                && base.as_ref() != Some(decision)
            {
                return Err(ExecutorError::InvalidState);
            }
        }
        Ok(())
    }
}
fn matches_file(witness: Option<&FileWitness>, expected: Option<&SyncFile>) -> bool {
    match (witness, expected) {
        (None, None) => true,
        (Some(w), Some(e)) => {
            w.sha256 == e.sha256.as_str() && w.bytes == e.bytes.0 && w.executable == e.executable
        }
        _ => false,
    }
}
fn load<T: serde::de::DeserializeOwned>(lease: &SyncLease, key: &str) -> SyncResult<Option<T>> {
    lease
        .read_record(key)?
        .map(|b| serde_json::from_slice(&b).map_err(Into::into))
        .transpose()
}
fn store(lease: &SyncLease, key: &str, value: &impl Serialize) -> SyncResult<()> {
    lease.write_record(key, &serde_json::to_vec(value)?)?;
    Ok(())
}
fn checkpoint(observer: &mut impl FnMut(Checkpoint) -> bool, point: Checkpoint) -> SyncResult<()> {
    if observer(point) {
        Ok(())
    } else {
        Err(ExecutorError::Interrupted)
    }
}

fn manifest_json(manifest: &WorkspaceManifest) -> SyncResult<String> {
    String::from_utf8(manifest.to_json()?).map_err(ExecutorError::Utf8)
}

// Account for existing empty directories and reserved staging/retention names,
// not just the regular-file domain manifest. Reject future alias/quota failure
// before any directory creation or user-file publication.
fn preflight_tree(
    captured: &crate::workspace_inventory::CapturedWorkspaceInventory,
    proposed: &WorkspaceManifest,
    operations: &[Operation],
    cloud: bool,
) -> SyncResult<()> {
    xharness_cloud::workspace_sync::validate_capture_tree(
        captured
            .directories()
            .map(|p| (p, true))
            .chain(proposed.files().keys().map(|p| (p.as_str(), false))),
    )?;
    let usage = captured.usage();
    let limits = InventoryLimits::default();
    let mut entries = usage.entries;
    let mut metadata = usage.metadata_bytes;
    let mut directories: std::collections::BTreeSet<String> =
        captured.directories().map(str::to_owned).collect();
    let mut reserve = |path_len: usize, count: usize| -> SyncResult<()> {
        entries = entries
            .checked_add(count)
            .ok_or(ExecutorError::BatchLimit)?;
        metadata = metadata
            .checked_add(
                (path_len + 256)
                    .checked_mul(count)
                    .ok_or(ExecutorError::BatchLimit)?,
            )
            .ok_or(ExecutorError::BatchLimit)?;
        if entries > limits.entries || metadata > limits.metadata_bytes {
            return Err(ExecutorError::BatchLimit);
        }
        Ok(())
    };
    // Three control records and bounded metadata-publication transients; old
    // orphaned artifacts are already included in usage, never silently omitted.
    reserve(256, 8)?;
    for op in operations.iter().filter(|op| op.cloud == cloud) {
        let parent = op.path.rsplit_once('/').map_or("", |(p, _)| p);
        let staging_len = parent.len() + usize::from(!parent.is_empty()) + 77;
        if staging_len > 4096 {
            return Err(ExecutorError::BatchLimit);
        }
        reserve(staging_len, 3)?;
        if op.before.is_none() {
            reserve(op.path.len(), 1)?;
        }
        let mut prefix = String::new();
        for component in parent.split('/').filter(|p| !p.is_empty()) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(component);
            if directories.insert(prefix.clone()) {
                reserve(prefix.len(), 1)?;
            }
        }
    }
    if directories.len() + 1 > limits.directories || proposed.files().len() > limits.files {
        return Err(ExecutorError::BatchLimit);
    }
    Ok(())
}
