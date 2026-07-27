#![cfg(target_os = "linux")]
#[path = "../../xharness-cloud/tests/common/mod.rs"]
mod common;
use common::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::{Child, Command};
use xharness_cloud::*;
use xharness_cloud_app::*;
struct Fixture {
    root: PathBuf,
    journal: NativePermitJournal,
    spec: NativePermitBinding,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "xh-native-gate-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::create_dir(root.join("state")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let journal = NativePermitJournal::open(&root.join("permit")).unwrap();
        let mut binding = accepted(&store()).binding;
        binding.host_build_ref.version = id(host_sha());
        let spec = NativePermitBinding {
            binding,
            workspace: root.join("workspace").to_str().unwrap().into(),
            state_dir: root.join("state").to_str().unwrap().into(),
        };
        journal.initialize(spec.clone()).unwrap();
        Self {
            root,
            journal,
            spec,
        }
    }
    fn transition(&self, name: &str, to: ExecutionPermit) {
        let s = self.journal.snapshot().unwrap();
        self.journal
            .transition(&NativePermitCommand {
                operation_id: id(name),
                scope: s.permit.scope,
                expected_revision: s.permit.revision,
                to,
            })
            .unwrap();
    }
    fn spawn(&self) -> Child {
        self.spawn_extra(&[])
    }
    fn spawn_extra(&self, extra: &[&str]) -> Child {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xharness-host"));
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.root)
            .env("TOKIO_WORKER_THREADS", "2")
            .args([
                "--bind",
                "127.0.0.1:0",
                "--workspace",
                &self.spec.workspace,
                "--state-dir",
                &self.spec.state_dir,
                "--hosted-permit-dir",
                self.root.join("permit").to_str().unwrap(),
                "--model",
                "unconfigured",
                "--ready-file",
                self.root.join("ready").to_str().unwrap(),
                "--shutdown-file",
                self.root.join("stop").to_str().unwrap(),
            ])
            .args(extra)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);
        command.spawn().unwrap()
    }
    async fn ready(&self, child: &mut Child) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .no_proxy()
            .build()
            .unwrap();
        // The test executable is a very large unoptimized debug build. Its
        // SHA attestation is intentional; release startup has a different budget.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "Host exited before Ready"
            );
            if let Ok(address) = fs::read_to_string(self.root.join("ready")) {
                if client
                    .get(format!("http://{address}/health/ready"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    return;
                }
            }
            assert!(tokio::time::Instant::now() < deadline, "Host Ready timeout");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn exit(&self, child: &mut Child, success: bool) {
        let status = tokio::time::timeout(Duration::from_secs(120), child.wait())
            .await
            .expect("native exit timeout")
            .unwrap();
        assert_eq!(status.success(), success);
    }
    async fn stop(&self, child: &mut Child) {
        fs::write(self.root.join("stop"), b"stop").unwrap();
        self.exit(child, true).await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn host_sha() -> &'static str {
    static SHA: OnceLock<String> = OnceLock::new();
    SHA.get_or_init(|| {
        let mut file = fs::File::open(env!("CARGO_BIN_EXE_xharness-host")).unwrap();
        let mut buffer = [0u8; 65536];
        let mut digest = Sha256::new();
        loop {
            let n = file.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        format!("{:x}", digest.finalize())
    })
}
#[tokio::test]
async fn prepared_stays_dormant_activation_runs_original_host_and_seal_prevents_restart() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(child.try_wait().unwrap().is_none());
    assert!(!fixture.root.join("ready").exists());
    assert!(!fixture.root.join("state/control").exists());
    assert!(!fixture.root.join("state/sessions").exists());
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(0)
    );
    fixture.transition("activate", ExecutionPermit::Active);
    fixture.ready(&mut child).await;
    assert_eq!(
        fixture.journal.launch(Counter(1)).unwrap().phase,
        NativeLaunchPhase::Ready
    );
    fixture.transition("cancel", ExecutionPermit::Sealed);
    fixture.exit(&mut child, true).await;
    let receipt = fixture.journal.launch(Counter(1)).unwrap();
    assert_eq!(receipt.phase, NativeLaunchPhase::Stopped);
    assert_eq!(
        receipt.shutdown.unwrap(),
        NativeShutdownOutcome {
            sealed: true,
            runtime_graceful: true,
            forced_workers: 0,
            cleanup_errors: 0
        }
    );
    let mut restarted = fixture.spawn();
    fixture.exit(&mut restarted, false).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(1)
    );
}
#[tokio::test]
async fn temporary_native_stop_and_restart_preserve_active_permit_and_state() {
    let fixture = Fixture::new();
    fixture.transition("activate", ExecutionPermit::Active);
    let mut first = fixture.spawn();
    fixture.ready(&mut first).await;
    fs::write(fixture.root.join("workspace/canary"), b"retained").unwrap();
    fixture.stop(&mut first).await;
    assert!(
        !fixture
            .journal
            .launch(Counter(1))
            .unwrap()
            .shutdown
            .unwrap()
            .sealed
    );
    let mut second = fixture.spawn();
    fixture.ready(&mut second).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(2)
    );
    assert_eq!(
        fs::read(fixture.root.join("workspace/canary")).unwrap(),
        b"retained"
    );
    fixture.stop(&mut second).await;
}
#[tokio::test]
async fn abrupt_native_exit_is_not_invented_stop_proof_and_restart_is_fenced() {
    let fixture = Fixture::new();
    fixture.transition("activate", ExecutionPermit::Active);
    let mut child = fixture.spawn();
    fixture.ready(&mut child).await;
    child.kill().await.unwrap();
    let receipt = fixture.journal.launch(Counter(1)).unwrap();
    assert_eq!(receipt.phase, NativeLaunchPhase::Ready);
    assert!(receipt.shutdown.is_none());
    let mut retry = fixture.spawn();
    fixture.exit(&mut retry, false).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(1)
    );
}
#[tokio::test]
async fn prepared_termination_does_not_claim_native_execution() {
    let fixture = Fixture::new();
    let mut child = fixture.spawn();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let status = std::process::Command::new("kill")
        .args(["-TERM", &child.id().unwrap().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    fixture.exit(&mut child, true).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(0)
    );
    assert!(!fixture.root.join("state/control").exists());
}
#[tokio::test]
async fn wrong_workspace_is_rejected_before_provider_bootstrap_or_restore() {
    let fixture = Fixture::new();
    fixture.transition("activate", ExecutionPermit::Active);
    let other = fixture.root.join("other");
    fs::create_dir(&other).unwrap();
    let bad = fixture.root.join("providers.json");
    fs::write(&bad, "this invalid provider must not be read").unwrap();
    let mut child = fixture.spawn_extra(&[
        "--workspace",
        other.to_str().unwrap(),
        "--providers-file",
        bad.to_str().unwrap(),
    ]);
    fixture.exit(&mut child, false).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(0)
    );
    assert!(!fixture.root.join("state/control").exists());
    assert!(!fixture.root.join("state/debug").exists());
}
#[tokio::test]
async fn hosted_listener_cannot_expose_ungated_remote_service() {
    let fixture = Fixture::new();
    fixture.transition("activate", ExecutionPermit::Active);
    let mut child = fixture.spawn_extra(&["--bind", "0.0.0.0:0"]);
    fixture.exit(&mut child, false).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(0)
    );
    assert!(!fixture.root.join("ready").exists());
}

