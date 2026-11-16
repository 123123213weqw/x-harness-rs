//! On-demand project badges. Fixed read commands, no credential export, shell,
//! model call, durable cache, background refresh or GitHub mutation.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::github_service::{bounded_read_limit, failure, invalid};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio};
use tokio::{process::Command, time::Instant};
use tokio_util::sync::CancellationToken;
use xharness_api::RpcError;

const QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state isDraft url headRefName headRefOid headRepository{nameWithOwner} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){totalCount pageInfo{hasNextPage} nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}}}}}}}}}}";
struct Output {
    success: bool,
    code: Option<i32>,
    text: String,
}
#[async_trait]
trait Commands: Sync {
    async fn run(&self, program: &str, args: &[String]) -> Result<Output, RpcError>;
}
struct NativeCommands<'a> {
    cwd: &'a str,
    cancel: CancellationToken,
    deadline: Instant,
}
#[async_trait]
impl Commands for NativeCommands<'_> {
    async fn run(&self, program: &str, args: &[String]) -> Result<Output, RpcError> {
        run_command(self.cwd, program, args, &self.cancel, self.deadline).await
    }
}
async fn run_command(
    cwd: &str,
    program: &str,
    args: &[String],
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Output, RpcError> {
    if cancel.is_cancelled() {
        return Err(failure("cancelled", "Project status cancelled"));
    }
    if Instant::now() >= deadline {
        return Err(failure("timeout", "Project status timed out"));
    }
    let executable = executable(program);
    let mut command = Command::new(executable);
    command
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_HOST", "github.com")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PAGER", "cat")
        .env("GIT_PAGER", "cat");
    // Project discovery must use this Host workspace, not a git invocation's
    // inherited environment (including a parent XHarness development shell).
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
    ] {
        command.env_remove(name);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            failure(
                if program == "gh" {
                    "missing_cli"
                } else {
                    "missing_git"
                },
                if program == "gh" {
                    "Install GitHub CLI on the Host and run gh auth login"
                } else {
                    "Git is unavailable on the Host"
                },
            )
        } else {
            failure("process", "Could not start project status reader")
        }
    })?;
    let stdout = child.stdout.take().ok_or_else(invalid)?;
    let stderr = child.stderr.take().ok_or_else(invalid)?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(failure("cancelled", "Project status cancelled")),
        result = tokio::time::timeout_at(deadline, async {
            let (status, out, _diagnostics) = tokio::try_join!(
                async { child.wait().await.map_err(|_| failure("process", "Project status reader failed")) },
                bounded_read_limit(stdout, 1024 * 1024), bounded_read_limit(stderr, 64 * 1024),
            )?;
            Ok(Output {success: status.success(), code: status.code(), text: String::from_utf8(out).map_err(|_| invalid())?.trim().to_owned()})
        }) => result.unwrap_or_else(|_| Err(failure("timeout", "Project status timed out"))),
    };
    if result.is_err() {
        // Observe cancellation/overflow/timeout: do not just detach a child.
        // try_wait distinguishes an already-reaped process from a live child.
        if child
            .try_wait()
            .map_err(|_| failure("process", "Could not inspect project reader"))?
            .is_none()
        {
            let stop = child.start_kill();
            let reap = child.wait().await;
            reap.map_err(|_| failure("process", "Could not reap project reader"))?;
            stop.map_err(|_| failure("process", "Could not stop project reader"))?;
        }
        child
            .wait()
            .await
            .map_err(|_| failure("process", "Could not reap project reader"))?;
    }
    result
}
fn executable(program: &str) -> &str {
    #[cfg(target_os = "macos")]
    if program == "gh" {
        for candidate in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
            if Path::new(candidate).is_file() {
                return candidate;
            }
        }
    }
    program
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_owned()).collect()
}
async fn git(commands: &dyn Commands, values: &[&str]) -> Result<Output, RpcError> {
    let mut all = args(&["--no-pager", "-c", "core.fsmonitor=false"]);
    all.extend(args(values));
    commands.run("git", &all).await
}
fn sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn repository(remote: &str) -> Option<String> {
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<_> = path.split('/').collect();
    (parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && ![".", ".."].contains(p)
                && p.len() <= 100
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        }))
    .then(|| path.to_owned())
}
async fn local(commands: &dyn Commands) -> Result<Option<(String, String, String)>, RpcError> {
    let branch = git(commands, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    if !branch.success {
        return Ok(None);
    }
    if branch.text.is_empty()
        || branch.text.len() > 1024
        || branch.text.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let commit = git(commands, &["rev-parse", "--verify", "HEAD"]).await?;
    if !commit.success || !sha(&commit.text) {
        return Ok(None);
    }
    let tracked = git(
        commands,
        &["config", "--get", &format!("branch.{}.remote", branch.text)],
    )
    .await?;
    let remote = if tracked.success && tracked.text != "." {
        tracked.text.as_str()
    } else {
        "origin"
    };
    if remote.is_empty() || remote.len() > 256 || remote.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = git(
        commands,
        &["config", "--get", &format!("remote.{remote}.url")],
    )
    .await?;
    if !url.success {
        return Ok(None);
    }
    let Some(repo) = repository(&url.text) else {
        return Ok(None);
    };
    let merge = git(
        commands,
        &["config", "--get", &format!("branch.{}.merge", branch.text)],
    )
    .await?;
    let branch = if merge.success {
        merge
            .text
            .strip_prefix("refs/heads/")
            .ok_or_else(invalid)?
            .to_owned()
    } else {
        branch.text
    };
    if branch.is_empty() || branch.len() > 1024 || branch.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(Some((repo, branch, commit.text)))
}
async fn gh(commands: &dyn Commands, values: &[&str]) -> Result<Value, RpcError> {
    let out = commands.run("gh", &args(values)).await?;
    if !out.success {
        return Err(failure(
            if out.code == Some(4) {
                "authentication"
            } else {
                "github_read"
            },
            "GitHub read failed; check gh auth status and repository access on the Host",
        ));
    }
    let value: Value = serde_json::from_str(&out.text).map_err(|_| invalid())?;
    if value
        .get("errors")
        .is_some_and(|e| e.as_array().is_none_or(|v| !v.is_empty()))
    {
        return Err(invalid());
    }
    Ok(value)
}
async fn canonical_repository(commands: &dyn Commands, remote: &str) -> Result<String, RpcError> {
    let value = gh(
        commands,
        &["repo", "view", remote, "--json", "nameWithOwner"],
    )
    .await?;
    let name = value["nameWithOwner"].as_str().ok_or_else(invalid)?;
    repository(&format!("https://github.com/{name}"))
        .filter(|v| v == name)
        .ok_or_else(invalid)
}

pub(crate) async fn read(
    cwd: &str,
    cancel: CancellationToken,
    deadline: Instant,
) -> Result<Value, RpcError> {
    if !Path::new(cwd).is_dir() {
        return Err(failure(
            "workspace_missing",
            "Workspace directory is unavailable on the Host",
        ));
    }
    read_with(&NativeCommands {
        cwd,
        cancel,
        deadline,
    })
    .await
}
async fn read_with(commands: &dyn Commands) -> Result<Value, RpcError> {
    let Some((remote_repo, branch, local_sha)) = local(commands).await? else {
        return Ok(json!({"kind":"unsupported", "ci":"unknown"}));
    };
    // Follow GitHub repository renames without accepting a PR from another
    // fork merely because it uses the same branch name.
    let repo = canonical_repository(commands, &remote_repo).await?;
    let list = gh(
        commands,
        &[
            "pr",
            "list",
            "--repo",
            &repo,
            "--head",
            &branch,
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,state,headRefName,headRepository,headRepositoryOwner,updatedAt",
        ],
    )
    .await?;
    let items = list.as_array().ok_or_else(invalid)?;
    if items.len() >= 20 {
        return Ok(json!({"kind":"ambiguous", "ci":"unknown"}));
    }
    let mut matches: Vec<_> = items
        .iter()
        .filter(|v| {
            v["headRefName"].as_str() == Some(&branch)
                && v["headRepository"]["name"]
                    .as_str()
                    .zip(v["headRepositoryOwner"]["login"].as_str())
                    .is_some_and(|(name, owner)| {
                        format!("{owner}/{name}").eq_ignore_ascii_case(&repo)
                    })
        })
        .collect();
    matches.sort_by(|a, b| {
        (b["state"] == "OPEN")
            .cmp(&(a["state"] == "OPEN"))
            .then_with(|| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()))
    });
    if matches.iter().filter(|p| p["state"] == "OPEN").count() > 1 {
        return Err(failure("ambiguous", "More than one PR matches this branch"));
    }
    let Some(selected) = matches.first() else {
        return Ok(
            json!({"kind":if items.len() >= 20 {"ambiguous"} else {"no_pr"},"repository":repo,"branch":branch,"localSha":local_sha,"ci":"none"}),
        );
    };
    let number = selected["number"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= i32::MAX as u64)
        .ok_or_else(invalid)?;
    let (owner, name) = repo.split_once('/').ok_or_else(invalid)?;
    let response = gh(
        commands,
        &[
            "api",
            "graphql",
            "--hostname",
            "github.com",
            "-f",
            &format!("query={QUERY}"),
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
        ],
    )
    .await?;
    let pr = &response["data"]["repository"]["pullRequest"];
    let head = pr["headRefOid"]
        .as_str()
        .filter(|v| sha(v))
        .ok_or_else(invalid)?;
    let state = pr["state"]
        .as_str()
        .filter(|v| ["OPEN", "CLOSED", "MERGED"].contains(v))
        .ok_or_else(invalid)?;
    if pr["number"].as_u64() != Some(number)
        || pr["headRefName"].as_str() != Some(&branch)
        || !pr["headRepository"]["nameWithOwner"]
            .as_str()
            .is_some_and(|v| v.eq_ignore_ascii_case(&repo))
    {
        return Err(invalid());
    }
    // Recheck local branch, remote and HEAD after the network round trip.
    if local(commands).await?.as_ref() != Some(&(remote_repo, branch.clone(), local_sha.clone())) {
        return Err(failure(
            "project_changed",
            "Project changed; refresh status",
        ));
    }
    let commit = &pr["commits"]["nodes"][0]["commit"];
    let ci = if head != local_sha || commit["oid"].as_str() != Some(head) {
        "outdated"
    } else {
        ci_status(&commit["statusCheckRollup"])
    };
    // Construct the link locally. Never hand an arbitrary remote URL to UI.
    Ok(
        json!({"kind":"ready","repository":repo,"branch":branch,"localSha":local_sha,"headSha":head,"number":number,"url":format!("https://github.com/{repo}/pull/{number}"),"state":state,"draft":pr["isDraft"].as_bool().ok_or_else(invalid)?,"ci":ci}),
    )
}
fn ci_status(rollup: &Value) -> &'static str {
    if rollup.is_null() {
        return "none";
    }
    let contexts = &rollup["contexts"];
    let Some(nodes) = contexts["nodes"].as_array() else {
        return "unknown";
    };
    if contexts["totalCount"].as_u64() != Some(nodes.len() as u64)
        || contexts["pageInfo"]["hasNextPage"].as_bool() != Some(false)
    {
        return "unknown";
    }
    if nodes.is_empty() {
        return "none";
    }
    let mut pending = false;
    let mut neutral = false;
    let mut unknown = false;
    for node in nodes {
        let state = match node["__typename"].as_str() {
            Some("CheckRun") if node["status"] == "COMPLETED" => node["conclusion"].as_str(),
            Some("CheckRun") => match node["status"].as_str() {
                Some("QUEUED" | "IN_PROGRESS" | "WAITING" | "REQUESTED" | "PENDING") => {
                    Some("PENDING")
                }
                _ => None,
            },
            Some("StatusContext") => node["state"].as_str(),
            _ => None,
        };
        match state {
            Some(
                "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
                | "STARTUP_FAILURE" | "STALE",
            ) => return "failing",
            Some("PENDING" | "EXPECTED") => pending = true,
            Some("SUCCESS") => {}
            Some("NEUTRAL" | "SKIPPED") => neutral = true,
            _ => unknown = true,
        }
    }
    if unknown {
        "unknown"
    } else if pending {
        "pending"
    } else if neutral {
        "neutral"
    } else {
        "passing"
    }
}

#[cfg(test)]
#[path = "project_github_status_tests.rs"]
mod tests;
