fn main() {
    // The bundled UI is served by the authenticated loopback Host, not a
    // tauri:// page. Remote IPC requires explicit application permissions too;
    // core:default alone only authorizes Tauri's own commands.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "desktop_report_startup_phase",
            "desktop_open_diagnostics",
            "desktop_diagnostics_status",
            "desktop_export_diagnostics",
            "desktop_diagnostics_acknowledge",
            "desktop_set_deep_diagnostics",
            "desktop_check_update",
            "desktop_update_status",
            "desktop_download_update",
            "desktop_install_update",
            "desktop_set_computer_activity",
            "desktop_browser_navigate",
            "desktop_browser_activate",
            "desktop_browser_bounds",
            "desktop_browser_action",
            "desktop_browser_close",
            "desktop_browser_restore",
            "desktop_browser_persist",
            "desktop_browser_inspect",
            "desktop_browser_perform",
        ]),
    ))
    .expect("failed to generate desktop IPC permissions")
}
