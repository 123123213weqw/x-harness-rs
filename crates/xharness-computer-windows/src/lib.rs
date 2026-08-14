//! Windows-specific APIs stay in a disposable child of the existing Host
//! executable. No Python, PowerShell, extra executable or persistent COM
//! pointer enters the application runtime.
#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(windows)]
mod adapter;
#[cfg(windows)]
mod native;
mod observation;
#[cfg(any(windows, test))]
mod state;
mod wire;
#[cfg(windows)]
pub use adapter::WindowsComputer;
#[cfg(all(windows, feature = "native-acceptance"))]
pub use native::acceptance::run as run_native_acceptance;
#[cfg(all(windows, feature = "native-acceptance"))]
pub use native::acceptance::run_freshness as run_freshness_acceptance;
#[cfg(windows)]
pub use native::run_worker;

#[cfg(not(windows))]
pub struct WindowsComputer;

#[cfg(not(windows))]
impl WindowsComputer {
    pub fn new() -> Result<Self, xharness_computer::ComputerError> {
        Err(xharness_computer::ComputerError::unavailable(
            "Windows Computer Use requires Windows",
        ))
    }
}
