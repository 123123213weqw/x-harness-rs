mod computer_activity;
mod diagnostics;
mod sidecar;
mod startup;
mod updater;

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

pub use sidecar::DesktopState;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapEvent {
    phase: &'static str,
    message: String,
}

pub fn run() {
    let app = tauri::Builder::default()
        // Keep the identifier stable across release channels and install paths.
        // This must run before any plugin/setup that can start a second Host.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = DesktopState::initialize(app.handle())?;
            app.manage(state);
            app.manage(computer_activity::DesktopComputerActivityState::default());
            configure_linux_webview(app.handle());
            if app.state::<DesktopState>().diagnostics.incident() {
                let _ = diagnostics::open(app.handle());
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle.emit(
                    "xharness-bootstrap",
                    DesktopBootstrapEvent {
                        phase: "starting",
                        message: "正在启动 XHarness Host…".to_owned(),
                    },
                );
                if let Err(error) = sidecar::start(&handle).await {
                    let _ = handle.emit(
                        "xharness-bootstrap",
                        DesktopBootstrapEvent {
                            phase: "failed",
                            message: error,
                        },
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::desktop_status,
            startup::desktop_report_startup_phase,
            diagnostics::desktop_open_diagnostics,
            diagnostics::desktop_diagnostics_status,
            diagnostics::desktop_export_diagnostics,
            diagnostics::desktop_diagnostics_acknowledge,
            diagnostics::desktop_set_deep_diagnostics,
            updater::desktop_check_update,
            updater::desktop_update_status,
            updater::desktop_download_update,
            updater::desktop_install_update,
            computer_activity::desktop_set_computer_activity,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            api.prevent_close();
            let state = window.state::<DesktopState>();
            if state.closing.swap(true, Ordering::SeqCst) {
                return;
            }
            let handle = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                // Check/Download observe closing and drop the HTTP future.
                // An installation already in progress must finish, not be killed
                // mid-replacement. Claim the gate before stopping the Host.
                while handle
                    .state::<DesktopState>()
                    .update_busy
                    .swap(true, Ordering::SeqCst)
                {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                computer_activity::clear(&handle);
                let _ = sidecar::graceful_stop(&handle).await;
                handle.exit(0);
            });
        })
        .build(tauri::generate_context!())
        .expect("failed to build XHarness desktop application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            sidecar::force_stop(handle);
            handle.state::<DesktopState>().diagnostics.finish();
        }
    });
}

#[cfg(target_os = "linux")]
fn configure_linux_webview(app: &tauri::AppHandle) {
    use gtk::prelude::WidgetExt;
    use webkit2gtk::{CacheModel, WebContextExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Tauri starts on a bundled bootstrap document, then navigates to the Host
    // origin.  WebKit's WebBrowser cache model may retain the old renderer as a
    // spare process.  DocumentBrowser keeps normal document/resource caching,
    // but disables that process cache so warm reopen does not accumulate a
    // second WebKitWebProcess.
    let handle = app.clone();
    let _ = window.with_webview(move |webview| {
        if let Some(context) = webview.inner().context() {
            context.set_cache_model(CacheModel::DocumentBrowser);
        }
        // GTK's map signal is the actual native window/widget mapping boundary;
        // it is not inferred from navigation or JavaScript evaluation.
        if webview.inner().is_mapped() {
            let state = handle.state::<DesktopState>();
            state.startup.window_mapped(&state.diagnostics);
        }
        webview.inner().connect_map(move |_| {
            let state = handle.state::<DesktopState>();
            state.startup.window_mapped(&state.diagnostics);
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webview(_: &tauri::AppHandle) {}
