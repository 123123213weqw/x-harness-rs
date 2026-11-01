//! Small platform-native launcher for Chrome/Edge Native Messaging. No Host or browser state.
#![cfg_attr(not(test), forbid(clippy::print_stderr))]
#![forbid(unsafe_code)]
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    version: u8,
    extension_id: String,
    node: PathBuf,
    script: PathBuf,
}

fn validate(config: &Configuration, origin: &str) -> Result<(), String> {
    if config.version != 1
        || config.extension_id.len() != 32
        || !config
            .extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte))
        || origin != format!("chrome-extension://{}/", config.extension_id)
    {
        return Err("browser extension identity mismatch".into());
    }
    for path in [&config.node, &config.script] {
        if !path.is_absolute() || !path.is_file() {
            return Err("native bridge requires absolute existing runtime files".into());
        }
    }
    Ok(())
}
fn read_config(path: &Path) -> Result<Configuration, String> {
    let info =
        std::fs::symlink_metadata(path).map_err(|_| "native bridge configuration is missing")?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 4096 {
        return Err("invalid native bridge configuration".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if info.permissions().mode() & 0o077 != 0 {
            return Err("native bridge configuration must be private".into());
        }
    }
    serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "could not read native bridge configuration")?,
    )
    .map_err(|_| "invalid native bridge configuration".into())
}
fn run() -> Result<i32, String> {
    let executable = std::env::current_exe().map_err(|_| "native executable path unavailable")?;
    let root = executable
        .parent()
        .ok_or("native executable directory unavailable")?;
    let config = read_config(&root.join("launcher.json"))?;
    let origin = std::env::args()
        .nth(1)
        .ok_or("browser extension origin missing")?;
    validate(&config, &origin)?;
    let mut command = Command::new(config.node);
    command
        .arg(config.script)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env_clear();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Do not forward API credentials or arbitrary model/plugin environment.
    for name in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "SYSTEMROOT",
        "TMP",
        "TEMP",
        "TMPDIR",
        "LANG",
        "XDG_CONFIG_HOME",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let status = command
        .status()
        .map_err(|_| "could not launch the pinned native bridge runtime")?;
    Ok(status.code().unwrap_or(1))
}
fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(message) => {
            xharness_diagnostics::diagnostic_stderr!("XHarness Browser: {message}");
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_exact_and_runtime_paths_are_not_shell_commands() {
        let exe = std::env::current_exe().unwrap();
        let config = Configuration {
            version: 1,
            extension_id: "abcdefghijklmnopabcdefghijklmnop".into(),
            node: exe.clone(),
            script: exe,
        };
        assert!(validate(
            &config,
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        )
        .is_ok());
        for origin in [
            "https://example.com/",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/extra",
            "chrome-extension://pppppppppppppppppppppppppppppppp/",
        ] {
            assert!(validate(&config, origin).is_err());
        }
        let invalid = Configuration {
            node: PathBuf::from("node --eval whatever"),
            ..config
        };
        assert!(validate(
            &invalid,
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        )
        .is_err());
    }
    #[test]
    fn configuration_rejects_unknown_fields_and_old_versions() {
        assert!(serde_json::from_str::<Configuration>(
            r#"{"version":1,"extension_id":"id","node":"/node","script":"/host","extra":true}"#
        )
        .is_err());
    }
}
