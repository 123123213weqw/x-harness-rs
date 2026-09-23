//! Read-only Git adapter: fixed argv, no shell, native sandbox, bounded capture.
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_api::display::{DisplayFile, GitDiffScope, MAX_TEXT_BYTES};
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_process::{
    shell::executable_search_path, ProcessHandle, ProcessOutput, SpawnSpec, TerminationReason,
};
use xharness_sandbox::SandboxMode;

pub(crate) async fn read(
    platform: &NativePlatform,
    layout: &GitLayout,
    path: &Path,
    scope: GitDiffScope,
    cancellation: CancellationToken,
    _permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<DisplayFile, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
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
    validate_scope_path(platform.workspace_root(), relative)?;
    if layout.workspace != platform.workspace_root() {
        return Err("Git preview layout does not belong to this workspace".into());
    }
    // Literal pathspec: a filename containing '*' or ':(' is never a pattern
    // or Git pathspec magic. Deleted paths remain displayable.
    let filter = if relative.as_os_str().is_empty() {
        ".".into()
    } else {
        format!(":(literal){}", {
            let name = relative
                .to_str()
                .ok_or("Git preview path must be valid Unicode")?;
            if cfg!(windows) {
                name.replace('\\', "/")
            } else {
                name.to_owned()
            }
        })
    };
    let overrides = filter_overrides(platform, layout, cancellation.clone(), deadline).await?;
    let mut spec = git_spec(platform, layout);
    for setting in overrides {
        spec = spec.arg("-c").arg(setting);
    }
    spec = spec
        .args([
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
        .output_limits(MAX_TEXT_BYTES, 16 * 1024);
    spec = match scope {
        GitDiffScope::Working => spec,
        GitDiffScope::Staged => spec.arg("--cached"),
        GitDiffScope::Head => spec.arg("HEAD"),
    }
    .arg("--")
    .arg(filter);
    let output = run_git(platform, spec, cancellation, deadline).await?;
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

fn git_spec(platform: &NativePlatform, layout: &GitLayout) -> SpawnSpec {
    let mut spec = SpawnSpec::new("git", platform.workspace_root())
        .args(["--no-pager", "-c"])
        // The restricted Windows token may not pass Git's directory-owner
        // check for an administrator-owned workspace. Git compares its
        // enclosing worktree, not cwd; trust only that exact discovered root.
        // cwd and the literal pathspec still fence output to the session.
        .arg(git_safe_directory(&layout.worktree))
        .arg("--git-dir")
        .arg(git_config_path(&layout.git_dir))
        .arg("--work-tree")
        .arg(git_config_path(&layout.worktree))
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            "-c",
            "core.quotePath=false",
        ])
        .env("PATH", executable_search_path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Missing partial-clone objects must fail, never fetch. The protocol
        // whitelist also protects Git versions without GIT_NO_LAZY_FETCH and
        // cannot be overridden by repository-local protocol.*.allow settings.
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("LANG", "C.UTF-8");
    // Windows needs its loader directories; never credentials/GIT_* ambient env.
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            spec = spec.env(key, value);
        }
    }
    spec
}

fn remaining_budget(deadline: tokio::time::Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(tokio::time::Instant::now())
        .ok_or_else(|| "Git preview timed out".into())
}

