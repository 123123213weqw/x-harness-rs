//! Preserve macOS TCC identity across local, unnotarized updater packages.
//!
//! The updater verifies the downloaded archive before this module runs.  The
//! private signing key is only in the user's login keychain, never in CI or the
//! app bundle.  This opt-in path is enabled by a local identity fingerprint in
//! the app config directory; all other installations keep Tauri's normal flow.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

const IDENTITY_FILE: &str = "local-code-signing-identity";
const BINARIES: [&str; 3] = ["rg", "xharness-host", "xharness-desktop"];

pub(super) struct LocalSigning {
    app: PathBuf,
    identity: String,
    rollback: PathBuf,
}

impl LocalSigning {
    pub fn discard(&self) {
        if let Err(error) = fs::remove_dir_all(&self.rollback) {
            eprintln!("清理未使用的本机更新备份失败：{error}");
        }
    }

    pub fn prepare(handle: &AppHandle) -> Result<Option<Self>, String> {
        let config = handle
            .path()
            .app_config_dir()
            .map_err(|error| format!("无法定位本机签名配置目录：{error}"))?
            .join(IDENTITY_FILE);
        let identity = match fs::read_to_string(&config) {
            Ok(value) => value.trim().to_ascii_uppercase(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("无法读取本机签名配置：{error}")),
        };
        if !valid_identity(&identity) {
            return Err("本机签名身份必须是 40 位十六进制证书指纹".to_owned());
        }
        let executable =
            std::env::current_exe().map_err(|error| format!("无法定位当前 App：{error}"))?;
        let app = app_bundle_from_exe(&executable)
            .ok_or_else(|| "本机签名仅支持从 .app 内启动更新".to_owned())?;
        if !same_designated_requirement(&app, &identity)? {
            return Err(
                "当前 App 与本机固定签名身份不一致，拒绝覆盖；请先安装已用该身份签名的基础包"
                    .to_owned(),
            );
        }
        let available = run_output(
            "/usr/bin/security",
            &["find-identity", "-v", "-p", "codesigning"],
        )?;
        if !available.to_ascii_uppercase().contains(&identity) {
            return Err("登录钥匙串中找不到本机签名私钥；更新尚未开始".to_owned());
        }

        let cache = handle
            .path()
            .app_cache_dir()
            .map_err(|error| format!("无法定位更新备份目录：{error}"))?;
        fs::create_dir_all(&cache).map_err(|error| format!("无法准备更新备份：{error}"))?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let rollback = cache.join(format!(
            "local-update-rollback-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&rollback).map_err(|error| format!("无法创建更新备份：{error}"))?;
        if let Err(error) = run(
            "/usr/bin/ditto",
            &[app.as_os_str(), rollback.join("XHarness.app").as_os_str()],
        ) {
            let _ = fs::remove_dir_all(&rollback);
            return Err(format!("无法备份当前 App，更新未开始：{error}"));
        }
        Ok(Some(Self {
            app,
            identity,
            rollback,
        }))
    }

    pub fn sign_installed(&self) -> Result<(), String> {
        for name in BINARIES {
            sign(&self.app.join("Contents/MacOS").join(name), &self.identity)?;
        }
        sign(&self.app, &self.identity)?;
        run(
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--deep".as_ref(),
                "--strict".as_ref(),
                self.app.as_os_str(),
            ],
        )?;
        if !same_designated_requirement(&self.app, &self.identity)? {
            return Err("更新后的 App 签名身份与旧版不同".to_owned());
        }
        if let Err(error) = fs::remove_dir_all(&self.rollback) {
            eprintln!("本机更新已签名，但清理旧版备份失败：{error}");
        }
        Ok(())
    }

    pub fn restore(&self) -> Result<(), String> {
        let previous = self.rollback.join("XHarness.app");
        if !previous.is_dir() {
            return Err(format!("回滚副本丢失：{}", previous.display()));
        }
        let quarantine = self.app.with_extension(format!(
            "failed-update-{}",
            self.rollback
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "无效的更新备份路径".to_owned())?
        ));
        if quarantine.exists() {
            return Err(format!("回滚暂存路径已存在：{}", quarantine.display()));
        }
        if self.app.exists() {
            fs::rename(&self.app, &quarantine)
                .map_err(|error| format!("无法隔离失败版本：{error}"))?;
        }
        if let Err(error) = run(
            "/usr/bin/ditto",
            &[previous.as_os_str(), self.app.as_os_str()],
        ) {
            let _ = fs::remove_dir_all(&self.app);
            let _ = fs::rename(&quarantine, &self.app);
            return Err(format!(
                "无法恢复旧版，备份保留在 {}：{error}",
                previous.display()
            ));
        }
        if let Err(error) = run(
            "/usr/bin/codesign",
            &[
                "--verify".as_ref(),
                "--deep".as_ref(),
                "--strict".as_ref(),
                self.app.as_os_str(),
            ],
        ) {
            return Err(format!(
                "旧版已恢复但验签失败，备份保留在 {}：{error}",
                previous.display()
            ));
        }
        let _ = fs::remove_dir_all(&quarantine);
        let _ = fs::remove_dir_all(&self.rollback);
        Ok(())
    }
}

fn sign(path: &Path, identity: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("更新包缺少待签名文件：{}", path.display()));
    }
    run(
        "/usr/bin/codesign",
        &[
            "--force".as_ref(),
            "--options".as_ref(),
            "runtime".as_ref(),
            "--preserve-metadata=entitlements".as_ref(),
            "--timestamp=none".as_ref(),
            "--sign".as_ref(),
            identity.as_ref(),
            path.as_os_str(),
        ],
    )
}

fn same_designated_requirement(app: &Path, identity: &str) -> Result<bool, String> {
    let output = run_output_os(
        "/usr/bin/codesign",
        &["-dr".as_ref(), "-".as_ref(), app.as_os_str()],
    )?;
    let expected = format!(
        "designated => identifier \"com.xlang.xharness\" and certificate root = H\"{}\"",
        identity.to_ascii_lowercase()
    );
    Ok(output.lines().any(|line| line.trim() == expected))
}

fn app_bundle_from_exe(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|part| part.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

fn valid_identity(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn run(program: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    run_output_os(program, args).map(|_| ())
}

fn run_output(program: &str, args: &[&str]) -> Result<String, String> {
    let args: Vec<&std::ffi::OsStr> = args.iter().map(std::ffi::OsStr::new).collect();
    run_output_os(program, &args)
}

fn run_output_os(program: &str, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("无法运行 {program}：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "{program} 失败（{}）：{} {}",
            output.status,
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(format!("{stdout}\n{stderr}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_exact_fingerprint() {
        assert!(valid_identity(&"A".repeat(40)));
        assert!(!valid_identity("-"));
        assert!(!valid_identity(&format!("{}/evil", "A".repeat(40))));
    }

    #[test]
    fn finds_bundle_without_guessing_install_root() {
        assert_eq!(
            app_bundle_from_exe(Path::new(
                "/Applications/XHarness.app/Contents/MacOS/xharness-desktop"
            )),
            Some(PathBuf::from("/Applications/XHarness.app"))
        );
        assert_eq!(
            app_bundle_from_exe(Path::new("/usr/local/bin/xharness-desktop")),
            None
        );
    }
}
