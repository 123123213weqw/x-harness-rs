#![cfg(any(target_os = "linux", target_os = "macos"))]
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_fs::{workspace_apply::ApplyError, FsService};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0) {
            eprintln!("admission fixture cleanup failed: {e}");
        }
    }
}
#[test]
fn native_lock_fault_probe_preserves_errno_and_closes_descriptors() {
    let root = std::env::temp_dir().join(format!(
        "xh-lock-fault-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let fixture = Fixture(root);
    let service = FsService::new(&fixture.0).unwrap();
    let fds = || fs::read_dir("/proc/self/fd").unwrap().count();
    let isolated =
        cfg!(target_os = "linux") && std::env::var_os("XHARNESS_LOCK_ISOLATED_PROBE").is_some();
    let before = isolated.then(fds);
    let result = service.sync_lease();
    match std::env::var("XHARNESS_LOCK_FAULT").as_deref() {
        Ok("busy") => assert!(matches!(result, Err(ApplyError::Busy))),
        Ok("io") => {
            assert!(matches!(result, Err(ApplyError::Io(ref e)) if e.raw_os_error() == Some(5)))
        }
        Ok("unknown") => {
            assert!(matches!(result, Err(ApplyError::Io(ref e)) if e.raw_os_error() == Some(300)))
        }
        Ok("interrupt") => assert!(
            matches!(result, Err(ApplyError::Io(ref e)) if e.kind() == std::io::ErrorKind::Interrupted && e.raw_os_error() == Some(4))
        ),
        _ => assert!(result.is_ok()),
    }
    drop(result);
    if let Some(before) = before {
        assert_eq!(before, fds());
    }
}
