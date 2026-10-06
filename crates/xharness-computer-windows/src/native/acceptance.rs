//! An explicit, independently graded Win32 fixture, not model self-evaluation.
//! This module is absent from normal product builds.
use super::api;
use crate::WindowsComputer;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use windows::{
    core::w,
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::*,
            Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyState},
            WindowsAndMessaging::*,
        },
    },
};
use xharness_computer::{ComputerDriver, ComputerRequest};

static CLICKS: AtomicU32 = AtomicU32::new(0);
static CONTROL_A: AtomicU32 = AtomicU32::new(0);
static WHEELS: AtomicU32 = AtomicU32::new(0);
unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_COMMAND && wparam.0 & 0xffff == 1002 {
        CLICKS.fetch_add(1, Ordering::Relaxed);
    }
    if message == WM_MOUSEWHEEL {
        WHEELS.fetch_add(1, Ordering::Relaxed);
        return LRESULT(0);
    }
    if message == WM_DESTROY {
        unsafe {
            PostQuitMessage(0);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}
struct Fixture {
    root: usize,
    edit: usize,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.root as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}
impl Fixture {
    fn open() -> Result<Self, Box<dyn std::error::Error>> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = (|| -> Result<(usize, usize), Box<dyn std::error::Error>> {
                unsafe {
                    if SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
                        .0
                        .is_null()
                    {
                        return Err("cannot establish fixture-window DPI context".into());
                    }
                    let module = api(GetModuleHandleW(None))?;
                    let instance = HINSTANCE(module.0);
                    let class = WNDCLASSW {
                        lpfnWndProc: Some(procedure),
                        hInstance: instance,
                        lpszClassName: w!("XHarnessComputerAcceptance"),
                        ..Default::default()
                    };
                    if RegisterClassW(&class) == 0 {
                        return Err("cannot register fixture class".into());
                    }
                    let root = api(CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        class.lpszClassName,
                        w!("XHarness Computer Use acceptance fixture"),
                        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                        120,
                        100,
                        600,
                        420,
                        None,
                        None,
                        Some(instance),
                        None,
                    ))?;
                    let edit = api(CreateWindowExW(
                        WS_EX_CLIENTEDGE,
                        w!("EDIT"),
                        w!(""),
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(0x0004 | 0x1000),
                        24,
                        36,
                        420,
                        100,
                        Some(root),
                        Some(HMENU(1001 as *mut _)),
                        Some(instance),
                        None,
                    ))?;
                    let _button = api(CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Confirm fixture"),
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                        24,
                        170,
                        160,
                        36,
                        Some(root),
                        Some(HMENU(1002 as *mut _)),
                        Some(instance),
                        None,
                    ))?;
                    // Single-line ValuePattern and password fixtures. These
                    // never receive model input and use no real credentials.
                    let _readable = api(CreateWindowExW(
                        WS_EX_CLIENTEDGE,
                        w!("EDIT"),
                        w!("known input"),
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                        24,
                        270,
                        200,
                        26,
                        Some(root),
                        Some(HMENU(1003 as *mut _)),
                        Some(instance),
                        None,
                    ))?;
                    let _password = api(CreateWindowExW(
                        WS_EX_CLIENTEDGE,
                        w!("EDIT"),
                        w!("fixture secret"),
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(0x0020),
                        24,
                        310,
                        200,
                        26,
                        Some(root),
                        Some(HMENU(1004 as *mut _)),
                        Some(instance),
                        None,
                    ))?;
                    let wrapper = api(CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("STATIC"),
                        w!("Excluded intermediate wrapper"),
                        WS_CHILD | WS_VISIBLE,
                        300,
                        270,
                        240,
                        70,
                        Some(root),
                        None,
                        Some(instance),
                        None,
                    ))?;
                    let _nested = api(CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Promoted visible child"),
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP,
                        8,
                        28,
                        210,
                        28,
                        Some(wrapper),
                        Some(HMENU(1005 as *mut _)),
                        Some(instance),
                        None,
                    ))?;
                    let _ = SetForegroundWindow(root);
                    Ok((root.0 as usize, edit.0 as usize))
                }
            })();
            let Ok(handles) = result else {
                let _ = tx.send(None);
                return;
            };
            let _ = tx.send(Some(handles));
            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
                // Observe delivered input independently; don't implement a
                // fake Ctrl+A shortcut in the classic Edit control.
                if message.hwnd == HWND(handles.1 as *mut _)
                    && message.message == WM_KEYDOWN
                    && message.wParam.0 == 0x41
                    && unsafe { GetKeyState(0x11) } < 0
                {
                    CONTROL_A.fetch_add(1, Ordering::Relaxed);
                }
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        });
        let (root, edit) = rx
            .recv_timeout(Duration::from_secs(3))?
            .ok_or("fixture creation failed")?;
        Ok(Self { root, edit })
    }
    fn text(&self) -> String {
        let mut units = [0u16; 8192];
        let length =
            unsafe { GetWindowTextW(HWND(self.edit as *mut _), &mut units) }.max(0) as usize;
        String::from_utf16_lossy(&units[..length])
    }
}
fn record(name: &str, detail: Value) {
    println!("{}", json!({"case":name,"passed":true,"detail":detail}));
}
/// Verify actual UIA logical descendant promotion independently of our walk.
/// This is not a model assertion or proof of every provider's offscreen data.
fn verify_filtered_descendant(root: usize) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::{
        System::{Com::*, Variant::VARIANT},
        UI::Accessibility::*,
    };
    struct ComScope;
    impl Drop for ComScope {
        fn drop(&mut self) {
            // SAFETY: paired with the successful initialization on this thread;
            // UIA interfaces created below are dropped before this guard.
            unsafe { CoUninitialize() };
        }
    }
    // SAFETY: fixture-only synchronous block, never crosses an await/thread.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let _com = ComScope;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let root = automation.ElementFromHandle(HWND(root as *mut _))?;
        let condition = automation.CreatePropertyCondition(
            UIA_NamePropertyId,
            &VARIANT::from("Promoted visible child"),
        )?;
        let walker = automation.CreateTreeWalker(&condition)?;
        let child = walker.GetFirstChildElement(&root)?;
        if child.CurrentName()?.to_string() != "Promoted visible child"
            || child.CurrentIsOffscreen()?.as_bool()
        {
            return Err("filtered walker lost the visible nested child".into());
        }
        let raw_parent = automation.RawViewWalker()?.GetParentElement(&child)?;
        let parent_name = raw_parent.CurrentName()?.to_string();
        if parent_name != "Excluded intermediate wrapper" {
            return Err(format!("promotion fixture parent was {parent_name:?}, expected excluded intermediate wrapper").into());
        }
    }
    record(
        "native_filtered_descendant",
        json!({"actual_intermediate_parent_verified":true,"visible_descendant_promoted":true}),
    );
    Ok(())
}
async fn execute(
    driver: &WindowsComputer,
    value: Value,
) -> Result<xharness_computer::ComputerOutput, Box<dyn std::error::Error>> {
    match driver
        .execute(serde_json::from_value(value)?, CancellationToken::new())
        .await
    {
        Ok(output) => Ok(output),
        Err(error) => {
            println!(
                "{}",
                json!({"case":"native_action_failure","passed":false,"detail":{"code":error.code,"message":error.message,"retryable":error.retryable,"foreground":super::foreground()}})
            );
            Err(error.into())
        }
    }
}
fn frame(output: &xharness_computer::ComputerOutput) -> Result<String, Box<dyn std::error::Error>> {
    Ok(output.value["frame_id"]
        .as_str()
        .ok_or("missing frame")?
        .to_owned())
}
fn node(
    output: &xharness_computer::ComputerOutput,
    role: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    Ok(output.value["accessibility"]["nodes"]
        .as_array()
        .ok_or("missing tree")?
        .iter()
        .find(|n| n["role"] == role)
        .ok_or("missing expected fixture control")?["node_id"]
        .as_str()
        .ok_or("missing node id")?
        .to_owned())
}
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("XHARNESS_DISPOSABLE_COMPUTER_VM").as_deref()
        != Ok("66b64058-bdcc-43e9-85ee-55a79fe2e875")
    {
        return Err("acceptance requires the authorized disposable VM guard".into());
    }
    let prior = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if prior.0.is_null() {
        return Err("cannot establish fixture physical-pixel DPI context".into());
    }
    let fixture = Fixture::open()?;
    let started = Instant::now();
    verify_filtered_descendant(fixture.root)?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let driver = Arc::new(WindowsComputer::new()?);
    let observe = json!({"action":"observe","detail":"semantic","include_screenshot":false});
    let mut output = execute(&driver, observe.clone()).await?;
    let own = output.value["surfaces"]
        .as_array()
        .ok_or("missing surfaces")?
        .iter()
        .find(|s| s["pid"] == std::process::id())
        .ok_or("fixture window absent")?;
    if own["frontmost"] != true {
        return Err("fixture did not obtain foreground; no input tests run".into());
    }
    if output.value["coordinate_space"] != "physical_desktop_pixels" {
        return Err("incorrect coordinate space".into());
    }
    let sid = own["surface_id"].as_str().ok_or("surface id")?.to_owned();
    let old_frame = frame(&output)?;
    record(
        "native_observe",
        json!({"elapsed_ms":started.elapsed().as_millis(),"nodes":output.value["accessibility"]["nodes"].as_array().map(Vec::len)}),
    );
    let nodes = output.value["accessibility"]["nodes"]
        .as_array()
        .ok_or("missing nodes")?;
    let confirm = nodes
        .iter()
        .find(|node| node["label"] == "Confirm fixture")
        .ok_or("fixture button missing")?;
    let timings = &output.value["accessibility"]["timings"];
    if !confirm["actions"]
        .as_array()
        .is_some_and(|actions| actions.iter().any(|action| action == "invoke"))
        || timings["invoke_cache_hits"].as_u64().unwrap_or(0) == 0
    {
        return Err("cached invoke availability lost the independent fixture button".into());
    }
    record(
        "native_invoke_cache",
        json!({"button_action_preserved":true,"cache_hits":timings["invoke_cache_hits"],"live_fallbacks":timings["invoke_live_fallbacks"]}),
    );
    let readable = nodes
        .iter()
        .find(|n| n["value_state"] == "known" && n["value"] == "known input")
        .ok_or("single-line ValuePattern input missing")?;
    let region = readable["bounds"].clone();
    if !nodes.iter().any(|n| {
        n["value_state"] == "redacted"
            && n["value"] == "<redacted>"
            && n["actions"].as_array().is_some_and(Vec::is_empty)
    }) || output.value.to_string().contains("fixture secret")
    {
        return Err("password was not redacted".into());
    }
    record(
        "native_input_state",
        json!({"valuepattern_matches_independent_fixture":true,"password_redacted":true}),
    );
    let restricted = execute(
        &driver,
        json!({"action":"observe","detail":"semantic","region":region,"include_screenshot":false}),
    )
    .await?;
    let restricted_nodes = restricted.value["accessibility"]["nodes"]
        .as_array()
        .ok_or("missing restricted nodes")?;
    if !restricted_nodes.iter().any(|n| n["value"] == "known input")
        || restricted_nodes
            .iter()
            .any(|n| n["context_only"] != true && n["value_state"] == "redacted")
        || !restricted.value["accessibility"]["truncation_reasons"].is_array()
    {
        return Err("region filtering or truncation metadata mismatch".into());
    }
    record(
        "native_ax_region",
        json!({"outside_password_excluded":true,"ancestor_context_preserved":true,"nodes":restricted_nodes.len()}),
    );
    output = execute(&driver, observe.clone()).await?;
    let edit = node(&output, "edit")?;
    output = execute(
        &driver,
        json!({"action":"type","node_id":edit,"frame_id":frame(&output)?,"text":"XHarness 中文🙂"}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    if fixture.text() != "XHarness 中文🙂" {
        return Err(format!("Unicode fixture text mismatch: {:?}", fixture.text()).into());
    }
    record(
        "native_unicode_input",
        json!({"independent_getwindowtext_matches":true,"clipboard_used":false}),
    );
    let stale: ComputerRequest =
        serde_json::from_value(json!({"action":"click","frame_id":old_frame,"x":150,"y":150}))?;
    let e = driver
        .execute(stale, CancellationToken::new())
        .await
        .expect_err("stale frame must fail");
    if e.code != "stale_frame" || fixture.text() != "XHarness 中文🙂" {
        return Err("wrong stale frame error".into());
    }
    record(
        "stale_frame_denied",
        json!({"text_unchanged":fixture.text()=="XHarness 中文🙂"}),
    );
    output = execute(
        &driver,
        json!({"action":"keypress","keys":["a"],"modifiers":["ctrl"],"frame_id":frame(&output)?}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    if CONTROL_A.load(Ordering::Relaxed) != 1 {
        return Err("Ctrl+A keydown/modifier did not reach the fixture exactly once".into());
    }
    record(
        "native_ctrl_a_delivery",
        json!({"independent_keydown_count":1}),
    );
    // Classic multiline Edit is not required to implement Ctrl+A. Exercise
    // documented navigation/selection rather than changing the driver or
    // synthesizing an app shortcut to make the assertion pass.
    output = execute(&driver, json!({"action":"keypress","keys":["home"],"modifiers":["ctrl"],"frame_id":frame(&output)?})).await?;
    output = execute(&driver, json!({"action":"keypress","keys":["end"],"modifiers":["ctrl","shift"],"frame_id":frame(&output)?})).await?;
    let mut start = 0u32;
    let mut end = 0u32;
    unsafe {
        SendMessageW(
            HWND(fixture.edit as *mut _),
            0x00b0,
            Some(WPARAM((&mut start as *mut u32) as usize)),
            Some(LPARAM((&mut end as *mut u32) as isize)),
        );
    }
    if start != 0 || end as usize != fixture.text().encode_utf16().count() {
        return Err(format!("native selection mismatch: start={start}, end={end}").into());
    }
    output = execute(
        &driver,
        json!({"action":"type","node_id":node(&output,"edit")?,"frame_id":frame(&output)?,"text":"replacement"}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    if fixture.text() != "replacement" {
        return Err("keypress/selection replacement mismatch".into());
    }
    record(
        "native_keypress",
        json!({"ctrl_home_shift_end_replacement_matches":true}),
    );
    execute(
        &driver,
        json!({"action":"click","node_id":node(&output,"button")?,"frame_id":frame(&output)?}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    if CLICKS.load(Ordering::Relaxed) != 1 {
        return Err("button command was not delivered exactly once".into());
    }
    record(
        "native_semantic_click",
        json!({"independent_command_count":1}),
    );
    execute(
        &driver,
        json!({"action":"window","operation":"move","surface_id":sid,"x":180,"y":110}),
    )
    .await?;
    let current = super::surface(HWND(fixture.root as *mut _)).ok_or("fixture disappeared")?;
    if current.bounds.x != 180.0 || current.bounds.y != 110.0 {
        return Err("window move mismatch".into());
    }
    record(
        "native_window_move",
        json!({"independent_bounds_match":true}),
    );
    output = execute(
        &driver,
        json!({"action":"window","operation":"resize","surface_id":sid,"width":640,"height":440}),
    )
    .await?;
    let current = super::surface(HWND(fixture.root as *mut _)).ok_or("fixture disappeared")?;
    if current.bounds.width != 640.0 || current.bounds.height != 440.0 {
        return Err("window resize mismatch".into());
    }
    record(
        "native_window_resize",
        json!({"independent_bounds_match":true}),
    );
    let x = current.bounds.x + 550.0;
    let y = current.bounds.y + 340.0;
    output = execute(
        &driver,
        json!({"action":"scroll","frame_id":frame(&output)?,"x":x,"y":y,"delta_y":120}),
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    if WHEELS.load(Ordering::Relaxed) == 0 {
        return Err("scroll wheel message did not reach fixture".into());
    }
    record(
        "native_scroll",
        json!({"independent_wheel_messages":WHEELS.load(Ordering::Relaxed)}),
    );
    let token = CancellationToken::new();
    let request: ComputerRequest = serde_json::from_value(
        json!({"action":"drag","frame_id":frame(&output)?,"path":[{"x":x,"y":y},{"x":x+20.0,"y":y+10.0}],"duration_ms":5000,"observe_after":"never"}),
    )?;
    let owned = Arc::clone(&driver);
    let child_token = token.clone();
    let operation = tokio::spawn(async move { owned.execute(request, child_token).await });
    let until = Instant::now() + Duration::from_secs(6);
    while unsafe { GetAsyncKeyState(1) } >= 0 && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if unsafe { GetAsyncKeyState(1) } >= 0 {
        token.cancel();
        let _ = operation.await;
        return Err("cancel drag fixture never observed a held mouse button".into());
    }
    let held_at = Instant::now();
    token.cancel();
    let result = operation.await?;
    if result.is_ok() || unsafe { GetAsyncKeyState(1) } < 0 {
        return Err("cancelled drag left held mouse input or reported success".into());
    }
    record(
        "native_cancel_drag",
        json!({"mouse_up_verified":true,"cancel_ms":held_at.elapsed().as_millis()}),
    );
    output = execute(
        &driver,
        json!({"action":"observe","detail":"low","include_screenshot":true}),
    )
    .await?;
    let png = output.screenshot.ok_or("missing binary screenshot")?;
    let decoded = image::load_from_memory_with_format(&png.png, image::ImageFormat::Png)?;
    let desktop = super::desktop();
    if decoded.width() != desktop.width as u32 || decoded.height() != desktop.height as u32 {
        return Err("screenshot coordinate dimensions mismatch".into());
    }
    std::fs::write(
        std::env::temp_dir().join("xharness-windows-computer-acceptance.png"),
        &png.png,
    )?;
    record(
        "native_screenshot",
        json!({"width":decoded.width(),"height":decoded.height(),"bytes":png.png.len(),"binary_transport":true}),
    );
    let wait_start = Instant::now();
    execute(
        &driver,
        json!({"action":"wait","duration_ms":100,"observe_after":"never"}),
    )
    .await?;
    if wait_start.elapsed() < Duration::from_millis(100) {
        return Err("native wait completed too early".into());
    }
    record(
        "native_wait",
        json!({"elapsed_ms":wait_start.elapsed().as_millis()}),
    );
    record(
        "native_acceptance",
        json!({"cases":16,"elapsed_ms":started.elapsed().as_millis(),"model_calls":0,"fixture_closed_on_return":true}),
    );
    Ok(())
}
