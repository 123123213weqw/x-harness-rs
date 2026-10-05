//! All COM and Win32 calls are confined to a disposable worker process.
//! The UIA thread is MTA and never owns a window. A separate native indicator
//! thread owns the non-activating, capture-excluded activity window.
#[cfg(feature = "native-acceptance")]
pub mod acceptance;
mod input;
mod screen;
mod uia;

use crate::wire::{self, Frame, Reply, Request, Surface};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use windows::{
    core::w,
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WAIT_ABANDONED, WAIT_OBJECT_0},
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
            StationsAndDesktops::*,
            Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};
use xharness_computer::{ComputerAction, ComputerError, Region};

pub(super) type Result<T> = std::result::Result<T, ComputerError>;
pub(super) fn error(code: &str, message: &str) -> ComputerError {
    ComputerError::retryable(code, message)
}
pub(super) fn api<T>(value: windows::core::Result<T>) -> Result<T> {
    value.map_err(|e| {
        error(
            "native_api_failed",
            &format!("Windows API failed: 0x{:08x}", e.code().0 as u32),
        )
    })
}
pub(super) fn clipped(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(240)
        .collect()
}
pub(super) fn hwnd(value: u64) -> HWND {
    HWND(value as usize as *mut std::ffi::c_void)
}
pub(super) fn rect(value: RECT) -> Region {
    Region {
        x: f64::from(value.left),
        y: f64::from(value.top),
        width: f64::from(value.right - value.left),
        height: f64::from(value.bottom - value.top),
    }
}

/// Recheck HWND, PID and class. A reused handle is not a durable identity.
pub(super) fn surface(handle: HWND) -> Option<Surface> {
    // SAFETY: Win32 checks an HWND before using it; all output slices live.
    unsafe {
        if !IsWindow(Some(handle)).as_bool() || !IsWindowVisible(handle).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(handle, Some(&mut pid));
        let mut class = [0; 256];
        let n = GetClassNameW(handle, &mut class);
        let mut bounds = RECT::default();
        if pid == 0 || n <= 0 || GetWindowRect(handle, &mut bounds).is_err() {
            return None;
        }
        Some(Surface {
            handle: handle.0 as usize as u64,
            pid,
            class: String::from_utf16_lossy(&class[..n as usize]),
            bounds: rect(bounds),
        })
    }
}
pub(super) fn verify_surface(expected: &Surface, geometry: bool) -> Result<HWND> {
    let actual = surface(hwnd(expected.handle))
        .ok_or_else(|| error("stale_surface", "window disappeared; observe again"))?;
    if actual.pid != expected.pid
        || actual.class != expected.class
        || (geometry && actual.bounds != expected.bounds)
    {
        return Err(error(
            "stale_surface",
            "window identity or geometry changed; observe again",
        ));
    }
    Ok(hwnd(actual.handle))
}
pub(super) fn foreground() -> Option<Surface> {
    // UIA SetFocus can transiently expose a child Edit as the foreground
    // HWND. Normalize only child ancestry, NOT owner ancestry: another popup
    // or top-level window still invalidates the observed frame.
    // SAFETY: both HWNDs are borrowed, and surface validates the root.
    surface(unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) })
}
pub(super) fn desktop() -> Region {
    // SAFETY: metrics are process-independent virtual-desktop dimensions.
    unsafe {
        Region {
            x: f64::from(GetSystemMetrics(SM_XVIRTUALSCREEN)),
            y: f64::from(GetSystemMetrics(SM_YVIRTUALSCREEN)),
            width: f64::from(GetSystemMetrics(SM_CXVIRTUALSCREEN)),
            height: f64::from(GetSystemMetrics(SM_CYVIRTUALSCREEN)),
        }
    }
}

pub(super) struct Cancellation {
    flag: Arc<AtomicBool>,
    deadline: Instant,
}
impl Cancellation {
    pub(super) fn check(&self) -> Result<()> {
        if self.flag.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(ComputerError {
                code: "cancelled".into(),
                message: "computer operation cancelled; verify UI before issuing new input".into(),
                retryable: false,
            });
        }
        Ok(())
    }
    pub(super) fn sleep(&self, duration: Duration) -> Result<()> {
        let end = Instant::now() + duration;
        while Instant::now() < end {
            self.check()?;
            std::thread::sleep(
                Duration::from_millis(10).min(end.saturating_duration_since(Instant::now())),
            );
        }
        self.check()
    }
}

