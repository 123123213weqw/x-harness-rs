//! Read-only Git adapter: fixed argv, no shell, native sandbox, bounded capture.
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_api::display::{DisplayFile, GitDiffScope, MAX_TEXT_BYTES};
use xharness_platform::NativePlatform;
use xharness_process::{
    shell::executable_search_path, ProcessHandle, ProcessOutput, SpawnSpec, TerminationReason,
};

pub(crate) async fn read(
    platform: &NativePlatform,
    path: &Path,
    scope: GitDiffScope,
    cancellation: CancellationToken,
    _permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<DisplayFile, String> {
    if cancellation.is_cancelled() {
        return Err("Git preview cancelled".into());
    }
    let relative = path
        .strip_prefix(platform.workspace_root())
        .map_err(|_| "Git preview path must be inside this session's workspace")?;
    if relative
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Git preview path escapes workspace".into());
    }
    // Literal pathspec: a filename containing '*' or ':(' is never a pattern
    // or Git pathspec magic. Deleted paths remain displayable.
    let filter = if relative.as_os_str().is_empty() {
        ".".into()
    } else {
        format!(":(literal){}", {
            let name = relative.to_string_lossy();
            if cfg!(windows) {
                name.replace('\\', "/")
            } else {
                name.into_owned()
            }
        })
    };
    let mut spec = SpawnSpec::new("git", platform.workspace_root())
        .args([
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--word-diff=none",
            "--unified=3",
            "--no-relative",
            "--no-renames",
            "--ignore-submodules=all",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ])
        .env("PATH", executable_search_path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LANG", "C.UTF-8")
        .timeout(Duration::from_secs(15))
        .output_limits(MAX_TEXT_BYTES, 16 * 1024);
    // Windows needs its loader directories; no credentials/GIT_* ambient env.
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            spec = spec.env(key, value);
        }
    }
    spec = match scope {
        GitDiffScope::Working => spec,
        GitDiffScope::Staged => spec.arg("--cached"),
        GitDiffScope::Head => spec.arg("HEAD"),
    }
    .arg("--")
    .arg(filter);
    let child = platform
        .spawn(spec)
        .await
        .map_err(|e| format!("Git preview unavailable: {e}"))?;
    let output = collect(child, cancellation).await?;
    if output.termination != TerminationReason::Exited {
        return Err(format!("Git preview stopped: {:?}", output.termination));
    }
    if !output.status.success {
        return Err(format!("Git preview failed: {}", output.stderr.text.trim()));
    }
    if output.stdout.truncated {
        return Err(
            "Git diff exceeds the 512 KiB preview limit; open a narrower file/directory scope"
                .into(),
        );
    }
    Ok(DisplayFile::Diff {
        path: path.to_string_lossy().into_owned(),
        text: output.stdout.text,
        source: scope.into(),
    })
}

async fn collect(
    child: ProcessHandle,
    cancellation: CancellationToken,
) -> Result<ProcessOutput, String> {
    let cancel = child.cancellation();
    let waiting = child.wait();
    tokio::pin!(waiting);
    tokio::select! {
        result=&mut waiting=>result.map_err(|e|e.to_string()),
        _=cancellation.cancelled()=>{cancel.cancel();let _=waiting.await;Err("Git preview cancelled".into())}
    }
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn running_preview_cancellation_waits_for_process_and_pipe_quiescence() {
        let child = xharness_process::ProcessRuntime::new()
            .spawn(
                SpawnSpec::new("/bin/sh", std::env::temp_dir())
                    .args(["-c", "exec sleep 60"])
                    .env("PATH", "/usr/bin:/bin")
                    .timeout(Duration::from_secs(10)),
            )
            .unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        let result = tokio::time::timeout(Duration::from_secs(5), collect(child, token))
            .await
            .unwrap();
        assert_eq!(result.unwrap_err(), "Git preview cancelled");
    }
}
