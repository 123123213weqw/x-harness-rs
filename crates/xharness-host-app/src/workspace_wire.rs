//! Owner-only SSH/stdio participant for controlled cross-machine source sync.
//! Transport objects are untrusted until full-hash validation. No browser route,
//! readonly-token promotion, deletion, automatic abort, task migration or UI flag.
//! A decided transaction rolls forward; ambiguous external writes fail closed.
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

use crate::{
    workspace_executor::ExecutorError,
    workspace_inventory::{capture_workspace_inventory, policy_ref},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use xharness_cloud::{
    workspace_sync::{
        validate_capture_tree, SyncFile, SyncSide, WorkspaceManifest, WorkspaceSyncPlan,
        WorkspaceSyncScope,
    },
    Counter, Id, VersionedRef,
};
use xharness_fs::{
    inventory::InventoryLimits,
    workspace_apply::{FileWitness, ReceivedStageSpec, SyncLease},
    FsService,
};

type WireResult<T> = std::result::Result<T, ExecutorError>;
pub const MAX_WIRE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ROUNDS: u64 = 128;
const MAX_SPOOL_BYTES: u64 = 64 * 1024 * 1024;
fn invalid<T>() -> WireResult<T> {
    Err(ExecutorError::InvalidState)
}
fn hash(v: &impl Serialize) -> WireResult<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(v)?)))
}
fn hex(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn manifest(v: &str) -> WireResult<WorkspaceManifest> {
    let m = WorkspaceManifest::from_json(v.as_bytes())?;
    if m.to_json()? != v.as_bytes() {
        return invalid();
    }
    if m.files().len() > 256
        || m.files()
            .values()
            .try_fold(0u64, |n, f| n.checked_add(f.bytes.0))
            .is_none_or(|n| n > MAX_BYTES as u64)
    {
        return Err(ExecutorError::BatchLimit);
    }
    Ok(m)
}
fn json(m: &WorkspaceManifest) -> WireResult<String> {
    String::from_utf8(m.to_json()?).map_err(ExecutorError::Utf8)
}
fn limits() -> InventoryLimits {
    InventoryLimits {
        files: 256,
        entries: 4096,
        directories: 1024,
        metadata_bytes: 1024 * 1024,
        file_bytes: MAX_BYTES,
        total_bytes: MAX_BYTES as u64,
        ..InventoryLimits::default()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Local,
    Cloud,
}
impl Role {
    fn peer(self) -> Self {
        match self {
            Self::Local => Self::Cloud,
            Self::Cloud => Self::Local,
        }
    }
    fn side(self) -> SyncSide {
        match self {
            Self::Local => SyncSide::Local,
            Self::Cloud => SyncSide::Cloud,
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub root: String,
    pub control: String,
    pub registration: String,
    pub spool: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub version: u8,
    pub pair: Id,
    pub epoch: u64,
    pub local: Descriptor,
    pub cloud: Descriptor,
    pub policy: VersionedRef,
}
impl Binding {
    fn descriptor(&self, role: Role) -> &Descriptor {
        match role {
            Role::Local => &self.local,
            Role::Cloud => &self.cloud,
        }
    }
    fn validate(&self) -> WireResult<()> {
        if self.version != 1
            || self.epoch == 0
            || self.epoch > 9_007_199_254_740_991
            || self.policy != policy_ref()?
        {
            return invalid();
        }
        let mut roots = BTreeSet::new();
        for d in [&self.local, &self.cloud] {
            for v in [&d.root, &d.control, &d.spool] {
                if !hex(v) || !roots.insert(v) {
                    return invalid();
                }
            }
            if !hex(&d.registration) {
                return invalid();
            }
        }
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Base {
    pub binding: String,
    pub generation: u64,
    pub manifest: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Observed {
    exact: String,
    identity: String,
    file: SyncFile,
}
impl Observed {
    fn from(w: FileWitness) -> WireResult<Self> {
        Ok(Self {
            exact: w.exact,
            identity: w.identity,
            file: SyncFile {
                sha256: xharness_cloud::Sha256Digest::new(w.sha256)?,
                bytes: Counter(w.bytes),
                executable: w.executable,
            },
        })
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub role: Role,
    pub base: Base,
    pub manifest: String,
    files: BTreeMap<String, Observed>,
    directories: BTreeSet<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    destination: Role,
    path: String,
    id: String,
    before: Option<Observed>,
    source: Observed,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Round {
    pub version: u8,
    pub id: String,
    pub binding: Binding,
    pub base: Base,
    pub local: Snapshot,
    pub cloud: Snapshot,
    pub proposed: String,
    operations: Vec<Operation>,
}
impl Round {
    fn snapshot(&self, role: Role) -> &Snapshot {
        match role {
            Role::Local => &self.local,
            Role::Cloud => &self.cloud,
        }
    }
    fn changes(
        binding: &Binding,
        base: &Base,
        l: &Snapshot,
        c: &Snapshot,
    ) -> WireResult<WorkspaceSyncPlan> {
        if l.role != Role::Local
            || c.role != Role::Cloud
            || l.base != *base
            || c.base != *base
            || base.binding != hash(binding)?
            || base.generation >= MAX_ROUNDS
        {
            return invalid();
        }
        for s in [l, c] {
            let m = manifest(&s.manifest)?;
            if s.files.len() != m.files().len()
                || s.files.iter().any(|(p, w)| {
                    m.files().get(p) != Some(&w.file) || !hex(&w.exact) || !hex(&w.identity)
                })
            {
                return invalid();
            }
            validate_capture_tree(
                s.directories
                    .iter()
                    .map(|p| (p.as_str(), true))
                    .chain(m.files().keys().map(|p| (p.as_str(), false))),
            )?;
        }
        let scope = WorkspaceSyncScope::new(
            binding.pair.clone(),
            Counter(base.generation),
            Id::new("local")?,
            Id::new("cloud")?,
            binding.policy.clone(),
        )?;
        let plan = WorkspaceSyncPlan::build(
            scope.clone(),
            &manifest(&base.manifest)?,
            &manifest(&l.manifest)?,
            &manifest(&c.manifest)?,
        )?;
        plan.check_inputs(
            &scope,
            &manifest(&base.manifest)?,
            &manifest(&l.manifest)?,
            &manifest(&c.manifest)?,
        )?;
        if plan.changes()?.iter().any(|c| c.after.is_none()) {
            return Err(ExecutorError::DeletionDisabled);
        }
        Ok(plan)
    }
    fn validate(&self) -> WireResult<()> {
        self.binding.validate()?;
        if self.version != 1
            || !hex(&self.id)
            || self.operations.len() > 128
            || serde_json::to_vec(self)?.len() > MAX_WIRE_BYTES / 2
        {
            return invalid();
        }
        let plan = Self::changes(&self.binding, &self.base, &self.local, &self.cloud)?;
        if plan.proposed_base() != Some(&manifest(&self.proposed)?) {
            return invalid();
        }
        let changes = plan.changes()?;
        if changes.len() != self.operations.len() {
            return invalid();
        }
        for (i, (op, c)) in self.operations.iter().zip(changes).enumerate() {
            let before = self.snapshot(op.destination).files.get(&op.path);
            let source = self.snapshot(op.destination.peer()).files.get(&op.path);
            if op.destination.side() != c.side
                || op.path != c.path
                || op.id != format!("{:x}", Sha256::digest(format!("{}:{i}", self.id)))
                || op.before.as_ref() != before
                || Some(&op.source) != source
                || Some(&op.source.file) != c.after.as_ref()
            {
                return invalid();
            }
        }
        for s in [&self.local, &self.cloud] {
            validate_capture_tree(
                s.directories.iter().map(|p| (p.as_str(), true)).chain(
                    manifest(&self.proposed)?
                        .files()
                        .keys()
                        .map(|p| (p.as_str(), false)),
                ),
            )?;
        }
        Ok(())
    }
    fn next(&self) -> WireResult<Base> {
        Ok(Base {
            binding: hash(&self.binding)?,
            generation: self
                .base
                .generation
                .checked_add(1)
                .ok_or(ExecutorError::InvalidState)?,
            manifest: self.proposed.clone(),
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Pending,
    Prepared,
    Decided,
    Applied,
    Complete,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub round: String,
    pub plan: String,
    pub role: Role,
    pub phase: Phase,
    pub generation: u64,
    pub manifest: String,
    pub stages: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    local: Receipt,
    cloud: Receipt,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    round: Round,
    role: Role,
    phase: Phase,
    stages: BTreeMap<String, Observed>,
    decision: Option<Decision>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub role: Role,
    pub binding: Binding,
    pub base: Base,
    pub phase: Option<Phase>,
    pub round: Option<Round>,
    pub receipt: Option<Receipt>,
    pub decision: Option<Decision>,
}

/// No deserialization of this authority. Native owner supplies three distinct
/// roots and the pinned registration. One process retains all exclusive leases;
/// disconnect releases locks, but the durable active marker continues fencing.
pub struct Participant {
    files: SyncLease,
    control: SyncLease,
    spool: SyncLease,
    descriptor: Descriptor,
    role: Role,
}
impl Participant {
    pub fn open(service: &FsService, spool: &FsService, role: Role) -> WireResult<Self> {
        let (control, registration) = service.sync_control().ok_or(ExecutorError::Unregistered)?;
        let roots = [
            service.workspace_root(),
            control.workspace_root(),
            spool.workspace_root(),
        ];
        for (i, a) in roots.iter().enumerate() {
            if roots
                .iter()
                .skip(i + 1)
                .any(|b| a.starts_with(b) || b.starts_with(a))
            {
                return invalid();
            }
        }
        let control = control.sync_lease()?;
        control.validate_private_root()?;
        let files = service.sync_lease()?;
        files.validate_control_binding(&control, registration)?;
        let spool = spool.sync_lease()?;
        spool.validate_private_root()?;
        let descriptor = Descriptor {
            root: files.root_identity()?,
            control: control.root_identity()?,
            registration: registration.into(),
            spool: spool.root_identity()?,
        };
        Ok(Self {
            files,
            control,
            spool,
            descriptor,
            role,
        })
    }
    pub fn descriptor(&self) -> &Descriptor {
        &self.descriptor
    }
    /// Explicit owner provisioning only, never part of the stdio request enum.
    pub fn bind_new(&self, binding: &Binding) -> WireResult<()> {
        binding.validate()?;
        if binding.descriptor(self.role) != &self.descriptor {
            return invalid();
        }
        let initial = Base {
            binding: hash(binding)?,
            generation: 0,
            manifest: json(&WorkspaceManifest::new([])?)?,
        };
        let pair = serde_json::to_vec(binding)?;
        let init = self.control.read_record("pair-init")?;
        let bound = self.control.read_record("pair")?;
        let base = self.load::<Base>("base")?;
        for value in [&init, &bound].into_iter().flatten() {
            if *value != pair {
                return invalid();
            }
        }
        if base.as_ref().is_some_and(|b| b != &initial) {
            return invalid();
        }
        let active = self.control.read_record("active")?;
        match active.as_deref() {
            Some(b"idle\n") if init.is_some() && bound.is_some() && base.is_some() => return Ok(()),
            Some(b"unpaired\n") => {
                if self.spool.entry_count(1)? != 0 {
                    return invalid();
                }
                // Durable write order is init -> base -> pair -> idle. Missing
                // earlier records are corruption, never permission to reset.
                if (base.is_some() && init.is_none()) || (bound.is_some() && base.is_none()) {
                    return invalid();
                }
            }
            _ => return invalid(),
        }
        self.control.put_record_once("pair-init", &pair)?;
        self.control
            .write_record("base", &serde_json::to_vec(&initial)?)?;
        self.control.put_record_once("pair", &pair)?;
        self.control.write_record("active", b"idle\n")?;
        Ok(())
    }
    fn binding(&self) -> WireResult<Binding> {
        self.files
            .validate_control_binding(&self.control, &self.descriptor.registration)?;
        if self.spool.root_identity()? != self.descriptor.spool {
            return invalid();
        }
        let b: Binding = self.load("pair")?.ok_or(ExecutorError::Unregistered)?;
        b.validate()?;
        if b.descriptor(self.role) != &self.descriptor
            || self.load::<Binding>("pair-init")?.as_ref() != Some(&b)
        {
            return invalid();
        }
        Ok(b)
    }
    fn load<T: serde::de::DeserializeOwned>(&self, key: &str) -> WireResult<Option<T>> {
        self.control
            .read_record(key)?
            .map(|b| serde_json::from_slice(&b).map_err(Into::into))
            .transpose()
    }
    fn base(&self, binding: &Binding) -> WireResult<Base> {
        let b: Base = self.load("base")?.ok_or(ExecutorError::Unregistered)?;
        if b.binding != hash(binding)? || b.generation > MAX_ROUNDS {
            return invalid();
        }
        manifest(&b.manifest)?;
        if b.generation == 0 {
            if !manifest(&b.manifest)?.files().is_empty() {
                return invalid();
            }
        } else {
            let a: Journal = self
                .load(&format!("checkpoint-{:020}", b.generation))?
                .ok_or(ExecutorError::InvalidState)?;
            if a.role != self.role
                || a.phase != Phase::Complete
                || a.round.binding != *binding
                || a.round.next()? != b
                || a.decision.is_none()
            {
                return invalid();
            }
            a.round.validate()?;
            self.validate_decision(&a, a.decision.as_ref().ok_or(ExecutorError::InvalidState)?)?;
            self.validate_stages(&a)?;
        }
        Ok(b)
    }
    fn journal(&self) -> WireResult<Option<Journal>> {
        let b = self.binding()?;
        let bytes = self
            .control
            .read_record("active")?
            .ok_or(ExecutorError::InvalidState)?;
        if bytes == b"idle\n" {
            return Ok(None);
        }
        let j: Journal = serde_json::from_slice(&bytes)?;
        j.round.validate()?;
        if j.role != self.role
            || j.round.binding != b
            || (j.phase >= Phase::Decided) != j.decision.is_some()
        {
            return invalid();
        }
        if let Some(d) = &j.decision {
            self.validate_decision(&j, d)?;
        }
        let base: Base = self.load("base")?.ok_or(ExecutorError::InvalidState)?;
        if base != j.round.base && !(j.phase >= Phase::Applied && base == j.round.next()?) {
            return invalid();
        }
        self.validate_stages(&j)?;
        for (p, w) in &j.stages {
            if !hex(&w.identity)
                || !hex(&w.exact)
                || !j
                    .round
                    .operations
                    .iter()
                    .any(|o| o.destination == self.role && &o.path == p && o.source.file == w.file)
            {
                return invalid();
            }
        }
        Ok(Some(j))
    }
    fn save(&self, j: &Journal) -> WireResult<()> {
        let bytes = serde_json::to_vec(j)?;
        if bytes.len() > MAX_WIRE_BYTES {
            return Err(ExecutorError::BatchLimit);
        }
        self.control.write_record("active", &bytes)?;
        Ok(())
    }
    fn receipt(&self, j: &Journal, phase: Phase) -> WireResult<Receipt> {
        Ok(Receipt {
            round: j.round.id.clone(),
            plan: hash(&j.round)?,
            role: self.role,
            phase,
            generation: j.round.next()?.generation,
            manifest: manifest(&j.round.proposed)?.digest()?.as_str().into(),
            stages: hash(&j.stages)?,
        })
    }
    fn check_peer(&self, j: &Journal, r: &Receipt, phase: Phase) -> WireResult<()> {
        if r.role != self.role.peer()
            || r.phase != phase
            || r.round != j.round.id
            || r.plan != hash(&j.round)?
            || r.generation != j.round.next()?.generation
            || r.manifest != manifest(&j.round.proposed)?.digest()?.as_str()
            || !hex(&r.stages)
        {
            return invalid();
        }
        Ok(())
    }
    fn validate_decision(&self, j: &Journal, d: &Decision) -> WireResult<()> {
        let (mine, peer) = if self.role == Role::Local {
            (&d.local, &d.cloud)
        } else {
            (&d.cloud, &d.local)
        };
        self.check_peer(j, peer, Phase::Prepared)?;
        if mine != &self.receipt(j, Phase::Prepared)? {
            return invalid();
        }
        Ok(())
    }
    pub fn status(&self) -> WireResult<Status> {
        let binding = self.binding()?;
        let base = self.base(&binding)?;
        let active = self.journal()?;
        let last = if active.is_none() && base.generation > 0 {
            self.load::<Journal>(&format!("checkpoint-{:020}", base.generation))?
        } else {
            None
        };
        let j = active.as_ref().or(last.as_ref());
        Ok(Status {
            role: self.role,
            binding,
            base,
            phase: active.as_ref().map(|j| j.phase),
            round: active.as_ref().map(|j| j.round.clone()),
            receipt: j.map(|j| self.receipt(j, j.phase)).transpose()?,
            decision: j.and_then(|j| j.decision.clone()),
        })
    }
    fn capture(&self, base: Base) -> WireResult<Snapshot> {
        let c = capture_workspace_inventory(self.files.service(), limits())?;
        let mut files = BTreeMap::new();
        for (p, f) in c.manifest().files() {
            let w = Observed::from(self.files.probe(p)?.ok_or(ExecutorError::InvalidState)?)?;
            if &w.file != f {
                return invalid();
            }
            files.insert(p.clone(), w);
        }
        let s = Snapshot {
            role: self.role,
            base,
            manifest: json(c.manifest())?,
            files,
            directories: c.directories().map(str::to_owned).collect(),
        };
        c.revalidate(self.files.service())?;
        Ok(s)
    }
    pub fn snapshot(&self) -> WireResult<Snapshot> {
        let b = self.binding()?;
        if self.journal()?.is_some() {
            return invalid();
        }
        self.capture(self.base(&b)?)
    }
    pub fn plan(&self, peer: Snapshot) -> WireResult<Option<Round>> {
        if self.role != Role::Local {
            return invalid();
        }
        let binding = self.binding()?;
        let local = self.snapshot()?;
        let plan = Round::changes(&binding, &local.base, &local, &peer)?;
        let proposed = plan.proposed_base().ok_or(ExecutorError::InvalidState)?;
        if plan.changes()?.is_empty() && proposed == &manifest(&local.base.manifest)? {
            return Ok(None);
        }
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(ExecutorError::Entropy)?;
        let id = format!("{:x}", Sha256::digest(entropy));
        let mut operations = Vec::new();
        for (i, c) in plan.changes()?.iter().enumerate() {
            let destination = if c.side == SyncSide::Local {
                Role::Local
            } else {
                Role::Cloud
            };
            let (dest, src) = if destination == Role::Local {
                (&local, &peer)
            } else {
                (&peer, &local)
            };
            operations.push(Operation {
                destination,
                path: c.path.clone(),
                id: format!("{:x}", Sha256::digest(format!("{id}:{i}"))),
                before: dest.files.get(&c.path).cloned(),
                source: src
                    .files
                    .get(&c.path)
                    .cloned()
                    .ok_or(ExecutorError::InvalidState)?,
            });
        }
        let r = Round {
            version: 1,
            id,
            binding,
            base: local.base.clone(),
            local,
            cloud: peer,
            proposed: json(proposed)?,
            operations,
        };
        r.validate()?;
        self.begin(r.clone())?;
        Ok(Some(r))
    }
    pub fn begin(&self, r: Round) -> WireResult<()> {
        r.validate()?;
        if r.binding != self.binding()? {
            return invalid();
        }
        if let Some(j) = self.journal()? {
            return if j.round == r { Ok(()) } else { invalid() };
        }
        if self.base(&r.binding)? != r.base
            || self.capture(r.base.clone())? != *r.snapshot(self.role)
        {
            return invalid();
        }
        self.preflight(&r)?;
        self.save(&Journal {
            round: r,
            role: self.role,
            phase: Phase::Pending,
            stages: BTreeMap::new(),
            decision: None,
        })
    }
    fn preflight(&self, r: &Round) -> WireResult<()> {
        let c = capture_workspace_inventory(self.files.service(), limits())?;
        let original: BTreeSet<_> = c.directories().map(str::to_owned).collect();
        let mut directories = original.clone();
        let mut entries = c.usage().entries + 8;
        let mut metadata = c.usage().metadata_bytes + 4096;
        for op in r.operations.iter().filter(|o| o.destination == self.role) {
            let mut parent = std::path::Path::new(&op.path).parent();
            while let Some(p) = parent {
                if !p.as_os_str().is_empty() {
                    directories.insert(p.to_str().ok_or(ExecutorError::InvalidState)?.to_owned());
                }
                parent = p.parent();
            }
            let stage_len = op.path.rsplit_once('/').map_or(77, |(p, _)| p.len() + 78);
            if stage_len > 4096 {
                return Err(ExecutorError::BatchLimit);
            }
            entries += 3 + usize::from(op.before.is_none());
            metadata += (stage_len + 256) * 3
                + if op.before.is_none() {
                    op.path.len() + 256
                } else {
                    0
                };
        }
        for path in directories.difference(&original) {
            entries += 1;
            metadata += path.len() + 256;
        }
        if entries > limits().entries
            || metadata > limits().metadata_bytes
            || directories.len() + 1 > limits().directories
        {
            return Err(ExecutorError::BatchLimit);
        }
        validate_capture_tree(
            directories.iter().map(|p| (p.as_str(), true)).chain(
                manifest(&r.proposed)?
                    .files()
                    .keys()
                    .map(|p| (p.as_str(), false)),
            ),
        )?;
        c.revalidate(self.files.service())?;
        Ok(())
    }
    fn validate_stages(&self, j: &Journal) -> WireResult<()> {
        let ops: Vec<_> = j
            .round
            .operations
            .iter()
            .filter(|o| o.destination == self.role)
            .collect();
        if j.phase >= Phase::Prepared && j.stages.len() != ops.len() {
            return invalid();
        }
        for (path, w) in &j.stages {
            if !hex(&w.exact)
                || !hex(&w.identity)
                || !ops
                    .iter()
                    .any(|o| &o.path == path && o.source.file == w.file)
            {
                return invalid();
            }
        }
        Ok(())
    }
    /// Receiver-side object admission happens before rsync, with content
    /// verification even when the transport believes a same-name object exists.
    pub fn need_objects(&self, id: &str) -> WireResult<Vec<String>> {
        let j = self.pending(id)?;
        if j.phase > Phase::Prepared {
            return invalid();
        }
        let c = capture_workspace_inventory(
            self.spool.service(),
            InventoryLimits {
                files: 512,
                total_bytes: MAX_SPOOL_BYTES,
                ..limits()
            },
        )?;
        let mut total = c
            .manifest()
            .files()
            .values()
            .map(|f| f.bytes.0)
            .sum::<u64>();
        let mut missing = BTreeSet::new();
        for op in j
            .round
            .operations
            .iter()
            .filter(|o| o.destination == self.role)
        {
            let name = op.source.file.sha256.as_str();
            if let Some(w) = self.spool.probe(name)? {
                if w.sha256 != name || w.bytes != op.source.file.bytes.0 || w.executable {
                    return invalid();
                }
            } else if missing.insert(name.to_owned()) {
                total = total
                    .checked_add(op.source.file.bytes.0)
                    .ok_or(ExecutorError::BatchLimit)?;
            }
        }
        if total > MAX_SPOOL_BYTES || c.manifest().files().len() + missing.len() > 512 {
            return Err(ExecutorError::BatchLimit);
        }
        c.revalidate(self.spool.service())?;
        Ok(missing.into_iter().collect())
    }
    fn pending(&self, id: &str) -> WireResult<Journal> {
        let j = self.journal()?.ok_or(ExecutorError::InvalidState)?;
        if j.round.id != id {
            return invalid();
        }
        Ok(j)
    }
    /// Seal only source objects named by the bound, durable round. Spool names
    /// are SHA256, never remote-requested paths. rsync may modify ONLY this root.
    pub fn materialize(&self, id: &str) -> WireResult<Vec<String>> {
        let j = self.pending(id)?;
        if j.phase > Phase::Prepared {
            return invalid();
        }
        let mut objects = BTreeSet::new();
        for op in j
            .round
            .operations
            .iter()
            .filter(|o| o.destination != self.role)
        {
            let bytes = self
                .files
                .export_bytes(&op.path, &op.source.exact, MAX_BYTES)?;
            op.source.file.verify_content(&bytes)?;
            let name = op.source.file.sha256.as_str();
            if let Some(existing) = self.spool.probe(name)? {
                if existing.sha256 != name
                    || existing.bytes != bytes.len() as u64
                    || existing.executable
                {
                    return invalid();
                }
            } else {
                let c = capture_workspace_inventory(
                    self.spool.service(),
                    InventoryLimits {
                        files: 512,
                        entries: 4096,
                        total_bytes: MAX_SPOOL_BYTES,
                        ..limits()
                    },
                )?;
                if c.manifest().files().len() >= 512
                    || c.manifest()
                        .files()
                        .values()
                        .map(|f| f.bytes.0)
                        .sum::<u64>()
                        .checked_add(bytes.len() as u64)
                        .is_none_or(|v| v > MAX_SPOOL_BYTES)
                {
                    return Err(ExecutorError::BatchLimit);
                }
                let operation = format!("{:x}", Sha256::digest(format!("wire-spool/v1:{name}")));
                let stage = self.spool.stage_bytes(
                    ReceivedStageSpec {
                        path: name,
                        operation: &operation,
                        sha256: name,
                        executable: false,
                    },
                    &bytes,
                )?;
                self.spool
                    .publish(name, &operation, None, None, &stage.identity)?;
            }
            objects.insert(name.to_owned());
        }
        Ok(objects.into_iter().collect())
    }
    pub fn stage(&self, id: &str) -> WireResult<()> {
        let mut j = self.pending(id)?;
        if j.phase != Phase::Pending {
            return invalid();
        }
        for op in j
            .round
            .operations
            .clone()
            .iter()
            .filter(|o| o.destination == self.role)
        {
            if let Some(w) = j.stages.get(&op.path) {
                if Observed::from(
                    self.files
                        .probe(&stage_name(&op.path, &op.id))?
                        .ok_or(ExecutorError::InvalidState)?,
                )? != *w
                {
                    return invalid();
                }
                continue;
            }
            if self
                .files
                .probe(&op.path)?
                .map(Observed::from)
                .transpose()?
                .as_ref()
                != op.before.as_ref()
            {
                return invalid();
            }
            let name = op.source.file.sha256.as_str();
            let object = self.spool.probe(name)?.ok_or(ExecutorError::InvalidState)?;
            if object.sha256 != name || object.bytes != op.source.file.bytes.0 || object.executable
            {
                return invalid();
            }
            let bytes = self.spool.export_bytes(name, &object.exact, MAX_BYTES)?;
            op.source.file.verify_content(&bytes)?;
            let staged = self.files.stage_bytes(
                ReceivedStageSpec {
                    path: &op.path,
                    operation: &op.id,
                    sha256: name,
                    executable: op.source.file.executable,
                },
                &bytes,
            )?;
            j.stages.insert(op.path.clone(), Observed::from(staged)?);
            self.save(&j)?;
        }
        Ok(())
    }
    fn validate_prepared_files(&self, j: &Journal) -> WireResult<()> {
        let before = j.round.snapshot(self.role);
        let now = self.capture(j.round.base.clone())?;
        let mut dirs = before.directories.clone();
        let mut count = 0;
        for op in j
            .round
            .operations
            .iter()
            .filter(|o| o.destination == self.role)
        {
            let mut parent = std::path::Path::new(&op.path).parent();
            while let Some(p) = parent {
                if !p.as_os_str().is_empty() {
                    dirs.insert(p.to_str().ok_or(ExecutorError::InvalidState)?.into());
                }
                parent = p.parent();
            }
            let stage = j.stages.get(&op.path).ok_or(ExecutorError::InvalidState)?;
            if Observed::from(
                self.files
                    .probe(&stage_name(&op.path, &op.id))?
                    .ok_or(ExecutorError::InvalidState)?,
            )? != *stage
            {
                return invalid();
            }
            count += 1;
        }
        if count != j.stages.len()
            || before.files != now.files
            || before.manifest != now.manifest
            || dirs != now.directories
        {
            return invalid();
        }
        Ok(())
    }
    pub fn prepare(&self, id: &str) -> WireResult<Receipt> {
        let mut j = self.pending(id)?;
        if j.phase > Phase::Prepared {
            return invalid();
        }
        self.validate_prepared_files(&j)?;
        j.phase = Phase::Prepared;
        self.save(&j)?;
        self.receipt(&j, Phase::Prepared)
    }
    /// Only the local native coordinator can make the durable decision, after
    /// matching both prepare receipts. This precedes either endpoint publish.
    pub fn decide(&self, id: &str, peer: Receipt) -> WireResult<Decision> {
        let mut j = self.pending(id)?;
        if self.role != Role::Local {
            return invalid();
        }
        if let Some(d) = &j.decision {
            self.check_peer(&j, &peer, Phase::Prepared)?;
            if d.cloud != peer {
                return invalid();
            }
            return Ok(d.clone());
        }
        if j.phase != Phase::Prepared {
            return invalid();
        }
        self.validate_prepared_files(&j)?;
        self.check_peer(&j, &peer, Phase::Prepared)?;
        let d = Decision {
            local: self.receipt(&j, Phase::Prepared)?,
            cloud: peer,
        };
        j.phase = Phase::Decided;
        j.decision = Some(d.clone());
        self.save(&j)?;
        Ok(d)
    }
    pub fn accept_decision(&self, id: &str, d: Decision) -> WireResult<()> {
        let mut j = self.pending(id)?;
        self.validate_decision(&j, &d)?;
        if let Some(old) = &j.decision {
            return if old == &d { Ok(()) } else { invalid() };
        }
        if self.role != Role::Cloud || j.phase != Phase::Prepared {
            return invalid();
        }
        self.validate_prepared_files(&j)?;
        j.phase = Phase::Decided;
        j.decision = Some(d);
        self.save(&j)
    }
    pub fn apply(&self, id: &str) -> WireResult<Receipt> {
        let mut j = self.pending(id)?;
        if j.phase < Phase::Decided {
            return invalid();
        }
        if j.phase < Phase::Applied {
            for op in j
                .round
                .operations
                .iter()
                .filter(|o| o.destination == self.role)
            {
                let s = j.stages.get(&op.path).ok_or(ExecutorError::InvalidState)?;
                let result = self.files.publish(
                    &op.path,
                    &op.id,
                    op.before.as_ref().map(|w| w.exact.as_str()),
                    op.before.as_ref().map(|w| w.identity.as_str()),
                    &s.identity,
                )?;
                if result.identity != s.identity {
                    return invalid();
                }
            }
            if self.capture(j.round.base.clone())?.manifest != j.round.proposed {
                return invalid();
            }
            j.phase = Phase::Applied;
            self.save(&j)?;
        }
        self.receipt(&j, Phase::Applied)
    }
    pub fn finalize(&self, id: &str, peer: Receipt) -> WireResult<Receipt> {
        let mut j = self.pending(id)?;
        if !matches!(peer.phase, Phase::Applied | Phase::Complete) {
            return invalid();
        }
        self.check_peer(&j, &peer, peer.phase)?;
        if j.phase < Phase::Applied
            || self.capture(j.round.base.clone())?.manifest != j.round.proposed
        {
            return invalid();
        }
        j.phase = Phase::Complete;
        // Archive first, then install base. Either lost-reply/crash ordering is
        // resumed from active Applied; it never acknowledges a missing archive.
        self.control.put_record_once(
            &format!("checkpoint-{:020}", j.round.next()?.generation),
            &serde_json::to_vec(&j)?,
        )?;
        self.control
            .write_record("base", &serde_json::to_vec(&j.round.next()?)?)?;
        self.save(&j)?;
        self.receipt(&j, Phase::Complete)
    }
    /// Native owner build input: idle, committed cloud contents only. No RPC
    /// accepts a snapshot path or grants process execution authority.
    pub fn seal_cloud_snapshot(
        &self,
        destination: &FsService,
    ) -> WireResult<crate::workspace_executor::PinnedWorkspaceSnapshot> {
        if self.role != Role::Cloud || self.journal()?.is_some() {
            return invalid();
        }
        let binding = self.binding()?;
        let base = self.base(&binding)?;
        if base.generation == 0 {
            return invalid();
        }
        let expected = manifest(&base.manifest)?;
        let capture = capture_workspace_inventory(self.files.service(), limits())?;
        if capture.manifest() != &expected {
            return invalid();
        }
        let protected_roots = [
            self.files.service(),
            self.control.service(),
            self.spool.service(),
        ]
        .iter()
        .map(|s| s.workspace_root().to_path_buf())
        .collect::<Vec<_>>();
        if protected_roots.iter().any(|p| {
            destination.workspace_root().starts_with(p)
                || p.starts_with(destination.workspace_root())
        }) {
            return invalid();
        }
        let snapshot = destination.sync_lease()?;
        snapshot.validate_private_root()?;
        if snapshot.entry_count(1)? != 0 {
            return invalid();
        }
        for (path, file) in expected.files() {
            let source = self.files.probe(path)?.ok_or(ExecutorError::InvalidState)?;
            let operation = format!(
                "{:x}",
                Sha256::digest(format!("wire-build:{}:{path}", snapshot.root_identity()?))
            );
            let stage = snapshot.stage_from(
                &self.files,
                xharness_fs::workspace_apply::StageSpec {
                    path,
                    operation: &operation,
                    source_exact: &source.exact,
                    sha256: file.sha256.as_str(),
                    bytes: file.bytes.0,
                    executable: file.executable,
                },
            )?;
            snapshot.publish(path, &operation, None, None, &stage.identity)?;
        }
        capture.revalidate(self.files.service())?;
        let pinned = crate::workspace_executor::PinnedWorkspaceSnapshot {
            lease: snapshot,
            manifest: expected.clone(),
            checkpoint: xharness_cloud::workspace_profile::BuildCheckpoint::new(
                binding.pair,
                Counter(base.generation),
                expected.digest()?,
            )?,
            environment: Id::new("cloud")?,
            protected_roots,
        };
        pinned.validate()?;
        Ok(pinned)
    }
    pub fn release(&self, id: &str, peer: Receipt) -> WireResult<Receipt> {
        let status = self.status()?;
        if status.round.is_none() {
            let own = status.receipt.ok_or(ExecutorError::InvalidState)?;
            let j: Journal = self
                .load(&format!("checkpoint-{:020}", status.base.generation))?
                .ok_or(ExecutorError::InvalidState)?;
            self.check_peer(&j, &peer, Phase::Complete)?;
            if own.round != id || own.phase != Phase::Complete {
                return invalid();
            }
            return Ok(own);
        }
        let j = self.pending(id)?;
        self.check_peer(&j, &peer, Phase::Complete)?;
        if j.phase != Phase::Complete
            || self.base(&j.round.binding)? != j.round.next()?
            || self.capture(j.round.base.clone())?.manifest != j.round.proposed
        {
            return invalid();
        }
        let receipt = self.receipt(&j, Phase::Complete)?;
        self.control.write_record("active", b"idle\n")?;
        Ok(receipt)
    }
}
fn stage_name(path: &str, id: &str) -> String {
    path.rsplit_once('/').map_or_else(
        || format!(".xh-sync-{id}.new"),
        |(p, _)| format!("{p}/.xh-sync-{id}.new"),
    )
}

/// No root, registration, binding mutation or executable selection in requests.
#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status {},
    Snapshot {},
    Plan { peer: Snapshot },
    Begin { round: Box<Round> },
    Materialize { id: String },
    NeedObjects { id: String },
    Stage { id: String },
    Prepare { id: String },
    Decide { id: String, peer: Receipt },
    AcceptDecision { id: String, decision: Decision },
    Apply { id: String },
    Finalize { id: String, peer: Receipt },
    Release { id: String, peer: Receipt },
}
impl Participant {
    pub fn request(&self, r: Request) -> WireResult<serde_json::Value> {
        Ok(match r {
            Request::Status {} => serde_json::to_value(self.status()?)?,
            Request::Snapshot {} => serde_json::to_value(self.snapshot()?)?,
            Request::Plan { peer } => serde_json::to_value(self.plan(peer)?)?,
            Request::Begin { round } => {
                self.begin(*round)?;
                serde_json::Value::Null
            }
            Request::NeedObjects { id } => serde_json::to_value(self.need_objects(&id)?)?,
            Request::Materialize { id } => serde_json::to_value(self.materialize(&id)?)?,
            Request::Stage { id } => {
                self.stage(&id)?;
                serde_json::Value::Null
            }
            Request::Prepare { id } => serde_json::to_value(self.prepare(&id)?)?,
            Request::Decide { id, peer } => serde_json::to_value(self.decide(&id, peer)?)?,
            Request::AcceptDecision { id, decision } => {
                self.accept_decision(&id, decision)?;
                serde_json::Value::Null
            }
            Request::Apply { id } => serde_json::to_value(self.apply(&id)?)?,
            Request::Finalize { id, peer } => serde_json::to_value(self.finalize(&id, peer)?)?,
            Request::Release { id, peer } => serde_json::to_value(self.release(&id, peer)?)?,
        })
    }
}