struct FakeModel {
    address: String,
    requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for FakeModel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl FakeModel {
    async fn new() -> Self {
        use std::sync::atomic::AtomicUsize;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let count = count.clone();
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut buf = [0u8; 8192];
                    loop {
                        let n = socket.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        data.extend_from_slice(&buf[..n]);
                        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&data[..end]).to_lowercase();
                            let length: usize = headers
                                .lines()
                                .find_map(|s| {
                                    s.strip_prefix("content-length:")
                                        .and_then(|s| s.trim().parse().ok())
                                })
                                .unwrap();
                            if data.len() >= end + 4 + length {
                                break;
                            }
                        }
                        assert!(data.len() < 1024 * 1024);
                    }
                    let index = count.fetch_add(1, Ordering::SeqCst);
                    let delta = if index == 0 {
                        serde_json::json!({"tool_calls":[{"index":0,"id":"report-1","type":"function","function":{"name":"goal","arguments":serde_json::json!({"action":"report","report":{"status":"complete","summary":"Verified fixture","remaining":[],"evidence":[{"kind":"artifact","reference":"fixture.txt"}]}}).to_string()}}]})
                    } else {
                        serde_json::json!({"content":"Fixture verified."})
                    };
                    let stream = format!(
                        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        serde_json::json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                        serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":if index==0 {"tool_calls"}else{"stop"}}]})
                    );
                    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",stream.len(),stream);
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        Self {
            address,
            requests,
            task,
        }
    }
}
impl Fixture {
    fn bootstrap_file(&self) -> PathBuf {
        use xharness_host::{GoalBootstrapSpec, PermissionPreset};
        use xharness_host_app::hosted_bootstrap::HostedGoalBootstrap;
        let bootstrap = HostedGoalBootstrap {
            scope: self.spec.binding.scope.clone(),
            task_spec: {
                let mut spec = common::spec();
                spec.objective =
                    "Verify fixture.txt exists, report with concrete artifact evidence.".into();
                spec.acceptance_criteria = vec!["Fixture exists".into()];
                spec
            },
            goal: GoalBootstrapSpec {
                operation_id: "bootstrap-prepare".into(),
                session_id: self.spec.binding.root_session_id.as_str().into(),
                goal_id: "stable-goal".into(),
                objective: "Verify fixture.txt exists, report with concrete artifact evidence."
                    .into(),
                acceptance_criteria: vec!["Fixture exists".into()],
                max_goal_rounds: 10000,
                created_at_ms: 123,
                workspace: self.spec.workspace.clone(),
                provider: "fake".into(),
                model: "fake-model".into(),
                reasoning_effort: None,
                context_window_tokens: Some(32768),
                permission: PermissionPreset::DangerFullAccess,
            },
        };
        let path = self.root.join("permit/bootstrap.json");
        fs::write(&path, serde_json::to_vec(&bootstrap).unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    fn spawn_bootstrap(&self, model: &FakeModel) -> Child {
        let path = self.bootstrap_file();
        self.spawn_extra(&[
            "--hosted-bootstrap-file",
            path.to_str().unwrap(),
            "--provider",
            "fake",
            "--model",
            "fake-model",
            "--base-url",
            &model.address,
            "--context-window",
            "32768",
        ])
    }
    async fn prepared_ready(&self, child: &mut Child, generation: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "bootstrap exited before PreparedReady"
            );
            if self
                .journal
                .launch(Counter(generation))
                .is_ok_and(|s| s.phase == NativeLaunchPhase::PreparedReady)
            {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "PreparedReady timeout"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn goal_count(&self) -> usize {
        use xharness_session::Store;
        let store =
            xharness_session_jsonl::JsonlSessionStore::new(self.root.join("state/sessions"))
                .unwrap();
        let session = store
            .load(self.spec.binding.root_session_id.as_str())
            .await
            .unwrap()
            .unwrap();
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), xharness_session::EventData::GoalChange { change:xharness_session::GoalChange::Snapshot(change) } if change.operation == xharness_session::GoalSnapshotOperation::Create))
            .count()
    }
}
#[tokio::test]
async fn full_prepared_bootstrap_is_gated_and_goal_is_not_recreated_on_restart() {
    let fixture = Fixture::new();
    let model = FakeModel::new().await;
    fs::write(fixture.root.join("workspace/fixture.txt"), "verified").unwrap();
    let mut first = fixture.spawn_bootstrap(&model);
    fixture.prepared_ready(&mut first, 1).await;
    assert_eq!(model.requests.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.goal_count().await, 1);
    let address = fs::read_to_string(fixture.root.join("ready")).unwrap();
    let response = reqwest::Client::new()
        .get(format!("http://{address}/health/ready"))
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    fixture.stop(&mut first).await;
    let _ = fs::remove_file(fixture.root.join("stop"));
    let _ = fs::remove_file(fixture.root.join("ready"));
    let mut second = fixture.spawn_bootstrap(&model);
    fixture.prepared_ready(&mut second, 2).await;
    assert_eq!(fixture.goal_count().await, 1);
    assert_eq!(model.requests.load(Ordering::SeqCst), 0);
    fixture.transition("activate-bootstrap", ExecutionPermit::Active);
    fixture.ready(&mut second).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while model.requests.load(Ordering::SeqCst) < 2 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "original Goal runtime never woke"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fixture.goal_count().await, 1);
    fixture.stop(&mut second).await;
    let before = model.requests.load(Ordering::SeqCst);
    let _ = fs::remove_file(fixture.root.join("stop"));
    let _ = fs::remove_file(fixture.root.join("ready"));
    let mut third = fixture.spawn_bootstrap(&model);
    fixture.ready(&mut third).await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(fixture.goal_count().await, 1);
    assert_eq!(
        model.requests.load(Ordering::SeqCst),
        before,
        "confirmation-waiting Goal must not restart its work"
    );
    fixture.transition("seal-bootstrap", ExecutionPermit::Sealed);
    fixture.exit(&mut third, true).await;
}
#[tokio::test]
async fn seal_prepared_ready_cleans_original_runtime_and_forbids_restart() {
    let fixture = Fixture::new();
    let model = FakeModel::new().await;
    let mut child = fixture.spawn_bootstrap(&model);
    fixture.prepared_ready(&mut child, 1).await;
    fixture.transition("seal-prepared", ExecutionPermit::Sealed);
    fixture.exit(&mut child, true).await;
    assert!(
        fixture
            .journal
            .launch(Counter(1))
            .unwrap()
            .shutdown
            .unwrap()
            .runtime_graceful
    );
    assert_eq!(model.requests.load(Ordering::SeqCst), 0);
    let mut retry = fixture.spawn_bootstrap(&model);
    fixture.exit(&mut retry, false).await;
    assert_eq!(fixture.goal_count().await, 1);
}

