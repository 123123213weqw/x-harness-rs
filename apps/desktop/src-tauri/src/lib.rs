mod sidecar;
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = DesktopState::initialize(app.handle())?;
            app.manage(state);
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
            updater::desktop_check_update,
            updater::desktop_update_status,
            updater::desktop_download_update,
            updater::desktop_install_update,
        ])
        .on_window_event(|window, event| {
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
                let _ = sidecar::graceful_stop(&handle).await;
                handle.exit(0);
            });
        })
        .build(tauri::generate_context!())
        .expect("failed to build XHarness desktop application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            sidecar::force_stop(handle);
        }
    });
}