struct DesktopGuard(HDESK);
impl Drop for DesktopGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.0);
        }
    }
}
fn require_interactive_desktop() -> Result<()> {
    // SAFETY: read-only handle, no desktop switch, never crosses UAC desktop.
    let owned = DesktopGuard(api(unsafe {
        OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
    })?);
    let mut name = [0u16; 128];
    api(unsafe {
        GetUserObjectInformationW(
            HANDLE(owned.0 .0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            None,
        )
    })?;
    let n = name.iter().position(|&n| n == 0).unwrap_or(name.len());
    if !String::from_utf16_lossy(&name[..n]).eq_ignore_ascii_case("Default") {
        return Err(error(
            "desktop_unavailable",
            "locked or secure desktop cannot be observed or controlled",
        ));
    }
    if desktop().width <= 1.0 || foreground().is_none() {
        return Err(error(
            "desktop_unavailable",
            "no interactive desktop is available",
        ));
    }
    Ok(())
}

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct Serial {
    handle: HANDLE,
    acquired: bool,
}
impl Drop for Serial {
    fn drop(&mut self) {
        unsafe {
            if self.acquired {
                let _ = ReleaseMutex(self.handle);
            }
            let _ = CloseHandle(self.handle);
        }
    }
}
fn serial(cancel: &Cancellation) -> Result<Serial> {
    // Kernel namespace Local scopes serialization to this interactive logon
    // session, across all Host instances. No GUI operations overlap.
    let handle =
        api(unsafe { CreateMutexW(None, false, w!("Local\\XHarness.Computer.Input.v1")) })?;
    let mut lock = Serial {
        handle,
        acquired: false,
    };
    loop {
        cancel.check()?;
        let result = unsafe { WaitForSingleObject(handle, 50) };
        if result == WAIT_OBJECT_0 {
            lock.acquired = true;
            return Ok(lock);
        }
        if result == WAIT_ABANDONED {
            lock.acquired = true;
            return Err(error(
                "stale_frame",
                "previous desktop controller exited unexpectedly; observe again",
            ));
        }
        if result != windows::Win32::Foundation::WAIT_TIMEOUT {
            return Err(error(
                "desktop_busy",
                "desktop controller lock is unavailable",
            ));
        }
    }
}

fn indicator(action: ComputerAction) -> Result<()> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let text = if matches!(action, ComputerAction::Observe | ComputerAction::Wait) {
            w!("XHarness — Viewing the screen")
        } else {
            w!("XHarness — Controlling the desktop")
        };
        // The native STATIC class needs no caller-owned WndProc. This thread
        // does not initialize UIA and never activates the target window.
        let result = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
                w!("STATIC"),
                text,
                WS_POPUP
                    | WS_VISIBLE
                    | WINDOW_STYLE(
                        windows::Win32::System::SystemServices::SS_CENTER.0
                            | windows::Win32::System::SystemServices::SS_CENTERIMAGE.0,
                    ),
                (GetSystemMetrics(SM_CXSCREEN) - 380) / 2,
                12,
                380,
                36,
                None,
                None,
                None,
                None,
            )
        };
        let Ok(handle) = result else {
            let _ = sender.send(false);
            return;
        };
        let excluded = unsafe { SetWindowDisplayAffinity(handle, WDA_EXCLUDEFROMCAPTURE) }.is_ok();
        let _ = sender.send(excluded);
        if !excluded {
            unsafe {
                let _ = DestroyWindow(handle);
            }
            return;
        }
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    });
    if receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(error(
            "indicator_unavailable",
            "cannot display the native desktop activity indicator",
        ))
    }
}

pub(super) fn windows() -> Result<Vec<Surface>> {
    unsafe extern "system" fn collect(handle: HWND, data: LPARAM) -> windows::core::BOOL {
        // SAFETY: EnumWindows synchronously calls back with a live Vec pointer.
        let entries = unsafe { &mut *(data.0 as *mut Vec<Surface>) };
        if entries.len() >= 128 {
            return false.into();
        }
        if let Some(s) = surface(handle) {
            if s.pid != std::process::id() && s.bounds.width > 0.0 && s.bounds.height > 0.0 {
                entries.push(s);
            }
        }
        true.into()
    }
    let mut entries: Vec<Surface> = Vec::new();
    let result = unsafe {
        EnumWindows(
            Some(collect),
            LPARAM((&mut entries as *mut Vec<Surface>) as isize),
        )
    };
    if entries.len() < 128 {
        api(result)?;
    }
    let front = foreground().map(|f| f.handle);
    entries.sort_by_key(|s| Some(s.handle) != front);
    Ok(entries)
}
pub(super) fn window_title(handle: HWND) -> String {
    let mut text = [0; 512];
    let len = unsafe { GetWindowTextW(handle, &mut text) }.max(0) as usize;
    clipped(&String::from_utf16_lossy(&text[..len]))
}

