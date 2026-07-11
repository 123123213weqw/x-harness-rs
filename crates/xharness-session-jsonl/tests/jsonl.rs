use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use xharness_session::{
    EventData, Message, Revision, SessionCatalogEntry, SessionEvent, SessionHeader,
    StartupCandidate, Store, StoreError,
};
use xharness_session_jsonl::{JsonlSessionStore, RequestAuditMode};

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "xharness-session-jsonl-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn session_file(&self, id: &str) -> PathBuf {
        self.0.join(format!("{id}.jsonl"))
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn header(id: &str) -> SessionHeader {
    SessionHeader {
        version: SessionHeader::FORMAT_VERSION,
        id: id.to_owned(),
        created_at_ms: 123,
        cwd: Some("/workspace".to_owned()),
    }
}

fn turn_start(turn: u32) -> SessionEvent {
    EventData::TurnStart { turn }.into()
}

fn user_message(content: &str) -> SessionEvent {
    EventData::UserMessage {
        message: Message::user(content),
        surface_replace: None,
    }
    .into()
}

#[tokio::test]
async fn delete_session_data_removes_only_selected_journal_and_is_idempotent() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("delete-me")).await.unwrap();
    store.create(header("keep-me")).await.unwrap();
    let reference = store
        .archive_tool_result("delete-me", "private result")
        .await
        .unwrap();
    store.delete_session_data("delete-me").await.unwrap();
    store.delete_session_data("delete-me").await.unwrap();
    assert!(!dir.session_file("delete-me").exists());
    assert!(store.load("delete-me").await.unwrap().is_none());
    assert!(store
        .tool_result_archive("delete-me", &reference.sha256)
        .await
        .unwrap()
        .is_none());
    assert!(store.load("keep-me").await.unwrap().is_some());
}

#[tokio::test]
async fn create_is_exclusive_and_header_is_first_jsonl_record() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    let created = store.create(header("session-1")).await.unwrap();
    assert_eq!(created.revision(), Revision::ZERO);

    let text = fs::read_to_string(dir.session_file("session-1")).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 1);
    let first: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(first["record"], "header");
    assert_eq!(first["format"], "xharness.session.jsonl");
    assert_eq!(first["header"]["id"], "session-1");

    assert_eq!(
        store.create(header("session-1")).await.unwrap_err(),
        StoreError::AlreadyExists {
            session_id: "session-1".to_owned()
        }
    );
}

#[tokio::test]
async fn list_headers_is_sorted_validated_and_ignores_non_session_files() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("z-last")).await.unwrap();
    store.create(header("a-first")).await.unwrap();
    fs::write(dir.path().join("README.txt"), b"not a session").unwrap();
    fs::write(dir.path().join("z-last.lock"), b"lock metadata").unwrap();

    let headers = store.list_headers().await.unwrap();
    assert_eq!(
        headers
            .iter()
            .map(|header| header.id.as_str())
            .collect::<Vec<_>>(),
        ["a-first", "z-last"]
    );
}

#[tokio::test]
async fn list_headers_fails_closed_for_corrupt_sessions() {
    let corrupt_dir = TestDir::new();
    let corrupt_store = JsonlSessionStore::new(corrupt_dir.path()).unwrap();
    corrupt_store.create(header("valid")).await.unwrap();
    fs::write(corrupt_dir.session_file("broken"), b"not-json\n").unwrap();
    assert!(matches!(
        corrupt_store.list_headers().await,
        Err(StoreError::Backend { message }) if message.contains("broken.jsonl")
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn list_headers_fails_closed_for_symlinked_sessions() {
    let symlink_dir = TestDir::new();
    let symlink_store = JsonlSessionStore::new(symlink_dir.path()).unwrap();
    symlink_store.create(header("valid")).await.unwrap();
    std::os::unix::fs::symlink(
        symlink_dir.session_file("valid"),
        symlink_dir.session_file("alias"),
    )
    .unwrap();
    assert!(matches!(
        symlink_store.list_headers().await,
        Err(StoreError::Backend { message }) if message.contains("symbolic link")
    ));
}

/// Regression for the crash artifact: `create` publishes the name before the
/// header, so a crash in that window leaves a zero-byte file. It carries no
/// durable work, so it must not hide every healthy session.
#[tokio::test]
async fn list_headers_skips_a_zero_byte_crash_residue() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("valid")).await.unwrap();

    fs::write(dir.session_file("torn"), b"").unwrap();
    assert_eq!(fs::metadata(dir.session_file("torn")).unwrap().len(), 0);

    let headers = store.list_headers().await.unwrap();
    assert_eq!(
        headers
            .iter()
            .map(|header| header.id.as_str())
            .collect::<Vec<_>>(),
        ["valid"]
    );
}

/// A name that cannot denote a session id is not addressable by this store, so
/// it must not make startup enumeration fail either.
#[tokio::test]
async fn list_headers_ignores_names_that_cannot_be_session_ids() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("valid")).await.unwrap();

    fs::write(dir.path().join(".hidden.jsonl"), b"").unwrap();
    fs::write(dir.path().join("session-1 copy.jsonl"), b"").unwrap();

    let headers = store.list_headers().await.unwrap();
    assert_eq!(
        headers
            .iter()
            .map(|header| header.id.as_str())
            .collect::<Vec<_>>(),
        ["valid"]
    );
}

/// The tolerance above is exactly one byte wide: a file that has any content at
/// all still fails closed, because it may hold durable work.
#[tokio::test]
async fn list_headers_fails_closed_for_a_single_byte_of_corruption() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("valid")).await.unwrap();

    fs::write(dir.session_file("torn"), b"\n").unwrap();

    assert!(matches!(
        store.list_headers().await,
        Err(StoreError::Backend { message }) if message.contains("torn.jsonl")
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn list_headers_does_not_treat_a_symlink_as_an_empty_artifact() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("valid")).await.unwrap();

    // A symlink to an empty file: `symlink_metadata` must not follow it, so it
    // keeps the existing stall-closed symlink rejection.
    let empty = dir.path().join("empty-target");
    fs::write(&empty, b"").unwrap();
    std::os::unix::fs::symlink(&empty, dir.session_file("alias")).unwrap();

    assert!(matches!(
        store.list_headers().await,
        Err(StoreError::Backend { message }) if message.contains("symbolic link")
    ));
}

/// The tolerant seam publishes what it can and reports the rest, so a Host can
/// start with the healthy sessions instead of exiting.
#[tokio::test]
async fn scan_sessions_publishes_healthy_sessions_and_reports_the_rest() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("valid")).await.unwrap();
    store.create(header("also-valid")).await.unwrap();

    fs::write(dir.session_file("empty"), b"").unwrap();
    fs::write(dir.session_file("broken"), b"not-json\n").unwrap();

    let (headers, unreadable) = store.scan_sessions().await.unwrap();
    assert_eq!(
        headers
            .iter()
            .map(|header| header.id.as_str())
            .collect::<Vec<_>>(),
        ["also-valid", "valid"]
    );
    let reported = unreadable
        .iter()
        .map(|entry| (entry.session_id.as_str(), entry.reason.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        reported.len(),
        2,
        "every unpublished entry must be reported"
    );
    assert_eq!(reported[0].0, "broken");
    assert!(
        reported[0].1.contains("invalid header JSON"),
        "the reason must be the store's own diagnostic, got {:?}",
        reported[0].1
    );
    assert_eq!(reported[1].0, "empty");
    assert!(
        reported[1].1.contains("missing header record"),
        "got {:?}",
        reported[1].1
    );
}

