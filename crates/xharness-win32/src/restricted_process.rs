use std::{
    ffi::{OsStr, OsString},
    mem,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr,
};

use windows_sys::Win32::{
    Foundation::{GetLastError, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0},
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        Threading::{
            CreateProcessAsUserW, GetExitCodeProcess, ResumeThread, TerminateProcess,
            WaitForSingleObject, CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION,
            STARTF_USESTDHANDLES, STARTUPINFOW,
        },
    },
};

use crate::{Job, OwnedWin32Handle, RestrictedToken, Win32Error};

pub struct RestrictedChild {
    process: OwnedWin32Handle,
    job: Job,
    pid: u32,
}

impl RestrictedChild {
    pub fn spawn_inherited(
        token: &RestrictedToken,
        program: &OsStr,
        args: &[OsString],
        cwd: &Path,
    ) -> Result<Self, Win32Error> {
        let job = Job::new_kill_on_close()?;
        let stdin = std_handle(STD_INPUT_HANDLE, "GetStdHandle(stdin)")?;
        let stdout = std_handle(STD_OUTPUT_HANDLE, "GetStdHandle(stdout)")?;
        let stderr = std_handle(STD_ERROR_HANDLE, "GetStdHandle(stderr)")?;
        let handles = [stdin, stdout, stderr];
        for (enabled, handle) in handles.into_iter().enumerate() {
            // SAFETY: standard handle values were validated above.
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                for prior in handles.into_iter().take(enabled) {
                    // SAFETY: best-effort restoration of handles we changed.
                    unsafe {
                        SetHandleInformation(prior, HANDLE_FLAG_INHERIT, 0);
                    }
                }
                return Err(Win32Error::last("SetHandleInformation(enable inherit)"));
            }
        }

