use std::{fs, path::PathBuf};

use xharness_platform::{NativePlatform, PlatformAccess, PlatformConfig, PlatformKind};
use xharness_process::SpawnSpec;
use xharness_sandbox::NetworkAccess;

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
    let config = PlatformConfig::new(&workspace.0)
        .full_access()
        .network(NetworkAccess::Deny);
    assert_eq!(config.network_value(), NetworkAccess::Allow);
    let platform = NativePlatform::new(config).unwrap();

    #[cfg(target_os = "linux")]
    assert_eq!(platform.kind(), PlatformKind::Linux);
    #[cfg(target_os = "macos")]
    assert_eq!(platform.kind(), PlatformKind::MacOS);
    assert_eq!(platform.workspace_root(), workspace.0);
    assert_eq!(platform.filesystem().workspace_root(), PathBuf::from("/"));
    assert_eq!(platform.access(), PlatformAccess::FullAccess);
    assert!(platform.sandbox().is_none());

    let relative = platform.resolve_file("probe.txt").unwrap();
    let absolute = platform
        .resolve_file(workspace.0.join("probe.txt"))
        .unwrap();
    assert_eq!(relative.key(), absolute.key());

    let original = SpawnSpec::new("/bin/echo", &workspace.0).arg("hello");
    assert_eq!(
        platform.prepare_spawn(original.clone()).await.unwrap(),
        original
    );

    let handle = platform.spawn(SpawnSpec::new("/bin/echo", &workspace.0).arg("managed"));
    let output = handle.await.unwrap().wait().await.unwrap();
    assert_eq!(output.stdout.text.trim(), "managed");
}