#[tokio::test]
async fn startup_candidates_read_only_headers_and_defer_tail_validation() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("healthy")).await.unwrap();
    store.create(header("corrupt-tail")).await.unwrap();
    let mut file = OpenOptions::new()
        .append(true)
        .open(dir.session_file("corrupt-tail"))
        .unwrap();
    file.write_all(b"not-json\n").unwrap();
    fs::write(dir.session_file("bad-header"), b"not-json\n").unwrap();

    let (candidates, unreadable) = store.scan_startup_candidates().await.unwrap();
    assert_eq!(
        candidates.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
        ["corrupt-tail", "healthy"]
    );
    assert_eq!(unreadable.len(), 1);
    assert_eq!(unreadable[0].session_id, "bad-header");
    assert!(store.load("healthy").await.unwrap().is_some());
    assert!(store.load("corrupt-tail").await.is_err());

    // Public strict enumeration is unchanged: it still validates the tail.
    assert!(store.list_headers().await.is_err());
    let (validated, invalid) = store.scan_sessions().await.unwrap();
    assert_eq!(validated.len(), 1);
    assert_eq!(invalid.len(), 2);
}

#[tokio::test]
async fn startup_stream_publishes_recent_headers_before_a_damaged_older_entry() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("session-001")).await.unwrap();
    store.create(header("session-002")).await.unwrap();
    fs::write(dir.session_file("bad-header"), b"not-json\n").unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    let producer = tokio::spawn(async move { store.stream_startup_candidates(sender).await });
    let mut seen = Vec::new();
    while let Some(candidate) = receiver.recv().await {
        seen.push(candidate);
    }
    producer.await.unwrap().unwrap();
    assert_eq!(seen.len(), 3);
    assert!(seen
        .iter()
        .any(|c| matches!(c, StartupCandidate::Header(h) if h.id == "session-002")));
    assert!(seen
        .iter()
        .any(|c| matches!(c, StartupCandidate::Header(h) if h.id == "session-001")));
    assert!(seen
        .iter()
        .any(|c| matches!(c, StartupCandidate::Unreadable(e) if e.session_id == "bad-header")));
}

#[tokio::test]
async fn one_locked_header_does_not_block_other_startup_candidates() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("session-001")).await.unwrap();
    store.create(header("session-002")).await.unwrap();
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.path().join("session-002.lock"))
        .unwrap();
    fs2::FileExt::lock_exclusive(&lock_file).unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
    let producer = tokio::spawn(async move { store.stream_startup_candidates(sender).await });
    let first = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("other header should not wait for the lock")
        .unwrap();
    assert!(matches!(first, StartupCandidate::Header(h) if h.id == "session-001"));
    fs2::FileExt::unlock(&lock_file).unwrap();
    let second = receiver.recv().await.unwrap();
    assert!(matches!(second, StartupCandidate::Header(h) if h.id == "session-002"));
    producer.await.unwrap().unwrap();
}

#[tokio::test]
async fn catalogue_is_rebuildable_and_never_trusts_a_stale_file() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("catalogued")).await.unwrap();
    let entry = SessionCatalogEntry {
        header: header("catalogued"),
        updated_at_ms: 123,
        title: Some("Example".into()),
        agent_preset: None,
        parent_session_id: None,
        origin: None,
        model_provider: "test".into(),
        model: "model".into(),
        reasoning_effort: None,
        context_window_tokens: None,
        permission_preset: "workspace-write".into(),
        plan_active: false,
        blank: true,
        next_seq: 0,
        needs_recovery: false,
    };
    assert_eq!(store.catalog_entry("catalogued").await.unwrap(), None);
    store.publish_catalog_entry(entry.clone()).await.unwrap();
    assert_eq!(
        store.catalog_entry("catalogued").await.unwrap(),
        Some(entry)
    );

    let session = store.load("catalogued").await.unwrap().unwrap();
    store
        .append("catalogued", session.revision(), vec![turn_start(1)])
        .await
        .unwrap();
    assert_eq!(store.catalog_entry("catalogued").await.unwrap(), None);
    fs::write(dir.path().join("catalogued.catalog"), b"broken").unwrap();
    assert_eq!(store.catalog_entry("catalogued").await.unwrap(), None);
    assert!(store.load("catalogued").await.unwrap().is_some());
}

#[tokio::test]
async fn catalogue_publication_rejects_stale_snapshot_even_when_large_cache_is_disabled() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_cache_limits(0, 0);
    store.create(header("catalogued")).await.unwrap();
    let mut entry = SessionCatalogEntry {
        header: header("catalogued"),
        updated_at_ms: 123,
        title: Some("before".into()),
        agent_preset: None,
        parent_session_id: None,
        origin: None,
        model_provider: "test".into(),
        model: "model".into(),
        reasoning_effort: None,
        context_window_tokens: None,
        permission_preset: "workspace-write".into(),
        plan_active: false,
        blank: true,
        next_seq: 0,
        needs_recovery: false,
    };
    store.publish_catalog_entry(entry.clone()).await.unwrap();
    store
        .append("catalogued", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    assert!(store.publish_catalog_entry(entry.clone()).await.is_err());
    assert_eq!(store.catalog_entry("catalogued").await.unwrap(), None);
    let current = store.load("catalogued").await.unwrap().unwrap();
    entry.next_seq = current.next_seq();
    entry.needs_recovery = true;
    store.publish_catalog_entry(entry.clone()).await.unwrap();
    assert_eq!(
        store.catalog_entry("catalogued").await.unwrap(),
        Some(entry)
    );
}

/// The strict seam still fails closed on the same directory: tolerating an
/// entry at startup must not weaken `list_headers` for its other callers.
#[tokio::test]
async fn scan_sessions_tolerance_does_not_weaken_list_headers() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("valid")).await.unwrap();
    fs::write(dir.session_file("broken"), b"not-json\n").unwrap();

    assert!(store.scan_sessions().await.is_ok());
    assert!(matches!(
        store.list_headers().await,
        Err(StoreError::Backend { message }) if message.contains("broken.jsonl")
    ));
}

/// `create` must publish the name only once it already holds the header, so no
/// crash can leave a zero-byte `<id>.jsonl` behind, and it must still refuse to
/// replace an existing session.
#[tokio::test]
async fn create_publishes_atomically_and_never_replaces() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("once")).await.unwrap();
    let published = fs::read(dir.session_file("once")).unwrap();
    assert!(published.starts_with(b"{\"record\":\"header\""));

    assert_eq!(
        store.create(header("once")).await.unwrap_err(),
        StoreError::AlreadyExists {
            session_id: "once".to_owned()
        }
    );
    assert_eq!(
        fs::read(dir.session_file("once")).unwrap(),
        published,
        "a rejected create must not touch the published session"
    );

    // No staging residue survives a completed or rejected create.
    let leftovers = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".creating-"))
        .collect::<Vec<_>>();
    assert!(
        leftovers.is_empty(),
        "staging files left behind: {leftovers:?}"
    );
}

