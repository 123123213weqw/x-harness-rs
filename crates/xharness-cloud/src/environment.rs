use crate::{
    CloudError, CloudResult, CloudTaskSpec, Counter, ErrorCode, Id, SystemPrivilege, VersionedRef,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    DedicatedLinux,
    PersistentVolume,
    SingleWriter,
    FullAccess,
    ManagedCleanup,
    Deployment,
    ModelReachable,
    MaterialReachable,
    Retention,
    Sudo,
    ExternalStop,
    CpuHardLimit,
    MemoryHardLimit,
    DiskHardLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityObservation {
    pub support: Support,
    pub observed_at_ms: Counter,
    pub constraints: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EnvironmentCapabilities(pub BTreeMap<Capability, CapabilityObservation>);

impl EnvironmentCapabilities {
    pub fn support(&self, capability: Capability) -> Support {
        self.0
            .get(&capability)
            .map_or(Support::Unknown, |o| o.support)
    }

    pub fn require(&self, capabilities: &[Capability]) -> CloudResult<()> {
        if capabilities
            .iter()
            .any(|c| self.support(*c) != Support::Supported)
        {
            return Err(CloudError::new(
                ErrorCode::CapabilityUnavailable,
                "required environment capability is unsupported or unverified",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentHealth {
    Preparing,
    Ready,
    Degraded,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentOccupancy {
    Unbound,
    Bound,
    Releasing,
    Released,
}

/// Trusted control-side configuration, not a user-provided admission DTO.
/// Credential/material authorization and actual probes belong to later adapters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredEnvironment {
    pub owner_id: Id,
    pub environment_ref: VersionedRef,
    pub instance_id: Id,
    pub volume_id: Id,
    pub host_build_ref: VersionedRef,
    pub execution_epoch: Counter,
    pub capabilities: EnvironmentCapabilities,
    pub resource_policy_ref: VersionedRef,
    pub stop_policy_ref: VersionedRef,
    pub retention_policy_ref: VersionedRef,
    pub required_resource_capabilities: Vec<Capability>,
    pub external_stop_authorized: bool,
}

impl RegisteredEnvironment {
    pub fn validate_submission(&self, spec: &CloudTaskSpec) -> CloudResult<()> {
        if self.environment_ref != spec.environment_ref
            || self.resource_policy_ref != spec.resource_policy_ref
            || self.stop_policy_ref != spec.stop_policy_ref
            || self.retention_policy_ref != spec.retention_policy_ref
        {
            return Err(CloudError::new(
                ErrorCode::Forbidden,
                "submission does not match authorized environment policies",
            ));
        }
        self.capabilities.require(&[
            Capability::DedicatedLinux,
            Capability::PersistentVolume,
            Capability::SingleWriter,
            Capability::FullAccess,
            Capability::ManagedCleanup,
            Capability::Deployment,
            Capability::ModelReachable,
            Capability::MaterialReachable,
            Capability::Retention,
        ])?;
        self.capabilities
            .require(&self.required_resource_capabilities)?;
        if spec.system_privilege == SystemPrivilege::Sudo {
            self.capabilities
                .require(&[Capability::Sudo, Capability::ExternalStop])?;
            if !self.external_stop_authorized {
                return Err(CloudError::new(
                    ErrorCode::Forbidden,
                    "sudo requires authorized external VM stop",
                ));
            }
        }
        if self.execution_epoch.0 == 0 {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "execution epoch must be established before binding",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingScope {
    pub task_id: Id,
    pub binding_id: Id,
    pub environment_instance_id: Id,
    pub volume_id: Id,
    pub execution_epoch: Counter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub scope: BindingScope,
    pub root_session_id: Id,
    pub host_build_ref: VersionedRef,
    pub external_stop_authorized: bool,
    pub external_stop_support: Support,
}

/// Environment I/O only. Activate/Seal are future VM Host journal operations,
/// not a way to bypass task cancellation with an arbitrary environment command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentOperationKind {
    Prepare,
    Stop,
    Collect,
    Release,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentOperation {
    pub operation_id: Id,
    pub scope: BindingScope,
    pub kind: EnvironmentOperationKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum EnvironmentOperationResult {
    Applied {
        operation: EnvironmentOperation,
    },
    Failed {
        operation: EnvironmentOperation,
        error: CloudError,
    },
}

/// A missing query result is unknown, NOT permission to create a new operation.
/// Real adapters must retain identities and authenticate scope before I/O.
#[async_trait]
pub trait EnvironmentBackend: Send + Sync {
    async fn execute(
        &self,
        operation: EnvironmentOperation,
    ) -> CloudResult<EnvironmentOperationResult>;
    async fn inspect(
        &self,
        operation: &EnvironmentOperation,
    ) -> CloudResult<Option<EnvironmentOperationResult>>;
}
