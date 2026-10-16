//! The app-owned Windows shell, pinned by the same lock used by packaging.
//! Startup checks small metadata/required files, not 250 MiB of hashes. Full
//! content verification belongs to staging and final installer acceptance.

use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const ROOT_ENV: &str = "XHARNESS_BUNDLED_POWERSHELL_ROOT";
const PIN: &str = include_str!("../../../runtime/powershell.lock.json");
pub const CORE_FILES: &[&str] = &[
    "pwsh.exe",
    "pwsh.dll",
    "pwsh.runtimeconfig.json",
    "pwsh.deps.json",
    "hostfxr.dll",
    "hostpolicy.dll",
    "coreclr.dll",
    "clrjit.dll",
    "System.Management.Automation.dll",
    "LICENSE.txt",
    "ThirdPartyNotices.txt",
];

fn pin() -> &'static Value {
    static LOCK: OnceLock<Value> = OnceLock::new();
    LOCK.get_or_init(|| serde_json::from_str(PIN).expect("invalid compiled PowerShell pin"))
}

pub fn version() -> &'static str {
    pin()["version"].as_str().expect("PowerShell pin version")
}

/// Fail closed when an app claims to ship this runtime. Standalone/unbundled
/// CLI discovery remains independent. No command or downloader is run here.
pub fn program(root: &Path) -> Result<PathBuf, String> {
    let invalid = || {
        format!("bundled PowerShell {} is missing or incompatible at {}; reinstall XHarness or explicitly configure XHARNESS_SHELL", version(), root.display())
    };
    if !root.is_absolute() {
        return Err(invalid());
    }
    let regular = |path: &Path, directory: bool| {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return false;
                }
            }
            if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            }
        })
    };
    let manifest_path = root.join("manifest.json");
    if !regular(root, true)
        || !regular(&root.join(version()), true)
        || !regular(&manifest_path, false)
        || std::fs::metadata(&manifest_path).map_or(true, |m| m.len() > 1024 * 1024)
    {
        return Err(invalid());
    }
    let manifest: Value = std::fs::read(&manifest_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(invalid)?;
    let target = "x86_64-pc-windows-msvc";
    if manifest["schema"] != 1
        || manifest["version"] != version()
        || manifest["target"] != target
        || manifest["archive_sha256"] != pin()["archives"][target]["sha256"]
    {
        return Err(invalid());
    }
    for name in CORE_FILES {
        let path = root.join(version()).join(name);
        let key = format!("{}/{name}", version());
        if !regular(&path, false)
            || std::fs::metadata(&path).ok().map(|m| m.len())
                != manifest["files"][&key]["size"].as_u64()
        {
            return Err(invalid());
        }
    }
    root.join(version())
        .join("pwsh.exe")
        .canonicalize()
        .map_err(|_| invalid())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(crate) struct Fixture(pub PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    pub(crate) fn fixture() -> Fixture {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "xharness powershell-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join(version())).unwrap();
        let mut files = serde_json::Map::new();
        for name in CORE_FILES {
            std::fs::write(root.join(version()).join(name), b"fixture").unwrap();
            files.insert(format!("{}/{name}", version()), json!({"size": 7}));
        }
        let manifest = json!({"schema":1,"version":version(),"target":"x86_64-pc-windows-msvc",
            "archive_sha256":pin()["archives"]["x86_64-pc-windows-msvc"]["sha256"],"files":files});
        std::fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
        Fixture(root)
    }

    #[test]
    fn selects_complete_versioned_bundle_with_spaces() {
        let fixture = fixture();
        let path = program(&fixture.0).unwrap();
        assert!(path.is_absolute());
        assert!(path.ends_with(Path::new(version()).join("pwsh.exe")));
    }

    #[test]
    fn missing_runtime_dll_or_license_never_looks_complete() {
        for name in CORE_FILES {
            let fixture = fixture();
            std::fs::remove_file(fixture.0.join(version()).join(name)).unwrap();
            assert!(program(&fixture.0).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_old_version_mixed_hash_truncation_and_relative_root() {
        for field in ["version", "archive_sha256", "schema", "target"] {
            let fixture = fixture();
            let path = fixture.0.join("manifest.json");
            let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            value[field] = json!("wrong");
            std::fs::write(path, value.to_string()).unwrap();
            assert!(program(&fixture.0).is_err());
        }
        let fixture = fixture();
        std::fs::write(fixture.0.join(version()).join("pwsh.dll"), b"truncated").unwrap();
        assert!(program(&fixture.0).is_err());
        assert!(program(Path::new("relative runtime")).is_err());
    }
}
