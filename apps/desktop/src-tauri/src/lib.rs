mod account_callback;
mod browser;
mod browser_bridge;
mod browser_delegation;
mod browser_inspect;
mod browser_lifecycle;
mod browser_perform;
mod computer_activity;
mod diagnostics;
mod installations;
mod managed_account;
mod native_startup;
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
    native_startup::prepare().expect("native runtime prerequisites failed");
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                // A full UI reload cannot run React unmount cleanup. Drop guest
                // views now; persisted tab URLs are restored by the new page.
                browser::close_all(webview.app_handle());
            }
        })
        .setup(|app| {
            let state = DesktopState::initialize(app.handle())?;
            app.manage(state);
            app.manage(managed_account::ManagedAccountState::default());
            managed_account::install_callbacks(app.handle());
            app.manage(installations::InstallationState::initialize(app.handle()));
            tauri::async_runtime::spawn(installations::worker(app.handle().clone()));
            app.manage(computer_activity::DesktopComputerActivityState::default());
            app.manage(browser::BrowserState::default());
            app.manage(browser_bridge::BrowserBridge::default());
            app.manage(browser_lifecycle::BrowserLifecycle::default());
            configure_linux_webview(app.handle());
            if app
                .state::<DesktopState>()
                .diagnostics
                .previous_run_interrupted()
            {
                diagnostics::open_automatically(app.handle());
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
                } else {
                    installations::started(&handle);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            managed_account::desktop_account_status,
            managed_account::desktop_account_open,
            managed_account::desktop_account_start,
            managed_account::desktop_account_poll,
            managed_account::desktop_account_finish,
            sidecar::desktop_status,
            installations::desktop_installation_status,
            installations::desktop_set_installation_statistics,
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
            browser::desktop_browser_navigate,
            browser::desktop_browser_page_state,
            browser::desktop_browser_activate,
            browser::desktop_browser_bounds,
            browser::desktop_browser_action,
            browser::desktop_browser_close,
            browser::desktop_browser_restore,
            browser::desktop_browser_persist,
            browser_lifecycle::desktop_browser_control_reply,
            browser_delegation::desktop_browser_delegate,
            browser_delegation::desktop_browser_access,
            browser_inspect::desktop_browser_inspect,
            browser_perform::desktop_browser_perform,
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
                browser::close_all(&handle);
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
