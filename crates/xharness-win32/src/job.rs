use std::{ffi::c_void, mem, os::windows::io::RawHandle, ptr};

use windows_sys::Win32::{
    Foundation::HANDLE,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
};

use crate::{OwnedWin32Handle, Win32Error};

/// Process counts reported by one Job Object.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JobAccounting {
    pub total_processes: u32,
    pub active_processes: u32,
    pub terminated_processes: u32,
}

/// A kill-on-close Job Object used as an owned process-tree boundary.
#[derive(Debug)]
pub struct Job {
    handle: OwnedWin32Handle,
}

impl Job {
    /// Create an unnamed Job whose members are terminated when the last Job
    /// handle closes.
    pub fn new_kill_on_close() -> Result<Self, Win32Error> {
        // SAFETY: null security attributes and name request a private Job with
        // the caller's default security descriptor.
        let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        // SAFETY: CreateJobObjectW transfers one owned handle on success.
        let handle = unsafe { OwnedWin32Handle::from_raw(raw) }
            .ok_or_else(|| Win32Error::last("CreateJobObjectW"))?;

        // SAFETY: the all-zero value is a valid initial form of this POD Win32
        // structure; only LimitFlags is set below.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` has the structure and byte length required by the
        // selected information class and stays alive for the call.
        let ok = unsafe {
            SetInformationJobObject(
                handle.as_raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(Win32Error::last("SetInformationJobObject"));
        }
        Ok(Self { handle })
    }

    /// Assign an already-created process to this Job.
    ///
    /// Callers must terminate the process if assignment fails; a process is not
    /// managed by this Job until this method returns success.
    pub fn assign_process(&self, process: RawHandle) -> Result<(), Win32Error> {
        // SAFETY: the caller supplies a live process handle and both handles
        // remain valid for the duration of the call.
        let ok = unsafe { AssignProcessToJobObject(self.handle.as_raw(), process as HANDLE) };
        if ok == 0 {
            Err(Win32Error::last("AssignProcessToJobObject"))
        } else {
            Ok(())
        }
    }

    /// Open a process by id with the least rights required for Job assignment
    /// and assign it while the temporary process handle is owned safely.
    pub fn assign_pid(&self, pid: u32) -> Result<(), Win32Error> {
        // SAFETY: OpenProcess validates the pid; inheritance is disabled and
        // only assignment/cleanup rights are requested.
        let raw = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        // SAFETY: OpenProcess transfers one owned handle on success.
        let process = unsafe { OwnedWin32Handle::from_raw(raw) }
            .ok_or_else(|| Win32Error::last("OpenProcess"))?;
        // SAFETY: both owned handles remain valid for the complete call.
        let ok = unsafe { AssignProcessToJobObject(self.handle.as_raw(), process.as_raw()) };
        if ok == 0 {
            Err(Win32Error::last("AssignProcessToJobObject"))
        } else {
            Ok(())
        }
    }

    /// Force every process in the Job to exit with `exit_code`.
    pub fn terminate(&self, exit_code: u32) -> Result<(), Win32Error> {
        // SAFETY: the owned Job handle remains valid for the call.
        let ok = unsafe { TerminateJobObject(self.handle.as_raw(), exit_code) };
        if ok == 0 {
            Err(Win32Error::last("TerminateJobObject"))
        } else {
            Ok(())
        }
    }

    /// Query stable process accounting for Job-settlement checks.
    pub fn accounting(&self) -> Result<JobAccounting, Win32Error> {
        // SAFETY: the all-zero value is a valid output buffer for this POD
        // Win32 structure.
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
        // SAFETY: the output buffer and its exact size match the selected class.
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle.as_raw(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast::<c_void>(),
                mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(Win32Error::last("QueryInformationJobObject"));
        }
        Ok(JobAccounting {
            total_processes: accounting.TotalProcesses,
            active_processes: accounting.ActiveProcesses,
            terminated_processes: accounting.TotalTerminatedProcesses,
        })
    }

    pub const fn as_raw_handle(&self) -> HANDLE {
        self.handle.as_raw()
    }
}