#[tokio::test]
async fn append_persists_one_complete_batch_and_round_trips() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("roundtrip")).await.unwrap();

    let receipt = store
        .append(
            "roundtrip",
            Revision::ZERO,
            vec![turn_start(1), user_message("hello")],
        )
        .await
        .unwrap();
    assert_eq!(receipt.revision, Revision(1));
    assert_eq!(receipt.first_seq, 0);
    assert_eq!(receipt.last_seq, Some(1));

    let text = fs::read_to_string(dir.session_file("roundtrip")).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 2, "an append batch must occupy one line");
    let batch: Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(batch["record"], "batch");
    assert_eq!(batch["previous_revision"], 0);
    assert_eq!(batch["revision"], 1);
    assert_eq!(batch["events"].as_array().unwrap().len(), 2);

    let loaded = store.load("roundtrip").await.unwrap().unwrap();
    assert_eq!(loaded.header(), &header("roundtrip"));
    assert_eq!(loaded.revision(), Revision(1));
    assert_eq!(loaded.events(), receipt.events);
    assert_eq!(loaded.derive_messages(), vec![Message::user("hello")]);

    let inspection = store.inspect("roundtrip").await.unwrap().unwrap();
    assert_eq!(inspection.revision, Revision(1));
    assert_eq!(inspection.next_seq, 2);
}

#[tokio::test]
async fn stale_cas_does_not_write_and_empty_batch_is_a_checked_noop() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("cas")).await.unwrap();
    store
        .append("cas", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let before = fs::read(dir.session_file("cas")).unwrap();

    assert_eq!(
        store
            .append("cas", Revision::ZERO, vec![turn_start(2)])
            .await
            .unwrap_err(),
        StoreError::RevisionConflict {
            session_id: "cas".to_owned(),
            expected: Revision::ZERO,
            actual: Revision(1),
        }
    );
    assert_eq!(fs::read(dir.session_file("cas")).unwrap(), before);

    let no_op = store.append("cas", Revision(1), Vec::new()).await.unwrap();
    assert_eq!(no_op.revision, Revision(1));
    assert!(no_op.events.is_empty());
    assert_eq!(fs::read(dir.session_file("cas")).unwrap(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_wide_session_lock_makes_same_revision_append_atomic() {
    let dir = TestDir::new();
    let first = Arc::new(JsonlSessionStore::new(dir.path()).unwrap());
    let second = Arc::new(JsonlSessionStore::new(dir.path()).unwrap());
    first.create(header("concurrent")).await.unwrap();

    let left = {
        let store = Arc::clone(&first);
        tokio::spawn(async move {
            store
                .append("concurrent", Revision::ZERO, vec![turn_start(1)])
                .await
        })
    };
    let right = {
        let store = Arc::clone(&second);
        tokio::spawn(async move {
            // Both contenders must be valid at revision zero. Otherwise the
            // test can nondeterministically observe lifecycle rejection when
            // turn 2 wins the scheduler instead of exercising revision CAS.
            store
                .append("concurrent", Revision::ZERO, vec![turn_start(1)])
                .await
        })
    };

    let results = [left.await.unwrap(), right.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(StoreError::RevisionConflict { .. })))
            .count(),
        1
    );
    let loaded = first.load("concurrent").await.unwrap().unwrap();
    assert_eq!(loaded.revision(), Revision(1));
    assert_eq!(loaded.events().len(), 1);
}

#[test]
fn subprocess_append_worker() {
    let Ok(root) = std::env::var("XHARNESS_JSONL_WORKER_ROOT") else {
        return;
    };
    let result_path = PathBuf::from(
        std::env::var_os("XHARNESS_JSONL_WORKER_RESULT").expect("worker result path"),
    );
    let ready_path =
        PathBuf::from(std::env::var_os("XHARNESS_JSONL_WORKER_READY").expect("worker ready path"));
    let turn = std::env::var("XHARNESS_JSONL_WORKER_TURN")
        .expect("worker turn")
        .parse::<u32>()
        .expect("numeric worker turn");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    fs::write(ready_path, b"ready").unwrap();
    let result = runtime.block_on(async {
        JsonlSessionStore::new(root)
            .unwrap()
            .append("cross-process", Revision::ZERO, vec![turn_start(turn)])
            .await
    });
    let outcome = match result {
        Ok(_) => "ok",
        Err(StoreError::RevisionConflict { .. }) => "revision_conflict",
        Err(error) => panic!("unexpected worker append error: {error}"),
    };
    fs::write(result_path, outcome).unwrap();
}

#[tokio::test]
async fn cross_process_file_lock_makes_cas_atomic() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("cross-process")).await.unwrap();

    let lock_path = dir.path().join("cross-process.lock");
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    fs2::FileExt::lock_exclusive(&lock_file).unwrap();

    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    let mut result_paths = Vec::new();
    let mut ready_paths = Vec::new();
    for worker in [1u32, 2u32] {
        let result_path = dir.path().join(format!("worker-{worker}.result"));
        let ready_path = dir.path().join(format!("worker-{worker}.ready"));
        let child = Command::new(&executable)
            .args([
                "--exact",
                "subprocess_append_worker",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("XHARNESS_JSONL_WORKER_ROOT", dir.path())
            .env("XHARNESS_JSONL_WORKER_RESULT", &result_path)
            .env("XHARNESS_JSONL_WORKER_READY", &ready_path)
            // Both contenders must submit a lifecycle-valid first event. The
            // test is about revision CAS, not event-level rejection.
            .env("XHARNESS_JSONL_WORKER_TURN", "1")
            .spawn()
            .unwrap();
        children.push(child);
        result_paths.push(result_path);
        ready_paths.push(ready_path);
    }

    let ready_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while ready_paths.iter().any(|path| !path.exists()) {
        assert!(
            std::time::Instant::now() < ready_deadline,
            "workers did not reach the append barrier"
        );
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(50));
    for child in &mut children {
        assert!(
            child.try_wait().unwrap().is_none(),
            "worker bypassed the inter-process session lock"
        );
    }
    fs2::FileExt::unlock(&lock_file).unwrap();
    drop(lock_file);

    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let outcomes = result_paths
        .iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|value| *value == "ok").count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| *value == "revision_conflict")
            .count(),
        1
    );
    let loaded = store.load("cross-process").await.unwrap().unwrap();
    assert_eq!(loaded.revision(), Revision(1));
    assert_eq!(loaded.events().len(), 1);
}

#[tokio::test]
async fn torn_final_record_is_ignored_and_healed_by_the_next_append() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("torn")).await.unwrap();
    store
        .append("torn", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();

    let path = dir.session_file("torn");
    let valid_len = fs::metadata(&path).unwrap().len();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(br#"{"record":"batch","previous_revision":1"#)
        .unwrap();
    file.flush().unwrap();

    let recovered = store.load("torn").await.unwrap().unwrap();
    assert_eq!(recovered.revision(), Revision(1));
    assert_eq!(recovered.events().len(), 1);
    assert!(fs::metadata(&path).unwrap().len() > valid_len);

    store
        .append("torn", Revision(1), vec![user_message("continue")])
        .await
        .unwrap();
    let healed = store.load("torn").await.unwrap().unwrap();
    assert_eq!(healed.revision(), Revision(2));
    assert_eq!(healed.events().len(), 2);
    let text = fs::read_to_string(path).unwrap();
    assert_eq!(text.lines().count(), 3);
    assert!(text
        .lines()
        .all(|line| serde_json::from_str::<Value>(line).is_ok()));
}

#[tokio::test]
async fn valid_unterminated_final_record_is_kept_and_separated_on_append() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("no-newline")).await.unwrap();
    store
        .append("no-newline", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let path = dir.session_file("no-newline");
    let mut bytes = fs::read(&path).unwrap();
    assert_eq!(bytes.pop(), Some(b'\n'));
    fs::write(&path, bytes).unwrap();

    assert_eq!(
        store.load("no-newline").await.unwrap().unwrap().revision(),
        Revision(1)
    );
    store
        .append("no-newline", Revision(1), vec![user_message("second")])
        .await
        .unwrap();
    let text = fs::read_to_string(path).unwrap();
    assert_eq!(text.lines().count(), 3);
    assert_eq!(
        store.load("no-newline").await.unwrap().unwrap().revision(),
        Revision(2)
    );
}