#[tokio::test]
async fn bootstrap_refuses_foreign_root_before_claiming_or_requesting_model() {
    use xharness_session::{SessionHeader, Store};
    let fixture = Fixture::new();
    let model = FakeModel::new().await;
    let store = xharness_session_jsonl::JsonlSessionStore::new(fixture.root.join("state/sessions"))
        .unwrap();
    store
        .create(SessionHeader {
            version: 1,
            id: fixture.spec.binding.root_session_id.as_str().into(),
            created_at_ms: 123,
            cwd: Some(fixture.spec.workspace.clone()),
        })
        .await
        .unwrap();
    let mut child = fixture.spawn_bootstrap(&model);
    fixture.exit(&mut child, false).await;
    assert_eq!(
        fixture.journal.snapshot().unwrap().launch_generation,
        Counter(0)
    );
    assert!(fixture.journal.bootstrap().unwrap().is_none());
    assert_eq!(model.requests.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn deleted_applied_goal_is_not_silently_recreated_on_restart() {
    let fixture = Fixture::new();
    let model = FakeModel::new().await;
    let mut first = fixture.spawn_bootstrap(&model);
    fixture.prepared_ready(&mut first, 1).await;
    fixture.stop(&mut first).await;
    let _ = fs::remove_file(fixture.root.join("stop"));
    fs::remove_file(fixture.root.join("state/sessions").join(format!(
        "{}.jsonl",
        fixture.spec.binding.root_session_id.as_str()
    )))
    .unwrap();
    let mut retry = fixture.spawn_bootstrap(&model);
    fixture.exit(&mut retry, false).await;
    assert!(!fixture
        .root
        .join("state/sessions")
        .join(format!(
            "{}.jsonl",
            fixture.spec.binding.root_session_id.as_str()
        ))
        .exists());
    assert_eq!(model.requests.load(Ordering::SeqCst), 0);
    // No fabricated Stop proof after boot corruption: external reconciliation.
    let head = fixture.journal.snapshot().unwrap();
    assert_eq!(
        fixture
            .journal
            .launch(head.launch_generation)
            .unwrap()
            .phase,
        NativeLaunchPhase::Starting
    );
}
