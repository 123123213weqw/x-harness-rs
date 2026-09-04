use std::{env, ffi::OsString, fs, path::PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};
use xharness_debug::{DebugEvent, DebugRecorder};
use xharness_process::SpawnSpec;

use crate::{
    sandbox::{spawn_spec_payload, ValidatedPaths},
    SandboxError, SandboxMode, SandboxPolicy,
};

const RUNNER_NAME: &str = "xharness-windows-sandbox-runner.exe";

#[derive(Clone, Debug)]
pub struct WindowsAclSandbox {
    policy: SandboxPolicy,
    runner: PathBuf,
    debug: DebugRecorder,
}

impl WindowsAclSandbox {
    pub fn new(policy: SandboxPolicy) -> Self {
        Self {
            policy,
            runner: default_runner_path(),
            debug: DebugRecorder::disabled(),
        }
    }

    pub fn with_debug(mut self, debug: DebugRecorder) -> Self {
        self.debug = debug;
        self
    }

    pub fn with_runner(mut self, runner: impl Into<PathBuf>) -> Self {
        self.runner = runner.into();
        self
    }

    pub const fn policy(&self) -> &SandboxPolicy {
        &self.policy
    }

    pub async fn prepare(&self, spec: SpawnSpec) -> Result<SpawnSpec, SandboxError> {
        self.debug
            .record_lossy(DebugEvent::new(
                "sandbox",
                "prepare.request",
                json!({
                    "backend": "windows-acl",
                    "enforcement": "partial",
                    "mode": format!("{:?}", self.policy.mode()),
                    "network": format!("{:?}", self.policy.network()),
                    "spec": spawn_spec_payload(&spec),
                }),
            ))
            .await;
        let result = self.prepare_inner(spec);
        self.debug
            .record_lossy(DebugEvent::new(
                "sandbox",
                "prepare.completed",
                json!({
                    "backend": "windows-acl",
                    "enforcement": "partial",
                    "spec": result.as_ref().ok().map(spawn_spec_payload),
                    "error": result.as_ref().err().map(ToString::to_string),
                }),
            ))
            .await;
        result
    }

    fn prepare_inner(&self, mut spec: SpawnSpec) -> Result<SpawnSpec, SandboxError> {
        if spec.program.is_empty() {
            return Err(SandboxError::EmptyProgram);
        }
        let paths = ValidatedPaths::new(&self.policy, &spec.cwd)?;
        let runner = fs::canonicalize(&self.runner).map_err(|error| SandboxError::Unavailable {
            reason: format!(
                "cannot resolve Windows sandbox runner {:?}: {error}",
                self.runner
            ),
        })?;
        if !runner.is_file() {
            return Err(SandboxError::Unavailable {
                reason: format!("Windows sandbox runner is not a file: {runner:?}"),
            });
        }

        let original_program = std::mem::take(&mut spec.program);
        let original_args = std::mem::take(&mut spec.args);
        let mut args = vec![
            OsString::from("--workspace"),
            paths.workspace.as_os_str().to_owned(),
            OsString::from("--temp-root"),
            env::temp_dir().into_os_string(),
            OsString::from("--cwd"),
            paths.cwd.as_os_str().to_owned(),
            OsString::from("--mode"),
            OsString::from(match self.policy.mode() {
                SandboxMode::ReadOnly => "read-only",
                SandboxMode::WorkspaceWrite => "workspace-write",
            }),
        ];
        for root in paths.allowed_cwd_roots {
            args.push(OsString::from("--allow-cwd-root"));
            args.push(root.into_os_string());
        }
        args.push(OsString::from("--"));
        args.push(original_program);
        args.extend(original_args);
        spec.program = runner.into_os_string();
        spec.args = args;
        spec.cwd = paths.cwd;
        Ok(spec)
    }
}

pub fn workspace_write_sid(workspace: &std::path::Path) -> String {
    capability_sid(b"workspace\0", workspace, false)
}

pub fn temp_write_sid(temp: &std::path::Path) -> String {
    capability_sid(b"temp\0", temp, true)
}

fn capability_sid(domain: &[u8], path: &std::path::Path, temp: bool) -> String {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(path.as_os_str().to_string_lossy().to_lowercase().as_bytes());
    let digest = digest.finalize();
    let first = u32::from_le_bytes(digest[0..4].try_into().expect("four digest bytes"))
        % (2_u32.pow(30) - 1)
        + 1;
    let second = u32::from_le_bytes(digest[4..8].try_into().expect("four digest bytes"))
        % (2_u32.pow(30) - 1)
        + 1;
    if temp {
        format!("S-1-4-{first}-{second}-1")
    } else {
        format!("S-1-4-{first}-{second}")
    }
}

fn default_runner_path() -> PathBuf {
    if let Some(path) = env::var_os("XHARNESS_WINDOWS_SANDBOX_RUNNER") {
        return PathBuf::from(path);
    }
    let executable = env::current_exe().unwrap_or_else(|_| PathBuf::from(RUNNER_NAME));
    let directory = executable
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let direct = directory.join(RUNNER_NAME);
    if direct.is_file() {
        return direct;
    }
    directory
        .parent()
        .map_or(direct, |parent| parent.join(RUNNER_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_sids_are_stable_case_insensitive_and_domain_separated() {
        let first = workspace_write_sid(std::path::Path::new(r"C:\Work\Repo"));
        let alias = workspace_write_sid(std::path::Path::new(r"c:\work\repo"));
        let temp = temp_write_sid(std::path::Path::new(r"C:\Work\Repo"));
        assert_eq!(first, alias);
        assert_ne!(first, temp);
        assert!(first.starts_with("S-1-4-"));
        assert!(temp.ends_with("-1"));
    }
}
