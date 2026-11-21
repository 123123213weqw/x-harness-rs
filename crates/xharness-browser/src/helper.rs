//! A pipe lifetime lease survives unexpected UI-process death. The helper owns
//! Chrome and reaps it before deleting its exact temporary profile on pipe EOF.
#![forbid(unsafe_code)]
use std::{
    io::Read,
    path::{Path, PathBuf},
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
    // Reuse the native execution-lifecycle primitive: Unix process groups and
    // a Windows kill-on-close Job. Reaping only Chrome's root is insufficient:
    // its network service can recreate profile files after root exit.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "owned browser supervisor unavailable")?;
    runtime.block_on(async {
        let mut spec = xharness_process::SpawnSpec::new(binary, profile);
        spec.args = [
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
        ]
        .map(std::ffi::OsString::from)
        .into_iter()
        .collect();
        spec.args
            .push(format!("--user-data-dir={}", profile.display()).into());
        spec.args.push("about:blank".into());
        spec.env = std::env::vars_os().collect();
        xharness_process::scrub_secret_env(&mut spec.env);
        spec.stdout_limit = 0;
        spec.stderr_limit = 0;
        let child = xharness_process::ProcessRuntime::new()
            .spawn(spec)
            .map_err(|_| "installed browser startup failed")?;
        let cancellation = child.cancellation();
        std::thread::spawn(move || {
            let _ = std::io::stdin().read(&mut [0u8; 1]);
            cancellation.cancel();
        });
        child
            .wait()
            .await
            .map_err(|_| "owned browser tree cleanup failed")?;
        super::process::cleanup_profile(PathBuf::from(profile))
    })
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
