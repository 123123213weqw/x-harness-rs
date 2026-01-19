use std::mem;

use windows_sys::Win32::System::{
    Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    },
    Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
};

use crate::{OwnedWin32Handle, Win32Error};

/// Creation flag used to keep a new process from running before Job assignment.
pub const WINDOWS_CREATE_SUSPENDED: u32 = CREATE_SUSPENDED;

/// Resume the sole primary thread of a freshly created suspended process.
///
/// This is paired with `WINDOWS_CREATE_SUSPENDED`: callers create the process,
/// assign it to a Job Object, then call this function before user code can run
/// or create descendants outside that Job.
pub fn resume_suspended_process(pid: u32) -> Result<(), Win32Error> {
    // SAFETY: the snapshot has no caller-provided pointers and transfers one
    // owned kernel handle on success.
    let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    // SAFETY: a successful snapshot call transfers exclusive ownership.
    let snapshot = unsafe { OwnedWin32Handle::from_raw(raw_snapshot) }
        .ok_or_else(|| Win32Error::last("CreateToolhelp32Snapshot"))?;

    // SAFETY: all-zero is a valid initial form; the API requires dwSize.
    let mut entry: THREADENTRY32 = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<THREADENTRY32>() as u32;
    // SAFETY: snapshot and the correctly sized output buffer remain live.
    if unsafe { Thread32First(snapshot.as_raw(), &mut entry) } == 0 {
        return Err(Win32Error::last("Thread32First"));
    }

    let thread_id = loop {
        if entry.th32OwnerProcessID == pid {
            break entry.th32ThreadID;
        }
        // SAFETY: snapshot and output buffer remain valid for enumeration.
        if unsafe { Thread32Next(snapshot.as_raw(), &mut entry) } == 0 {
            return Err(Win32Error::code(
                "Thread32Next(process thread not found)",
                1168,
            ));
        }
    };

    // SAFETY: the thread id came from the snapshot, inheritance is disabled,
    // and only the right required for ResumeThread is requested.
    let raw_thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    // SAFETY: OpenThread transfers one owned handle on success.
    let thread = unsafe { OwnedWin32Handle::from_raw(raw_thread) }
        .ok_or_else(|| Win32Error::last("OpenThread"))?;
    // SAFETY: this is the suspended primary thread of the just-created process.
    if unsafe { ResumeThread(thread.as_raw()) } == u32::MAX {
        return Err(Win32Error::last("ResumeThread"));
    }
    Ok(())
}
