//! Trusted VM-local bootstrap. Not a model Tool or public RPC.
#![forbid(unsafe_code)]
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    path::Path,
};
use xharness_cloud::BindingScope;
use xharness_cloud_app::{NativeBootstrapIntent, NativePermitJournal};
use xharness_host::{GoalBootstrapReceipt, GoalBootstrapSpec};
use xharness_session::Store;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostedGoalBootstrap {
    pub scope: BindingScope,
    pub task_spec: xharness_cloud::CloudTaskSpec,
    pub goal: GoalBootstrapSpec,
}
fn invalid() -> io::Error {
    io::Error::other("hosted Goal bootstrap identity or state is invalid")
}
impl HostedGoalBootstrap {
    pub fn read(path: &Path, permit_directory: &Path) -> io::Result<Self> {
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 256 * 1024 {
            return Err(invalid());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(invalid());
            }
        }
        let path = std::fs::canonicalize(path)?;
        if path.parent() != Some(std::fs::canonicalize(permit_directory)?.as_path()) {
            return Err(invalid());
        }
        let mut data = Vec::new();
        std::fs::File::open(path)?
            .take(256 * 1024 + 1)
            .read_to_end(&mut data)?;
        if data.len() > 256 * 1024 {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(&data).map_err(|_| invalid())?;
        value.goal.fingerprint().map_err(|_| invalid())?;
        value
            .task_spec
            .validate(&xharness_cloud::AdmissionLimits::default())
            .map_err(|_| invalid())?;
        Ok(value)
    }
    pub fn intent(&self) -> io::Result<NativeBootstrapIntent> {
        Ok(NativeBootstrapIntent {
            operation_id: xharness_cloud::Id::new(&self.goal.operation_id)
                .map_err(|_| invalid())?,
            scope: self.scope.clone(),
            root_session_id: xharness_cloud::Id::new(&self.goal.session_id)
                .map_err(|_| invalid())?,
            fingerprint: self.goal.fingerprint().map_err(|_| invalid())?,
            task_spec_fingerprint: self
                .task_spec
                .fingerprint()
                .map_err(|_| invalid())?
                .as_str()
                .into(),
        })
    }
    /// Reserve BEFORE Host launch/config bootstrap, but only for a new root.
    /// State directory's original ownership lease is required by the caller.
    pub async fn reserve(
        &self,
        journal: &NativePermitJournal,
        store: &dyn Store,
    ) -> io::Result<()> {
        let head = journal.snapshot().map_err(|_| invalid())?;
        if self.task_spec.objective != self.goal.objective
            || self.task_spec.acceptance_criteria != self.goal.acceptance_criteria
            || self.goal.permission != xharness_host::PermissionPreset::DangerFullAccess
        {
            return Err(invalid());
        }

        if self.scope != head.permit.scope
            || self.goal.session_id != head.specification.binding.root_session_id.as_str()
            || self.goal.workspace != head.specification.workspace
        {
            return Err(invalid());
        }
        if journal.bootstrap().map_err(|_| invalid())?.is_none()
            && store
                .load(&self.goal.session_id)
                .await
                .map_err(|_| invalid())?
                .is_some()
        {
            return Err(invalid());
        }
        journal
            .reserve_bootstrap(self.intent()?)
            .map_err(|_| invalid())?;
        Ok(())
    }
    pub async fn prepare(
        &self,
        journal: &NativePermitJournal,
        store: &dyn Store,
    ) -> io::Result<GoalBootstrapReceipt> {
        let intent = self.intent()?;
        let reserved = journal
            .bootstrap()
            .map_err(|_| invalid())?
            .ok_or_else(invalid)?;
        if reserved.intent != intent {
            return Err(invalid());
        }
        // An applied reservation MUST find its original journal; deletion or
        // corruption cannot silently recreate a Goal and repeat side effects.
        if reserved.applied
            && store
                .load(&self.goal.session_id)
                .await
                .map_err(|_| invalid())?
                .is_none()
        {
            return Err(invalid());
        }
        let receipt = xharness_host::prepare_goal_session(store, &self.goal, !reserved.applied)
            .await
            .map_err(|_| invalid())?;
        journal
            .record_bootstrap_applied(&intent)
            .map_err(|_| invalid())?;
        Ok(receipt)
    }
}
