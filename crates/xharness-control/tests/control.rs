use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    process::Command,
    sync::{atomic::AtomicU64, atomic::Ordering, Arc},
    thread,
    time::Duration,
};

use serde_json::json;
use xharness_control::{
    mutation_fingerprint, ControlError, ControlEvent, ControlRevision, ControlStore,
    JsonlControlStore, MemoryControlStore, MutationReceipt, SettingsSnapshot, WorkspaceSnapshot,
};

struct TestDir(PathBuf);

static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-control-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn workspace(title: &str) -> WorkspaceSnapshot {
    WorkspaceSnapshot {
        workspace_id: "workspace-1".to_owned(),
        path: "/workspace".to_owned(),
        title: title.to_owned(),
        session_order: vec!["session-1".to_owned()],
        created_at: "1".to_owned(),
        updated_at: "2".to_owned(),
    }
}

fn receipt(id: &str, method: &str, payload: serde_json::Value) -> MutationReceipt {
    MutationReceipt {
        rpc_id: id.to_owned(),
        method: method.to_owned(),
        fingerprint: mutation_fingerprint(method, &payload),
        response: json!({"accepted": true}),
    }
}

#[tokio::test]
async fn state_and_generic_receipt_commit_in_one_cas_batch() {
    let store = MemoryControlStore::default();
    let committed = store
        .append(
            ControlRevision::ZERO,
            vec![
                ControlEvent::WorkspaceDefined {
                    workspace: workspace("Project"),
                },
                ControlEvent::WorkspaceOrderSet {
                    workspace_ids: vec!["workspace-1".to_owned()],
                },
                ControlEvent::MutationCommitted {
                    receipt: receipt("rpc-1", "workspace.create", json!({"path": "/workspace"})),
                },
            ],
        )
        .await
        .unwrap();
    assert_eq!(committed.revision, ControlRevision(1));
    assert_eq!(committed.events.len(), 3);
    let projection = store.load().await.unwrap().projection().unwrap();
    assert_eq!(projection.workspaces["workspace-1"].title, "Project");
    assert_eq!(projection.workspace_order.unwrap(), ["workspace-1"]);
    assert_eq!(projection.receipts["rpc-1"].method, "workspace.create");

    let stale = store
        .append(
            ControlRevision::ZERO,
            vec![ControlEvent::MutationCommitted {
                receipt: receipt("rpc-2", "workspace.rename", json!({})),
            }],
        )
        .await
        .unwrap_err();
    assert_eq!(
        stale,
        ControlError::RevisionConflict {
            expected: ControlRevision::ZERO,
            actual: ControlRevision(1),
        }
    );
}