async fn run_git(
    platform: &NativePlatform,
    spec: SpawnSpec,
    cancellation: CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<ProcessOutput, String> {
    let spec = spec.timeout(remaining_budget(deadline)?);
    let child = tokio::time::timeout_at(deadline, platform.spawn(spec))
        .await
        .map_err(|_| "Git preview timed out")?
        .map_err(|error| format!("Git preview unavailable: {error}"))?;
    collect(child, cancellation, deadline).await
}

async fn filter_overrides(
    platform: &NativePlatform,
    layout: &GitLayout,
    cancellation: CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<Vec<String>, String> {
    const FILTER_KEYS: &str = r"^(filter\..*\.(clean|process|required))$";
    let output = run_git(
        platform,
        git_spec(platform, layout)
            .args([
                "config",
                "--null",
                "--name-only",
                "--get-regexp",
                FILTER_KEYS,
            ])
            .output_limits(16 * 1024, 16 * 1024),
        cancellation,
        deadline,
    )
    .await?;
    if output.termination != TerminationReason::Exited {
        return Err(format!(
            "Git preview filter scan stopped: {:?}",
            output.termination
        ));
    }
    if output.stdout.truncated || output.stderr.truncated {
        return Err("Git preview filter configuration exceeds the scan limit".into());
    }
    // Exit 1 alone is not proof of no matches: config errors may also use it.
    if output.status.code == Some(1)
        && output.stdout.text.is_empty()
        && output.stderr.text.is_empty()
    {
        return Ok(Vec::new());
    }
    if !output.status.success || !output.stderr.text.is_empty() {
        return Err("Git preview could not safely inspect filter configuration".into());
    }
    parse_filter_overrides(&output.stdout.text)
}

fn parse_filter_overrides(names: &str) -> Result<Vec<String>, String> {
    use std::collections::BTreeSet;
    if !names.ends_with('\0') {
        return Err("Git preview received malformed filter keys".into());
    }
    let mut drivers = BTreeSet::new();
    let mut key_count = 0;
    for key in names.split_terminator('\0') {
        key_count += 1;
        if key_count > 192
            || key.len() > 1024
            || key
                .chars()
                .any(|ch| ch.is_control() || ch == '=' || ch == '\u{fffd}')
        {
            return Err("Git preview received unsupported filter keys".into());
        }
        let driver = key
            .strip_prefix("filter.")
            .and_then(|key| {
                key.strip_suffix(".clean")
                    .or_else(|| key.strip_suffix(".process"))
                    .or_else(|| key.strip_suffix(".required"))
            })
            .filter(|name| !name.is_empty())
            .ok_or("Git preview received malformed filter keys")?;
        drivers.insert(driver);
        if drivers.len() > 64 {
            return Err("Git preview has too many configured filters".into());
        }
    }
    let mut overrides = Vec::with_capacity(drivers.len() * 3);
    for driver in drivers {
        // These are config argv values, never shell commands or copied values.
        overrides.extend([
            format!("filter.{driver}.clean="),
            format!("filter.{driver}.process="),
            format!("filter.{driver}.required=false"),
        ]);
    }
    Ok(overrides)
}

/// Validated Git metadata is private to the display adapter, never a model FS
/// capability. Keep the session cwd/output scope, and expose metadata only.
#[derive(Debug)]
pub(crate) struct GitLayout {
    workspace: PathBuf,
    worktree: PathBuf,
    git_dir: PathBuf,
}

pub(crate) fn platform_config(workspace: &Path) -> Result<(PlatformConfig, GitLayout), String> {
    let workspace = std::fs::canonicalize(workspace)
        .map_err(|error| format!("Git preview cannot resolve workspace: {error}"))?;
    let worktree = enclosing_worktree(&workspace)?;
    let marker = worktree.join(".git");
    let marker_metadata = std::fs::symlink_metadata(&marker)
        .map_err(|error| format!("Git preview cannot inspect .git marker: {error}"))?;
    let linked = marker_metadata.is_file();
    let git_dir = if marker_metadata.is_dir() {
        canonical_metadata_path(&marker, true)?
    } else {
        let reference = read_metadata_reference(&marker)?;
        let target = reference
            .strip_prefix("gitdir: ")
            .filter(|path| !path.is_empty())
            .ok_or("Git preview .git file must contain a gitdir reference")?;
        let git_dir = canonical_metadata_path(&worktree.join(target), true)?;
        // A linked worktree's metadata has a backreference to this exact .git
        // file. A forged .git file cannot grant a read root to an arbitrary dir.
        let backreference = read_metadata_reference(&git_dir.join("gitdir"))?;
        let backreference = canonical_metadata_path(&git_dir.join(backreference), false)?;
        if backreference != canonical_metadata_path(&marker, false)? {
            return Err(
                "Git preview linked-worktree backreference does not match its .git file".into(),
            );
        }
        git_dir
    };
    canonical_metadata_path(&git_dir.join("HEAD"), false)?;
    let common_marker = git_dir.join("commondir");
    let common_dir = match std::fs::symlink_metadata(&common_marker) {
        Ok(_) => {
            let reference = read_metadata_reference(&common_marker)?;
            canonical_metadata_path(&git_dir.join(reference), true)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => git_dir.clone(),
        Err(error) => return Err(format!("Git preview cannot inspect commondir: {error}")),
    };
    if linked {
        // Support Git's ordinary .git/worktrees/<id> layout, not an arbitrary
        // directory advertised as metadata by an untrusted text reference.
        let common_name = common_dir.file_name().and_then(|name| name.to_str());
        let is_git_marker = if cfg!(windows) {
            common_name.is_some_and(|name| name.eq_ignore_ascii_case(".git"))
        } else {
            common_name == Some(".git")
        };
        let expected = common_dir.join("worktrees").join(
            git_dir
                .file_name()
                .ok_or("Git preview linked metadata has no directory name")?,
        );
        if !is_git_marker || canonical_metadata_path(&expected, true)? != git_dir {
            return Err(
                "Git preview linked metadata is not an ordinary .git/worktrees layout".into(),
            );
        }
    } else if common_dir != git_dir {
        return Err("Git preview refuses an external commondir for a directory .git marker".into());
    }
    // An external metadata root must actually have Git's object-store layout.
    // In particular, a forged reference to '/' or a home directory is not a
    // general-purpose read-root grant. No config/credential contents are read.
    canonical_metadata_path(&common_dir.join("objects"), true)?;
    canonical_metadata_path(&common_dir.join("config"), false)?;
    let mut config = PlatformConfig::new(&workspace).sandbox_mode(SandboxMode::ReadOnly);
    if !common_dir.starts_with(&workspace) {
        config = config.read_only_root(&common_dir);
    }
    if !git_dir.starts_with(&workspace) && !git_dir.starts_with(&common_dir) {
        config = config.read_only_root(&git_dir);
    }
    Ok((
        config,
        GitLayout {
            workspace,
            worktree,
            git_dir,
        },
    ))
}

/// Git's tiny path-reference files must be regular, non-symlink, bounded UTF-8.
fn read_metadata_reference(path: &Path) -> Result<String, String> {
    const MAX_REFERENCE_BYTES: u64 = 4096;
    let path = canonical_metadata_path(path, false)?;
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|error| format!("Git preview cannot open metadata reference: {error}"))?
        .take(MAX_REFERENCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Git preview cannot read metadata reference: {error}"))?;
    if bytes.len() > MAX_REFERENCE_BYTES as usize {
        return Err("Git preview metadata reference exceeds 4096 bytes".into());
    }
    let text =
        String::from_utf8(bytes).map_err(|_| "Git preview metadata reference must be UTF-8")?;
    let text = text.trim_end_matches(['\r', '\n']);
    if text.is_empty() || text.contains('\0') || text.contains(['\r', '\n']) {
        return Err("Git preview metadata reference must contain one nonempty path".into());
    }
    Ok(text.to_owned())
}

/// Validate every path component before canonicalizing; canonicalization alone
/// would silently follow symlinks and Windows junctions in metadata references.
fn canonical_metadata_path(path: &Path, directory: bool) -> Result<PathBuf, String> {
    let mut current = PathBuf::new();
    let mut components = path.components().peekable();
    while let Some(component) = components.next() {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::ParentDir => {
                if !current.pop() {
                    return Err("Git preview metadata path escapes the filesystem root".into());
                }
                continue;
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                current.push(component.as_os_str());
                continue;
            }
            std::path::Component::Normal(_) => current.push(component.as_os_str()),
        }
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|error| format!("Git preview cannot inspect metadata path: {error}"))?;
        if is_link_or_reparse(&metadata) {
            return Err("Git preview metadata must not traverse a symlink or reparse point".into());
        }
        if components.peek().is_some() && !metadata.is_dir() {
            return Err("Git preview metadata path traverses a non-directory".into());
        }
    }
    let canonical = std::fs::canonicalize(&current)
        .map_err(|error| format!("Git preview cannot canonicalize metadata path: {error}"))?;
    let metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|error| format!("Git preview cannot inspect metadata target: {error}"))?;
    if is_link_or_reparse(&metadata)
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err("Git preview metadata target has an invalid file type".into());
    }
    if directory && canonical.parent().is_none() {
        return Err("Git preview metadata cannot be a filesystem root".into());
    }
    Ok(canonical)
}

