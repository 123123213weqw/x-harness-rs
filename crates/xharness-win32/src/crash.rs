//! The faulting Host only signals a pre-opened file/event and waits briefly.
//! DbgHelp executes in the desktop observer, never in the damaged Host heap.
//! Fast-fail, OOM, process kill and a corrupted exception handler can bypass this
//! best-effort hook; lifecycle evidence is still recorded by the desktop.
use crate::{ObservedProcess, OwnedWin32Handle};
use std::{
    ffi::c_void,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{BOOL, HANDLE, S_FALSE, S_OK},
    Storage::FileSystem::{FlushFileBuffers, WriteFile},
    System::{
        Diagnostics::Debug::{
            IoFinishCallback, IoStartCallback, IoWriteAllCallback, MiniDumpNormal,
            MiniDumpWithFullMemory, MiniDumpWriteDump, SetUnhandledExceptionFilter,
            EXCEPTION_POINTERS, MINIDUMP_CALLBACK_INFORMATION, MINIDUMP_CALLBACK_INPUT,
            MINIDUMP_CALLBACK_OUTPUT, MINIDUMP_EXCEPTION_INFORMATION,
        },
        Threading::{
            CreateEventW, GetCurrentThreadId, OpenEventW, SetEvent, WaitForSingleObject,
            SYNCHRONIZATION_SYNCHRONIZE,
        },
    },
};

static DBGHELP: Mutex<()> = Mutex::new(());
struct Hook {
    file: File,
    ack: OwnedWin32Handle,
    fired: AtomicBool,
}
static HOOK: OnceLock<Hook> = OnceLock::new();
fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

pub fn install_crash_signal(context: &Path, event_name: &str) -> io::Result<()> {
    let name = wide(event_name);
    // SAFETY: null-terminated name, no inherited handle. Desktop owns the event.
    let raw = unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
    // SAFETY: successful OpenEventW transfers ownership.
    let ack = unsafe { OwnedWin32Handle::from_raw(raw) }.ok_or_else(io::Error::last_os_error)?;
    let file = File::create(context)?;
    HOOK.set(Hook {
        file,
        ack,
        fired: AtomicBool::new(false),
    })
    .map_err(|_| io::Error::other("crash signal already installed"))?;
    // SAFETY: callback uses a process-lifetime OnceLock; it never captures stack
    // references, allocates, logs, locks a Rust mutex or invokes DbgHelp.
    unsafe {
        SetUnhandledExceptionFilter(Some(signal_crash));
    }
    Ok(())
}

unsafe extern "system" fn signal_crash(exception: *const EXCEPTION_POINTERS) -> i32 {
    if let Some(hook) = HOOK.get() {
        if !hook.fired.swap(true, Ordering::SeqCst) {
            let mut context = [0u8; 16];
            // SAFETY: GetCurrentThreadId has no preconditions.
            context[..4].copy_from_slice(&unsafe { GetCurrentThreadId() }.to_le_bytes());
            context[8..].copy_from_slice(&(exception as usize as u64).to_le_bytes());
            let mut written = 0;
            // SAFETY: pre-opened file remains live for process lifetime; bytes
            // and output pointer remain valid for this synchronous write.
            let ok = unsafe {
                WriteFile(
                    hook.file.as_raw_handle() as HANDLE,
                    context.as_ptr(),
                    16,
                    &mut written,
                    ptr::null_mut(),
                )
            };
            if ok != 0 && written == 16 {
                // SAFETY: both handles are owned by the process-lifetime Hook.
                unsafe {
                    FlushFileBuffers(hook.file.as_raw_handle() as HANDLE);
                    WaitForSingleObject(hook.ack.as_raw(), 15_000);
                }
            }
        }
    }
    0 // EXCEPTION_CONTINUE_SEARCH: never suppress the crash/OS error reporting.
}

