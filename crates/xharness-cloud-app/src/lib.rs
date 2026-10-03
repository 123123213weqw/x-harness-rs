//! Control-plane adapters. No Provider, Tool, Host or second model-loop dependency.
#![forbid(unsafe_code)]

pub mod controller;
pub mod native_permit;
pub mod native_stage;
pub mod persistence;

pub use controller::*;
pub use native_permit::*;
pub use native_stage::*;
pub use persistence::SqliteCloudTaskStore;
