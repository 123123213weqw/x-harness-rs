//! Durable control state for long-lived XHarness agents.
//!
//! The model/tool loop remains a turn executor. This crate owns pending input,
//! stable message identities and atomic claim batches that survive process
//! restart. The session event log is the only authoritative history.

mod activation;
mod driver;
mod inbox;
mod lease;
mod lifecycle;

pub use activation::*;
pub use driver::*;
pub use inbox::*;
pub use lease::*;
pub use lifecycle::*;
pub use xharness_session::{InboxMessage, InboxTarget};