/// Find only the nearest enclosing worktree marker. Never trust all ancestors
/// or follow a .git symlink; linked worktrees use a regular .git file.
fn enclosing_worktree(workspace: &Path) -> Result<std::path::PathBuf, String> {
    for candidate in workspace.ancestors() {
        let marker = candidate.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Ok(metadata) => {
                if is_link_or_reparse(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
                    return Err("Git preview refuses a symlink or special .git marker".into());
                }
                // Git treats a safe.directory ending in /* as a trust wildcard,
                // even when '*' is a real Unix directory name. Fail closed.
                if candidate.file_name() == Some(std::ffi::OsStr::new("*")) {
                    return Err("Git preview cannot safely trust a worktree named '*'".into());
                }
                return Ok(candidate.to_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Git preview cannot inspect .git marker: {error}")),
        }
    }
    Err("Git preview requires an enclosing Git worktree".into())
}

/// Deleted paths are valid pathspecs, but existing scope components must never
/// redirect traversal outside the session (including Windows junctions).
fn validate_scope_path(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_owned();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if is_link_or_reparse(&metadata) => {
                return Err("Git preview path must not traverse a symlink or reparse point".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Git preview cannot inspect scope path: {error}")),
        }
    }
    Ok(())
}

fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn git_safe_directory(root: &Path) -> OsString {
    let mut setting = OsString::from("safe.directory=");
    setting.push(git_config_path(root));
    setting
}

#[cfg(not(windows))]
fn git_config_path(root: &Path) -> std::path::PathBuf {
    root.to_owned()
}

#[cfg(windows)]
fn git_config_path(root: &Path) -> std::path::PathBuf {
    use std::path::{Component, PathBuf, Prefix};
    let mut components = root.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return root.to_owned();
    };
    let mut path = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
        Prefix::VerbatimUNC(server, share) => PathBuf::from(r"\\").join(server).join(share),
        _ => return root.to_owned(),
    };
    path.extend(components);
    path
}

