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
    EventData, Message, Revision, SessionEvent, SessionHeader, Store, StoreError,
};
use xharness_session_jsonl::JsonlSessionStore;

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
