use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    display::{DisplayFile, DisplayRead},
    ApiBackend, RpcId, RpcMethod,
};
use xharness_host::{BasicHost, DisplayTool, HostConfig, PermissionPreset, SessionToolFactory};
use xharness_host_app::{configured_web_runtime, NativeToolFactory};
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self::at(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        )
    }
    fn at(tick: u128) -> Self {
        // Windows clock resolution is not a uniqueness guarantee. Reserve the
        // directory atomically, and never share it with another fixture/drop.
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = loop {
            let p = std::env::temp_dir().join(format!(
                "xh-file-preview-{}-{}-{}",
                std::process::id(),
                tick,
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&p) {
                Ok(()) => break p,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("fixture directory reservation failed: {error}"),
            }
        };
        std::fs::create_dir_all(p.join("docs")).unwrap();
        std::fs::write(
            p.join("docs/report.md"),
            "# Report\n![Image](../image.png)\n",
        )
        .unwrap();
        std::fs::write(p.join("main.rs"), "fn main() {}\n").unwrap();
        Self(std::fs::canonicalize(p).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("outside.txt"));
    }
}
#[test]
fn same_clock_tick_fixtures_reserve_disjoint_directories_and_cleanup_only_their_own() {
    let barrier = Arc::new(std::sync::Barrier::new(32));
    let handles: Vec<_> = (0..32)
        .map(|_| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Fixture::at(42)
            })
        })
        .collect();
    let mut fixtures: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    let paths: std::collections::HashSet<_> =
        fixtures.iter().map(|fixture| fixture.0.clone()).collect();
    assert_eq!(paths.len(), 32);
    let removed = fixtures.pop().unwrap();
    let removed_path = removed.0.clone();
    drop(removed);
    assert!(!removed_path.exists());
    for fixture in &fixtures {
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("main.rs")).unwrap(),
            "fn main() {}\n"
        );
    }
}
fn factory() -> Arc<NativeToolFactory> {
    NativeToolFactory::new(
        configured_web_runtime(None, xharness_debug::DebugRecorder::disabled()).unwrap(),
    )
}
async fn host(f: &Fixture) -> Arc<BasicHost> {
    let factory = factory();
    let config = HostConfig::new(f.0.clone());
    let host = BasicHost::new(config, None, factory.clone());
    factory.bind_agent_host(&host).unwrap();
    let created = host
        .call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"sessionId":"s","cwd":f.0}),
            CancellationToken::new(),
        )
        .await;
    assert!(created.is_ok(), "{created:?}");
    host
}
#[tokio::test]
async fn file_display_reads_markdown_and_code_without_a_model() {
    let f = Fixture::new();
    let host = host(&f).await;
    let file = host
        .read_display_file(
            DisplayRead {
                git_diff: None,
                session_id: "s".into(),
                path: "docs/report.md".into(),
                relative_to: None,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(file, DisplayFile::Markdown { .. }));
    assert_eq!(file.path(), f.0.join("docs/report.md").to_str().unwrap());
    let file = host
        .read_display_file(
            DisplayRead {
                git_diff: None,
                session_id: "s".into(),
                path: "../main.rs".into(),
                relative_to: Some(file.path().into()),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(file, DisplayFile::Text { .. }));
}
#[tokio::test]
async fn preview_rejects_escape_symlink_missing_binary_and_large_text() {
    let f = Fixture::new();
    let host = host(&f).await;
    std::fs::write(f.0.join("binary"), [0, 255]).unwrap();
    std::fs::write(
        f.0.join("huge.txt"),
        vec![b'a'; xharness_api::display::MAX_TEXT_BYTES + 1],
    )
    .unwrap();
    for path in ["../outside.txt", "missing.md", "binary", "huge.txt", "docs"] {
        let r = host
            .read_display_file(
                DisplayRead {
                    git_diff: None,
                    session_id: "s".into(),
                    path: path.into(),
                    relative_to: None,
                },
                CancellationToken::new(),
            )
            .await;
        assert!(r.is_err(), "must reject {path}");
    }
    #[cfg(unix)]
    {
        let outside = f.0.with_extension("outside.txt");
        std::fs::write(&outside, "external content").unwrap();
        std::os::unix::fs::symlink(&outside, f.0.join("escape.txt")).unwrap();
        assert!(host
            .read_display_file(
                DisplayRead {
                    git_diff: None,
                    session_id: "s".into(),
                    path: "escape.txt".into(),
                    relative_to: None
                },
                CancellationToken::new()
            )
            .await
            .is_err());
    }
    let invalid = host
        .call_dynamic(
            RpcId::new("bad"),
            "display/read",
            json!({"sessionId":"other","path":"main.rs"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!invalid.is_ok());
    let token = CancellationToken::new();
    token.cancel();
    assert!(host
        .read_display_file(
            DisplayRead {
                git_diff: None,
                session_id: "s".into(),
                path: "main.rs".into(),
                relative_to: None
            },
            token
        )
        .await
        .is_err());
}
#[tokio::test]
async fn image_is_ephemeral_bounded_and_independent_of_model_vision() {
    let f = Fixture::new();
    let host = host(&f).await;
    // Valid 1x1 RGBA PNG with CRC-checked chunks.
    let data="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPwd3v6HwAE3AJ6zM4FjgAAAABJRU5ErkJggg==";
    use xharness_attachments::Upload;
    let bytes = Upload::from_base64("image/png", data).unwrap().data;
    std::fs::write(f.0.join("image.png"), bytes).unwrap();
    let file = host
        .read_display_file(
            DisplayRead {
                git_diff: None,
                session_id: "s".into(),
                path: "image.png".into(),
                relative_to: None,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        file,
        DisplayFile::Image {
            width: 1,
            height: 1,
            ..
        }
    ));
    std::fs::write(f.0.join("corrupt.png"), b"\x89PNG\r\n\x1a\nnot-an-image").unwrap();
    assert!(host
        .read_display_file(
            DisplayRead {
                git_diff: None,
                session_id: "s".into(),
                path: "corrupt.png".into(),
                relative_to: None
            },
            CancellationToken::new()
        )
        .await
        .is_err());
}
#[tokio::test]
async fn display_tool_publishes_only_intent_not_content_and_has_no_strong_host_cycle() {
    let f = Fixture::new();
    let host = host(&f).await;
    let mut events = host.host_events();
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(DisplayTool::for_host(&host, "s"))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);
    let result = executor
        .execute(ToolRequest::new("display", r#"{"path":"docs/report.md"}"#))
        .await;
    assert!(result.is_ok(), "{result:?}");
    let result = result.output.unwrap();
    assert!(result.content.contains("requested"));
    assert!(!result.content.contains("# Report"));
    use futures::StreamExt;
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
        .await
        .unwrap()
        .unwrap();
    let payload = serde_json::to_value(event).unwrap();
    assert!(payload.to_string().contains("display/open"));
    assert!(!payload.to_string().contains("# Report"));
    assert!(executor
        .execute(ToolRequest::new(
            "display",
            r#"{"path":"main.rs","sessionId":"other"}"#
        ))
        .await
        .failure
        .is_some());
    let weak = Arc::downgrade(&host);
    drop(host);
    assert!(weak.upgrade().is_none());
}
#[tokio::test]
async fn production_registry_projects_one_display_tool_and_obeys_allowlist() {
    let f = Fixture::new();
    let tools = factory();
    let host = BasicHost::new(HostConfig::new(f.0.clone()), None, tools.clone());
    tools.bind_agent_host(&host).unwrap();
    let executor = tools
        .executor("s", f.0.to_str().unwrap(), PermissionPreset::WorkspaceWrite)
        .await
        .unwrap();
    assert_eq!(
        executor
            .registry()
            .definitions()
            .await
            .iter()
            .filter(|d| d.name == "display")
            .count(),
        1
    );
    let tools = factory();
    tools
        .restrict_tools(xharness_host_app::tool_allowlist::ToolAllowlist::parse("read").unwrap())
        .unwrap();
    tools.bind_agent_host(&host).unwrap();
    let executor = tools
        .executor("s", f.0.to_str().unwrap(), PermissionPreset::WorkspaceWrite)
        .await
        .unwrap();
    assert!(executor
        .registry()
        .definitions()
        .await
        .iter()
        .all(|d| d.name != "display"));
}

#[tokio::test]
async fn user_preview_does_not_authorize_a_blind_model_write() {
    let f = Fixture::new();
    let tools = factory();
    let preview = tools
        .read_display_file(
            "file-preview",
            f.0.to_str().unwrap(),
            PermissionPreset::WorkspaceWrite,
            &f.0.join("main.rs"),
        )
        .await
        .unwrap();
    assert!(matches!(preview, DisplayFile::Text { .. }));
    let executor = tools
        .executor(
            "file-preview",
            f.0.to_str().unwrap(),
            PermissionPreset::WorkspaceWrite,
        )
        .await
        .unwrap();
    let result = executor
        .execute(ToolRequest::new(
            "write",
            r#"{"path":"main.rs","content":"should not overwrite"}"#,
        ))
        .await;
    assert!(
        !result.is_ok(),
        "UI reading must not mark a model session as having read the file"
    );
    assert_eq!(
        std::fs::read_to_string(f.0.join("main.rs")).unwrap(),
        "fn main() {}\n"
    );
}

#[tokio::test]
async fn real_host_http_display_route_reads_a_file_and_preserves_rpc_envelope() {
    use std::process::Stdio;
    let f = Fixture::new();
    git_repository(&f);
    std::fs::write(f.0.join("main.rs"), "fn http_diff() {}\n").unwrap();
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = socket.local_addr().unwrap();
    drop(socket);
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_xharness-host"))
        .args([
            "--bind",
            &address.to_string(),
            "--workspace",
            f.0.to_str().unwrap(),
            "--state-dir",
            f.0.join("state").to_str().unwrap(),
            "--model",
            "file-display-test",
            "--base-url",
            "http://127.0.0.1:1/v1",
            "--api-key",
            "file-display-test-unused",
            "--context-window",
            "32768",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    async fn rpc(
        client: &reqwest::Client,
        address: std::net::SocketAddr,
        method: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        client.post(format!("http://{address}/api/{method}")).json(&json!({"type":"client-request","rpcId":format!("display-{method}"),"method":method,"payload":payload})).send().await.unwrap().json().await.unwrap()
    }
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            assert!(child.try_wait().unwrap().is_none(), "Host exited before the ready RPC");
            if let Ok(response) = client
                .post(format!("http://{address}/api/host.describe"))
                .json(&json!({"type":"client-request","rpcId":"ready","method":"host.describe","payload":{}}))
                .send()
                .await
            {
                if response.status().is_success() {
                    if let Ok(body) = response.json::<serde_json::Value>().await {
                        if body["type"] == "server-response" && body["result"]["ok"] == true {
                            break;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("Host did not publish a successful host.describe RPC within its readiness budget");
    let created = rpc(
        &client,
        address,
        "session.create",
        json!({"sessionId":"display-http","cwd":f.0}),
    )
    .await;
    assert_eq!(created["result"]["ok"], true, "{created}");
    let reply = rpc(
        &client,
        address,
        "display/read",
        json!({"sessionId":"display-http","path":"docs/report.md"}),
    )
    .await;
    assert_eq!(reply["type"], "server-response");
    assert_eq!(reply["rpcId"], "display-display/read");
    let file: DisplayFile = serde_json::from_value(reply["result"]["value"].clone()).unwrap();
    assert!(matches!(file, DisplayFile::Markdown { .. }));
    let reply = rpc(
        &client,
        address,
        "display/read",
        json!({"sessionId":"display-http","path":".","gitDiff":"working"}),
    )
    .await;
    assert_eq!(reply["result"]["ok"], true, "{reply}");
    let diff: DisplayFile = serde_json::from_value(reply["result"]["value"].clone()).unwrap();
    assert!(matches!(diff,DisplayFile::Diff{text,..} if text.contains("+fn http_diff()")));
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}

fn git(f: &Fixture, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(&f.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn git_repository(f: &Fixture) {
    git(f, &["init", "-q"]);
    git(f, &["config", "user.name", "Display Test"]);
    git(f, &["config", "user.email", "display@example.invalid"]);
    git(f, &["add", "main.rs"]);
    git(f, &["commit", "-qm", "baseline"]);
}
async fn preview_git(
    host: &BasicHost,
    path: &str,
    scope: xharness_api::display::GitDiffScope,
) -> Result<DisplayFile, xharness_api::RpcError> {
    host.read_display_file(
        DisplayRead {
            session_id: "s".into(),
            path: path.into(),
            relative_to: None,
            git_diff: Some(scope),
        },
        CancellationToken::new(),
    )
    .await
}
#[tokio::test]
async fn patch_files_are_diff_not_markdown_and_have_no_implicit_model_read() {
    let f = Fixture::new();
    let host = host(&f).await;
    let patch = "--- a/main.rs\n+++ b/main.rs\n@@ -1 +1 @@\n-old\n+new\n";
    for name in ["change.diff", "change.PATCH"] {
        std::fs::write(f.0.join(name), patch).unwrap();
        let result = host
            .read_display_file(
                DisplayRead {
                    session_id: "s".into(),
                    path: name.into(),
                    relative_to: None,
                    git_diff: None,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            matches!(result,DisplayFile::Diff{source:xharness_api::display::DisplayDiffSource::Patch,text,..} if text==patch)
        );
    }
}
#[tokio::test]
async fn git_scopes_are_real_readonly_and_do_not_include_untracked_or_run_external_diff() {
    use xharness_api::display::{DisplayDiffSource, GitDiffScope};
    let f = Fixture::new();
    git_repository(&f);
    std::fs::write(f.0.join("main.rs"), "fn staged() {}\n").unwrap();
    git(&f, &["add", "main.rs"]);
    std::fs::write(f.0.join("main.rs"), "fn working() {}\n").unwrap();
    std::fs::write(
        f.0.join("untracked.txt"),
        "must not be represented as tracked\n",
    )
    .unwrap();
    // All three diff escape hatches must be disabled by the production adapter.
    git(&f, &["config", "diff.external", "not-a-real-diff-program"]);
    git(
        &f,
        &["config", "core.fsmonitor", "not-a-real-fsmonitor-program"],
    );
    git(
        &f,
        &["config", "diff.bad.textconv", "not-a-real-textconv-program"],
    );
    std::fs::write(f.0.join(".gitattributes"), "main.rs diff=bad\n").unwrap();
    let index_before = std::fs::read(f.0.join(".git/index")).unwrap();
    let host = host(&f).await;
    for (scope, expected, not_expected) in [
        (GitDiffScope::Working, "-fn staged()", "-fn main()"),
        (GitDiffScope::Staged, "+fn staged()", "+fn working()"),
        (GitDiffScope::Head, "+fn working()", "+fn staged()"),
    ] {
        let file = preview_git(&host, ".", scope).await.unwrap();
        let DisplayFile::Diff { text, source, .. } = file else {
            panic!("not diff")
        };
        assert_eq!(source, DisplayDiffSource::from(scope));
        assert!(text.contains(expected), "{text}");
        assert!(!text.contains(not_expected));
        assert!(!text.contains("untracked.txt"));
    }
    assert_eq!(
        std::fs::read(f.0.join(".git/index")).unwrap(),
        index_before,
        "display must not update index"
    );
    assert_eq!(
        std::fs::read_to_string(f.0.join("main.rs")).unwrap(),
        "fn working() {}\n"
    );
    assert!(preview_git(&host, "../", GitDiffScope::Working)
        .await
        .is_err());
    let invalid = host
        .call_dynamic(
            RpcId::new("invalid-scope"),
            "display/read",
            json!({"sessionId":"s","path":".","gitDiff":"shell"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!invalid.is_ok());
    let invalid = host
        .call_dynamic(
            RpcId::new("invalid-base"),
            "display/read",
            json!({"sessionId":"s","path":".","gitDiff":"working","relativeTo":"main.rs"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!invalid.is_ok());
}
#[tokio::test]
async fn git_deleted_and_literal_paths_clean_unborn_binary_oversize_and_cancellation() {
    use xharness_api::display::GitDiffScope;
    let f = Fixture::new();
    git_repository(&f);
    let host = host(&f).await;
    let clean = preview_git(&host, ".", GitDiffScope::Working)
        .await
        .unwrap();
    assert!(matches!(clean,DisplayFile::Diff{text,..} if text.is_empty()));
    // Brackets are valid on Windows but would match star1.txt as a Git glob.
    std::fs::write(f.0.join("star[1].txt"), "old\n").unwrap();
    std::fs::write(f.0.join("star1.txt"), "old\n").unwrap();
    std::fs::write(f.0.join("image.bin"), [0, 1, 2]).unwrap();
    git(&f, &["add", "star[1].txt", "star1.txt", "image.bin"]);
    git(&f, &["commit", "-qm", "paths"]);
    std::fs::write(f.0.join("star[1].txt"), "literal\n").unwrap();
    std::fs::write(f.0.join("star1.txt"), "other\n").unwrap();
    std::fs::write(f.0.join("image.bin"), [0, 2, 3]).unwrap();
    let literal = preview_git(&host, "star[1].txt", GitDiffScope::Working)
        .await
        .unwrap();
    assert!(
        matches!(literal,DisplayFile::Diff{text,..} if text.contains("+literal")&&!text.contains("+other"))
    );
    let binary = preview_git(&host, "image.bin", GitDiffScope::Working)
        .await
        .unwrap();
    assert!(matches!(binary,DisplayFile::Diff{text,..} if text.contains("Binary files")));
    std::fs::remove_file(f.0.join("main.rs")).unwrap();
    let deleted = preview_git(&host, "main.rs", GitDiffScope::Working)
        .await
        .unwrap();
    assert!(matches!(deleted,DisplayFile::Diff{text,..} if text.contains("+++ /dev/null")));
    std::fs::write(
        f.0.join("star[1].txt"),
        "x".repeat(xharness_api::display::MAX_TEXT_BYTES + 1024),
    )
    .unwrap();
    let oversized = preview_git(&host, "star[1].txt", GitDiffScope::Working)
        .await
        .unwrap_err();
    assert!(
        oversized.message.contains("512 KiB"),
        "{}",
        oversized.message
    );
    let token = CancellationToken::new();
    token.cancel();
    let cancelled = host
        .read_display_file(
            DisplayRead {
                session_id: "s".into(),
                path: ".".into(),
                relative_to: None,
                git_diff: Some(GitDiffScope::Working),
            },
            token,
        )
        .await;
    assert!(cancelled.is_err());
    let fresh = Fixture::new();
    git(&fresh, &["init", "-q"]);
    git(&fresh, &["add", "main.rs"]);
    let fresh_host = host_for_fixture(&fresh).await;
    assert!(
        matches!(preview_git(&fresh_host,".",GitDiffScope::Staged).await.unwrap(),DisplayFile::Diff{text,..} if text.contains("new file mode"))
    );
    assert!(preview_git(&fresh_host, ".", GitDiffScope::Head)
        .await
        .is_err());
}
async fn host_for_fixture(f: &Fixture) -> Arc<BasicHost> {
    host(f).await
}

#[tokio::test]
async fn same_display_tool_emits_git_scope_not_patch_text() {
    use futures::StreamExt;
    let f = Fixture::new();
    git_repository(&f);
    std::fs::write(f.0.join("main.rs"), "fn model_display() {}\n").unwrap();
    let host = host(&f).await;
    let mut events = host.host_events();
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(DisplayTool::for_host(&host, "s"))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);
    let result = executor
        .execute(ToolRequest::new(
            "display",
            r#"{"path":".","gitDiff":"working"}"#,
        ))
        .await;
    assert!(result.is_ok(), "{result:?}");
    let text = result.output.unwrap().content;
    assert!(text.contains("requested"));
    assert!(!text.contains("model_display"));
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
        .await
        .unwrap()
        .unwrap();
    let payload = serde_json::to_value(event).unwrap();
    assert!(payload.to_string().contains("\"gitDiff\":\"working\""));
    assert!(!payload.to_string().contains("model_display"));
    assert!(!executor
        .execute(ToolRequest::new(
            "display",
            r#"{"path":".","gitDiff":"shell"}"#
        ))
        .await
        .is_ok());
}
