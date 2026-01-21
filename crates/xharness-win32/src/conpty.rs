use std::{
    collections::BTreeMap,
    ffi::{c_void, OsStr, OsString},
    fs::File,
    mem,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::Path,
    ptr,
};

use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON},
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
            InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
            UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES,
            STARTUPINFOEXW,
        },
    },
};

use crate::{restricted_process::command_line, Job, OwnedWin32Handle, Win32Error};

/// One native ConPTY session split into process control and master-side I/O.
pub struct ConPtySession {
    pub child: ConPtyChild,
    pub reader: File,
    pub writer: File,
}

/// The process, pseudo-console, and kill-on-close Job for one ConPTY session.
pub struct ConPtyChild {
    process: OwnedWin32Handle,
    job: Job,
    pseudo_console: PseudoConsole,
    pid: u32,
}

impl ConPtyChild {
    pub const fn pid(&self) -> u32 {
        self.pid
    }

    pub fn try_wait(&self) -> Result<Option<u32>, Win32Error> {
        // SAFETY: the process handle is owned and remains valid for the call.
        match unsafe { WaitForSingleObject(self.process.as_raw(), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                // SAFETY: the signaled process handle and output pointer are valid.
                if unsafe { GetExitCodeProcess(self.process.as_raw(), &mut code) } == 0 {
                    Err(Win32Error::last("GetExitCodeProcess(ConPTY)"))
                } else {
                    Ok(Some(code))
                }
            }
            _ => Err(Win32Error::last("WaitForSingleObject(ConPTY)")),
        }
    }

    pub fn terminate(&self, exit_code: u32) -> Result<(), Win32Error> {
        self.job.terminate(exit_code)
    }

    pub fn accounting(&self) -> Result<crate::JobAccounting, Win32Error> {
        self.job.accounting()
    }
}

impl std::fmt::Debug for ConPtyChild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConPtyChild")
            .field("pid", &self.pid)
            .field("process", &self.process)
            .field("job", &self.job)
            .field("pseudo_console", &self.pseudo_console)
            .finish()
    }
}

