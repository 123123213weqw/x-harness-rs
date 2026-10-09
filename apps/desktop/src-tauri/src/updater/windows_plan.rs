//! Installation placement policy, separate from update transport and Host lifecycle.
use serde::Deserialize;
#[cfg(windows)]
use serde::Serialize;
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Placement {
    Current,
    User,
}

#[cfg(windows)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub needs_choice: bool,
    pub current_directory: String,
    pub user_directory: String,
    pub migration_available: bool,
    pub reason: Option<String>,
}

pub fn directory(executable: &Path) -> Result<PathBuf, String> {
    let parent = executable.parent().filter(|p| p.parent().is_some());
    if !executable.is_absolute() || executable.components().any(|c| c == Component::ParentDir) {
        return Err("Invalid installation path".into());
    }
    parent
        .map(Path::to_owned)
        .ok_or_else(|| "Invalid installation directory".into())
}

/// Inspect existing ancestors without following redirects. An unknown/missing
/// permission is not evidence of safety. Installer repeats checks after exit.
fn no_redirects(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[cfg(windows)]
                let redirect = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let redirect = meta.file_type().is_symlink();
                if redirect {
                    return Err(io::Error::other("Redirected installation path"));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub fn writable(directory: &Path) -> io::Result<bool> {
    no_redirects(directory)?;
    let probe = || -> io::Result<()> {
        // Create/remove only a randomly named disposable probe, never real data.
        let file = tempfile::NamedTempFile::new_in(directory)?;
        file.close()?;
        for name in [
            "xharness-desktop.exe",
            "xharness-host.exe",
            "rg.exe",
            "xharness-windows-sandbox-runner.exe",
            "uninstall.exe",
        ] {
            let path = directory.join(name);
            match fs::symlink_metadata(&path) {
                Ok(meta) => {
                    no_redirects(&path)?;
                    if !meta.is_file() {
                        return Err(io::Error::other("Invalid application file"));
                    }
                    // No truncate and normal sharing: loaded executables remain live.
                    if meta.permissions().readonly() {
                        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
                    }
                    #[cfg(windows)]
                    if !xharness_win32::can_replace_file(&path).map_err(io::Error::other)? {
                        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
                    }
                    #[cfg(not(windows))]
                    fs::OpenOptions::new().write(true).open(path)?;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        Ok(())
    };
    match probe() {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(e), // sharing/IO failure is not an elevation request
    }
}

pub fn migration_target(local_data: &Path) -> Result<PathBuf, String> {
    directory(&local_data.join("placeholder.exe"))?;
    let target = local_data.join("Programs").join("XHarness");
    no_redirects(&target).map_err(|e| e.to_string())?;
    // Do not merge an unrelated or another existing installation silently.
    if target.exists()
        && fs::read_dir(&target)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("User installation directory is occupied; inspect it before migrating".into());
    }
    // Probe the nearest existing ancestor without creating a directory on cancel.
    let ancestor = target
        .ancestors()
        .find(|p| p.is_dir())
        .ok_or("Missing user data directory")?;
    if !writable(ancestor).map_err(|e| e.to_string())? {
        return Err("User installation directory is not writable".into());
    }
    Ok(target)
}

pub fn select(
    needs_choice: bool,
    choice: Option<Placement>,
    migration_available: bool,
) -> Result<Placement, String> {
    match choice {
        Some(Placement::User) if !migration_available => Err("Migration unavailable; run XHarness without administrator privileges and check the destination".into()),
        Some(value) => Ok(value),
        None if needs_choice => Err("Choose an installation location before stopping tasks".into()),
        None => Ok(Placement::Current),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn choice_is_explicit_and_fail_closed() {
        assert!(select(true, None, true).is_err());
        assert!(select(true, Some(Placement::User), false).is_err());
        assert_eq!(
            select(true, Some(Placement::Current), false).unwrap(),
            Placement::Current
        );
        assert_eq!(select(false, None, true).unwrap(), Placement::Current);
        assert_eq!(
            select(true, Some(Placement::User), true).unwrap(),
            Placement::User
        );
    }
    #[test]
    fn reject_relative_root_and_parent_traversal() {
        assert!(directory(Path::new("app.exe")).is_err());
        assert!(directory(Path::new("/app.exe")).is_err());
        let tmp = tempfile::tempdir().unwrap();
        assert!(directory(&tmp.path().join("../app.exe")).is_err());
        assert_eq!(directory(&tmp.path().join("app.exe")).unwrap(), tmp.path());
    }
    #[test]
    fn probes_preserve_bytes_and_cancel_creates_no_target() {
        let tmp = tempfile::tempdir().unwrap();
        // Resolve the platform temporary-root alias (e.g. macOS /var) in the
        // fixture, never in production placement validation.
        let path = tmp.path().canonicalize().unwrap();
        let file = path.join("xharness-desktop.exe");
        fs::write(&file, "retained").unwrap();
        assert!(writable(&path).unwrap());
        assert_eq!(fs::read_to_string(file).unwrap(), "retained");
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
        let target = migration_target(&path).unwrap();
        assert!(!target.exists());
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("unrelated"), "keep").unwrap();
        assert!(migration_target(&path).is_err());
        assert_eq!(
            fs::read_to_string(target.join("unrelated")).unwrap(),
            "keep"
        );
    }
    #[cfg(unix)]
    #[test]
    fn redirected_destination_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().canonicalize().unwrap();
        std::os::unix::fs::symlink(&path, path.join("Programs")).unwrap();
        assert!(migration_target(&path)
            .unwrap_err()
            .contains("Redirected installation path"));
    }
}
