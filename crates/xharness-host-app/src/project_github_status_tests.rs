use super::*;
use std::{collections::VecDeque, sync::Mutex};
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
type Step = (&'static str, Vec<String>, bool, String);
struct Fixture {
    steps: Mutex<VecDeque<Step>>,
}
impl Fixture {
    fn new() -> Self {
        Self {
            steps: Mutex::new(VecDeque::new()),
        }
    }
    fn push(
        &self,
        program: &'static str,
        values: Vec<String>,
        success: bool,
        text: impl Into<String>,
    ) {
        self.steps
            .lock()
            .unwrap()
            .push_back((program, values, success, text.into()));
    }
    fn local(&self, commit: &str) {
        for (a, ok, text) in [
            (
                vec!["symbolic-ref", "--quiet", "--short", "HEAD"],
                true,
                "feature/test",
            ),
            (vec!["rev-parse", "--verify", "HEAD"], true, commit),
            (
                vec!["config", "--get", "branch.feature/test.remote"],
                false,
                "",
            ),
            (
                vec!["config", "--get", "remote.origin.url"],
                true,
                "git@github.com:alice/project.git",
            ),
            (
                vec!["config", "--get", "branch.feature/test.merge"],
                false,
                "",
            ),
        ] {
            let mut values = args(&["--no-pager", "-c", "core.fsmonitor=false"]);
            values.extend(args(&a));
            self.push("git", values, ok, text);
        }
    }
    fn list(&self, value: Value) {
        self.push(
            "gh",
            args(&[
                "repo",
                "view",
                "alice/project",
                "--json",
                "id,nameWithOwner",
            ]),
            true,
            json!({"id":"R_project7","nameWithOwner":"alice/project"}).to_string(),
        );
        self.push(
            "gh",
            args(&[
                "pr",
                "list",
                "--repo",
                "alice/project",
                "--head",
                "feature/test",
                "--state",
                "all",
                "--limit",
                "20",
                "--json",
                "number,state,headRefName,headRepository,headRepositoryOwner,updatedAt",
            ]),
            true,
            value.to_string(),
        );
    }
    fn detail(&self, value: Value) {
        self.push(
            "gh",
            args(&[
                "api",
                "graphql",
                "--hostname",
                "github.com",
                "-f",
                &format!("query={QUERY}"),
                "-f",
                "owner=alice",
                "-f",
                "name=project",
                "-F",
                "number=7",
            ]),
            true,
            json!({"data":{"repository":{"pullRequest":value}}}).to_string(),
        );
    }
}
#[async_trait]
impl Commands for Fixture {
    async fn run(&self, program: &str, values: &[String]) -> Result<Output, RpcError> {
        let (p, a, success, text) = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected command");
        assert_eq!(p, program);
        assert_eq!(a, values);
        Ok(Output {
            success,
            code: Some(if success { 0 } else { 1 }),
            text,
        })
    }
}
fn listing() -> Value {
    json!([{"number":7,"state":"OPEN","headRefName":"feature/test","headRepository":{"name":"project"},"headRepositoryOwner":{"login":"alice"},"updatedAt":"2026-11-16T00:00:00Z"}])
}
fn rollup(nodes: Value) -> Value {
    json!({"contexts":{"totalCount":nodes.as_array().unwrap().len(),"pageInfo":{"hasNextPage":false},"nodes":nodes}})
}
fn run(status: &str, conclusion: Value) -> Value {
    json!({"__typename":"CheckRun","status":status,"conclusion":conclusion})
}
fn pr() -> Value {
    json!({"number":7,"state":"OPEN","isDraft":false,"headRefName":"feature/test","headRefOid":SHA,"headRepository":{"id":"R_project7","nameWithOwner":"alice/project"},"commits":{"nodes":[{"commit":{"oid":SHA,"statusCheckRollup":rollup(json!([run("COMPLETED",json!("SUCCESS"))]))}}]}})
}
#[test]
fn remotes_are_allowlisted_without_credentials_or_host_confusion() {
    for remote in [
        "git@github.com:alice/project.git",
        "https://github.com/alice/project.git",
        "ssh://git@github.com/alice/project",
    ] {
        assert_eq!(repository(remote).as_deref(), Some("alice/project"));
    }
    for remote in [
        "https://github.com.evil/alice/project",
        "https://token@github.com/alice/project",
        "http://github.com/alice/project",
        "https://github.com/alice/project?token=secret",
        "git@evil:alice/project.git",
        "/local/repo",
        "https://github.com/alice/../project",
        "https://github.com/alice/project/",
        "https://github.com/../project",
        "https://github.com/a/b\n",
    ] {
        assert!(repository(remote).is_none(), "{remote}");
    }
}
#[test]
fn ci_is_fail_closed_for_empty_incomplete_unknown_skipped_cancelled() {
    assert_eq!(ci_status(&Value::Null), "none");
    assert_eq!(ci_status(&rollup(json!([]))), "none");
    for (node, want) in [
        (run("COMPLETED", json!("SUCCESS")), "passing"),
        (run("IN_PROGRESS", Value::Null), "pending"),
        (run("COMPLETED", json!("FAILURE")), "failing"),
        (run("COMPLETED", json!("CANCELLED")), "failing"),
        (run("COMPLETED", json!("TIMED_OUT")), "failing"),
        (run("COMPLETED", json!("SKIPPED")), "neutral"),
        (run("COMPLETED", Value::Null), "unknown"),
        (run("FUTURE_STATE", Value::Null), "unknown"),
        (
            json!({"__typename":"StatusContext","state":"SUCCESS"}),
            "passing",
        ),
        (
            json!({"__typename":"StatusContext","state":"ERROR"}),
            "failing",
        ),
    ] {
        assert_eq!(ci_status(&rollup(json!([node]))), want);
    }
    let mut incomplete = rollup(json!([run("COMPLETED", json!("SUCCESS"))]));
    incomplete["contexts"]["totalCount"] = json!(2);
    assert_eq!(ci_status(&incomplete), "unknown");
    incomplete["contexts"]["totalCount"] = json!(1);
    incomplete["contexts"]["pageInfo"]["hasNextPage"] = json!(true);
    assert_eq!(ci_status(&incomplete), "unknown");
    assert_eq!(
        ci_status(&rollup(json!([
            run("IN_PROGRESS", Value::Null),
            run("COMPLETED", json!("FAILURE"))
        ]))),
        "failing"
    );
}
#[tokio::test]
async fn exact_head_project_query_and_local_recheck() {
    let f = Fixture::new();
    f.local(SHA);
    f.list(listing());
    f.detail(pr());
    f.local(SHA);
    let result = read_with(&f).await.unwrap();
    assert_eq!(result["ci"], "passing");
    assert_eq!(result["url"], "https://github.com/alice/project/pull/7");
    assert!(f.steps.lock().unwrap().is_empty());
}
#[tokio::test]
async fn local_ahead_and_commit_mismatch_never_reuse_green() {
    for (head, commit) in [
        ("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", SHA),
        (SHA, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ] {
        let f = Fixture::new();
        f.local(SHA);
        f.list(listing());
        let mut p = pr();
        p["headRefOid"] = json!(head);
        p["commits"]["nodes"][0]["commit"]["oid"] = json!(commit);
        f.detail(p);
        f.local(SHA);
        assert_eq!(read_with(&f).await.unwrap()["ci"], "outdated");
    }
}
#[tokio::test]
async fn local_branch_change_during_query_is_visible_failure() {
    let f = Fixture::new();
    f.local(SHA);
    f.list(listing());
    f.detail(pr());
    f.local("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert_eq!(
        read_with(&f).await.unwrap_err().details["kind"],
        "project_changed"
    );
}
#[tokio::test]
async fn no_pr_wrong_fork_and_ambiguous_open_prs_do_not_pick_randomly() {
    for items in [json!([]), {
        let mut v = listing();
        v[0]["headRepositoryOwner"]["login"] = json!("other");
        v
    }] {
        let f = Fixture::new();
        f.local(SHA);
        f.list(items);
        assert_eq!(read_with(&f).await.unwrap()["kind"], "no_pr");
    }
    let f = Fixture::new();
    f.local(SHA);
    let mut items = listing();
    let duplicate = items[0].clone();
    items.as_array_mut().unwrap().push(duplicate);
    f.list(items);
    assert!(read_with(&f).await.is_err());
}
#[tokio::test]
async fn merged_and_closed_are_separate_from_ci() {
    for state in ["MERGED", "CLOSED"] {
        let f = Fixture::new();
        f.local(SHA);
        f.list(listing());
        let mut p = pr();
        p["state"] = json!(state);
        p["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null;
        f.detail(p);
        f.local(SHA);
        let result = read_with(&f).await.unwrap();
        assert_eq!(result["state"], state);
        assert_eq!(result["ci"], "none");
    }
}
#[tokio::test]
async fn malformed_graphql_and_wrong_repository_are_rejected() {
    for p in [Value::Null, {
        let mut p = pr();
        p["headRepository"]["nameWithOwner"] = json!("other/project");
        p
    }] {
        let f = Fixture::new();
        f.local(SHA);
        f.list(listing());
        f.detail(p);
        assert!(read_with(&f).await.is_err());
    }
}
#[tokio::test]
async fn missing_executable_and_pre_cancelled_operation_are_observable() {
    let token = CancellationToken::new();
    token.cancel();
    let result = run_command(
        ".",
        "git",
        &args(&["--version"]),
        &token,
        Instant::now() + std::time::Duration::from_secs(1),
    )
    .await;
    assert_eq!(result.err().unwrap().details["kind"], "cancelled");
    let result = run_command(
        ".",
        "xharness-nonexistent-gh-fixture",
        &[],
        &CancellationToken::new(),
        Instant::now() + std::time::Duration::from_secs(1),
    )
    .await;
    assert_eq!(result.err().unwrap().details["kind"], "missing_git");
}
#[cfg(unix)]
#[tokio::test]
async fn actual_process_timeout_and_output_overflow_cleanup() {
    let result = run_command(
        ".",
        "sh",
        &args(&["-c", "while :; do :; done"]),
        &CancellationToken::new(),
        Instant::now() + std::time::Duration::from_millis(80),
    )
    .await;
    assert_eq!(result.err().unwrap().details["kind"], "timeout");
    let result=run_command(".","sh",&args(&["-c","while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done"]),&CancellationToken::new(),Instant::now()+std::time::Duration::from_secs(4)).await;
    assert_eq!(result.err().unwrap().details["kind"], "response_too_large");
}

#[tokio::test]
async fn full_candidate_page_and_reused_branch_prefers_open() {
    let f = Fixture::new();
    f.local(SHA);
    let first = listing()[0].clone();
    f.list(json!(vec![first; 20]));
    assert_eq!(read_with(&f).await.unwrap()["kind"], "ambiguous");
    let f = Fixture::new();
    f.local(SHA);
    let mut items = listing();
    let mut closed = items[0].clone();
    closed["state"] = json!("CLOSED");
    closed["number"] = json!(999);
    closed["updatedAt"] = json!("2026-11-17");
    items.as_array_mut().unwrap().push(closed);
    f.list(items);
    f.detail(pr());
    f.local(SHA);
    assert_eq!(read_with(&f).await.unwrap()["number"], 7);
}
#[tokio::test]
async fn detached_unborn_and_missing_origin_stop_before_gh() {
    for step in [0, 1, 3] {
        let f = Fixture::new();
        f.local(SHA);
        {
            let mut steps = f.steps.lock().unwrap();
            let chosen = steps.get_mut(step).unwrap();
            chosen.2 = false;
            chosen.3 = String::new();
            steps.truncate(step + 1);
        }
        assert!(local(&f).await.unwrap().is_none());
        assert!(f.steps.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn tracked_remote_and_differently_named_upstream_branch() {
    let f = Fixture::new();
    f.local(SHA);
    {
        let mut steps = f.steps.lock().unwrap();
        steps[2].2 = true;
        steps[2].3 = "upstream".into();
        steps[3].1 = args(&[
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "config",
            "--get",
            "remote.upstream.url",
        ]);
        steps[3].3 = "https://github.com/owner/repo.git".into();
        steps[4].2 = true;
        steps[4].3 = "refs/heads/remote-feature".into();
    }
    assert_eq!(
        local(&f).await.unwrap(),
        Some(("owner/repo".into(), "remote-feature".into(), SHA.into()))
    );
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn actual_midflight_cancel_reaps_child() {
    let root = crate::tests::TempWorkspace::new();
    let pidfile = root.0.join("pid");
    let cancellation = CancellationToken::new();
    let child_cancel = cancellation.clone();
    let cwd = root.0.to_string_lossy().into_owned();
    let task = tokio::spawn(async move {
        run_command(
            &cwd,
            "sh",
            &args(&["-c", "echo $$ > pid; while :; do :; done"]),
            &child_cancel,
            Instant::now() + std::time::Duration::from_secs(5),
        )
        .await
    });
    let mut pid = None;
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(&pidfile) {
            if let Ok(n) = text.trim().parse::<u32>() {
                pid = Some(n);
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    cancellation.cancel();
    let result = task.await.unwrap();
    assert_eq!(result.err().unwrap().details["kind"], "cancelled");
    assert!(
        !Path::new(&format!("/proc/{}", pid.expect("child started"))).exists(),
        "reader must be reaped before completion"
    );
}

#[tokio::test]
async fn repository_rename_resolution_is_verified_and_not_a_fork_guess() {
    for (name, accepted) in [
        ("new-owner/renamed", true),
        ("alice/project", true),
        ("https://evil/repo", false),
        ("alice/../other", false),
    ] {
        let f = Fixture::new();
        f.push(
            "gh",
            args(&[
                "repo",
                "view",
                "alice/project",
                "--json",
                "id,nameWithOwner",
            ]),
            true,
            json!({"id":"R_project7","nameWithOwner":name}).to_string(),
        );
        let result = canonical_repository(&f, "alice/project").await;
        assert_eq!(result.is_ok(), accepted);
    }
}
