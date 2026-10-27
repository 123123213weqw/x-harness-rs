//! Append-only, event-sourced session storage for XHarness.
//!
//! A [`Session`] is an immutable-history snapshot. New facts enter through a
//! compare-and-swap append, receive contiguous sequence numbers, and advance a
//! single-writer [`Revision`]. Model history is always derived from those
//! facts; it is never maintained as a second mutable transcript.

pub mod plan;
pub use plan::{session_plan, PlanItem, PlanItemStatus, SessionPlan};
mod checkpoint;
mod dispatch;
pub mod goal;
mod goal_validation;
pub use checkpoint::*;
mod event;
mod job_continuation;
pub use job_continuation::*;
mod message;
mod reception;
mod recovery;
pub use reception::*;
mod session;
mod store;
mod stream_append;
mod tool_archive;
pub use tool_archive::*;

pub use event::*;
pub use message::*;
pub use recovery::*;
pub use session::*;
pub use store::*;
pub use stream_append::StreamAppendCursor;