        // SAFETY: zero is a valid initial value for these Win32 POD records.
        let mut startup: STARTUPINFOW = unsafe { mem::zeroed() };
        startup.cb = mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = stdin;
        startup.hStdOutput = stdout;
        startup.hStdError = stderr;
        // SAFETY: zero is the required initial output form.
        let mut info: PROCESS_INFORMATION = unsafe { mem::zeroed() };
        let mut command_line = command_line(program, args);
        let cwd = cwd
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // SAFETY: command_line is mutable and NUL-terminated; cwd remains
        // live; security/environment defaults are intentional; std handles
        // are inheritable and referenced by startup.
        let created = unsafe {
            CreateProcessAsUserW(
                token.as_raw_handle(),
                ptr::null(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED,
                ptr::null(),
                cwd.as_ptr(),
                &startup,
                &mut info,
            )
        };
        let create_error = if created == 0 {
            // SAFETY: reads thread-local last-error immediately after failure.
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        for handle in handles {
            // SAFETY: best-effort restoration after CreateProcessAsUserW.
            unsafe {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
        if let Some(code) = create_error {
            return Err(Win32Error::code("CreateProcessAsUserW", code));
        }
        // SAFETY: successful creation transfers both handles.
        let process = unsafe { OwnedWin32Handle::from_raw(info.hProcess) }
            .ok_or_else(|| Win32Error::code("CreateProcessAsUserW(process handle)", 6))?;
        // SAFETY: successful creation transfers the primary thread handle.
        let thread = match unsafe { OwnedWin32Handle::from_raw(info.hThread) } {
            Some(thread) => thread,
            None => {
                // SAFETY: the process handle is owned and the process remains
                // suspended, so forced termination cannot race user code.
                unsafe {
                    TerminateProcess(process.as_raw(), 1);
                }
                return Err(Win32Error::code("CreateProcessAsUserW(thread handle)", 6));
            }
        };
        finish_job_assignment(process.as_raw(), job.assign_process(process.as_raw() as _))?;
        // SAFETY: thread is the live suspended primary thread.
        if unsafe { ResumeThread(thread.as_raw()) } == u32::MAX {
            let error = Win32Error::last("ResumeThread");
            let _ = job.terminate(1);
            return Err(error);
        }
        drop(thread);
        Ok(Self {
            process,
            job,
            pid: info.dwProcessId,
        })
    }

    pub const fn pid(&self) -> u32 {
        self.pid
    }

    pub fn wait(self) -> Result<u32, Win32Error> {
        // SAFETY: process handle remains live for both calls.
        let wait = unsafe { WaitForSingleObject(self.process.as_raw(), INFINITE) };
        if wait != WAIT_OBJECT_0 {
            return Err(Win32Error::last("WaitForSingleObject"));
        }
        let mut code = 0;
        // SAFETY: process is signaled and code is a valid output slot.
        if unsafe { GetExitCodeProcess(self.process.as_raw(), &mut code) } == 0 {
            return Err(Win32Error::last("GetExitCodeProcess"));
        }
        let _ = self.job.accounting();
        Ok(code)
    }
}

/// Assignment failed, so this process is NOT owned by our Job. Kill by the
/// still-owned process handle, never by PID or by terminating the empty Job.
fn finish_job_assignment(
    process: HANDLE,
    assignment: Result<(), Win32Error>,
) -> Result<(), Win32Error> {
    let Err(error) = assignment else {
        return Ok(());
    };
    // SAFETY: caller retains the creation handle with PROCESS_TERMINATE and
    // SYNCHRONIZE rights until this function returns. The child is suspended.
    unsafe {
        if TerminateProcess(process, 1) != 0 {
            // Bounded best-effort reap; cleanup must not replace the original
            // assignment error or hang the sandbox runner indefinitely.
            WaitForSingleObject(process, 5_000);
        }
    }
    Err(error)
}

fn std_handle(which: u32, api: &'static str) -> Result<HANDLE, Win32Error> {
    // SAFETY: selector is one of the three documented standard-handle ids.
    let handle = unsafe { GetStdHandle(which) };
    if handle == 0 || handle == -1isize {
        Err(Win32Error::last(api))
    } else {
        Ok(handle)
    }
}

pub(crate) fn command_line(program: &OsStr, args: &[OsString]) -> Vec<u16> {
    let mut output = Vec::new();
    quote_arg(program, &mut output);
    for arg in args {
        output.push(b' ' as u16);
        quote_arg(arg, &mut output);
    }
    output.push(0);
    output
}

fn quote_arg(argument: &OsStr, output: &mut Vec<u16>) {
    let units = argument.encode_wide().collect::<Vec<_>>();
    let needs_quotes =
        units.is_empty() || units.iter().any(|unit| matches!(*unit, 0x09 | 0x20 | 0x22));
    if !needs_quotes {
        output.extend(units);
        return;
    }
    output.push(b'"' as u16);
    let mut backslashes = 0usize;
    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
        } else if unit == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            output.push(unit);
            backslashes = 0;
        } else {
            output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
            output.push(unit);
            backslashes = 0;
        }
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    output.push(b'"' as u16);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_failure_kills_suspended_child_and_preserves_error() {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        use std::process::Command;

        // Retain Child for explicit fallback cleanup before assertions. This
        // fixture has no membership in the Job that assignment failed to join.
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "exit 0"])
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .expect("create suspended child");
        let process = child.as_raw_handle() as HANDLE;
        let result =
            finish_job_assignment(process, Err(Win32Error::code("injected assignment", 5)));
        // SAFETY: Child owns a live process handle throughout this wait.
        let signaled = unsafe { WaitForSingleObject(process, 1000) };
        if signaled != WAIT_OBJECT_0 {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_eq!(signaled, WAIT_OBJECT_0, "suspended process escaped cleanup");
        let error = result.unwrap_err();
        assert_eq!(error.api, "injected assignment");
        assert_eq!(error.code, 5);
        assert_eq!(child.wait().unwrap().code(), Some(1));
    }

    #[test]
    fn successful_assignment_does_not_terminate_child() {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        use std::process::Command;
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;

        let job = Job::new_kill_on_close().unwrap();
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "exit 0"])
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .expect("create suspended child");
        let process = child.as_raw_handle() as HANDLE;
        let result = finish_job_assignment(process, job.assign_process(process as _));
        // SAFETY: Child retains ownership; a successfully assigned child should
        // still be suspended, not killed by the cleanup helper.
        let state = unsafe { WaitForSingleObject(process, 0) };
        let _ = child.kill();
        let _ = child.wait();
        result.expect("assign child");
        assert_eq!(state, WAIT_TIMEOUT);
    }

    #[test]
    fn command_line_quoting_handles_spaces_quotes_and_trailing_slashes() {
        let line = command_line(
            OsStr::new(r"C:\Program Files\tool.exe"),
            &[
                OsString::from("plain"),
                OsString::from("two words"),
                OsString::from("quoted\"value"),
                OsString::from(r"ends\"),
            ],
        );
        let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            text,
            r#""C:\Program Files\tool.exe" plain "two words" "quoted\"value" ends\"#
        );
    }
}