/// Spawn a command in a headless native Windows pseudo-console.
///
/// The process begins suspended, is assigned to its kill-on-close Job, and is
/// only then resumed. ConPTY is created with the documented default flags so a
/// service or CI runner does not depend on a parent console or cursor protocol.
pub fn spawn_conpty(
    program: &OsStr,
    args: &[OsString],
    cwd: &Path,
    environment: &BTreeMap<OsString, OsString>,
    rows: u16,
    cols: u16,
) -> Result<ConPtySession, Win32Error> {
    validate_no_nul(program)?;
    for argument in args {
        validate_no_nul(argument)?;
    }
    let rows = i16::try_from(rows)
        .map_err(|_| Win32Error::code("ConPTY rows", ERROR_INVALID_PARAMETER))?;
    let cols = i16::try_from(cols)
        .map_err(|_| Win32Error::code("ConPTY columns", ERROR_INVALID_PARAMETER))?;

    let (pseudo_input, input_writer) = create_pipe("CreatePipe(ConPTY input)")?;
    let (output_reader, pseudo_output) = create_pipe("CreatePipe(ConPTY output)")?;
    let pseudo_console = PseudoConsole::new(
        COORD { X: cols, Y: rows },
        pseudo_input.as_raw(),
        pseudo_output.as_raw(),
    )?;
    drop(pseudo_input);
    drop(pseudo_output);

    let attributes = AttributeList::for_pseudo_console(pseudo_console.as_raw())?;
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
    startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    // A detached service or CI runner can itself have redirected standard
    // handles. Marking all three invalid prevents the child from bypassing
    // ConPTY and writing to those parent handles instead.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    startup.lpAttributeList = attributes.as_raw();
    let mut information: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    let mut command_line = command_line(program, args);
    let cwd = wide_nul(cwd.as_os_str())?;
    let environment = environment_block(environment)?;
    let job = Job::new_kill_on_close()?;

    // SAFETY: every pointer targets a live, correctly sized Win32 buffer;
    // handle inheritance is disabled because ConPTY is attached through the
    // process attribute list rather than inherited stdio handles.
    let created = unsafe {
        CreateProcessW(
            ptr::null(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            environment.as_ptr().cast::<c_void>(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    };
    if created == 0 {
        return Err(Win32Error::last("CreateProcessW(ConPTY)"));
    }
    // SAFETY: successful creation transfers one process and one thread handle.
    let process = unsafe { OwnedWin32Handle::from_raw(information.hProcess) }
        .ok_or_else(|| Win32Error::code("CreateProcessW(ConPTY process handle)", 6))?;
    // SAFETY: successful creation transfers the primary thread handle.
    let thread = match unsafe { OwnedWin32Handle::from_raw(information.hThread) } {
        Some(thread) => thread,
        None => {
            // SAFETY: the process is still suspended and the handle is owned.
            unsafe {
                TerminateProcess(process.as_raw(), 1);
            }
            return Err(Win32Error::code("CreateProcessW(ConPTY thread handle)", 6));
        }
    };
    if let Err(error) = job.assign_process(process.as_raw() as _) {
        // SAFETY: the process has not executed user code and is not in the Job.
        unsafe {
            TerminateProcess(process.as_raw(), 1);
        }
        return Err(error);
    }
    // SAFETY: this is the live suspended primary thread.
    if unsafe { ResumeThread(thread.as_raw()) } == u32::MAX {
        let error = Win32Error::last("ResumeThread(ConPTY)");
        let _ = job.terminate(1);
        return Err(error);
    }
    drop(thread);
    drop(attributes);

    // SAFETY: each valid pipe handle has unique ownership which is transferred
    // to a File and will subsequently be closed by File::drop.
    let writer = unsafe { File::from_raw_handle(input_writer.into_raw() as _) };
    // SAFETY: same ownership transfer for the output side.
    let reader = unsafe { File::from_raw_handle(output_reader.into_raw() as _) };
    Ok(ConPtySession {
        child: ConPtyChild {
            process,
            job,
            pseudo_console,
            pid: information.dwProcessId,
        },
        reader,
        writer,
    })
}

fn create_pipe(api: &'static str) -> Result<(OwnedWin32Handle, OwnedWin32Handle), Win32Error> {
    let mut read: HANDLE = 0;
    let mut write: HANDLE = 0;
    // SAFETY: both output slots are valid and null attributes request the
    // caller's default, non-inheritable security descriptor.
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        // Defensive ownership conversion closes any partial result.
        let _ = unsafe { OwnedWin32Handle::from_raw(read) };
        let _ = unsafe { OwnedWin32Handle::from_raw(write) };
        return Err(Win32Error::last(api));
    }
    // SAFETY: successful CreatePipe transfers two distinct handles.
    let read =
        unsafe { OwnedWin32Handle::from_raw(read) }.ok_or_else(|| Win32Error::code(api, 6))?;
    // SAFETY: successful CreatePipe transfers the second distinct handle.
    let write =
        unsafe { OwnedWin32Handle::from_raw(write) }.ok_or_else(|| Win32Error::code(api, 6))?;
    Ok((read, write))
}

struct PseudoConsole(HPCON);

impl PseudoConsole {
    fn new(size: COORD, input: HANDLE, output: HANDLE) -> Result<Self, Win32Error> {
        let mut handle: HPCON = 0;
        // SAFETY: size is positive and both pipe handles are live for the call.
        let result = unsafe { CreatePseudoConsole(size, input, output, 0, &mut handle) };
        if result < 0 || handle == 0 {
            Err(Win32Error::code("CreatePseudoConsole", result as u32))
        } else {
            Ok(Self(handle))
        }
    }

    const fn as_raw(&self) -> HPCON {
        self.0
    }
}

unsafe impl Send for PseudoConsole {}
unsafe impl Sync for PseudoConsole {}

impl std::fmt::Debug for PseudoConsole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("PseudoConsole")
            .field(&format_args!("0x{:x}", self.0))
            .finish()
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // SAFETY: this object uniquely owns a successful HPCON result.
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}

struct AttributeList {
    _storage: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl AttributeList {
    fn for_pseudo_console(pseudo_console: HPCON) -> Result<Self, Win32Error> {
        let mut bytes = 0usize;
        // SAFETY: the documented sizing call uses a null list and writes size.
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(Win32Error::last("InitializeProcThreadAttributeList(size)"));
        }
        let slots = bytes.div_ceil(mem::size_of::<usize>());
        let mut storage = vec![0usize; slots];
        let pointer = storage.as_mut_ptr().cast::<c_void>();
        // SAFETY: storage is pointer-aligned and contains at least the requested
        // number of bytes for one attribute.
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
            return Err(Win32Error::last("InitializeProcThreadAttributeList"));
        }
        let list = Self {
            _storage: storage,
            pointer,
        };
        // SAFETY: list is initialized. Unlike most process attributes, the
        // documented ConPTY contract takes the HPCON value itself as
        // `lpValue` (HPCON is already an opaque pointer-sized handle), not a
        // pointer to a variable containing that handle.
        if unsafe {
            UpdateProcThreadAttribute(
                list.pointer,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                pseudo_console as *const c_void,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            return Err(Win32Error::last("UpdateProcThreadAttribute(ConPTY)"));
        }
        Ok(list)
    }

    const fn as_raw(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.pointer
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: pointer denotes the initialized list backed by `_storage`.
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn environment_block(environment: &BTreeMap<OsString, OsString>) -> Result<Vec<u16>, Win32Error> {
    let mut entries = environment.iter().collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| {
        left.to_string_lossy()
            .to_lowercase()
            .cmp(&right.to_string_lossy().to_lowercase())
    });
    let mut block = Vec::new();
    for (name, value) in entries {
        validate_no_nul(name)?;
        validate_no_nul(value)?;
        block.extend(name.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn wide_nul(value: &OsStr) -> Result<Vec<u16>, Win32Error> {
    validate_no_nul(value)?;
    Ok(value.encode_wide().chain(Some(0)).collect())
}

fn validate_no_nul(value: &OsStr) -> Result<(), Win32Error> {
    if value.encode_wide().any(|unit| unit == 0) {
        Err(Win32Error::code(
            "ConPTY input contains NUL",
            ERROR_INVALID_PARAMETER,
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_block_is_sorted_case_insensitively_and_double_terminated() {
        let environment = BTreeMap::from([
            (OsString::from("zeta"), OsString::from("last")),
            (OsString::from("Alpha"), OsString::from("first")),
        ]);
        let block = environment_block(&environment).unwrap();
        let text = String::from_utf16(&block[..block.len() - 2]).unwrap();
        assert_eq!(text, "Alpha=first\0zeta=last");
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
    }
}