fn check_frame(frame: &Frame, pointer: bool) -> Result<()> {
    if desktop() != frame.desktop {
        return Err(error(
            "stale_frame",
            "display layout changed; observe again",
        ));
    }
    let expected = frame
        .foreground
        .as_ref()
        .ok_or_else(|| error("stale_frame", "observation has no foreground window"))?;
    let actual =
        foreground().ok_or_else(|| error("stale_frame", "foreground window is unavailable"))?;
    if actual.handle != expected.handle || actual.pid != expected.pid {
        return Err(error(
            "stale_frame",
            "foreground application changed; observe again",
        ));
    }
    verify_surface(expected, pointer)?;
    Ok(())
}

fn execute(request: Request, cancel: &Cancellation) -> Result<(Reply, Vec<u8>)> {
    if request.schema != 1 {
        return Err(ComputerError::invalid(
            "unsupported private computer protocol",
        ));
    }
    request.request.validate()?;
    let _lock = serial(cancel)?;
    require_interactive_desktop()?;
    indicator(request.request.action)?;
    // SAFETY: this thread has no windows/COM objects yet. S_OK and S_FALSE both
    // require exactly one balanced CoUninitialize after all UIA objects drop.
    api(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok())?;
    let _com = Com;
    let automation = uia::Automation::new()?;
    let r = &request.request;
    let observing = r.action == ComputerAction::Observe
        || (r.action == ComputerAction::Window && r.operation.as_deref() == Some("list"));
    if !observing && r.action != ComputerAction::Wait {
        let frame = request
            .frame
            .as_ref()
            .ok_or_else(|| error("stale_frame", "observe before operating"))?;
        if r.action != ComputerAction::Window {
            check_frame(
                frame,
                matches!(
                    r.action,
                    ComputerAction::Move
                        | ComputerAction::Click
                        | ComputerAction::Drag
                        | ComputerAction::Scroll
                ),
            )?;
        }
        input::perform(&automation, &request, cancel).map_err(|mut e| {
            e.retryable = false;
            e
        })?;
    } else if r.action == ComputerAction::Wait {
        cancel.sleep(Duration::from_millis(r.duration_ms.unwrap_or(1000)))?;
    }
    cancel.check()?;
    if observing || r.wants_observation_after() {
        let (mut reply, png) = automation.observe(r, cancel).map_err(|e| {
            if observing { e } else { ComputerError { code: "outcome_unknown".into(), message: format!("action was dispatched, but follow-up observation failed: {}; do not replay input", e.code), retryable: false } }
        })?;
        reply.value["action"] = json!(r.action);
        reply.value["performed"] = json!(!observing && r.action != ComputerAction::Wait);
        Ok((reply, png))
    } else {
        Ok((
            Reply {
                schema: 1,
                value: json!({"action":r.action,"performed":r.action != ComputerAction::Wait}),
                error: None,
                frame: None,
                nodes: vec![],
                surfaces: vec![],
                png_len: 0,
            },
            vec![],
        ))
    }
}

/// Child-only entry point. Parent EOF is cancellation, not another command.
pub fn run_worker() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut stdin = io::stdin();
    let bytes = wire::read_packet(&mut stdin, wire::MAX_REQUEST)?;
    let request: Request = serde_json::from_slice(&bytes)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let watcher = Arc::clone(&cancelled);
    std::thread::spawn(move || {
        let mut byte = [0];
        let _ = stdin.read(&mut byte);
        watcher.store(true, Ordering::Release);
    });
    let cancel = Cancellation {
        flag: cancelled,
        deadline: Instant::now() + Duration::from_secs(40),
    };
    // Thread-local PMv2 removes all DPI virtualization from coordinates, UIA,
    // GDI capture and SendInput. This never changes the Host/Tauri DPI mode.
    let prior = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if prior.0.is_null() {
        return Err("cannot establish worker physical-pixel DPI context".into());
    }
    let outcome = execute(request, &cancel);
    let (reply, png) = match outcome {
        Ok(value) => value,
        Err(error) => (
            Reply {
                schema: 1,
                value: Value::Null,
                error: Some(error.into()),
                frame: None,
                nodes: vec![],
                surfaces: vec![],
                png_len: 0,
            },
            vec![],
        ),
    };
    let bytes = serde_json::to_vec(&reply)?;
    let mut stdout = io::stdout().lock();
    wire::write_packet(&mut stdout, &bytes, wire::MAX_METADATA)?;
    stdout.write_all(&png)?;
    stdout.flush()?;
    Ok(())
}
