//! Domain foundation only: no VM deployment, credentials, Host or second Agent loop.
//! The default memory store is ephemeral. A commit sink / validated snapshot
//! lets durable adapters reuse exactly the same admission and reducer rules.
#![forbid(unsafe_code)]

pub mod contract;
pub mod environment;
pub mod state;
pub mod store;
pub mod testing;

pub use contract::*;
pub use environment::*;
pub use state::*;
pub use store::*;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    Unauthenticated,
    VersionUnsupported,
    NotFound,
    Forbidden,
    IdempotencyConflict,
    RevisionConflict,
    CapabilityUnavailable,
    EnvironmentBusy,
    QuotaExceeded,
    ConfigurationUnavailable,
    OwnershipUnverified,
    OutcomeUnknown,
    RuntimeUnavailable,
    CursorExpired,
    CleanupIncomplete,
    StorageFailure,
    Internal,
}

/// Static, secret-blind diagnostics. Never interpolate credentials or raw payloads.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[error("{code:?}: {message}")]
#[serde(deny_unknown_fields)]
pub struct CloudError {
    pub code: ErrorCode,
    pub message: String,
}

impl CloudError {
    pub fn new(code: ErrorCode, message: &'static str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub type CloudResult<T> = Result<T, CloudError>;
