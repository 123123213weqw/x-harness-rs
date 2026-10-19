fn main() {
    println!("cargo:rerun-if-env-changed=XHARNESS_ACCOUNT_ORIGIN");
    println!("cargo:rerun-if-env-changed=XHARNESS_INSTALLATION_ENDPOINT");
    println!("cargo:rerun-if-env-changed=XHARNESS_RELEASE_CHANNEL");
    // Wry imports TaskDialogIndirect (ComCtl32 v6). Tauri resources cover
    // the production bin but not Cargo's lib test executable. Give every
    // executable target the same activation dependency, including unit tests.
    // Embed once at link time. Tauri's RC manifest is disabled for MSVC below;
    // embedding both produces duplicate type=MANIFEST/name=1 resources.
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("windows-common-controls.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    if std::env::var("TARGET").is_ok_and(|target| target.ends_with("windows-msvc")) {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    // The bundled UI is served by the authenticated loopback Host, not a
    // tauri:// page. Remote IPC requires explicit application permissions too;
    // core:default alone only authorizes Tauri's own commands.
    let attributes = tauri_build::Attributes::new();
    let attributes = if std::env::var("TARGET").is_ok_and(|target| target.ends_with("windows-msvc"))
    {
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };
    tauri_build::try_build(
        attributes.app_manifest(tauri_build::AppManifest::new().commands(&[
            "desktop_account_status",
            "desktop_account_open",
            "desktop_account_start",
            "desktop_account_poll",
            "desktop_account_finish",
            "desktop_status",
            "desktop_installation_status",
            "desktop_set_installation_statistics",
            "desktop_report_startup_phase",
            "desktop_open_diagnostics",
            "desktop_diagnostics_status",
            "desktop_export_diagnostics",
            "desktop_diagnostics_acknowledge",
            "desktop_set_deep_diagnostics",
            "desktop_check_update",
            "desktop_update_status",
            "desktop_update_preflight",
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
            "desktop_browser_control_reply",
            "desktop_browser_delegate",
            "desktop_browser_access",
            "desktop_browser_inspect",
            "desktop_browser_perform",
        ])),
    )
    .expect("failed to generate desktop IPC permissions")
}