#[tokio::test]
async fn complete_middle_corruption_is_rejected() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("corrupt")).await.unwrap();
    store
        .append("corrupt", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let path = dir.session_file("corrupt");
    let text = fs::read_to_string(&path).unwrap();
    let mut lines = text.lines();
    let header_line = lines.next().unwrap();
    let batch_line = lines.next().unwrap();
    fs::write(&path, format!("{header_line}\nnot-json\n{batch_line}\n")).unwrap();

    assert!(matches!(
        store.load("corrupt").await,
        Err(StoreError::Backend { message }) if message.contains("line 2")
    ));
}

#[tokio::test]
async fn discontinuous_sequence_or_revision_is_rejected() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("coordinates")).await.unwrap();
    store
        .append("coordinates", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let path = dir.session_file("coordinates");
    let text = fs::read_to_string(&path).unwrap();
    let mut lines = text.lines();
    let header_line = lines.next().unwrap();
    let mut batch: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    batch["events"][0]["seq"] = Value::from(9);
    fs::write(
        &path,
        format!(
            "{header_line}\n{}\n",
            serde_json::to_string(&batch).unwrap()
        ),
    )
    .unwrap();

    assert!(matches!(
        store.load("coordinates").await,
        Err(StoreError::Backend { .. })
    ));

    store.create(header("revision")).await.unwrap();
    store
        .append("revision", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let path = dir.session_file("revision");
    let text = fs::read_to_string(&path).unwrap();
    let mut lines = text.lines();
    let header_line = lines.next().unwrap();
    let mut batch: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    batch["revision"] = Value::from(7);
    fs::write(
        &path,
        format!(
            "{header_line}\n{}\n",
            serde_json::to_string(&batch).unwrap()
        ),
    )
    .unwrap();
    assert!(matches!(
        store.load("revision").await,
        Err(StoreError::Backend { .. })
    ));
}

#[tokio::test]
async fn wrong_file_format_is_rejected_before_replay() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("format")).await.unwrap();
    let path = dir.session_file("format");
    let mut first: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    first["format"] = Value::from("some.other.format");
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&first).unwrap()),
    )
    .unwrap();

    assert!(matches!(
        store.load("format").await,
        Err(StoreError::Backend { message }) if message.contains("unsupported file format")
    ));
}

#[tokio::test]
async fn unsafe_ids_cannot_escape_the_storage_root() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    for id in ["", ".hidden", "../escape", "nested/name", r"nested\name"] {
        assert_eq!(
            store.create(header(id)).await.unwrap_err(),
            StoreError::InvalidSessionId {
                session_id: id.to_owned()
            }
        );
        assert_eq!(
            store.load(id).await.unwrap_err(),
            StoreError::InvalidSessionId {
                session_id: id.to_owned()
            }
        );
    }
    assert!(!dir.path().parent().unwrap().join("escape.jsonl").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_lock_file_is_rejected() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    let outside = dir.path().join("outside-lock-target");
    fs::write(&outside, b"do not lock").unwrap();
    std::os::unix::fs::symlink(&outside, dir.path().join("symlink-lock.lock")).unwrap();
    assert!(matches!(
        store.create(header("symlink-lock")).await,
        Err(StoreError::Backend { message }) if message.contains("open session lock")
    ));
    assert_eq!(fs::read(outside).unwrap(), b"do not lock");
}

#[tokio::test]
async fn flush_syncs_and_returns_the_validated_revision() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("flush")).await.unwrap();
    store
        .append("flush", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    assert_eq!(store.flush("flush").await.unwrap(), Revision(1));
    assert_eq!(
        store.flush("missing").await.unwrap_err(),
        StoreError::NotFound {
            session_id: "missing".to_owned()
        }
    );
}

