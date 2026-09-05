fn main() {
    // The bundled UI is served by the authenticated loopback Host, not a
    // tauri:// page. Remote IPC requires explicit application permissions too;
    // core:default alone only authorizes Tauri's own commands.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "desktop_check_update",
            "desktop_update_status",
            "desktop_download_update",
            "desktop_install_update",
        ]),
    ))
    .expect("failed to generate desktop IPC permissions")
}
