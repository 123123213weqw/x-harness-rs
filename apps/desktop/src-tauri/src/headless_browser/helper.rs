//! A pipe lifetime lease survives unexpected UI-process death. The helper owns
//! Chrome and reaps it before deleting its exact temporary profile on pipe EOF.
#![forbid(unsafe_code)]
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
pub const FLAG: &str = "--xharness-owned-browser-helper";

pub fn run_if_requested() -> bool {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.first().is_none_or(|value| value != FLAG) {
        return false;
    }
    let result = if arguments.len() == 3 {
        run(Path::new(&arguments[1]), Path::new(&arguments[2]))
    } else {
        Err("invalid owned browser helper arguments".into())
    };
    if result.is_err() {
        eprintln!("owned browser helper failed");
        std::process::exit(1);
    }
    true
}
fn run(binary: &Path, profile: &Path) -> Result<(), String> {
    let parent = profile
        .parent()
        .and_then(|parent| parent.canonicalize().ok());
    if !profile.is_absolute()
        || profile
            .symlink_metadata()
            .map_or(true, |meta| !meta.is_dir() || meta.file_type().is_symlink())
        || !profile.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .starts_with("xharness-owned-browser-")
        })
        || parent != std::env::temp_dir().canonicalize().ok()
        || !super::process::candidates()
            .iter()
            .any(|candidate| candidate.canonicalize().ok() == binary.canonicalize().ok())
    {
        return Err("invalid owned browser launch".into());
    }
    let mut command = Command::new(binary);
    command
        .args([
            "--headless=new",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-extensions",
            "--password-store=basic",
            "--use-mock-keychain",
            "--window-size=1280,720",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "installed browser startup failed")?;
    let (closed, lease) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        // EOF (or unexpected data) revokes the parent-owned lifetime lease.
        let _ = std::io::stdin().read(&mut [0u8; 1]);
        let _ = closed.send(());
    });
    loop {
        if child
            .try_wait()
            .map_err(|_| "browser exit unavailable")?
            .is_some()
        {
            break;
        }
        if !matches!(
            lease.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            let _ = child.kill();
            child.wait().map_err(|_| "owned browser reap failed")?;
            break;
        }
    }
    super::process::cleanup_profile(PathBuf::from(profile))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_rejects_foreign_profiles_without_deleting_or_launching() {
        let foreign = tempfile::tempdir().unwrap();
        std::fs::write(foreign.path().join("keep"), b"fixture").unwrap();
        assert!(run(Path::new("/not-a-browser"), foreign.path()).is_err());
        assert_eq!(
            std::fs::read(foreign.path().join("keep")).unwrap(),
            b"fixture"
        );
    }
}