#[tokio::test]
async fn image_references_survive_jsonl_restart_without_payload() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("image-session")).await.unwrap();
    let message =
        Message::user("").with_content_blocks(vec![xharness_session::ContentBlock::Image {
            attachment: xharness_session::AttachmentRef {
                id: "sha256-ref".into(),
                session_id: "image-session".into(),
                media_type: "image/png".into(),
                bytes: 128,
                width: 64,
                height: 32,
            },
        }]);
    store
        .append(
            "image-session",
            Revision::ZERO,
            vec![
                turn_start(1),
                EventData::UserMessage {
                    message: message.clone(),
                    surface_replace: None,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    drop(store);
    let reopened = JsonlSessionStore::new(dir.path()).unwrap();
    assert_eq!(
        reopened
            .load("image-session")
            .await
            .unwrap()
            .unwrap()
            .derive_messages(),
        vec![message]
    );
    let raw = fs::read_to_string(dir.session_file("image-session")).unwrap();
    assert!(!raw.contains("base64"));
    assert!(raw.contains("sha256-ref"));
}

#[tokio::test]
async fn future_goal_record_fails_closed_without_truncating_or_appending() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("future-goal")).await.unwrap();
    store
        .append("future-goal", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let path = dir.session_file("future-goal");
    let text = fs::read_to_string(&path).unwrap();
    let mut rows: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    rows[1]["events"][0]["event"] =
        serde_json::json!({"type":"goal/future-version","data":{"version":999}});
    // Locate the actual flattened SessionEvent representation instead of inventing a second record.
    let event = rows[1]["events"][0].as_object_mut().unwrap();
    if event.contains_key("type") {
        event.insert("type".into(), Value::String("goal/future-version".into()));
    }
    let bytes = rows
        .iter()
        .map(|v| serde_json::to_string(v).unwrap() + "\n")
        .collect::<String>();
    fs::write(&path, bytes.as_bytes()).unwrap();
    assert!(store.load("future-goal").await.is_err());
    assert!(store
        .append("future-goal", Revision::ZERO, vec![turn_start(2)])
        .await
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes.as_bytes());
}

fn audited_turn(turn: u32, h: xharness_session::RequestHeader) -> Vec<SessionEvent> {
    vec![
        turn_start(turn),
        user_message("original user fact"),
        EventData::StepStart { turn, step: 1 }.into(),
        EventData::RequestHeader { header: h }.into(),
        EventData::AssistantMessage {
            turn,
            step: 1,
            message: Message::assistant("original answer"),
            usage: None,
        }
        .into(),
        EventData::StepEnd { turn, step: 1 }.into(),
        EventData::TurnEnd {
            turn,
            reason: xharness_session::TurnEndReason::Completed,
        }
        .into(),
    ]
}
fn large_request() -> xharness_session::RequestHeader {
    let mut h = xharness_session::RequestHeader::new("test", "model");
    h.input = vec![Message::user("中文🚀".repeat(32768))];
    h.system = Some("system prompt".into());
    h.tools = vec![serde_json::json!({"name":"read","description":"test"})];
    h.options.insert(
        "context".into(),
        serde_json::json!({"edits":[{"reason":"visible surface"}],"visible_message_count":1}),
    );
    h
}

async fn indexed_fixture(dir: &TestDir, id: &str, turns: u32) -> JsonlSessionStore {
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_cache_limits(0, 0)
        .for_runtime();
    store.create(header(id)).await.unwrap();
    let mut revision = Revision::ZERO;
    for turn in 1..=turns {
        revision = store
            .append(
                id,
                revision,
                audited_turn(turn, xharness_session::RequestHeader::new("test", "model")),
            )
            .await
            .unwrap()
            .revision;
    }
    store.load(id).await.unwrap().unwrap();
    store
}

#[tokio::test]
async fn history_index_matches_every_cursor_and_survives_restart_without_full_load() {
    let dir = TestDir::new();
    let store = indexed_fixture(&dir, "indexed", 8).await;
    let session = store.load("indexed").await.unwrap().unwrap();
    let original = fs::read(dir.session_file("indexed")).unwrap();
    assert!(dir
        .session_file("indexed")
        .with_extension("history-index")
        .is_file());
    let reopened = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_cache_limits(0, 0);
    for before in (0..=session.next_seq() + 2)
        .map(Some)
        .chain([None, Some(u64::MAX)])
    {
        for max in [0, 1, 2, 3, 7, 50, usize::MAX] {
            let end = before.unwrap_or(session.next_seq()).min(session.next_seq()) as usize;
            let mut start = end;
            let mut count = 0;
            while start > 0 && count < max.max(1) {
                start -= 1;
                if matches!(
                    session.events()[start].data(),
                    EventData::UserMessage { .. }
                        | EventData::AssistantMessage { .. }
                        | EventData::ToolResult { .. }
                ) {
                    count += 1;
                }
            }
            let page = reopened
                .history_window("indexed", session.next_seq(), before, max)
                .await
                .unwrap()
                .expect("valid indexed page");
            assert_eq!(page.has_more, start > 0);
            assert_eq!(page.next_seq, session.next_seq());
            assert_eq!(page.events, session.events()[start..end]);
            assert_eq!(page.initial_request_header_seq, Some(3));
            assert_eq!(page.completed_steps.len(), 8);
        }
    }
    assert_eq!(reopened.cache_stats().entries, 0);
    assert_eq!(fs::read(dir.session_file("indexed")).unwrap(), original);
}

#[tokio::test]
async fn history_index_stale_append_and_compression_fall_back_then_rebuild_losslessly() {
    let dir = TestDir::new();
    let store = indexed_fixture(&dir, "changed", 2).await;
    let old = store.load("changed").await.unwrap().unwrap();
    store
        .append("changed", old.revision(), audited_turn(3, large_request()))
        .await
        .unwrap();
    assert!(store
        .history_window("changed", old.next_seq(), None, 50)
        .await
        .unwrap()
        .is_none());
    let updated = store.load("changed").await.unwrap().unwrap();
    let page = store
        .history_window("changed", updated.next_seq(), None, 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.events, updated.events());
    assert!(
        store
            .compress_cold_session("changed")
            .await
            .unwrap()
            .changed
    );
    assert!(store
        .history_window("changed", updated.next_seq(), None, 50)
        .await
        .unwrap()
        .is_none());
    let compressed = store.load("changed").await.unwrap().unwrap();
    let page = store
        .history_window("changed", compressed.next_seq(), None, 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.events, compressed.events());
    assert_eq!(compressed.events(), updated.events());
    store.delete_session_data("changed").await.unwrap();
    assert!(!dir
        .session_file("changed")
        .with_extension("history-index")
        .exists());
}

#[tokio::test]
async fn history_index_missing_corrupt_oversized_or_unpublishable_never_loses_history() {
    let dir = TestDir::new();
    let store = indexed_fixture(&dir, "fallback", 2).await;
    let session = store.load("fallback").await.unwrap().unwrap();
    let journal = dir.session_file("fallback");
    let original = fs::read(&journal).unwrap();
    let index = journal.with_extension("history-index");
    let bytes = fs::read(&index).unwrap();
    for bad in [
        b"".to_vec(),
        b"{}".to_vec(),
        bytes[..bytes.len() / 2].to_vec(),
        vec![b' '; 8 * 1024 * 1024 + 1],
    ] {
        fs::write(&index, bad).unwrap();
        assert!(store
            .history_window("fallback", session.next_seq(), None, 50)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store.load("fallback").await.unwrap().unwrap().events(),
            session.events()
        );
        assert_eq!(fs::read(&journal).unwrap(), original);
    }
    fs::remove_file(&index).unwrap();
    assert!(store
        .history_window("fallback", session.next_seq(), None, 50)
        .await
        .unwrap()
        .is_none());
    // A blocked publication must not turn an otherwise valid full read into an error.
    fs::create_dir(&index).unwrap();
    assert_eq!(
        store.load("fallback").await.unwrap().unwrap().events(),
        session.events()
    );
    assert!(store
        .history_window("fallback", session.next_seq(), None, 50)
        .await
        .unwrap()
        .is_none());
    fs::remove_dir(&index).unwrap();
    fs::write(
        index.with_extension("history-index.tmp"),
        b"interrupted publish",
    )
    .unwrap();
    assert_eq!(
        store.load("fallback").await.unwrap().unwrap().events(),
        session.events()
    );
    assert_eq!(fs::read(&journal).unwrap(), original);
    store.load("fallback").await.unwrap().unwrap();
    assert!(store
        .history_window("fallback", session.next_seq(), None, 50)
        .await
        .unwrap()
        .is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn history_index_symlink_is_not_read_and_external_target_is_never_modified() {
    let dir = TestDir::new();
    let external = TestDir::new();
    let store = indexed_fixture(&dir, "symlink-index", 1).await;
    let index = dir
        .session_file("symlink-index")
        .with_extension("history-index");
    let bytes = fs::read(&index).unwrap();
    let target = external.path().join("external");
    fs::write(&target, &bytes).unwrap();
    fs::remove_file(&index).unwrap();
    std::os::unix::fs::symlink(&target, &index).unwrap();
    assert!(store
        .history_window("symlink-index", 7, None, 50)
        .await
        .unwrap()
        .is_none());
    store.load("symlink-index").await.unwrap().unwrap();
    assert_eq!(fs::read(target).unwrap(), bytes);
}

#[tokio::test]
async fn history_index_unremovable_sidecar_does_not_block_authoritative_deletion() {
    let dir = TestDir::new();
    let store = indexed_fixture(&dir, "delete-index", 1).await;
    let index = dir
        .session_file("delete-index")
        .with_extension("history-index");
    fs::remove_file(&index).unwrap();
    fs::create_dir(&index).unwrap();
    store.delete_session_data("delete-index").await.unwrap();
    assert!(store.load("delete-index").await.unwrap().is_none());
    assert!(store
        .history_window("delete-index", 7, None, 50)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn history_index_keeps_existing_warm_snapshot_path_instead_of_rereading_batches() {
    let dir = TestDir::new();
    indexed_fixture(&dir, "warm-index", 2).await;
    let warm = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    let snapshot = warm.load("warm-index").await.unwrap().unwrap();
    assert_eq!(warm.cache_stats().entries, 1);
    assert!(warm
        .history_window("warm-index", snapshot.next_seq(), None, 50)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        warm.load("warm-index").await.unwrap().unwrap().events(),
        snapshot.events()
    );
    assert_eq!(warm.cache_stats().entries, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_index_concurrent_append_never_returns_a_mixed_revision() {
    let dir = TestDir::new();
    let store = indexed_fixture(&dir, "concurrent-index", 2).await;
    let prior = store.load("concurrent-index").await.unwrap().unwrap();
    let (page, append) = tokio::join!(
        store.history_window("concurrent-index", prior.next_seq(), None, 50),
        store.append(
            "concurrent-index",
            prior.revision(),
            audited_turn(3, large_request())
        )
    );
    append.unwrap();
    if let Some(page) = page.unwrap() {
        assert_eq!(page.events, prior.events());
        assert_eq!(page.next_seq, prior.next_seq());
    }
    assert!(store
        .history_window("concurrent-index", prior.next_seq(), None, 50)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn history_index_torn_tail_and_semantic_corruption_do_not_publish_valid_index() {
    let dir = TestDir::new();
    let store = indexed_fixture(&dir, "torn-index", 1).await;
    let journal = dir.session_file("torn-index");
    let original = fs::read(&journal).unwrap();
    OpenOptions::new()
        .append(true)
        .open(&journal)
        .unwrap()
        .write_all(b"{\"record\":")
        .unwrap();
    assert!(store
        .history_window("torn-index", 7, None, 50)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store.load("torn-index").await.unwrap().unwrap().next_seq(),
        7
    );
    assert!(store
        .history_window("torn-index", 7, None, 50)
        .await
        .unwrap()
        .is_none());
    let mut bad = String::from_utf8(original).unwrap();
    bad = bad.replace("\"turn\":1", "\"turn\":99");
    bad = bad.replacen("\"turn\":99", "\"turn\":1", 1);
    fs::write(&journal, bad).unwrap();
    assert!(store.load("torn-index").await.is_err());
    assert!(store
        .history_window("torn-index", 7, None, 50)
        .await
        .unwrap()
        .is_none());
}

/// Synthetic legacy-audit fixture only. Run fixture/full/indexed in separate
/// remote processes with /usr/bin/time -v; never point this at real chat data.
#[tokio::test]
#[ignore = "explicit remote history paging performance acceptance"]
async fn history_index_performance_acceptance() {
    use sha2::{Digest, Sha256};
    use xharness_session::LoggedEvent;
    let mode =
        std::env::var("XHARNESS_HISTORY_BENCH_MODE").expect("fixture/full/indexed mode required");
    let root = PathBuf::from(
        std::env::var_os("XHARNESS_HISTORY_BENCH_ROOT").expect("isolated temporary root required"),
    );
    assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
    let id = "synthetic-history-offset-benchmark";
    const TURNS: u32 = 512;
    let store = JsonlSessionStore::new(&root).unwrap().for_runtime();
    let store = if mode == "cached" {
        store
    } else {
        store.with_cache_limits(0, 0)
    };
    if mode == "fixture" {
        store.create(header(id)).await.unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(root.join(format!("{id}.jsonl")))
            .unwrap();
        let mut seq = 0;
        for turn in 1..=TURNS {
            let mut request = xharness_session::RequestHeader::new("test", "model");
            request.input = vec![Message::user("x".repeat(256 * 1024))];
            let mut events = audited_turn(turn, request);
            if let EventData::AssistantMessage { message, .. } = events[4].data_mut() {
                message.content = "answer".repeat(5461);
            }
            let events = events
                .into_iter()
                .map(|event| {
                    let logged = LoggedEvent {
                        seq,
                        revision: Revision(u64::from(turn)),
                        timestamp_ms: 123,
                        event,
                    };
                    seq += 1;
                    logged
                })
                .collect::<Vec<_>>();
            serde_json::to_writer(&mut file, &serde_json::json!({"record":"batch", "previous_revision":turn-1, "revision":turn, "events":events})).unwrap();
            file.write_all(b"\n").unwrap();
        }
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(store.load(id).await.unwrap().unwrap().next_seq(), seq);
        println!(
            "HISTORY_BENCH fixture_bytes={} index_bytes={}",
            fs::metadata(root.join(format!("{id}.jsonl")))
                .unwrap()
                .len(),
            fs::metadata(root.join(format!("{id}.history-index")))
                .unwrap()
                .len()
        );
        return;
    }
    assert!(matches!(mode.as_str(), "full" | "indexed" | "cached"));
    if mode == "cached" {
        store.load(id).await.unwrap().unwrap();
        assert!(store
            .history_window(id, u64::from(TURNS) * 7, None, 50)
            .await
            .unwrap()
            .is_none());
    }
    for repetition in 0..3 {
        let start_time = std::time::Instant::now();
        let events = if mode == "indexed" {
            store
                .history_window(id, u64::from(TURNS) * 7, None, 50)
                .await
                .unwrap()
                .expect("synthetic page should fit index budget")
                .events
        } else {
            let session = store.load(id).await.unwrap().unwrap();
            let mut start = session.events().len();
            let mut messages = 0;
            while start > 0 && messages < 50 {
                start -= 1;
                if matches!(
                    session.events()[start].data(),
                    EventData::UserMessage { .. }
                        | EventData::AssistantMessage { .. }
                        | EventData::ToolResult { .. }
                ) {
                    messages += 1;
                }
            }
            session.events()[start..].to_vec()
        };
        let bytes = serde_json::to_vec(&events).unwrap();
        println!("HISTORY_BENCH mode={mode} repetition={repetition} elapsed_us={} page_events={} digest={:x}", start_time.elapsed().as_micros(), events.len(), Sha256::digest(bytes));
    }
}

#[tokio::test]
async fn cold_compression_preserves_legacy_audit_and_future_appends() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    store.create(header("cold")).await.unwrap();
    let original_request = large_request();
    let first = store
        .append(
            "cold",
            Revision::ZERO,
            audited_turn(1, original_request.clone()),
        )
        .await
        .unwrap();
    store.flush("cold").await.unwrap();
    let original = store.inspect("cold").await.unwrap().unwrap();
    let before = fs::metadata(dir.session_file("cold")).unwrap().len();

    let report = store.compress_cold_session("cold").await.unwrap();
    assert!(report.changed);
    assert_eq!(report.bytes_before, before);
    assert!(report.bytes_after < before / 2);
    assert!(report.batches_compressed > 0);
    let text = fs::read_to_string(dir.session_file("cold")).unwrap();
    assert!(text.contains("\"format_version\":2"));
    assert!(text.contains("\"record\":\"batch_gzip\""));
    assert_eq!(store.inspect("cold").await.unwrap().unwrap(), original);
    assert_eq!(
        store.request_header("cold", 3).await.unwrap(),
        Some(original_request)
    );
    assert_eq!(store.list_headers().await.unwrap(), vec![header("cold")]);
    assert!(!store.compress_cold_session("cold").await.unwrap().changed);

    let appended = store
        .append(
            "cold",
            first.revision,
            vec![turn_start(2), user_message(&"new content ".repeat(4096))],
        )
        .await
        .unwrap();
    store.flush("cold").await.unwrap();
    let reopened = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    assert_eq!(
        reopened.load("cold").await.unwrap().unwrap().revision(),
        appended.revision
    );
    assert_eq!(
        reopened
            .inspect("cold")
            .await
            .unwrap()
            .unwrap()
            .events
            .len(),
        original.events.len() + 2
    );
    assert_eq!(
        reopened.request_header("cold", 3).await.unwrap(),
        store.request_header("cold", 3).await.unwrap()
    );
    // Version 2 may mix archived and newly appended ordinary batches. A
    // second migration compresses only the new batch, not gzip-on-gzip.
    let second = reopened.compress_cold_session("cold").await.unwrap();
    assert!(second.changed);
    assert_eq!(second.batches_compressed, 1);
    assert_eq!(
        reopened.load("cold").await.unwrap().unwrap().revision(),
        appended.revision
    );
}

#[tokio::test]
async fn cold_compression_rejects_corrupt_and_torn_tails_without_rewriting() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    for id in ["corrupt", "torn"] {
        store.create(header(id)).await.unwrap();
        store
            .append(id, Revision::ZERO, vec![turn_start(1)])
            .await
            .unwrap();
    }
    for (id, tail) in [
        ("corrupt", &b"not-json\n"[..]),
        ("torn", &b"{\"record\":"[..]),
    ] {
        let path = dir.session_file(id);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(tail).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(store.compress_cold_session(id).await.is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[tokio::test]
async fn compressed_batch_digest_failure_is_not_treated_as_a_torn_tail() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("digest")).await.unwrap();
    store
        .append(
            "digest",
            Revision::ZERO,
            vec![turn_start(1), user_message(&"z".repeat(32768))],
        )
        .await
        .unwrap();
    assert!(store.compress_cold_session("digest").await.unwrap().changed);
    let path = dir.session_file("digest");
    let mut rows: Vec<Value> = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    rows[1]["sha256"] = Value::String("0".repeat(64));
    let mut bytes = rows
        .iter()
        .map(|v| serde_json::to_string(v).unwrap() + "\n")
        .collect::<String>();
    bytes.pop(); // A complete but unterminated bad record must fail closed.
    fs::write(&path, bytes).unwrap();
    assert!(store.load("digest").await.is_err());
    assert!(store
        .append("digest", Revision::ZERO, vec![])
        .await
        .is_err());
}

#[tokio::test]
async fn cold_compression_serializes_with_append_and_keeps_cas() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("race")).await.unwrap();
    let first = store
        .append(
            "race",
            Revision::ZERO,
            vec![turn_start(1), user_message(&"a".repeat(65536))],
        )
        .await
        .unwrap();
    let (compressed, appended) = tokio::join!(
        store.compress_cold_session("race"),
        store.append("race", first.revision, vec![user_message("next")])
    );
    assert!(compressed.unwrap().changed);
    let appended = appended.unwrap();
    let reopened = JsonlSessionStore::new(dir.path()).unwrap();
    let final_session = reopened.load("race").await.unwrap().unwrap();
    assert_eq!(final_session.revision(), appended.revision);
    assert_eq!(final_session.events().len(), 3);
}

#[tokio::test]
async fn cold_compression_no_saving_leaves_v1_bytes_unchanged() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("small")).await.unwrap();
    store
        .append("small", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let before = fs::read(dir.session_file("small")).unwrap();
    let report = store.compress_cold_session("small").await.unwrap();
    assert!(!report.changed);
    assert_eq!(report.bytes_before, report.bytes_after);
    assert_eq!(fs::read(dir.session_file("small")).unwrap(), before);
}
#[tokio::test]
async fn request_audit_defaults_to_metadata_without_creating_blob_files() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    assert!(!store.captures_full_request_audit());
    store.create(header("metadata-only")).await.unwrap();
    let full = large_request();
    let compact = store.archive_request(full.clone()).await.unwrap();
    assert_eq!(compact.provider, full.provider);
    assert_eq!(compact.model, full.model);
    assert_eq!(compact.options["auditSnapshot"]["kind"], "omitted");
    assert_eq!(
        compact.options["auditSnapshot"]["reason"],
        "capture_disabled"
    );
    assert_eq!(compact.options["inputMessageCount"], full.input.len());
    assert_eq!(compact.options["toolCount"], full.tools.len());
    assert!(compact.input.is_empty() && compact.tools.is_empty() && compact.system.is_none());
    assert!(!dir.path().join("request-audit").exists());
    store
        .append(
            "metadata-only",
            Revision::ZERO,
            audited_turn(1, compact.clone()),
        )
        .await
        .unwrap();
    let reopened = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    assert_eq!(
        reopened.request_header("metadata-only", 3).await.unwrap(),
        Some(compact)
    );
    assert_eq!(
        reopened
            .load("metadata-only")
            .await
            .unwrap()
            .unwrap()
            .derive_messages()[0]
            .content,
        "original user fact"
    );
}

#[tokio::test]
async fn audit_archive_is_lossless_deduplicated_and_not_in_hot_history() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_request_audit_mode(RequestAuditMode::Full)
        .for_runtime();
    assert!(store.captures_full_request_audit());
    store.create(header("audit")).await.unwrap();
    let original = large_request();
    let compact = store.archive_request(original.clone()).await.unwrap();
    assert!(compact.input.is_empty());
    assert!(compact.tools.is_empty());
    assert!(compact.system.is_none());
    let archive_dir = dir.path().join("request-audit");
    let count = fs::read_dir(&archive_dir).unwrap().count();
    assert_eq!(
        store.archive_request(original.clone()).await.unwrap(),
        compact
    );
    assert_eq!(fs::read_dir(&archive_dir).unwrap().count(), count);
    store
        .append("audit", Revision::ZERO, audited_turn(1, compact))
        .await
        .unwrap();
    store.flush("audit").await.unwrap();
    assert!(fs::metadata(dir.session_file("audit")).unwrap().len() < 8192);
    let loaded = store.load("audit").await.unwrap().unwrap();
    assert_eq!(loaded.derive_messages()[0].content, "original user fact");
    assert_eq!(
        store.request_header("audit", 3).await.unwrap(),
        Some(original.clone())
    );
    assert!(store.request_header("audit", 0).await.unwrap().is_none());
    let reopened = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    assert_eq!(
        reopened.request_header("audit", 3).await.unwrap(),
        Some(original)
    );
    assert!(reopened.cache_stats().accounted_bytes < 8192);
}
#[tokio::test]
async fn legacy_audit_view_is_small_and_does_not_rewrite_disk_or_model_history() {
    let dir = TestDir::new();
    let raw = JsonlSessionStore::new(dir.path()).unwrap();
    raw.create(header("legacy")).await.unwrap();
    let original = large_request();
    raw.append("legacy", Revision::ZERO, audited_turn(1, original.clone()))
        .await
        .unwrap();
    raw.flush("legacy").await.unwrap();
    let before = fs::read(dir.session_file("legacy")).unwrap();
    let runtime = JsonlSessionStore::new(dir.path()).unwrap().for_runtime();
    let small = runtime.load("legacy").await.unwrap().unwrap();
    let full = raw.load("legacy").await.unwrap().unwrap();
    assert_eq!(small.derive_messages(), full.derive_messages());
    assert_eq!(small.revision(), full.revision());
    assert_eq!(small.next_seq(), full.next_seq());
    assert!(runtime.cache_stats().accounted_bytes < 16384);
    assert_eq!(
        runtime.request_header("legacy", 3).await.unwrap(),
        Some(original)
    );
    assert_eq!(
        runtime.inspect("legacy").await.unwrap().unwrap(),
        full.inspect()
    );
    assert_eq!(fs::read(dir.session_file("legacy")).unwrap(), before);
    runtime
        .append("legacy", small.revision(), vec![turn_start(2)])
        .await
        .unwrap();
    assert!(fs::read(dir.session_file("legacy"))
        .unwrap()
        .starts_with(&before));
}
#[tokio::test]
async fn cache_eviction_disabled_oversized_and_old_snapshot_cas_remain_correct() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_cache_limits(4096, 2);
    for id in ["a", "b", "c"] {
        store.create(header(id)).await.unwrap();
    }
    assert_eq!(store.cache_stats().entries, 2);
    assert!(store.cache_stats().accounted_bytes <= 4096);
    let old = store.load("a").await.unwrap().unwrap();
    store
        .append(
            "a",
            Revision::ZERO,
            vec![turn_start(1), user_message(&"x".repeat(65536))],
        )
        .await
        .unwrap();
    assert!(store.cache_stats().accounted_bytes <= 4096);
    assert!(old.events().is_empty());
    assert!(matches!(
        store.append("a", Revision::ZERO, vec![]).await,
        Err(StoreError::RevisionConflict { .. })
    ));
    let fresh = store.load("a").await.unwrap().unwrap();
    assert_eq!(fresh.derive_messages()[0].content.len(), 65536);
    let disabled = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_cache_limits(0, 0);
    disabled.load("a").await.unwrap();
    disabled.flush("a").await.unwrap();
    assert_eq!(disabled.cache_stats().entries, 0);
}

/// Regression for the Windows release crash in serde_json's borrowed
/// `SliceRead` string scanner. Windows exercises the owned `IoRead` containment
/// path; the other targets preserve the same recovery contract on `SliceRead`.
/// Real journals can contain multi-megabyte, escape-heavy request records and
/// must remain stable across repeated cold opens.
#[tokio::test]
async fn escape_heavy_large_record_survives_repeated_cold_recovery() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("large-owned-json")).await.unwrap();
    let fragment = r#"{"path":"C:\\deep\\folder","quote":"\"","line":"\n"}"#;
    let content = fragment.repeat(32 * 1024);
    assert!(content.len() > 1024 * 1024);
    store
        .append(
            "large-owned-json",
            Revision::ZERO,
            vec![turn_start(1), user_message(&content)],
        )
        .await
        .unwrap();
    drop(store);

    for _ in 0..16 {
        let cold = JsonlSessionStore::new(dir.path())
            .unwrap()
            .with_cache_limits(0, 0);
        let restored = cold.load("large-owned-json").await.unwrap().unwrap();
        assert_eq!(restored.derive_messages()[0].content, content);
    }
}

