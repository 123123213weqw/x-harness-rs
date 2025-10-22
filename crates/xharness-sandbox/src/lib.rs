//! Native process confinement for [`xharness_process::SpawnSpec`].
//!
//! Linux uses Bubblewrap and macOS uses the built-in Seatbelt profile runner.
//! Restricted modes are fail closed: an unavailable native backend is an
//! error and never falls back to the original process. The unrestricted mode
//! is an explicit escape hatch and returns the spawn spec byte-for-byte
//! unchanged.

mod policy;
mod sandbox;
#[cfg(target_os = "macos")]
mod seatbelt;

pub use policy::*;
pub use sandbox::*;
#[cfg(target_os = "macos")]
pub use seatbelt::*;

/// The compile-time native sandbox. Runtime backend switching is deliberately
/// avoided so policy semantics cannot silently change on one host.
#[cfg(target_os = "linux")]
pub type NativeSandbox = BwrapSandbox;
#[cfg(target_os = "macos")]
pub type NativeSandbox = SeatbeltSandbox;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("xharness-sandbox currently supports only Linux and macOS");
