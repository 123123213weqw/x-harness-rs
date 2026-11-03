//! Fixed v1 intent and version labels, NOT execution/root authority. Native
//! adapters must establish checkpoint provenance and authenticated placement.
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
use crate::{CloudError, CloudResult, Counter, ErrorCode, Id, Sha256Digest};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkspaceProfile {
    #[serde(rename = "local_code_remote_exec_v1")]
    LocalCodeRemoteExecV1,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionLocation {
    Local,
    Remote,
}
impl WorkspaceProfile {
    pub fn require_execution(
        self,
        location: ExecutionLocation,
        connected: bool,
    ) -> CloudResult<()> {
        if location != ExecutionLocation::Remote {
            return Err(CloudError::new(
                ErrorCode::Forbidden,
                "workspace profile prohibits local process execution",
            ));
        }
        if !connected {
            return Err(CloudError::new(
                ErrorCode::RuntimeUnavailable,
                "remote execution is unavailable; local fallback is prohibited",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CheckpointWire")]
pub struct BuildCheckpoint {
    pair: Id,
    generation: Counter,
    manifest: Sha256Digest,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointWire {
    pair: Id,
    generation: Counter,
    manifest: Sha256Digest,
}
impl TryFrom<CheckpointWire> for BuildCheckpoint {
    type Error = CloudError;
    fn try_from(value: CheckpointWire) -> CloudResult<Self> {
        Self::new(value.pair, value.generation, value.manifest)
    }
}
impl BuildCheckpoint {
    pub fn new(pair: Id, generation: Counter, manifest: Sha256Digest) -> CloudResult<Self> {
        if generation.0 == 0 {
            return Err(CloudError::new(
                ErrorCode::InvalidRequest,
                "build requires a committed nonzero checkpoint",
            ));
        }
        Ok(Self {
            pair,
            generation,
            manifest,
        })
    }
    pub fn pair(&self) -> &Id {
        &self.pair
    }
    pub fn generation(&self) -> Counter {
        self.generation
    }
    pub fn manifest(&self) -> &Sha256Digest {
        &self.manifest
    }
    pub fn is_current(&self, current: &Self) -> bool {
        self == current
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_remote_execution_and_never_fallback() {
        let profile = WorkspaceProfile::LocalCodeRemoteExecV1;
        assert!(profile
            .require_execution(ExecutionLocation::Remote, true)
            .is_ok());
        assert!(profile
            .require_execution(ExecutionLocation::Remote, false)
            .is_err());
        assert!(profile
            .require_execution(ExecutionLocation::Local, true)
            .is_err());
        assert!(profile
            .require_execution(ExecutionLocation::Local, false)
            .is_err());
        assert!(serde_json::from_str::<WorkspaceProfile>("\"auto\"").is_err());
    }
    #[test]
    fn stale_results_and_unknown_checkpoint_fields_are_rejected() {
        let a = BuildCheckpoint::new(
            Id::new("pair").unwrap(),
            Counter(1),
            Sha256Digest::new("a".repeat(64)).unwrap(),
        )
        .unwrap();
        let b =
            BuildCheckpoint::new(Id::new("pair").unwrap(), Counter(2), a.manifest.clone()).unwrap();
        assert!(!a.is_current(&b));
        let mut value = serde_json::to_value(&a).unwrap();
        assert_eq!(
            serde_json::from_value::<BuildCheckpoint>(value.clone()).unwrap(),
            a
        );
        value["generation"] = serde_json::json!("0");
        assert!(serde_json::from_value::<BuildCheckpoint>(value).is_err());
        let mut value = serde_json::to_value(&a).unwrap();
        value["localFallback"] = true.into();
        assert!(serde_json::from_value::<BuildCheckpoint>(value).is_err());
    }
}