#[tokio::test]
async fn missing_or_corrupt_audit_is_explicit_error_but_does_not_break_conversation() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_request_audit_mode(RequestAuditMode::Full)
        .for_runtime();
    store.create(header("bad-audit")).await.unwrap();
    let h = store.archive_request(large_request()).await.unwrap();
    let key = h.options["auditSnapshot"]["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .append("bad-audit", Revision::ZERO, audited_turn(1, h))
        .await
        .unwrap();
    let manifest = dir.path().join("request-audit").join(format!("{key}.json"));
    let before = fs::read(&manifest).unwrap();
    fs::write(&manifest, b"{}").unwrap();
    assert!(store.request_header("bad-audit", 3).await.is_err());
    assert_eq!(
        store
            .load("bad-audit")
            .await
            .unwrap()
            .unwrap()
            .derive_messages()
            .len(),
        2
    );
    fs::write(&manifest, before).unwrap();
    fs::remove_file(&manifest).unwrap();
    assert!(store.request_header("bad-audit", 3).await.is_err());
    // Recovery never removes committed conversation facts merely because audit is missing.
    assert!(store.inspect("bad-audit").await.unwrap().is_some());
}
#[tokio::test]
async fn complete_unknown_unterminated_record_is_not_a_torn_tail() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("unknown")).await.unwrap();
    store
        .append("unknown", Revision::ZERO, vec![turn_start(1)])
        .await
        .unwrap();
    let p = dir.session_file("unknown");
    let data = fs::read_to_string(&p)
        .unwrap()
        .replace("turn/start", "turn/future");
    let data = data.trim_end();
    fs::write(&p, data).unwrap();
    assert!(store.load("unknown").await.is_err());
    assert!(store
        .append("unknown", Revision::ZERO, vec![])
        .await
        .is_err());
    assert_eq!(fs::read_to_string(p).unwrap(), data);
}
#[cfg(unix)]
#[tokio::test]
async fn audit_directory_symlink_is_rejected_without_writing_outside() {
    let dir = TestDir::new();
    let outside = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_request_audit_mode(RequestAuditMode::Full);
    std::os::unix::fs::symlink(outside.path(), dir.path().join("request-audit")).unwrap();
    assert!(store.archive_request(large_request()).await.is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn switching_to_runtime_drops_existing_full_audit_cache() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path()).unwrap();
    store.create(header("switch")).await.unwrap();
    store
        .append("switch", Revision::ZERO, audited_turn(1, large_request()))
        .await
        .unwrap();
    assert!(store.cache_stats().accounted_bytes > 100000);
    let store = store.for_runtime();
    assert_eq!(store.cache_stats().entries, 0);
    store.load("switch").await.unwrap();
    assert!(store.cache_stats().accounted_bytes < 16384);
}

