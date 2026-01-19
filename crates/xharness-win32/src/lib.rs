//! Audited low-level Win32 primitives shared by native XHarness providers.
//!
//! This crate deliberately owns the small unsafe boundary around Windows
//! handles, Job Objects, restricted tokens and ACL operations. Higher layers
//! remain safe Rust and express policy rather than raw API calls. On non-Windows
//! targets the crate is empty so the complete workspace remains portable.

#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(windows)]
mod file;
#[cfg(windows)]
mod handle;
#[cfg(windows)]
mod job;

#[cfg(windows)]
pub use file::replace_file;
#[cfg(windows)]
pub use handle::OwnedWin32Handle;
#[cfg(windows)]
pub use job::{Job, JobAccounting};

/// One checked Win32 API failure.
#[cfg(windows)]
#[derive(Debug, thiserror::Error)]
#[error("{api} failed with Win32 error {code}")]
pub struct Win32Error {
    pub api: &'static str,
    pub code: u32,
}

#[cfg(windows)]
impl Win32Error {
    pub(crate) fn last(api: &'static str) -> Self {
        // SAFETY: GetLastError has no preconditions and reads thread-local state.
        let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        Self { api, code }
    }
}
