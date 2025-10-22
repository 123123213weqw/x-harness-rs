//! Append-only, event-sourced session storage for XHarness.
//!
//! A [`Session`] is an immutable-history snapshot. New facts enter through a
//! compare-and-swap append, receive contiguous sequence numbers, and advance a
//! single-writer [`Revision`]. Model history is always derived from those
//! facts; it is never maintained as a second mutable transcript.

mod event;
mod message;
mod recovery;
mod session;
mod store;

pub use event::*;
pub use message::*;
pub use recovery::*;
pub use session::*;
pub use store::*;
