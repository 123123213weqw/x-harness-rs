use std::{ffi::OsString, fs, path::PathBuf};

use xharness_process::SpawnSpec;

use crate::{sandbox::ValidatedPaths, NetworkAccess, SandboxError, SandboxMode, SandboxPolicy};

const DEFAULT_SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Fail-closed macOS Seatbelt adapter.
///
/// The profile is constructed from a canonical workspace capability and
/// passed directly as an argv element; no shell or temporary profile file is
/// involved. `DangerFullAccess` is the only mode that bypasses preparation.
#[derive(Clone, Debug)]
pub struct SeatbeltSandbox {
    policy: SandboxPolicy,
    sandbox_exec: PathBuf,
}

impl SeatbeltSandbox {
    pub fn new(policy: SandboxPolicy) -> Self {
        Self {
            policy,
            sandbox_exec: PathBuf::from(DEFAULT_SANDBOX_EXEC),
        }
    }

    /// Override the profile runner, primarily for deterministic integration
    /// tests. Restricted execution still requires a canonical regular file.
    pub fn with_sandbox_exec(mut self, path: impl Into<PathBuf>) -> Self {
        self.sandbox_exec = path.into();
        self
    }

    pub const fn policy(&self) -> &SandboxPolicy {
        &self.policy
    }

    pub async fn prepare(&self, mut spec: SpawnSpec) -> Result<SpawnSpec, SandboxError> {
        if self.policy.mode() == SandboxMode::DangerFullAccess {
            return Ok(spec);
        }
        if spec.program.is_empty() {
            return Err(SandboxError::EmptyProgram);
        }

        let paths = ValidatedPaths::new(&self.policy, &spec.cwd)?;
        let sandbox_exec =
            fs::canonicalize(&self.sandbox_exec).map_err(|error| SandboxError::Unavailable {
                reason: format!(
                    "cannot resolve macOS sandbox runner {:?}: {error}",
                    self.sandbox_exec
                ),
            })?;
        if !sandbox_exec.is_file() {
            return Err(SandboxError::Unavailable {
                reason: format!("macOS sandbox runner is not a file: {sandbox_exec:?}"),
            });
        }

        let profile = build_profile(&self.policy, &paths)?;
        let original_program = std::mem::take(&mut spec.program);
        let original_args = std::mem::take(&mut spec.args);
        spec.program = sandbox_exec.into_os_string();
        spec.args = vec![
            OsString::from("-p"),
            OsString::from(profile),
            OsString::from("--"),
            original_program,
        ];
        spec.args.extend(original_args);
        spec.cwd = paths.cwd;
        Ok(spec)
    }
}

fn build_profile(policy: &SandboxPolicy, paths: &ValidatedPaths) -> Result<String, SandboxError> {
    let mut profile = String::from("(version 1)\n(allow default)\n");
    profile.push_str("(deny file-write*)\n");
    if policy.mode() == SandboxMode::WorkspaceWrite {
        profile.push_str("(allow file-write* (subpath ");
        profile.push_str(&profile_string(&paths.workspace)?);
        profile.push_str("))\n");
    }
    if policy.network() == NetworkAccess::Deny {
        profile.push_str("(deny network*)\n");
    }
    Ok(profile)
}

fn profile_string(path: &std::path::Path) -> Result<String, SandboxError> {
    let value = path
        .to_str()
        .ok_or_else(|| SandboxError::ProfilePathEncoding {
            path: path.to_owned(),
        })?;
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(quoted, "\\u{{{:x}}}", character as u32);
            }
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_quotes_workspace_and_keeps_network_explicit() {
        let workspace = PathBuf::from("/tmp/work \\\"space");
        let paths = ValidatedPaths {
            workspace: workspace.clone(),
            cwd: workspace.clone(),
            allowed_cwd_roots: Vec::new(),
        };
        let profile = build_profile(
            &SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite),
            &paths,
        )
        .unwrap();
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("/tmp/work \\\\\\\"space"));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn read_only_profile_has_no_write_exception() {
        let workspace = PathBuf::from("/tmp/workspace");
        let paths = ValidatedPaths {
            workspace: workspace.clone(),
            cwd: workspace.clone(),
            allowed_cwd_roots: Vec::new(),
        };
        let profile = build_profile(
            &SandboxPolicy::new(&workspace, SandboxMode::ReadOnly)
                .with_network(NetworkAccess::Allow),
            &paths,
        )
        .unwrap();
        assert_eq!(profile.matches("file-write*").count(), 1);
        assert!(!profile.contains("network"));
    }
}
