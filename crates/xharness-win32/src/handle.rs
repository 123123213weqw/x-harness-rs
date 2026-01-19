use std::fmt;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

/// Sole owner of one non-null, non-invalid Win32 `HANDLE`.
pub struct OwnedWin32Handle(HANDLE);

impl OwnedWin32Handle {
    /// Take ownership of a handle returned by a Win32 API.
    ///
    /// # Safety
    ///
    /// `handle` must be exclusively owned by the caller and must be closed with
    /// `CloseHandle`. After this call the caller must not close or reuse it.
    pub unsafe fn from_raw(handle: HANDLE) -> Option<Self> {
        (handle != 0 && handle != INVALID_HANDLE_VALUE).then_some(Self(handle))
    }

    pub const fn as_raw(&self) -> HANDLE {
        self.0
    }

    pub(crate) fn into_raw(self) -> HANDLE {
        let raw = self.0;
        std::mem::forget(self);
        raw
    }
}

// Windows kernel handles may be transferred and referenced across threads.
unsafe impl Send for OwnedWin32Handle {}
unsafe impl Sync for OwnedWin32Handle {}

impl fmt::Debug for OwnedWin32Handle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("OwnedWin32Handle")
            .field(&format_args!("0x{:x}", self.0))
            .finish()
    }
}

impl Drop for OwnedWin32Handle {
    fn drop(&mut self) {
        // SAFETY: construction guarantees exclusive ownership of a valid handle.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
