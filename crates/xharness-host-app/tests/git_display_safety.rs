//! Independent adapter regressions: native read-only execution and exact scopes.
#[path = "../src/git_display.rs"]
mod git_display;

use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;
use xharness_api::display::{DisplayFile, GitDiffScope};
use xharness_platform::NativePlatform;

struct Repository(PathBuf);
impl Repository {
    fn new() -> Self {
        // Windows wall-clock resolution is not a uniqueness guarantee when
        // tests create repositories concurrently. Own each directory exclusively.
        static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = loop {
            let sequence = NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "xh-git-display-中文-{}-{}-{sequence}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            match std::fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot exclusively create Git fixture {root:?}: {error}"),
            }
        };
        let fixture = Self(std::fs::canonicalize(root).unwrap());
        fixture.git(&["init", "-q"]);
        fixture.git(&["config", "user.name", "Git Display Test"]);
        fixture.git(&["config", "user.email", "git-display@example.invalid"]);
        fixture
    }
    fn git(&self, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn write(&self, name: &str, content: &str) {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    fn commit(&self) {
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "fixture"]);
    }
}
impl Drop for Repository {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn preview_result(
    workspace: &std::path::Path,
    path: &std::path::Path,
    scope: GitDiffScope,
) -> Result<DisplayFile, String> {
    let (config, layout) = git_display::platform_config(workspace)?;
    let platform = NativePlatform::new(config).map_err(|error| error.to_string())?;
    let permit = Arc::new(tokio::sync::Semaphore::new(1))
        .acquire_owned()
        .await
        .unwrap();
    git_display::read(
        &platform,
        &layout,
        path,
        scope,
        CancellationToken::new(),
        permit,
    )
    .await
}

async fn preview(workspace: &std::path::Path, path: &str, scope: GitDiffScope) -> String {
    let result = preview_result(workspace, &workspace.join(path), scope)
        .await
        .unwrap();
    let DisplayFile::Diff { text, .. } = result else {
        panic!("not a Git diff")
    };
    text
}

#[tokio::test]
async fn git_preview_scopes_a_session_subdirectory_without_exposing_its_siblings() {
    let fixture = Repository::new();
    fixture.write("outer.txt", "outer baseline\n");
    fixture.write("sub/inner.txt", "inner baseline\n");
    fixture.commit();
    fixture.write("outer.txt", "outside session must not appear\n");
    fixture.write("sub/inner.txt", "inside session staged\n");
    fixture.git(&["add", "sub/inner.txt"]);
    fixture.write("sub/inner.txt", "inside session working\n");
    let root = std::fs::canonicalize(fixture.0.join("sub")).unwrap();
    let index = std::fs::read(fixture.0.join(".git/index")).unwrap();
    for (scope, expected) in [
        (GitDiffScope::Working, "+inside session working"),
        (GitDiffScope::Staged, "+inside session staged"),
        (GitDiffScope::Head, "+inside session working"),
    ] {
        let text = preview(&root, ".", scope).await;
        assert!(text.contains(expected), "{text}");
        assert!(!text.contains("outer.txt"), "session scope widened: {text}");
        assert!(
            !text.contains("outside session"),
            "session scope widened: {text}"
        );
    }
    assert_eq!(index, std::fs::read(fixture.0.join(".git/index")).unwrap());
}

#[tokio::test]
async fn git_preview_treats_windows_legal_glob_characters_and_unicode_literally() {
    let fixture = Repository::new();
    // Brackets are both legal on Windows and meaningful in Git wildcard syntax.
    // '*' and ':' would never reach Git on a native Windows filesystem.
    fixture.write("star[1]-中文.txt", "baseline\n");
    fixture.write("star1-中文.txt", "baseline\n");
    fixture.commit();
    fixture.write("star[1]-中文.txt", "literal file\n");
    fixture.write("star1-中文.txt", "wildcard sibling must not appear\n");
    let text = preview(&fixture.0, "star[1]-中文.txt", GitDiffScope::Working).await;
    assert!(text.contains("+literal file"), "{text}");
    assert!(
        !text.contains("wildcard sibling"),
        "literal scope widened: {text}"
    );
}

#[tokio::test]
async fn git_preview_reads_a_linked_worktree_without_modifying_either_index() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    // Keep the worktree inside the fixture solely so teardown is self-contained.
    let worktree = fixture.0.join("linked-worktree");
    fixture.git(&[
        "worktree",
        "add",
        "-q",
        "--detach",
        "linked-worktree",
        "HEAD",
    ]);
    let root = std::fs::canonicalize(worktree).unwrap();
    std::fs::write(root.join("main.txt"), "linked worktree change\n").unwrap();
    let main_index_path = fixture.0.join(".git/index");
    let worktree_index_path = fixture.0.join(".git/worktrees/linked-worktree/index");
    let main_index = std::fs::read(&main_index_path).unwrap();
    let worktree_index = std::fs::read(&worktree_index_path).unwrap();
    let text = preview(&root, ".", GitDiffScope::Working).await;
    assert!(text.contains("+linked worktree change"), "{text}");
    assert_eq!(main_index, std::fs::read(main_index_path).unwrap());
    assert_eq!(worktree_index, std::fs::read(worktree_index_path).unwrap());
}

