//! Opt-in immutable local macOS credential caller. Never shipped as a new copy
//! during ordinary app updates; its exact hash and certificate are locally pinned.
#![forbid(unsafe_code)]

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 65_536;
const ERROR: &str = "Local Keychain helper unavailable or access denied. Repair/authorize the local helper; no credential fallback is used.";
const BINARY: &str = "credential-helper/v1/xharness-keychain-helper";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    schema: u8,
    sha256: String,
    certificate_sha1: String,
}

pub(super) struct LocalHelper {
    binary: PathBuf,
    pin: Pin,
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl LocalHelper {
    pub(super) fn load(state: &Path) -> Result<Option<Self>, String> {
        let config = state.join("local-keychain-helper.json");
        match std::fs::symlink_metadata(&config) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ERROR.into()),
            Ok(meta) if !meta.is_file() || meta.len() > 1024 => return Err(ERROR.into()),
            Ok(_) => {}
        }
        let binary = state.join(BINARY);
        for path in [
            &config,
            &state.join("credential-helper"),
            &state.join("credential-helper/v1"),
            &binary,
        ] {
            private_path(state, path)?;
        }
        let pin: Pin = serde_json::from_slice(&read_bounded(&config, 1024)?).map_err(|_| ERROR)?;
        if pin.schema != 1 || !hex(&pin.sha256, 64) || !hex(&pin.certificate_sha1, 40) {
            return Err(ERROR.into());
        }
        let helper = Self { binary, pin };
        helper.verify_bytes()?;
        Ok(Some(helper))
    }

    fn verify_bytes(&self) -> Result<(), String> {
        // Tiny fixed helper, not an unbounded executable read chosen by config.
        let meta = std::fs::symlink_metadata(&self.binary).map_err(|_| ERROR)?;
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return Err(ERROR.into());
        }
        let bytes = read_bounded(&self.binary, 1024 * 1024)?;
        if format!("{:x}", Sha256::digest(bytes)) != self.pin.sha256 {
            return Err(ERROR.into());
        }
        Ok(())
    }

    pub(super) async fn invoke(
        &self,
        action: &str,
        service: &str,
        reference: &str,
        value: Option<&str>,
    ) -> Result<Option<String>, String> {
        if !super::valid_credential_reference(reference)
            || !matches!(action, "get" | "set" | "delete")
            || (action == "set") != value.is_some()
            || value.is_some_and(|s| s.is_empty() || s.len() > LIMIT)
        {
            return Err(ERROR.into());
        }
        self.verify_bytes()?;
        let requirement = format!(
            "=identifier \"com.xlang.xharness.keychain-helper\" and certificate leaf = H\"{}\"",
            self.pin.certificate_sha1
        );
        let verified = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict", "-R", &requirement])
                .arg(&self.binary)
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await
        .map_err(|_| ERROR)?
        .map_err(|_| ERROR)?;
        if !verified.success() {
            return Err(ERROR.into());
        }
        run(&self.binary, action, service, reference, value).await
    }
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| ERROR)?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ERROR)?;
    if bytes.len() > limit {
        return Err(ERROR.into());
    }
    Ok(bytes)
}