pub struct CrashCapture {
    process: ObservedProcess,
    pid: u32,
    ack: OwnedWin32Handle,
}
impl CrashCapture {
    pub fn prepare(pid: u32, event_name: &str) -> io::Result<Self> {
        let name = wide(event_name);
        // SAFETY: random per-generation name, default user DACL, manual reset.
        let raw = unsafe { CreateEventW(ptr::null(), 1, 0, name.as_ptr()) };
        // SAFETY: CreateEventW transfers ownership of one handle on success.
        let ack =
            unsafe { OwnedWin32Handle::from_raw(raw) }.ok_or_else(io::Error::last_os_error)?;
        let process = ObservedProcess::open(pid).map_err(io::Error::other)?;
        Ok(Self { process, pid, ack })
    }
    /// Called only for a nonempty context belonging to this still-owned child.
    /// Always acknowledges the crash signal, including I/O/budget failures.
    pub fn capture(&self, context: &Path, destination: &Path, full: bool) -> io::Result<u64> {
        let result = self.write_dump(context, destination, full);
        // SAFETY: owned event stays alive for this call and belongs to this Host.
        unsafe {
            SetEvent(self.ack.as_raw());
        }
        result
    }
    fn write_dump(&self, context: &Path, destination: &Path, full: bool) -> io::Result<u64> {
        let mut bytes = [0u8; 16];
        File::open(context)?.read_exact(&mut bytes)?;
        let thread = u32::from_le_bytes(
            bytes[..4]
                .try_into()
                .map_err(|_| io::Error::other("invalid crash context"))?,
        );
        let address = u64::from_le_bytes(
            bytes[8..]
                .try_into()
                .map_err(|_| io::Error::other("invalid crash context"))?,
        );
        if thread == 0 || address == 0 {
            return Err(io::Error::other("empty crash context"));
        }
        let _gate = DBGHELP
            .try_lock()
            .map_err(|_| io::Error::other("another capture is running"))?;
        let file = File::create(destination)?;
        let mut writer = BoundedDump {
            file,
            limit: if full {
                512 * 1024 * 1024
            } else {
                64 * 1024 * 1024
            },
            deadline: Instant::now() + Duration::from_secs(10),
            used_callback: false,
        };
        let exception = MINIDUMP_EXCEPTION_INFORMATION {
            ThreadId: thread,
            ExceptionPointers: address as usize as *mut EXCEPTION_POINTERS,
            ClientPointers: 1,
        };
        let callback = MINIDUMP_CALLBACK_INFORMATION {
            CallbackRoutine: Some(dump_io),
            CallbackParam: (&mut writer as *mut BoundedDump).cast(),
        };
        // SAFETY: process handle is pinned before startup gate opens. Exception
        // pointers are in that process (ClientPointers=TRUE); Host waits up to
        // 15 seconds. File/callback context live until synchronous API returns.
        // All DbgHelp entry points in this module are serialized by DBGHELP.
        let ok = unsafe {
            MiniDumpWriteDump(
                self.process.handle.as_raw(),
                self.pid,
                writer.file.as_raw_handle() as HANDLE,
                if full {
                    MiniDumpWithFullMemory
                } else {
                    MiniDumpNormal
                },
                &exception,
                ptr::null(),
                &callback,
            )
        };
        if ok == 0 || !writer.used_callback {
            drop(writer);
            let _ = fs::remove_file(destination); // only our just-created partial dump
            return Err(io::Error::other(
                "crash capture failed, timed out or exceeded size budget",
            ));
        }
        writer.file.sync_all()?;
        Ok(writer.file.metadata()?.len())
    }
}
struct BoundedDump {
    file: File,
    limit: u64,
    deadline: Instant,
    used_callback: bool,
}
unsafe extern "system" fn dump_io(
    param: *mut c_void,
    input: *const MINIDUMP_CALLBACK_INPUT,
    output: *mut MINIDUMP_CALLBACK_OUTPUT,
) -> BOOL {
    if param.is_null() || input.is_null() || output.is_null() {
        return 0;
    }
    // SAFETY: DbgHelp calls synchronously with the exclusive callback context.
    let writer = unsafe { &mut *param.cast::<BoundedDump>() };
    // SAFETY: input/output are API-supplied valid callback structures; copying
    // packed fields avoids forming unaligned references.
    let kind = unsafe { (*input).CallbackType as i32 };
    if kind == IoStartCallback {
        writer.used_callback = true;
        unsafe {
            (*output).Anonymous.Status = S_FALSE;
        }
    } else if kind == IoWriteAllCallback {
        // SAFETY: Io is the discriminated union variant for this callback type.
        let request = unsafe { (*input).Anonymous.Io };
        let end = request.Offset.checked_add(request.BufferBytes as u64);
        if end.is_none_or(|end| end > writer.limit)
            || Instant::now() >= writer.deadline
            || (request.Buffer.is_null() && request.BufferBytes > 0)
        {
            return 0;
        }
        if request.BufferBytes > 0 {
            // SAFETY: DbgHelp supplies BufferBytes readable bytes for the call.
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    request.Buffer.cast::<u8>(),
                    request.BufferBytes as usize,
                )
            };
            if writer
                .file
                .seek(SeekFrom::Start(request.Offset))
                .and_then(|_| writer.file.write_all(bytes))
                .is_err()
            {
                return 0;
            }
        }
        unsafe {
            (*output).Anonymous.Status = S_OK;
        }
    } else if kind == IoFinishCallback {
        unsafe {
            (*output).Anonymous.Status = S_OK;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_crash_fixture() {
        let Ok(root) = std::env::var("XHARNESS_TEST_CRASH_ROOT") else {
            return;
        };
        let path = std::path::PathBuf::from(root);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.join("permit").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        install_crash_signal(
            &path.join("context"),
            &std::env::var("XHARNESS_TEST_CRASH_EVENT").unwrap(),
        )
        .unwrap();
        // SAFETY: isolated child test process only. This intentionally raises an
        // unhandled software exception; no application/user data is loaded.
        unsafe {
            windows_sys::Win32::System::Diagnostics::Debug::SetErrorMode(2);
            windows_sys::Win32::System::Diagnostics::Debug::RaiseException(
                0xe0424242,
                0,
                0,
                ptr::null(),
            );
        }
    }
    #[test]
    fn external_crash_capture_saves_a_real_minidump() {
        exercise_capture(false);
    }
    #[test]
    fn external_crash_capture_saves_full_memory_when_selected() {
        exercise_capture(true);
    }
    fn exercise_capture(full: bool) {
        static FIXTURE_GATE: Mutex<()> = Mutex::new(());
        let _serial = FIXTURE_GATE.lock().unwrap();
        use std::os::windows::process::CommandExt;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "xharness-crash-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let event = format!("Local\\XHarnessTest-{}-{nonce}", std::process::id());
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "crash::tests::isolated_crash_fixture",
                "--nocapture",
            ])
            .env("XHARNESS_TEST_CRASH_ROOT", &root)
            .env("XHARNESS_TEST_CRASH_EVENT", &event)
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let result = (|| -> io::Result<()> {
            let capture = CrashCapture::prepare(child.id(), &event)?;
            fs::write(root.join("permit"), b"1")?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while !fs::metadata(root.join("context")).is_ok_and(|meta| meta.len() == 16) {
                if Instant::now() >= deadline {
                    return Err(io::Error::other("fixture did not signal crash"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let size = capture.capture(&root.join("context"), &root.join("crash.dmp"), full)?;
            assert!(
                size > 100
                    && size
                        <= if full {
                            512 * 1024 * 1024
                        } else {
                            64 * 1024 * 1024
                        }
            );
            let mut signature = [0u8; 4];
            File::open(root.join("crash.dmp"))?.read_exact(&mut signature)?;
            assert_eq!(&signature, b"MDMP");
            Ok(())
        })();
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root); // unique test-only directory
        result.unwrap();
    }
    #[test]
    fn dump_callback_rejects_writes_before_exceeding_budget() {
        let root =
            std::env::temp_dir().join(format!("xharness-dump-budget-{}.tmp", std::process::id()));
        let mut writer = BoundedDump {
            file: File::create(&root).unwrap(),
            limit: 8,
            deadline: Instant::now() + Duration::from_secs(5),
            used_callback: true,
        };
        // SAFETY: zeroed API POD structs are valid buffers for our callback;
        // below initializes the discriminant and the matching union variant.
        let mut input: MINIDUMP_CALLBACK_INPUT = unsafe { std::mem::zeroed() };
        let mut output: MINIDUMP_CALLBACK_OUTPUT = unsafe { std::mem::zeroed() };
        let mut bytes = [0u8; 9];
        input.CallbackType = IoWriteAllCallback as u32;
        input.Anonymous.Io = windows_sys::Win32::System::Diagnostics::Debug::MINIDUMP_IO_CALLBACK {
            Handle: 0,
            Offset: 0,
            Buffer: bytes.as_mut_ptr().cast(),
            BufferBytes: 9,
        };
        // SAFETY: all callback inputs refer to live, exclusively owned locals.
        assert_eq!(
            unsafe {
                dump_io(
                    (&mut writer as *mut BoundedDump).cast(),
                    &input,
                    &mut output,
                )
            },
            0
        );
        assert_eq!(writer.file.metadata().unwrap().len(), 0);
        drop(writer);
        fs::remove_file(root).unwrap();
    }
}
