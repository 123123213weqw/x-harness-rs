use super::windows_plan::{self, Placement, Preflight};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub(super) fn inspect(app: &AppHandle) -> Result<Preflight, String> {
    let current = windows_plan::directory(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    let elevated = xharness_win32::current_process_elevated().map_err(|e| e.to_string())?;
    let writable = windows_plan::writable(&current).map_err(|e| e.to_string())?;
    let local = app.path().local_data_dir().map_err(|e| e.to_string())?;
    let user = local.join("Programs").join("XHarness");
    let migration = if elevated {
        Err("Restart XHarness without administrator privileges before migration".to_owned())
    } else {
        match xharness_win32::machine_msi_registered("XHarness") {
            Ok(true) => Err("Machine-wide MSI detected; use a reviewed manual migration to preserve the old installation".to_owned()),
            Ok(false) => windows_plan::migration_target(&local),
            Err(error) => Err(format!("Cannot verify machine-wide installation; migration unavailable: {error}")),
        }
    };
    Ok(Preflight {
        needs_choice: elevated || !writable,
        current_directory: current.to_string_lossy().into_owned(),
        user_directory: user.to_string_lossy().into_owned(),
        migration_available: migration.is_ok(),
        reason: migration.err(),
    })
}

pub(super) fn select(
    app: &AppHandle,
    choice: Option<Placement>,
) -> Result<(Option<PathBuf>, bool), String> {
    let inspection = inspect(app)?; // Recheck facts; UI consent never bypasses native policy.
    let placement = windows_plan::select(
        inspection.needs_choice,
        choice,
        inspection.migration_available,
    )?;
    if placement == Placement::Current {
        if inspection.needs_choice
            && !xharness_win32::current_process_elevated().map_err(|e| e.to_string())?
        {
            if !xharness_win32::can_self_elevate().map_err(|e| e.to_string())? {
                return Err("This account cannot elevate without changing Windows user. Choose user-directory migration or a reviewed manual installation; tasks have not been stopped".into());
            }
            return Ok((None, true));
        }
        return Ok((None, false));
    }
    let local = app.path().local_data_dir().map_err(|e| e.to_string())?;
    let directory = windows_plan::migration_target(&local)?;
    // Destination is native-owned, never an arbitrary path supplied by WebView.
    Ok((Some(directory.join("xharness-desktop.exe")), false))
}

pub(super) struct ElevatedInstaller {
    _directory: tempfile::TempDir,
    executable: PathBuf,
    arguments: std::ffi::OsString,
}
impl ElevatedInstaller {
    pub(super) fn prepare(bytes: &[u8], current: &std::path::Path) -> Result<Self, String> {
        // This path only supports the signed NSIS executable distributed by us;
        // never invoke a ZIP/MSI with NSIS arguments or fall back to a shell.
        if std::env::args_os().nth(1).is_some() {
            return Err("Custom launch arguments require a reviewed manual administrator update; tasks have not been stopped".into());
        }
        if bytes.get(..2) != Some(b"MZ") {
            return Err("Administrator update requires an NSIS executable package".into());
        }
        let directory = tempfile::Builder::new()
            .prefix("xharness-admin-update-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let executable = directory.path().join("setup.exe");
        std::fs::write(&executable, bytes).map_err(|e| e.to_string())?;
        let mut arguments = std::ffi::OsString::from("/UPDATE /P /R ");
        arguments.push(super::windows_install_directory_arg(current)?); // /D is last, unquoted.
        Ok(Self {
            _directory: directory,
            executable,
            arguments,
        })
    }
    pub(super) fn launch(&self) -> Result<(), String> {
        xharness_win32::launch_elevated(&self.executable, &self.arguments)
            .map_err(|e| e.to_string())
    }
}