#[tokio::test]
async fn settings_are_revisioned_and_credentials_fail_closed() {
    let store = MemoryControlStore::default();
    store
        .append(
            ControlRevision::ZERO,
            vec![
                ControlEvent::SettingsSet {
                    settings: SettingsSnapshot {
                        namespace: "permission".to_owned(),
                        user: json!({"defaultPreset": "danger-full-access"}),
                        value: json!({"defaultPreset": "danger-full-access"}),
                        revision: 1,
                    },
                },
                ControlEvent::MutationCommitted {
                    receipt: receipt("rpc-settings", "settings.replace", json!({})),
                },
            ],
        )
        .await
        .unwrap();
    let secret = store
        .append(
            ControlRevision(1),
            vec![
                ControlEvent::SettingsSet {
                    settings: SettingsSnapshot {
                        namespace: "provider".to_owned(),
                        user: json!({"apiKey": "must-not-persist"}),
                        value: json!({"apiKey": "must-not-persist"}),
                        revision: 1,
                    },
                },
                ControlEvent::MutationCommitted {
                    receipt: receipt("rpc-secret", "settings.replace", json!({})),
                },
            ],
        )
        .await
        .unwrap_err();
    assert!(matches!(secret, ControlError::InvalidLog { message } if message.contains("apiKey")));
    assert_eq!(store.load().await.unwrap().revision(), ControlRevision(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jsonl_round_trip_torn_tail_and_cross_instance_cas() {
    let dir = TestDir::new();
    let first = Arc::new(JsonlControlStore::new(&dir.0).unwrap());
    let second = Arc::new(JsonlControlStore::new(&dir.0).unwrap());
    let batch = vec![
        ControlEvent::WorkspaceDefined {
            workspace: workspace("Project"),
        },
        ControlEvent::MutationCommitted {
            receipt: receipt("rpc-jsonl", "workspace.create", json!({})),
        },
    ];
    let left = {
        let store = Arc::clone(&first);
        let events = batch.clone();
        tokio::spawn(async move { store.append(ControlRevision::ZERO, events).await })
    };
    let right = {
        let store = Arc::clone(&second);
        tokio::spawn(async move { store.append(ControlRevision::ZERO, batch).await })
    };
    let outcomes = [left.await.unwrap(), right.await.unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    first.flush().await.unwrap();
    assert_eq!(
        first.load().await.unwrap().projection().unwrap().workspaces["workspace-1"].title,
        "Project"
    );

    let path = dir.0.join("host-control.jsonl");
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"record\":\"batch\"")
        .unwrap();
    let recovered = JsonlControlStore::new(&dir.0)
        .unwrap()
        .load()
        .await
        .unwrap();
    assert_eq!(recovered.revision(), ControlRevision(1));

    first
        .append(
            ControlRevision(1),
            vec![ControlEvent::MutationCommitted {
                receipt: receipt("rpc-after-torn", "workspace.rename", json!({})),
            }],
        )
        .await
        .unwrap();
    assert_eq!(first.load().await.unwrap().revision(), ControlRevision(2));

    let secret = first
        .append(
            ControlRevision(2),
            vec![
                ControlEvent::SettingsSet {
                    settings: SettingsSnapshot {
                        namespace: "provider".to_owned(),
                        user: json!({"apiToken": "must-not-persist"}),
                        value: json!({"apiToken": "must-not-persist"}),
                        revision: 1,
                    },
                },
                ControlEvent::MutationCommitted {
                    receipt: receipt("rpc-secret", "settings.replace", json!({})),
                },
            ],
        )
        .await
        .unwrap_err();
    assert!(matches!(secret, ControlError::InvalidLog { .. }));
    let raw = fs::read_to_string(path).unwrap();
    assert!(!raw.contains("must-not-persist"));
    assert_eq!(first.load().await.unwrap().revision(), ControlRevision(2));
}

#[test]
fn subprocess_append_worker() {
    let Ok(root) = std::env::var("XHARNESS_CONTROL_WORKER_ROOT") else {
        return;
    };
    let result_path = PathBuf::from(
        std::env::var_os("XHARNESS_CONTROL_WORKER_RESULT").expect("worker result path"),
    );
    let ready_path = PathBuf::from(
        std::env::var_os("XHARNESS_CONTROL_WORKER_READY").expect("worker ready path"),
    );
    let rpc_id = std::env::var("XHARNESS_CONTROL_WORKER_RPC_ID").expect("worker rpc id");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    fs::write(ready_path, b"ready").unwrap();
    let result = runtime.block_on(async {
        JsonlControlStore::new(root)
            .unwrap()
            .append(
                ControlRevision::ZERO,
                vec![ControlEvent::MutationCommitted {
                    receipt: receipt(&rpc_id, "workspace.create", json!({})),
                }],
            )
            .await
    });
    let outcome = match result {
        Ok(_) => "ok",
        Err(ControlError::RevisionConflict { .. }) => "revision_conflict",
        Err(error) => panic!("unexpected worker append error: {error}"),
    };
    fs::write(result_path, outcome).unwrap();
}

#[tokio::test]
async fn cross_process_file_lock_makes_control_cas_atomic() {
    let dir = TestDir::new();
    let lock_path = dir.0.join("host-control.lock");
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .unwrap();
    fs2::FileExt::lock_exclusive(&lock_file).unwrap();

    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    let mut result_paths = Vec::new();
    let mut ready_paths = Vec::new();
    for worker in [1u32, 2u32] {
        let result_path = dir.0.join(format!("worker-{worker}.result"));
        let ready_path = dir.0.join(format!("worker-{worker}.ready"));
        let child = Command::new(&executable)
            .args([
                "--exact",
                "subprocess_append_worker",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("XHARNESS_CONTROL_WORKER_ROOT", &dir.0)
            .env("XHARNESS_CONTROL_WORKER_RESULT", &result_path)
            .env("XHARNESS_CONTROL_WORKER_READY", &ready_path)
            .env(
                "XHARNESS_CONTROL_WORKER_RPC_ID",
                format!("rpc-worker-{worker}"),
            )
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
            "workers did not reach the control append barrier"
        );
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(50));
    for child in &mut children {
        assert!(
            child.try_wait().unwrap().is_none(),
            "worker bypassed the inter-process control lock"
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
    let loaded = JsonlControlStore::new(&dir.0)
        .unwrap()
        .load()
        .await
        .unwrap();
    assert_eq!(loaded.revision(), ControlRevision(1));
    assert_eq!(loaded.events().len(), 1);
}

#[tokio::test]
async fn jsonl_rejects_middle_corruption_instead_of_silently_truncating() {
    let dir = TestDir::new();
    let store = JsonlControlStore::new(&dir.0).unwrap();
    store
        .append(
            ControlRevision::ZERO,
            vec![
                ControlEvent::WorkspaceDefined {
                    workspace: workspace("Project"),
                },
                ControlEvent::MutationCommitted {
                    receipt: receipt("rpc-1", "workspace.create", json!({})),
                },
            ],
        )
        .await
        .unwrap();
    store.flush().await.unwrap();

    let path = dir.0.join("host-control.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    let split = original.find('\n').unwrap() + 1;
    let corrupt = format!("{}not-json\n{}", &original[..split], &original[split..]);
    fs::write(&path, corrupt).unwrap();

    let error = store.load().await.unwrap_err();
    assert!(
        matches!(error, ControlError::Backend { message } if message.contains("decode control batch"))
    );
}

#[cfg(unix)]
#[tokio::test]
async fn jsonl_rejects_a_symlinked_log_file() {
    use std::os::unix::fs::symlink;

    let dir = TestDir::new();
    let outside = dir.0.join("outside.jsonl");
    fs::write(&outside, b"outside").unwrap();
    symlink(&outside, dir.0.join("host-control.jsonl")).unwrap();

    let store = JsonlControlStore::new(&dir.0).unwrap();
    let error = store.load().await.unwrap_err();
    assert!(
        matches!(error, ControlError::Backend { message } if message.contains("symbolic link"))
    );
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
}
