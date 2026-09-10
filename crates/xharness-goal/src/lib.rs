//! Goal-level decisions, NOT another executor.
//!
//! This crate performs no I/O, model calls or scheduling. The Host must supply
//! one consistent observation and atomically revalidate a decision's fence
//! before changing state. Repeated decisions are deterministic proposals, not
//! an exactly-once side-effect guarantee. No durable v1 format is changed here.
mod decision;
mod types;
pub use decision::decide;
pub use types::*;
