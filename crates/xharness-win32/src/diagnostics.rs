//! Read-only observations of a pinned process handle, never a periodically
//! reopened PID (which might have been reused by an unrelated process).
use crate::{OwnedWin32Handle, Win32Error};
use std::mem;
use windows_sys::Win32::System::{
    ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX},
    Threading::{GetProcessHandleCount, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
};

pub struct ObservedProcess {
    pub(crate) handle: OwnedWin32Handle,
}
pub struct ProcessResources {
    pub resident_bytes: u64,
    pub private_bytes: u64,
    pub handles: u32,
}
impl ObservedProcess {
    /// Call while the newly spawned owned child is still behind its start gate.
    pub fn open(pid: u32) -> Result<Self, Win32Error> {
        // SAFETY: OpenProcess validates pid and rights. No handle inheritance.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        // SAFETY: OpenProcess transfers ownership of a real handle on success.
        let handle = unsafe { OwnedWin32Handle::from_raw(raw) }
            .ok_or_else(|| Win32Error::last("OpenProcess"))?;
        Ok(Self { handle })
    }
    pub fn sample(&self) -> Result<ProcessResources, Win32Error> {
        // SAFETY: this Win32 output structure is POD and accepts zero initialization.
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { mem::zeroed() };
        counters.cb = mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        // SAFETY: handle remains owned, pointer and length describe the EX buffer
        // supported by GetProcessMemoryInfo, whose prefix is MEMORY_COUNTERS.
        let ok = unsafe {
            GetProcessMemoryInfo(
                self.handle.as_raw(),
                (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX)
                    .cast::<PROCESS_MEMORY_COUNTERS>(),
                counters.cb,
            )
        };
        if ok == 0 {
            return Err(Win32Error::last("GetProcessMemoryInfo"));
        }
        let mut handles = 0;
        // SAFETY: live owned process handle and valid writable output pointer.
        if unsafe { GetProcessHandleCount(self.handle.as_raw(), &mut handles) } == 0 {
            return Err(Win32Error::last("GetProcessHandleCount"));
        }
        Ok(ProcessResources {
            resident_bytes: counters.WorkingSetSize as u64,
            private_bytes: counters.PrivateUsage as u64,
            handles,
        })
    }
}

/// Explicit diagnostic-only scan of the default process heap. May block other
/// allocators temporarily; never called in the normal diagnostic tier.
pub fn validate_process_heap() -> bool {
    // SAFETY: GetProcessHeap returns the current process default heap. Flags=0
    // preserves required heap serialization; null validates the whole heap.
    // HeapValidate does not expose a meaningful GetLastError on failure.
    unsafe {
        windows_sys::Win32::System::Memory::HeapValidate(
            windows_sys::Win32::System::Memory::GetProcessHeap(),
            0,
            std::ptr::null(),
        ) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn samples_owned_process_and_rejects_invalid_pid() {
        assert!(validate_process_heap());
        let sample = ObservedProcess::open(std::process::id())
            .unwrap()
            .sample()
            .unwrap();
        assert!(sample.resident_bytes > 0);
        assert!(sample.handles > 0);
        assert!(ObservedProcess::open(0).is_err());
    }
}
