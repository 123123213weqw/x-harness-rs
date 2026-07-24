//! Read-only path compatibility and pagination contract; no process/network needed.
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use xharness_coding_tools::CodingToolBundle;
use xharness_jobs::JobRegistry;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_tools::{ToolExecutor, ToolRequest};
use xharness_web::WebRuntime;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    base: PathBuf,
    work: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "xh-read-contract-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        Self {
            base: std::fs::canonicalize(base).unwrap(),
            work: std::fs::canonicalize(work).unwrap(),
        }
    }
    async fn executor(&self) -> ToolExecutor {
        let platform = Arc::new(NativePlatform::new(PlatformConfig::new(&self.work)).unwrap());
        let bundle = CodingToolBundle::new(
            platform,
            Arc::new(JobRegistry::default()),
            Arc::new(WebRuntime::default()),
            "read-tests",
            "owner",
        );
        ToolExecutor::new(bundle.registry().await.unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}
async fn page(executor: &ToolExecutor, args: Value) -> Value {
    let result = executor
        .execute(ToolRequest::new("read", args.to_string()))
        .await;
    assert!(result.is_ok(), "{result:?}");
    serde_json::from_str(&result.output.unwrap().content).unwrap()
}

#[tokio::test]
async fn authorized_absolute_read_matches_relative_and_keeps_mutation_contract() {
    let f = Fixture::new();
    std::fs::write(f.work.join("text.txt"), "汉字\nsecond\n").unwrap();
    let platform = NativePlatform::new(PlatformConfig::new(&f.work)).unwrap();
    assert!(platform.resolve_file(f.work.join("text.txt")).is_err());
    let e = f.executor().await;
    let relative = page(&e, json!({"path":"text.txt","line_limit":1})).await;
    let absolute = page(&e, json!({"path":f.work.join("text.txt"),"line_limit":1})).await;
    assert_eq!(relative, absolute);
}

#[cfg(windows)]
#[tokio::test]
async fn ordinary_windows_absolute_reads_keep_workspace_and_attachment_boundaries() {
    use xharness_sandbox::SandboxMode;
    fn ordinary(path: &std::path::Path) -> PathBuf {
        let value = path.to_str().unwrap();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{rest}"))
        } else {
            PathBuf::from(value.strip_prefix(r"\\?\").unwrap())
        }
    }
    let f = Fixture::new();
    let attachment = f.base.join("attachment");
    std::fs::create_dir(&attachment).unwrap();
    std::fs::write(f.work.join("text.txt"), "workspace\n").unwrap();
    std::fs::write(attachment.join("note.txt"), "attachment\n").unwrap();
    std::fs::write(f.base.join("private.txt"), "outside\n").unwrap();
    let sibling = f.base.join("work-other");
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("text.txt"), "sibling\n").unwrap();
    let ordinary_work = ordinary(&f.work);
    for mode in [SandboxMode::WorkspaceWrite, SandboxMode::ReadOnly] {
        let platform = Arc::new(
            NativePlatform::new(
                PlatformConfig::new(&ordinary_work)
                    .sandbox_mode(mode)
                    .read_only_root(&attachment),
            )
            .unwrap(),
        );
        assert!(
            platform
                .resolve_file(ordinary_work.join("text.txt"))
                .is_err(),
            "mutations must stay relative"
        );
        let bundle = CodingToolBundle::new(
            platform,
            Arc::new(JobRegistry::default()),
            Arc::new(WebRuntime::default()),
            "windows-read",
            "owner",
        );
        let e = ToolExecutor::new(bundle.registry().await.unwrap());
        let relative = page(&e, json!({"path":"text.txt"})).await;
        for path in [
            f.work.join("text.txt"),
            ordinary_work.join("text.txt"),
            ordinary_work
                .join("text.txt")
                .to_string_lossy()
                .replace('\\', "/")
                .into(),
        ] {
            assert_eq!(page(&e, json!({"path":path})).await, relative);
        }
        let expected = page(&e, json!({"path":attachment.join("note.txt")})).await;
        assert_eq!(
            page(&e, json!({"path":ordinary(&attachment).join("note.txt")})).await,
            expected
        );
        for path in [
            ordinary(&f.base).join("private.txt"),
            ordinary(&sibling).join("text.txt"),
            ordinary_work.join("..\\private.txt"),
        ] {
            let result = e
                .execute(ToolRequest::new("read", json!({"path":path}).to_string()))
                .await;
            assert!(
                !result.is_ok(),
                "outside workspace path accepted: {result:?}"
            );
        }
    }
}

#[tokio::test]
async fn outside_component_prefix_and_parent_traversal_are_denied() {
    let f = Fixture::new();
    std::fs::write(f.base.join("private.txt"), "private").unwrap();
    let sibling = f.base.join("work-other");
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("private.txt"), "private").unwrap();
    let e = f.executor().await;
    for path in [
        f.base.join("private.txt"),
        sibling.join("private.txt"),
        f.work.join("../private.txt"),
        PathBuf::from("../private.txt"),
    ] {
        let r = e
            .execute(ToolRequest::new("read", json!({"path":path}).to_string()))
            .await;
        assert!(!r.is_ok(), "{r:?}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn absolute_symlink_file_and_directory_cannot_escape() {
    let f = Fixture::new();
    let outside = f.base.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), f.work.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(&outside, f.work.join("link-dir")).unwrap();
    let e = f.executor().await;
    for path in [f.work.join("link.txt"), f.work.join("link-dir/secret.txt")] {
        let r = e
            .execute(ToolRequest::new("read", json!({"path":path}).to_string()))
            .await;
        assert!(!r.is_ok(), "{r:?}");
    }
}

#[tokio::test]
async fn invalid_numeric_arguments_never_silently_default() {
    let f = Fixture::new();
    std::fs::write(f.work.join("text.txt"), "abcdef\n").unwrap();
    let e = f.executor().await;
    for (name, value) in [
        ("offset", json!(-1)),
        ("offset", json!(1.5)),
        ("offset", json!("1")),
        ("offset", json!(null)),
        ("start_line", json!(0)),
        ("start_line", json!(-1)),
        ("limit", json!(-1)),
        ("limit", json!(3)),
        ("limit", json!(65537)),
        ("line_limit", json!(-1)),
        ("line_limit", json!(0)),
        ("line_limit", json!(1001)),
        (
            "offset",
            serde_json::from_str::<Value>("18446744073709551616").unwrap(),
        ),
    ] {
        let mut args = json!({"path":"text.txt"});
        args[name] = value;
        let r = e.execute(ToolRequest::new("read", args.to_string())).await;
        assert!(!r.is_ok(), "invalid {name} accepted: {r:?}");
    }
}

#[tokio::test]
async fn bytes_and_lines_keep_distinct_legacy_semantics() {
    let f = Fixture::new();
    std::fs::write(f.work.join("text.txt"), "aaaa\nbbbb\ncccc\n").unwrap();
    let e = f.executor().await;
    let bytes = page(&e, json!({"path":"text.txt","start_line":2,"limit":4})).await;
    assert_eq!(bytes["content"], "bbbb");
    assert!(bytes["next_cursor"].is_string());
    let lines = page(&e, json!({"path":"text.txt","start_line":2,"line_limit":2})).await;
    assert_eq!(lines["content"], "bbbb\ncccc\n");
    assert!(lines["next_cursor"].is_null());
}

#[tokio::test]
async fn utf8_small_pages_reconstruct_every_byte_with_forward_progress() {
    let f = Fixture::new();
    let original = "汉字🙂\n你好\nlast";
    std::fs::write(f.work.join("text.txt"), original).unwrap();
    let e = f.executor().await;
    let mut args = json!({"path":"text.txt","limit":4});
    let mut text = String::new();
    let mut previous = 0;
    for _ in 0..original.len() + 1 {
        let p = page(&e, args).await;
        text.push_str(p["content"].as_str().unwrap());
        if p["next_cursor"].is_null() {
            break;
        }
        let start = p["page_start_offset"].as_u64().unwrap();
        let n = p["captured_bytes"].as_u64().unwrap();
        assert!(start + n > previous);
        previous = start + n;
        args = json!({"path":"text.txt","cursor":p["next_cursor"]});
    }
    assert_eq!(text, original);
}

#[tokio::test]
async fn long_line_pages_reconstruct_without_truncation_loss() {
    let f = Fixture::new();
    let original = format!("{}\ntail\n", "x".repeat(40000));
    std::fs::write(f.work.join("text.txt"), &original).unwrap();
    let e = f.executor().await;
    let mut args = json!({"path":"text.txt"});
    let mut text = String::new();
    for _ in 0..10 {
        let p = page(&e, args).await;
        text.push_str(p["content"].as_str().unwrap());
        if p["next_cursor"].is_null() {
            break;
        }
        args = json!({"path":"text.txt","cursor":p["next_cursor"]});
    }
    assert_eq!(text, original);
}

#[tokio::test]
async fn empty_missing_and_past_eof_stay_distinguishable() {
    let f = Fixture::new();
    std::fs::write(f.work.join("empty.txt"), "").unwrap();
    std::fs::write(f.work.join("text.txt"), "one\n").unwrap();
    let e = f.executor().await;
    let missing = page(&e, json!({"path":"missing.txt"})).await;
    assert_eq!(missing["absent"], true);
    let empty = page(&e, json!({"path":"empty.txt"})).await;
    assert_eq!(empty["total_bytes"], 0);
    assert_eq!(empty["content"], "");
    assert!(empty["next_cursor"].is_null());
    let eof = page(&e, json!({"path":"text.txt","start_line":99})).await;
    assert_eq!(eof["content"], "");
    assert_eq!(eof["page_start_offset"], 4);
    assert_eq!(eof["total_bytes"], 4);
}

#[tokio::test]
async fn conflicting_selectors_and_stale_cursors_fail_explicitly() {
    let f = Fixture::new();
    std::fs::write(f.work.join("text.txt"), "one\ntwo\n").unwrap();
    let e = f.executor().await;
    let p = page(&e, json!({"path":"text.txt","line_limit":1})).await;
    for args in [
        json!({"path":"text.txt","offset":0,"start_line":1}),
        json!({"path":"text.txt","cursor":p["next_cursor"],"line_limit":1}),
        json!({"path":"text.txt","cursor":p["next_cursor"],"offset":0}),
    ] {
        let r = e.execute(ToolRequest::new("read", args.to_string())).await;
        assert!(!r.is_ok(), "{r:?}");
    }
    std::fs::write(f.work.join("text.txt"), "changed\nsecond\n").unwrap();
    let r = e
        .execute(ToolRequest::new(
            "read",
            json!({"path":"text.txt","cursor":p["next_cursor"]}).to_string(),
        ))
        .await;
    assert!(!r.is_ok(), "{r:?}");
    assert_eq!(
        page(&e, json!({"path":"text.txt","line_limit":1})).await["content"],
        "changed\n"
    );
}

#[tokio::test]
async fn cancelled_read_does_not_become_a_success() {
    let f = Fixture::new();
    std::fs::write(f.work.join("text.txt"), "contents").unwrap();
    let e = f.executor().await;
    let request = ToolRequest::new("read", r#"{"path":"text.txt"}"#);
    request.cancellation.cancel();
    let r = e.execute(request).await;
    assert!(!r.is_ok(), "{r:?}");
}

#[tokio::test]
async fn field_descriptions_expose_units_and_ranges() {
    let f = Fixture::new();
    let bundle = CodingToolBundle::new(
        Arc::new(NativePlatform::new(PlatformConfig::new(&f.work)).unwrap()),
        Arc::new(JobRegistry::default()),
        Arc::new(WebRuntime::default()),
        "schema",
        "owner",
    );
    let registry = bundle.registry().await.unwrap();
    let read = registry.get("read").await.unwrap();
    let p = &read.definition.parameters["properties"];
    for field in [
        "path",
        "offset",
        "start_line",
        "cursor",
        "limit",
        "line_limit",
    ] {
        assert!(p[field]["description"].as_str().unwrap().len() > 10);
    }
    assert_eq!(p["limit"]["maximum"], 65536);
    assert_eq!(p["line_limit"]["maximum"], 1000);
    assert_eq!(p["start_line"]["minimum"], 1);
    assert_eq!(p["offset"]["minimum"], 0);
}