#[tokio::test]
async fn git_preview_rejects_an_outside_absolute_path_or_parent_traversal() {
    let fixture = Repository::new();
    fixture.write("tracked.txt", "baseline\n");
    fixture.commit();
    for outside in [
        fixture.0.with_extension("outside"),
        fixture.0.join("../outside"),
    ] {
        let result = preview_result(&fixture.0, &outside, GitDiffScope::Working).await;
        assert!(result.is_err(), "outside scope was accepted: {outside:?}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn git_preview_refuses_scope_symlinks_and_symlink_git_markers() {
    let fixture = Repository::new();
    let outside = Repository::new();
    fixture.write("tracked.txt", "baseline\n");
    fixture.commit();
    outside.write("private.txt", "outside content must not be read\n");
    outside.commit();
    std::os::unix::fs::symlink(&outside.0, fixture.0.join("escape")).unwrap();
    let result = preview_result(
        &fixture.0,
        &fixture.0.join("escape/private.txt"),
        GitDiffScope::Working,
    )
    .await;
    assert!(result.unwrap_err().contains("symlink"));
    std::fs::create_dir(fixture.0.join("fake-worktree")).unwrap();
    std::os::unix::fs::symlink(fixture.0.join(".git"), fixture.0.join("fake-worktree/.git"))
        .unwrap();
    let result = preview_result(
        &fixture.0.join("fake-worktree"),
        &fixture.0.join("fake-worktree"),
        GitDiffScope::Working,
    )
    .await;
    assert!(result.unwrap_err().contains(".git marker"));
}

#[cfg(windows)]
#[tokio::test]
async fn git_preview_refuses_scope_junctions_and_junction_git_markers() {
    // Junctions do not require the symbolic-link privilege or Developer Mode.
    let fixture = Repository::new();
    let outside = Repository::new();
    fixture.write("tracked.txt", "baseline\n");
    fixture.commit();
    outside.write("private.txt", "outside content must not be read\n");
    outside.commit();
    fn junction(target: &std::path::Path, link: &std::path::Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link.to_str().unwrap().trim_start_matches(r"\\?\"))
            .arg(target.to_str().unwrap().trim_start_matches(r"\\?\"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction setup: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    junction(&outside.0, &fixture.0.join("escape"));
    let result = preview_result(
        &fixture.0,
        &fixture.0.join("escape/private.txt"),
        GitDiffScope::Working,
    )
    .await;
    assert!(result.unwrap_err().contains("reparse"));
    std::fs::create_dir(fixture.0.join("fake-worktree")).unwrap();
    junction(
        &fixture.0.join(".git"),
        &fixture.0.join("fake-worktree/.git"),
    );
    let result = preview_result(
        &fixture.0.join("fake-worktree"),
        &fixture.0.join("fake-worktree"),
        GitDiffScope::Working,
    )
    .await;
    assert!(result.unwrap_err().contains(".git marker"));
    // Remove junctions explicitly, never recursively follow their targets.
    std::fs::remove_dir(fixture.0.join("fake-worktree/.git")).unwrap();
    std::fs::remove_dir(fixture.0.join("escape")).unwrap();
}

#[tokio::test]
async fn git_preview_missing_promisor_blob_does_not_lazily_fetch_from_a_working_remote() {
    let source = Repository::new();
    source.write("main.txt", "remote baseline\n");
    source.commit();
    fn git_with_input(root: &std::path::Path, args: &[&str], input: &[u8]) -> std::process::Output {
        use std::io::Write;
        let mut child = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        {
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(input).unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    fn source_git_text(source: &Repository, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&source.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    let target_oid = source_git_text(&source, &["rev-parse", "HEAD:main.txt"])
        .trim()
        .to_owned();
    let head_oid = source_git_text(&source, &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    // Build a genuine commit/tree-only promisor pack locally. A clone's remote
    // may ignore blob:none; missingness must not depend on server negotiation.
    let filtered_oids = source_git_text(
        &source,
        &[
            "rev-list",
            "--objects",
            "--filter=blob:none",
            "--no-object-names",
            "HEAD",
        ],
    );
    let expected_objects = filtered_oids
        .lines()
        .map(str::to_owned)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        expected_objects.len(),
        2,
        "fixture must contain exactly its commit and root tree"
    );
    assert!(expected_objects.contains(&head_oid));
    assert!(
        !expected_objects.contains(&target_oid),
        "filtered object list contains target blob"
    );
    let pack = git_with_input(
        &source.0,
        &["pack-objects", "--stdout"],
        filtered_oids.as_bytes(),
    )
    .stdout;
    let control_fixture = Repository::new();
    let partial_fixture = Repository::new();
    // Both repositories use the same real source as a functional lazy-fetch
    // fallback, but neither local object store receives the promised blob.
    let source_url = format!(
        "{}{}",
        if cfg!(windows) { "file:///" } else { "file://" },
        source
            .0
            .to_str()
            .unwrap()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
    );
    for destination in [&control_fixture, &partial_fixture] {
        git_with_input(
            &destination.0,
            &["index-pack", "--stdin", "--promisor"],
            &pack,
        );
        assert!(
            std::fs::read_dir(destination.0.join(".git/objects/pack"))
                .unwrap()
                .any(|entry| entry.unwrap().path().extension()
                    == Some(std::ffi::OsStr::new("promisor"))),
            "fixture pack was not marked promisor"
        );
        destination.git(&["config", "core.repositoryformatversion", "1"]);
        destination.git(&["config", "extensions.partialClone", "origin"]);
        destination.git(&["config", "remote.origin.url", &source_url]);
        destination.git(&[
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        ]);
        destination.git(&["config", "remote.origin.promisor", "true"]);
        destination.git(&["config", "remote.origin.partialclonefilter", "blob:none"]);
        destination.git(&["update-ref", "refs/heads/fixture", &head_oid]);
        destination.git(&["symbolic-ref", "HEAD", "refs/heads/fixture"]);
    }
    fn local_object_ids(root: &std::path::Path) -> std::collections::BTreeSet<String> {
        // Enumerate actual stores, not an object lookup that could resolve or
        // lazily fetch a promised object.
        let output = std::process::Command::new("git")
            .args([
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
            ])
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ALLOW_PROTOCOL", "")
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "local object enumeration: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    fn assert_missing_promised_blob(root: &std::path::Path, target_oid: &str) {
        assert!(
            !local_object_ids(root).contains(target_oid),
            "fixture physically contains promised blob {target_oid} at {root:?}"
        );
    }
    let control = &control_fixture.0;
    let initial_partial_root = &partial_fixture.0;
    assert_eq!(
        local_object_ids(control),
        expected_objects,
        "control pack differs from filtered object list"
    );
    assert_eq!(
        local_object_ids(initial_partial_root),
        expected_objects,
        "production fixture pack differs from filtered object list"
    );
    assert_missing_promised_blob(control, &target_oid);
    assert_missing_promised_blob(initial_partial_root, &target_oid);
    let output = std::process::Command::new("git")
        .args(["show", "HEAD:main.txt"])
        .current_dir(control)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "control lazy fetch: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "remote baseline\n"
    );
    assert!(
        local_object_ids(control).contains(&target_oid),
        "positive control did not physically fetch the promised blob"
    );
    let root = partial_fixture.0.clone();
    let output = std::process::Command::new("git")
        .args(["read-tree", "HEAD"])
        // read-tree itself may prefetch index blobs, so setup must disable it.
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_ALLOW_PROTOCOL", "")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "partial index setup: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(root.join("main.txt"), "local working content\n").unwrap();
    assert_missing_promised_blob(&root, &target_oid);
    // An explicit repository protocol allowance must not override the empty
    // environment whitelist. Exercise that fallback independently of no-lazy.
    let output = std::process::Command::new("git")
        .args(["-c", "protocol.file.allow=always", "show", "HEAD:main.txt"])
        .env_remove("GIT_NO_LAZY_FETCH")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .env("GIT_ALLOW_PROTOCOL", "")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "empty transport whitelist was overridden"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("not allowed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let objects_before = local_object_ids(&root);
    let index_before = std::fs::read(root.join(".git/index")).unwrap();
    fn pack_files(root: &std::path::Path) -> Vec<std::ffi::OsString> {
        let mut names = std::fs::read_dir(root.join(".git/objects/pack"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        names.sort();
        names
    }
    let packs_before = pack_files(&root);
    let result = preview_result(&root, &root.join("main.txt"), GitDiffScope::Working).await;
    let error = result.unwrap_err();
    assert!(
        !error.contains("Read-only file system"),
        "sandbox write denial alone is not an offline-fetch guard: {error}"
    );
    assert!(
        error.contains("not allowed")
            || error.contains("unable to read")
            || error.contains("bad object")
            || error.contains("could not fetch"),
        "missing object must fail without fetching: {error}"
    );
    assert_eq!(
        index_before,
        std::fs::read(root.join(".git/index")).unwrap()
    );
    assert_eq!(
        packs_before,
        pack_files(&root),
        "preview fetched promised objects"
    );
    assert_missing_promised_blob(&root, &target_oid);
    assert_eq!(
        objects_before,
        local_object_ids(&root),
        "preview changed physical objects"
    );
}

#[test]
fn git_metadata_references_fail_closed_for_forgery_invalid_utf8_and_oversize() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    fixture.git(&["worktree", "add", "-q", "--detach", "first", "HEAD"]);
    fixture.git(&["worktree", "add", "-q", "--detach", "second", "HEAD"]);
    let first = fixture.0.join("first");
    let marker = first.join(".git");
    let original = std::fs::read(&marker).unwrap();
    assert!(git_display::platform_config(&first).is_ok());
    // Another real metadata directory cannot be reused: its backreference is
    // to second/.git, not first/.git.
    std::fs::write(
        &marker,
        std::fs::read(fixture.0.join("second/.git")).unwrap(),
    )
    .unwrap();
    let error = git_display::platform_config(&first).unwrap_err();
    assert!(error.contains("backreference"), "{error}");
    for bytes in [
        vec![0xff],
        vec![b'a'; 4097],
        b"gitdir: path\nextra\n".to_vec(),
    ] {
        std::fs::write(&marker, bytes).unwrap();
        assert!(git_display::platform_config(&first).is_err());
    }
    std::fs::write(&marker, original).unwrap();
    let common = fixture.0.join(".git/worktrees/first/commondir");
    let original = std::fs::read(&common).unwrap();
    for bytes in [vec![0xff], vec![b'a'; 4097], b"../..\nextra\n".to_vec()] {
        std::fs::write(&common, bytes).unwrap();
        assert!(git_display::platform_config(&first).is_err());
    }
    std::fs::write(common, original).unwrap();
    assert!(git_display::platform_config(&first).is_ok());
    // Even a plausible Git directory with a forged matching gitdir file is
    // not an arbitrary parent read grant outside the standard linked layout.
    let outside = Repository::new();
    std::fs::write(outside.0.join(".git/gitdir"), marker.to_str().unwrap()).unwrap();
    std::fs::write(
        &marker,
        format!("gitdir: {}\n", outside.0.join(".git").to_str().unwrap()),
    )
    .unwrap();
    assert!(git_display::platform_config(&first).is_err());
}

#[test]
fn git_metadata_read_roots_do_not_grant_the_parent_worktree_or_network() {
    let fixture = Repository::new();
    fixture.write("sub/main.txt", "baseline\n");
    fixture.commit();
    let workspace = std::fs::canonicalize(fixture.0.join("sub")).unwrap();
    let (config, _) = git_display::platform_config(&workspace).unwrap();
    assert_eq!(
        config.access_value(),
        xharness_platform::PlatformAccess::ReadOnly
    );
    assert_eq!(
        config.network_value(),
        xharness_sandbox::NetworkAccess::Deny
    );
    let platform = NativePlatform::new(config).unwrap();
    let policy = platform.sandbox().unwrap().policy();
    assert_eq!(policy.workspace_root(), workspace);
    assert_eq!(policy.mode(), xharness_sandbox::SandboxMode::ReadOnly);
    assert_eq!(policy.network(), xharness_sandbox::NetworkAccess::Deny);
    assert_eq!(
        policy.allowed_cwd_roots(),
        &[std::fs::canonicalize(fixture.0.join(".git")).unwrap()]
    );
    assert!(!policy.allowed_cwd_roots().contains(&fixture.0));
}

#[tokio::test]
async fn git_preview_disables_clean_filters_that_a_real_git_diff_executes() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    fixture.write(".gitattributes", "main.txt filter=canary\n");
    fixture.git(&[
        "config",
        "filter.canary.clean",
        "echo CLEAN_FILTER_EXECUTED",
    ]);
    fixture.git(&["config", "filter.canary.required", "true"]);
    fixture.write("main.txt", "unfiltered working content\n");
    let output = std::process::Command::new("git")
        .args(["diff", "--no-ext-diff", "--no-textconv", "--", "main.txt"])
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("+CLEAN_FILTER_EXECUTED"),
        "positive control did not execute its clean filter"
    );
    let text = preview(&fixture.0, "main.txt", GitDiffScope::Working).await;
    assert!(text.contains("+unfiltered working content"), "{text}");
    assert!(
        !text.contains("CLEAN_FILTER_EXECUTED"),
        "external clean filter ran: {text}"
    );
}

#[tokio::test]
async fn git_preview_disables_required_process_filters_before_the_diff_phase() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    fixture.write(".gitattributes", "main.txt filter=canary\n");
    fixture.git(&[
        "config",
        "filter.canary.process",
        "not-a-real-process-filter",
    ]);
    fixture.git(&["config", "filter.canary.required", "true"]);
    fixture.write("main.txt", "working without process filter\n");
    let output = std::process::Command::new("git")
        .args(["diff", "--no-ext-diff", "--no-textconv", "--", "main.txt"])
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "positive control did not try its required process filter"
    );
    let text = preview(&fixture.0, "main.txt", GitDiffScope::Working).await;
    assert!(text.contains("+working without process filter"), "{text}");
}

#[cfg(unix)]
#[tokio::test]
async fn git_preview_never_starts_a_process_filter_that_would_stop_git() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    fixture.write(".gitattributes", "main.txt filter=canary\n");
    // This canary would stop its own Git parent if executed, even with every
    // filesystem read-only; success proves more than suppressing filter errors.
    fixture.git(&[
        "config",
        "filter.canary.process",
        "kill -STOP $PPID; exit 42",
    ]);
    fixture.git(&["config", "filter.canary.required", "true"]);
    fixture.write("main.txt", "process filter never started\n");
    let started = std::time::Instant::now();
    let text = preview(&fixture.0, "main.txt", GitDiffScope::Working).await;
    assert!(text.contains("+process filter never started"), "{text}");
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
}

#[tokio::test]
async fn git_preview_rejects_unrepresentable_filter_driver_keys() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    fixture.git(&[
        "config",
        "filter.driver=ambiguous.clean",
        "echo MUST_NOT_RUN",
    ]);
    fixture.write("main.txt", "working\n");
    let result = preview_result(
        &fixture.0,
        &fixture.0.join("main.txt"),
        GitDiffScope::Working,
    )
    .await;
    assert!(result.unwrap_err().contains("unsupported filter keys"));
}

#[tokio::test]
async fn git_filter_subsection_quotes_and_spaces_remain_single_config_arguments() {
    let fixture = Repository::new();
    fixture.write("main.txt", "baseline\n");
    fixture.commit();
    fixture.write(".gitattributes", "main.txt filter=quote'driver\n");
    fixture.git(&[
        "config",
        "filter.quote'driver.clean",
        "echo QUOTED_FILTER_EXECUTED",
    ]);
    fixture.git(&["config", "filter.quote'driver.required", "true"]);
    fixture.git(&[
        "config",
        "filter.spaced driver.process",
        "not-a-real-process-filter",
    ]);
    fixture.write("main.txt", "literal working content\n");
    let output = std::process::Command::new("git")
        .args(["diff", "--no-ext-diff", "--no-textconv", "--", "main.txt"])
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("+QUOTED_FILTER_EXECUTED"));
    let text = preview(&fixture.0, "main.txt", GitDiffScope::Working).await;
    assert!(text.contains("+literal working content"), "{text}");
    assert!(!text.contains("QUOTED_FILTER_EXECUTED"), "{text}");
}

#[test]
fn git_fixture_parallel_allocations_are_unique_and_cleanup_isolated() {
    const COUNT: usize = 16;
    let barrier = Arc::new(std::sync::Barrier::new(COUNT));
    let workers = (0..COUNT)
        .map(|index| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let fixture = Repository::new();
                fixture.write("owner.txt", &format!("fixture {index}"));
                (index, fixture)
            })
        })
        .collect::<Vec<_>>();
    let mut fixtures = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    let roots = fixtures
        .iter()
        .map(|(_, fixture)| fixture.0.clone())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(roots.len(), COUNT);
    for (index, fixture) in &fixtures {
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("owner.txt")).unwrap(),
            format!("fixture {index}")
        );
    }
    let (_, removed) = fixtures.pop().unwrap();
    let removed_path = removed.0.clone();
    drop(removed);
    assert!(!removed_path.exists());
    for (index, fixture) in &fixtures {
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("owner.txt")).unwrap(),
            format!("fixture {index}"),
            "cleanup removed another fixture"
        );
    }
}
