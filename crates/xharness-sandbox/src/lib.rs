//! Native process confinement for [`xharness_process::SpawnSpec`].
//!
//! Linux uses Bubblewrap, macOS uses Seatbelt, and Windows uses a restricted
//! token plus capability-SID ACL grants.
//! Restricted modes are fail closed: an unavailable native backend is an
//! error and never falls back to the original process. The unrestricted mode
//! is an explicit escape hatch and returns the spawn spec byte-for-byte
//! unchanged.

mod policy;
mod sandbox;
#[cfg(target_os = "macos")]
mod seatbelt;
#[cfg(windows)]
mod windows;

pub use policy::*;
pub use sandbox::*;
#[cfg(target_os = "macos")]
pub use seatbelt::*;
#[cfg(windows)]
pub use windows::*;

/// The compile-time native sandbox. Runtime backend switching is deliberately
/// avoided so policy semantics cannot silently change on one host.
#[cfg(target_os = "linux")]
pub type NativeSandbox = BwrapSandbox;
#[cfg(target_os = "macos")]
pub type NativeSandbox = SeatbeltSandbox;
#[cfg(windows)]
pub type NativeSandbox = WindowsAclSandbox;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
compile_error!("xharness-sandbox currently supports only Linux, macOS and Windows");
