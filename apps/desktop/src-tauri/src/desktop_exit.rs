//! One exit gate. A failed graceful stop keeps the UI and Host alive instead
//! of ignoring the error and leaving the next launch locked out.
#![forbid(unsafe_code)]
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use xharness_diagnostics::{ExitSource, Phase, Record};

pub fn record(app: &AppHandle, phase: Phase, source: ExitSource, code: Option<i32>) {
    let mut record = Record::new(phase);
    record.pid = Some(std::process::id());
    record.exit_source = Some(source);
    record.exit_code = code;
    app.state::<crate::DesktopState>()
        .diagnostics
        .record(record);
}

pub fn request(app: &AppHandle, source: ExitSource, code: i32) {
    record(app, Phase::DesktopCloseRequested, source, Some(code));
    let state = app.state::<crate::DesktopState>();
    if state.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while handle
            .state::<crate::DesktopState>()
            .update_busy
            .swap(true, Ordering::SeqCst)
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        crate::computer_activity::clear(&handle);
        match crate::sidecar::graceful_stop(&handle).await {
            Ok(()) => {
                crate::browser::close_all(&handle);
                handle.exit(code);
            }
            Err(_) => {
                record(&handle, Phase::DesktopExitBlocked, source, Some(code));
                let state = handle.state::<crate::DesktopState>();
                state.update_busy.store(false, Ordering::SeqCst);
                state.closing.store(false, Ordering::SeqCst);
                state.diagnostics.mark_incident();
                let _=handle.emit("xharness-host",serde_json::json!({"phase":"error","message":"Host 尚未确认安全退出，窗口和任务已保留。请查看运行诊断后重试。"}));
                crate::diagnostics::open_automatically(&handle);
            }
        }
    });
}

/// Keep ordinary native Edit/Window menus. Only replace the macOS app submenu:
/// predefined Quit invokes NSApplication.terminate directly, bypassing our
/// asynchronous exit admission. Explicit Quit now uses the same gate as Close.
#[cfg(target_os = "macos")]
pub fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Native, Submenu};
    let menu = Menu::default(app)?;
    let _ = menu.remove_at(0)?;
    let quit = MenuItem::with_id(
        app,
        "xharness-safe-quit",
        format!("Quit {}", app.package_info().name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let about = AboutMetadata {
        name: Some(app.package_info().name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let submenu = Submenu::with_items(
        app,
        app.package_info().name.clone(),
        true,
        &[
            &Native::about(app, None, Some(about))?,
            &Native::separator(app)?,
            &Native::services(app, None)?,
            &Native::separator(app)?,
            &Native::hide(app, None)?,
            &Native::hide_others(app, None)?,
            &Native::separator(app)?,
            &quit,
        ],
    )?;
    menu.prepend(&submenu)?;
    let _ = app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        if event.id().as_ref() == "xharness-safe-quit" {
            request(handle, ExitSource::Menu, 0);
        }
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install_menu(_: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

pub fn may_exit(host_running: bool) -> bool {
    !host_running
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_shutdown_request_or_timeout_does_not_make_a_running_host_safe_to_exit() {
        assert!(!super::may_exit(true));
        assert!(super::may_exit(false));
    }
}
