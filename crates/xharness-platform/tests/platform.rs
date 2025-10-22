use std::{fs, path::PathBuf};

use xharness_platform::{NativePlatform, PlatformConfig, PlatformKind};
use xharness_process::SpawnSpec;
use xharness_sandbox::SandboxMode;

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-platform-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn native_platform_composes_filesystem_process_and_policy() {
    let workspace = TempWorkspace::new();
    let platform = NativePlatform::new(
        PlatformConfig::new(&workspace.0).sandbox_mode(SandboxMode::DangerFullAccess),
    )
    .unwrap();

    #[cfg(target_os = "linux")]
    assert_eq!(platform.kind(), PlatformKind::Linux);
    #[cfg(target_os = "macos")]
    assert_eq!(platform.kind(), PlatformKind::MacOS);
    assert_eq!(platform.filesystem().workspace_root(), workspace.0);

    let original = SpawnSpec::new("/bin/echo", &workspace.0).arg("hello");
    assert_eq!(
        platform.prepare_spawn(original.clone()).await.unwrap(),
        original
    );
}