async fn collect(
    child: ProcessHandle,
    cancellation: CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<ProcessOutput, String> {
    let cancel = child.cancellation();
    let waiting = child.wait();
    tokio::pin!(waiting);
    tokio::select! {
        result=&mut waiting=>result.map_err(|e|e.to_string()),
        _=cancellation.cancelled()=>{cancel.cancel();let _=waiting.await;Err("Git preview cancelled".into())},
        _=tokio::time::sleep_until(deadline)=>{cancel.cancel();let _=waiting.await;Err("Git preview timed out".into())}
    }
}
#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn safe_directory_is_one_exact_worktree_not_a_wildcard() {
        let root = std::env::temp_dir().join("Git preview space and 中文");
        let mut expected = OsString::from("safe.directory=");
        expected.push(git_config_path(&root));
        assert_eq!(git_safe_directory(&root), expected);
        assert!(!git_safe_directory(&root).to_string_lossy().contains('*'));
    }

    #[test]
    fn filter_key_scan_generates_only_exact_empty_driver_overrides() {
        assert_eq!(
            parse_filter_overrides("filter.lfs.process\0filter.lfs.required\0filter.other.clean\0")
                .unwrap(),
            [
                "filter.lfs.clean=",
                "filter.lfs.process=",
                "filter.lfs.required=false",
                "filter.other.clean=",
                "filter.other.process=",
                "filter.other.required=false",
            ]
        );
        for names in [
            "filter.lfs.clean",
            "filter.evil=other.clean\0",
            "filter.line\nbreak.clean\0",
            "filter.\u{fffd}.process\0",
            "core.pager\0",
            "filter..clean\0",
        ] {
            assert!(parse_filter_overrides(names).is_err(), "{names:?}");
        }
        let many_drivers = (0..65)
            .map(|i| format!("filter.driver{i}.process\0"))
            .collect::<String>();
        assert!(parse_filter_overrides(&many_drivers).is_err());
        assert!(parse_filter_overrides(&"filter.lfs.clean\0".repeat(193)).is_err());
        assert!(parse_filter_overrides(&format!("filter.{}.clean\0", "x".repeat(1024))).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn git_configuration_accepts_verbatim_disk_and_unc_without_lossy_conversion() {
        assert_eq!(
            git_config_path(Path::new(r"\\?\C:\workspace\中文")),
            std::path::PathBuf::from(r"C:\workspace\中文")
        );
        assert_eq!(
            git_config_path(Path::new(r"\\?\UNC\server\share\workspace")),
            std::path::PathBuf::from(r"\\server\share\workspace")
        );
        assert_eq!(
            git_config_path(Path::new(r"C:\workspace\normal")),
            std::path::PathBuf::from(r"C:\workspace\normal")
        );
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preview_deadline_cancels_and_joins_a_running_phase() {
        let child = xharness_process::ProcessRuntime::new()
            .spawn(
                SpawnSpec::new("/bin/sh", std::env::temp_dir())
                    .args(["-c", "exec sleep 60"])
                    .env("PATH", "/usr/bin:/bin")
                    .timeout(Duration::from_secs(10)),
            )
            .unwrap();
        let result = collect(
            child,
            CancellationToken::new(),
            tokio::time::Instant::now() + Duration::from_millis(30),
        )
        .await;
        assert_eq!(result.unwrap_err(), "Git preview timed out");
        assert!(remaining_budget(tokio::time::Instant::now() - Duration::from_millis(1)).is_err());
    }

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
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            collect(
                child,
                token,
                tokio::time::Instant::now() + Duration::from_secs(5),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "Git preview cancelled");
    }
}
