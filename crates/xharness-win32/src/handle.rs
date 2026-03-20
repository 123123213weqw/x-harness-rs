use std::fmt;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

/// Sole owner of one non-null, non-invalid Win32 `HANDLE`.
pub struct OwnedWin32Handle(HANDLE);

impl OwnedWin32Handle {
    /// Take ownership of a handle returned by a Win32 API.
    ///
    /// # Safety
    ///
    /// A valid `handle` must be exclusively owned by the caller and closable
    /// with `CloseHandle`. On `Some`, the caller must not close or reuse it.
    /// Null and INVALID_HANDLE_VALUE return `None` without any OS calls.
    pub unsafe fn from_raw(handle: HANDLE) -> Option<Self> {
        // Do not eagerly construct an owner for invalid handles: dropping the
        // temporary would call CloseHandle and overwrite the caller's LastError.
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError};

    #[test]
    fn invalid_handles_preserve_the_original_error() {
        for raw in [0, INVALID_HANDLE_VALUE] {
            // SAFETY: LastError is thread-local; invalid handles transfer no resource.
            let (owner, error) = unsafe {
                SetLastError(1234);
                let owner = OwnedWin32Handle::from_raw(raw);
                (owner, GetLastError())
            };
            assert!(owner.is_none());
            assert_eq!(error, 1234);
        }
    }

    #[test]
    fn valid_handle_ownership_can_be_transferred_and_closed_once() {
        use windows_sys::Win32::System::Threading::CreateEventW;
        // SAFETY: default security, unnamed event, no borrowed pointers.
        let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        assert_ne!(raw, 0);
        // SAFETY: newly created event is exclusively owned.
        let owner = unsafe { OwnedWin32Handle::from_raw(raw) }.unwrap();
        assert_eq!(owner.as_raw(), raw);
        let raw = owner.into_raw();
        // SAFETY: into_raw relinquished ownership; transfer it to a new owner.
        drop(unsafe { OwnedWin32Handle::from_raw(raw) }.unwrap());
        let mut flags = 0;
        // SAFETY: GetHandleInformation validates the now-closed handle, no close twice.
        assert_eq!(
            unsafe { windows_sys::Win32::Foundation::GetHandleInformation(raw, &mut flags) },
            0
        );
    }
}