fn private_path(state: &Path, path: &Path) -> Result<(), String> {
    let m = std::fs::symlink_metadata(path).map_err(|_| ERROR)?;
    if m.file_type().is_symlink() {
        return Err(ERROR.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.uid() != std::fs::metadata(state).map_err(|_| ERROR)?.uid()
            || m.mode() & 0o077 != 0
            || (m.is_file() && m.nlink() != 1)
        {
            return Err(ERROR.into());
        }
    }
    #[cfg(not(unix))]
    let _ = state;
    Ok(())
}

async fn run(
    binary: &Path,
    action: &str,
    service: &str,
    reference: &str,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    // Arguments contain only operation + namespace + reference. Secret stdin and
    // stdout stay in this process; helper stderr is never a diagnostic payload.
    let mut child = tokio::process::Command::new(binary)
        .args([action, service, reference])
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ERROR)?;
    let result = tokio::time::timeout(Duration::from_secs(180), async {
        let mut stdin = child.stdin.take().ok_or(ERROR)?;
        if let Some(value) = value {
            stdin.write_all(value.as_bytes()).await.map_err(|_| ERROR)?;
        }
        drop(stdin);
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or(ERROR)?
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut output)
            .await
            .map_err(|_| ERROR)?;
        if output.len() > LIMIT {
            return Err(ERROR);
        }
        let status = child.wait().await.map_err(|_| ERROR)?;
        match (status.code(), action) {
            (Some(0), "get") => String::from_utf8(output).map(Some).map_err(|_| ERROR),
            (Some(0), "set" | "delete") if output.is_empty() => Ok(None),
            (Some(3), "get" | "delete") if output.is_empty() => Ok(None),
            _ => Err(ERROR),
        }
    })
    .await
    .map_err(|_| ERROR)?;
    result.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> Fixture {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "xh-keychain-helper-tests-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Fixture(path)
    }
    #[test]
    fn absent_is_opt_out_invalid_manifest_is_not_a_fallback() {
        let state = tempdir();
        assert!(LocalHelper::load(state.path()).unwrap().is_none());
        std::fs::write(state.path().join("local-keychain-helper.json"), b"{}").unwrap();
        assert!(LocalHelper::load(state.path()).is_err());
        assert!(!hex(&"A".repeat(40), 40));
        assert!(!hex(&"a".repeat(39), 40));
    }
    #[cfg(unix)]
    #[test]
    fn private_pins_reject_changed_executable_unknown_fields_and_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let state = tempdir();
        let path = state.path().join(BINARY);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for p in [
            state.path().join("credential-helper"),
            state.path().join("credential-helper/v1"),
        ] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = state.path().join("local-keychain-helper.json");
        let value = serde_json::json!({"schema":1,"sha256":format!("{:x}",Sha256::digest(b"fixture")),"certificate_sha1":"a".repeat(40)});
        std::fs::write(&config, value.to_string()).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(LocalHelper::load(state.path()).unwrap().is_some());
        let mut unknown = value.clone();
        unknown["foreign"] = serde_json::json!(true);
        std::fs::write(&config, unknown.to_string()).unwrap();
        assert!(LocalHelper::load(state.path()).is_err());
        std::fs::write(&config, value.to_string()).unwrap();
        std::fs::write(&path, b"changed").unwrap();
        assert!(LocalHelper::load(state.path()).is_err());
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(LocalHelper::load(state.path()).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_file(&config).unwrap();
        symlink(&path, &config).unwrap();
        assert!(LocalHelper::load(state.path()).is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn private_pipes_statuses_and_bounded_protocol_do_not_expose_errors() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir();
        let p = d.path().join("fixture");
        std::fs::write(&p,"#!/bin/sh\ncase \"$1\" in get) printf fixture-secret;; set) value=$(cat); test \"$value\" = fixture-secret;; delete) exit 3;; esac\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            run(&p, "get", "service", "REF", None).await.unwrap(),
            Some("fixture-secret".into())
        );
        assert!(run(&p, "set", "service", "REF", Some("fixture-secret"))
            .await
            .unwrap()
            .is_none());
        assert!(run(&p, "delete", "service", "REF", None)
            .await
            .unwrap()
            .is_none());
        std::fs::write(&p, "#!/bin/sh\nprintf secret-error; exit 4\n").unwrap();
        assert_eq!(
            run(&p, "get", "service", "REF", None).await.unwrap_err(),
            ERROR
        );
        std::fs::write(&p, "#!/bin/sh\nhead -c 65537 /dev/zero\n").unwrap();
        assert!(run(&p, "get", "service", "REF", None).await.is_err());
        let helper = LocalHelper {
            binary: p,
            pin: Pin {
                schema: 1,
                sha256: "a".repeat(64),
                certificate_sha1: "a".repeat(40),
            },
        };
        assert!(helper
            .invoke("invalid", "service", "REF", None)
            .await
            .is_err());
    }
}