#[tokio::test]
async fn audit_offsets_survive_cache_hit_eviction_and_unterminated_last_record() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_request_audit_mode(RequestAuditMode::Full)
        .for_runtime();
    store.create(header("offset")).await.unwrap();
    let h = large_request();
    let compact = store.archive_request(h.clone()).await.unwrap();
    let r = store
        .append("offset", Revision::ZERO, audited_turn(1, compact.clone()))
        .await
        .unwrap();
    let p = dir.session_file("offset");
    let mut bytes = fs::read(&p).unwrap();
    assert_eq!(bytes.pop(), Some(b'\n'));
    fs::write(&p, &bytes).unwrap();
    // Appending must account for the newline separating the prior record.
    store
        .append("offset", r.revision, audited_turn(2, compact))
        .await
        .unwrap();
    assert_eq!(
        store.request_header("offset", 10).await.unwrap(),
        Some(h.clone())
    );
    let uncached = JsonlSessionStore::new(dir.path())
        .unwrap()
        .for_runtime()
        .with_cache_limits(0, 0);
    assert_eq!(
        uncached.request_header("offset", 10).await.unwrap(),
        Some(h)
    );
}

#[tokio::test]
async fn audit_preserves_multimodal_opaque_reasoning_and_crlf_legacy_history() {
    let dir = TestDir::new();
    let store = JsonlSessionStore::new(dir.path())
        .unwrap()
        .with_request_audit_mode(RequestAuditMode::Full)
        .for_runtime();
    store.create(header("opaque")).await.unwrap();
    let mut h = large_request();
    h.input[0].content_blocks = vec![xharness_session::ContentBlock::Image {
        attachment: xharness_session::AttachmentRef {
            id: "image-ref".into(),
            session_id: "opaque".into(),
            media_type: "image/png".into(),
            bytes: 128,
            width: 20,
            height: 30,
        },
    }];
    let mut reasoning = Message::assistant("");
    reasoning.provider_items =
        vec![serde_json::json!({"type":"reasoning","encrypted_content":"opaque-provider-value"})];
    h.input.push(reasoning);
    let archived = store.archive_request(h.clone()).await.unwrap();
    store
        .append("opaque", Revision::ZERO, audited_turn(1, archived))
        .await
        .unwrap();
    let path = dir.session_file("opaque");
    let text = fs::read_to_string(&path).unwrap().replace('\n', "\r\n");
    fs::write(&path, &text).unwrap();
    assert_eq!(store.request_header("opaque", 3).await.unwrap(), Some(h));
    assert_eq!(
        store
            .load("opaque")
            .await
            .unwrap()
            .unwrap()
            .derive_messages()
            .len(),
        2
    );
    assert_eq!(fs::read_to_string(path).unwrap(), text);
}
