//! A/B contract experiment over the real ScheduleManager and JobRegistry.
//! Synthetic producers are explicit; only the smoke test starts a real shell.
//! This adapter has no production tool schema, permissions or Host wiring.
use super::*;
use async_trait::async_trait;
use futures::stream;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicI64, AtomicUsize},
    time::Instant,
};
use xharness_agent::{AgentRegistry, MemoryLeaseManager, TurnRequestFactory};
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_jobs::{
    JobCancel, JobEventKind, JobLease, JobOutcome, JobOutputCursor, JobRead, JobRegistry,
    JobRegistryConfig, JobStatus,
};
use xharness_session::{MemorySessionStore, SessionHeader};
use xharness_session_jsonl::JsonlSessionStore;

#[derive(Clone, Copy, Debug)]
enum Arm {
    Separate,
    Unified,
}
const ARMS: [Arm; 2] = [Arm::Separate, Arm::Unified];

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire)
    }
}

/// Definitions and occurrences deliberately have different identity domains.
#[derive(Clone, Debug)]
enum Ticket {
    Run(String),
    Plan(String),
}
impl Ticket {
    fn id(&self) -> &str {
        match self {
            Self::Run(id) | Self::Plan(id) => id,
        }
    }
}
enum Definition {
    NowProcess { label: String, cancel: JobCancel },
    ScheduledAgent(AutomationCommand),
}
enum Admission {
    Run(Ticket, JobLease),
    Plan(Ticket),
}

/// B: one typed entry, two unchanged lifecycle drivers, authenticated owner.
#[derive(Clone)]
struct UnifiedJobs {
    owner: Arc<str>,
    jobs: JobRegistry,
    schedules: Arc<ScheduleManager>,
}
impl UnifiedJobs {
    async fn create(&self, definition: Definition) -> Result<Admission, String> {
        match definition {
            Definition::NowProcess { label, cancel } => {
                let (id, lease) = self
                    .jobs
                    .reserve(self.owner.as_ref(), "bash", label, None)
                    .and_then(|r| r.commit(None, cancel))
                    .map_err(|e| e.to_string())?;
                Ok(Admission::Run(Ticket::Run(id.to_string()), lease))
            }
            Definition::ScheduledAgent(command) => {
                if !matches!(command, AutomationCommand::Create { .. }) {
                    return Err("create requires a create definition".into());
                }
                let value = self
                    .schedules
                    .execute(&self.owner, "lab-create", command)
                    .await;
                let id = value["id"].as_str().ok_or_else(|| value.to_string())?;
                Ok(Admission::Plan(Ticket::Plan(id.to_owned())))
            }
        }
    }
    fn output(&self, run: &Ticket, cursor: &JobOutputCursor) -> Result<JobRead, String> {
        match run {
            Ticket::Run(id) => self
                .jobs
                .read_since(&self.owner, id, cursor)
                .map_err(|e| e.to_string()),
            Ticket::Plan(_) => Err("choose a run_id; a recurring plan has no single output".into()),
        }
    }
    async fn control(&self, ticket: &Ticket, action: &str) -> Value {
        match ticket {
            Ticket::Run(id) if action == "cancel" => match self.jobs.kill(&self.owner, id, None) {
                Ok(value) => json!({"result":value}),
                Err(error) => json!({"error":error.to_string()}),
            },
            Ticket::Run(_) => json!({"error":"process runs do not have recurring-plan controls"}),
            Ticket::Plan(id) => {
                let action = if action == "cancel" { "delete" } else { action };
                let command = serde_json::from_value(json!({"action":action,"id":id})).unwrap();
                self.schedules
                    .execute(&self.owner, "lab-control", command)
                    .await
            }
        }
    }
}

/// A calls the original APIs directly. B goes through the unified adapter.
struct Lab {
    arm: Arm,
    store: Arc<dyn Store>,
    clock: Arc<TestClock>,
    unified: UnifiedJobs,
}
impl Lab {
    async fn new(arm: Arm, limit: usize) -> Self {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        store.create(SessionHeader::new("root")).await.unwrap();
        Self::from_store(arm, store, limit)
    }
    fn from_store(arm: Arm, store: Arc<dyn Store>, limit: usize) -> Self {
        let clock = Arc::new(TestClock(AtomicI64::new(0)));
        let schedules = ScheduleManager::with_clock(store.clone(), clock.clone());
        let jobs = JobRegistry::new(JobRegistryConfig {
            max_concurrent_jobs_per_owner: limit,
            ..JobRegistryConfig::default()
        });
        Self {
            arm,
            store,
            clock,
            unified: UnifiedJobs {
                owner: "root".into(),
                jobs,
                schedules,
            },
        }
    }
    async fn run(&self, cancel: JobCancel) -> Result<(Ticket, JobLease), String> {
        match self.arm {
            Arm::Separate => {
                let (id, lease) = self
                    .unified
                    .jobs
                    .reserve("root", "bash", "lab process", None)
                    .and_then(|r| r.commit(None, cancel))
                    .map_err(|e| e.to_string())?;
                Ok((Ticket::Run(id.to_string()), lease))
            }
            Arm::Unified => match self
                .unified
                .create(Definition::NowProcess {
                    label: "lab process".into(),
                    cancel,
                })
                .await?
            {
                Admission::Run(id, lease) => Ok((id, lease)),
                Admission::Plan(_) => unreachable!(),
            },
        }
    }
    async fn plan(&self, key: &str, every: bool) -> Ticket {
        let mut value = json!({"action":"create","prompt":"authorized fixture check","mode":"task","idempotency_key":key});
        value[if every {
            "every_seconds"
        } else {
            "after_seconds"
        }] = json!(if every { 300 } else { 1 });
        let command = serde_json::from_value(value).unwrap();
        match self.arm {
            Arm::Separate => {
                let v = self
                    .unified
                    .schedules
                    .execute("root", "lab-create", command)
                    .await;
                Ticket::Plan(v["id"].as_str().unwrap().to_owned())
            }
            Arm::Unified => match self
                .unified
                .create(Definition::ScheduledAgent(command))
                .await
                .unwrap()
            {
                Admission::Plan(id) => id,
                Admission::Run(_, _) => unreachable!(),
            },
        }
    }
    fn output(&self, ticket: &Ticket, cursor: &JobOutputCursor) -> JobRead {
        match self.arm {
            Arm::Separate => self
                .unified
                .jobs
                .read_since("root", ticket.id(), cursor)
                .unwrap(),
            Arm::Unified => self.unified.output(ticket, cursor).unwrap(),
        }
    }
    async fn control(&self, ticket: &Ticket, action: &str) -> Value {
        match self.arm {
            Arm::Unified => self.unified.control(ticket, action).await,
            Arm::Separate => match ticket {
                Ticket::Run(id) => json!({"result":self.unified.jobs.kill("root", id, None).unwrap()}),
                Ticket::Plan(id) => self.unified.schedules.execute("root", "lab-control",
                    serde_json::from_value(json!({"action":if action == "cancel" { "delete" } else { action },"id":id})).unwrap()).await,
            },
        }
    }
    async fn view(&self, plan: &Ticket) -> Value {
        self.control(plan, "view").await
    }
    async fn bind(&self, provider: Arc<TestProvider>) -> (DurableAgentHandle, Arc<ScheduleOwner>) {
        let registry =
            AgentRegistry::new(self.store.clone(), Arc::new(MemoryLeaseManager::default()));
        let handle = DurableAgentHandle::start(
            registry.activate(SessionHeader::new("root")).await.unwrap(),
            Arc::new(TestFactory(provider)),
            64,
        );
        let owner = self.unified.schedules.owner("root").await.unwrap();
        *owner.handle.write().await = Some(handle.clone());
        (handle, owner)
    }
    async fn wait_run(&self, plan: &Ticket, state: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let value = self.view(plan).await;
                if value["runs"]
                    .as_array()
                    .is_some_and(|runs| runs.iter().any(|r| r["state"] == state))
                {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
}
fn noop_cancel() -> JobCancel {
    Arc::new(|_| Ok(()))
}

struct TestProvider {
    calls: AtomicUsize,
    entered: Notify,
    release: Notify,
    block: AtomicBool,
    fail: bool,
}
impl TestProvider {
    fn new(block: bool, fail: bool) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            entered: Notify::new(),
            release: Notify::new(),
            block: AtomicBool::new(block),
            fail,
        })
    }
}
#[async_trait]
impl ModelProvider for TestProvider {
    async fn stream(
        &self,
        _: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        self.entered.notify_one();
        if self.block.swap(false, Ordering::AcqRel) {
            tokio::select! {
                _ = self.release.notified() => {},
                _ = cancellation.cancelled() => return Err(ProviderError::new("fixture cancelled")),
            }
        }
        if self.fail {
            return Err(ProviderError::new("fixture model rejected request"));
        }
        Ok(Box::pin(stream::iter(vec![
            Ok(ProviderEvent::TextDelta("fixture complete".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}
struct TestFactory(Arc<TestProvider>);
#[async_trait]
impl TurnRequestFactory for TestFactory {
    async fn build(&self, _: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        Ok(LoopRequest::new(self.0.clone(), input))
    }
}
async fn idle(handle: &DurableAgentHandle) {
    tokio::time::timeout(Duration::from_secs(3), handle.when_idle())
        .await
        .unwrap()
        .unwrap();
}
async fn drive(owner: &ScheduleOwner) {
    assert!(matches!(owner.drive_once().await, DriveAction::Continue));
    assert!(matches!(owner.drive_once().await, DriveAction::Continue));
}

#[tokio::test]
async fn ab_stream_cursor_and_nonzero_exit_smoke_use_real_platform_shell() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let (id, lease) = lab.run(noop_cancel()).await.unwrap();
        // Deliberately fixed, harmless command; not a production process driver.
        #[cfg(unix)]
        let result = std::process::Command::new("/bin/sh")
            .args(["-c", "printf '你好'; printf 'fixture error' >&2; exit 7"])
            .output()
            .unwrap();
        #[cfg(windows)]
        let result = std::process::Command::new(
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Console]::Out.Write('你好'); [Console]::Error.Write('fixture error'); exit 7"])
        .output()
        .unwrap();
        lease.publish_stdout(result.stdout);
        lease.publish_stderr(result.stderr);
        lease.finish(JobOutcome::failed(format!(
            "exit_code={}",
            result.status.code().unwrap()
        )));
        let read = lab.output(&id, &JobOutputCursor::start(id.id()));
        assert_eq!(read.stdout, "你好", "{arm:?}");
        assert_eq!(read.stderr, "fixture error");
        assert_eq!(read.snapshot.status, JobStatus::Failed);
        assert_eq!(read.snapshot.detail.as_deref(), Some("exit_code=7"));
        assert_eq!(lab.output(&id, &read.next_cursor).stdout, "");
    }
}

#[tokio::test]
async fn ab_wait_timeout_is_not_failure_or_cancellation() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let (id, lease) = lab.run(noop_cancel()).await.unwrap();
        assert_eq!(
            lab.unified
                .jobs
                .wait("root", id.id(), Duration::from_millis(2))
                .await
                .unwrap()
                .status,
            JobStatus::Running
        );
        lease.finish(JobOutcome::completed("done"));
        assert_eq!(
            lab.unified
                .jobs
                .wait("root", id.id(), Duration::from_millis(2))
                .await
                .unwrap()
                .status,
            JobStatus::Completed
        );
    }
}

#[tokio::test]
async fn ab_future_rules_do_not_consume_process_capacity() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        for n in 0..12 {
            lab.plan(&format!("future-{n}"), true).await;
        }
        let (_, lease) = lab.run(noop_cancel()).await.unwrap();
        assert!(lab.run(noop_cancel()).await.is_err());
        assert_eq!(
            active_schedules(&lab.store.load("root").await.unwrap().unwrap())
                .unwrap()
                .len(),
            12
        );
        lease.finish(JobOutcome::completed("done"));
    }
}

#[tokio::test]
async fn ab_cancel_run_and_cancel_future_have_independent_scope() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let plan = lab.plan("first", true).await;
        let cancellations = Arc::new(AtomicUsize::new(0));
        let count = cancellations.clone();
        let (run, lease) = lab
            .run(Arc::new(move |_| {
                count.fetch_add(1, Ordering::AcqRel);
                Ok(())
            }))
            .await
            .unwrap();
        assert_eq!(lab.control(&plan, "cancel").await["deleted"], true);
        assert_eq!(cancellations.load(Ordering::Acquire), 0);
        assert_eq!(
            lab.unified.jobs.get("root", run.id()).unwrap().status,
            JobStatus::Running
        );
        let remaining = lab.plan("second", true).await;
        lab.control(&run, "cancel").await;
        assert_eq!(cancellations.load(Ordering::Acquire), 1);
        assert_eq!(
            lab.unified.jobs.get("root", run.id()).unwrap().status,
            JobStatus::Stopping
        );
        assert_eq!(lab.view(&remaining).await["state"], "scheduled");
        lease.finish(JobOutcome::killed(
            "fixture producer acknowledged cancellation",
        ));
    }
}

#[tokio::test]
async fn ab_periodic_occurrences_have_distinct_ids_and_preserve_prior_results() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let provider = TestProvider::new(false, false);
        let (handle, owner) = lab.bind(provider.clone()).await;
        let plan = lab.plan("periodic", true).await;
        lab.clock.0.store(300000, Ordering::Release);
        drive(&owner).await;
        idle(&handle).await;
        let first = lab.wait_run(&plan, "completed").await;
        assert_eq!(first["runs"].as_array().unwrap().len(), 1);
        lab.clock.0.store(600000, Ordering::Release);
        drive(&owner).await;
        idle(&handle).await;
        let second = lab.view(&plan).await;
        assert_eq!(second["runs"].as_array().unwrap().len(), 2);
        assert_ne!(second["runs"][0]["runId"], second["runs"][1]["runId"]);
        assert!(second["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["runId"] == first["runs"][0]["runId"] && r["state"] == "completed"));
        assert_eq!(provider.calls.load(Ordering::Acquire), 2);
        assert_eq!(
            active_schedules(&lab.store.load("root").await.unwrap().unwrap())
                .unwrap()
                .len(),
            1
        );
        handle.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn ab_missed_ticks_coalesce_instead_of_replaying_every_interval() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let provider = TestProvider::new(false, false);
        let (handle, owner) = lab.bind(provider.clone()).await;
        let plan = lab.plan("catch-up", true).await;
        lab.clock.0.store(3000000, Ordering::Release);
        drive(&owner).await;
        idle(&handle).await;
        assert_eq!(lab.wait_run(&plan, "completed").await["runCount"], 1);
        assert!(matches!(owner.drive_once().await, DriveAction::Wait(_, _)));
        assert_eq!(provider.calls.load(Ordering::Acquire), 1);
        handle.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn ab_busy_chat_waits_for_idle_without_blocking_process_admission() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let provider = TestProvider::new(true, false);
        let (handle, owner) = lab.bind(provider.clone()).await;
        handle
            .followup(InboxMessage::user("first", "ongoing fixture work"))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), provider.entered.notified())
            .await
            .unwrap();
        let plan = lab.plan("idle-boundary", false).await;
        lab.clock.0.store(1000, Ordering::Release);
        assert!(matches!(owner.drive_once().await, DriveAction::Busy(_, _)));
        assert_eq!(lab.view(&plan).await["runCount"], 0);
        let (_, lease) = lab.run(noop_cancel()).await.unwrap();
        lease.finish(JobOutcome::completed("independent process completed"));
        provider.release.notify_one();
        idle(&handle).await;
        drive(&owner).await;
        lab.wait_run(&plan, "completed").await;
        assert_eq!(provider.calls.load(Ordering::Acquire), 2);
        handle.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn ab_schedule_admission_is_not_a_success_receipt() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let (handle, owner) = lab.bind(TestProvider::new(false, true)).await;
        let plan = lab.plan("failing-task", false).await;
        lab.clock.0.store(1000, Ordering::Release);
        drive(&owner).await;
        assert_eq!(
            lab.wait_run(&plan, "failed").await["runs"][0]["state"],
            "failed"
        );
        handle.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn ab_deleting_plan_does_not_cancel_an_already_admitted_agent_run() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let provider = TestProvider::new(true, false);
        let (handle, owner) = lab.bind(provider.clone()).await;
        let plan = lab.plan("delete-while-running", true).await;
        lab.clock.0.store(300000, Ordering::Release);
        drive(&owner).await;
        tokio::time::timeout(Duration::from_secs(2), provider.entered.notified())
            .await
            .unwrap();
        assert_eq!(lab.control(&plan, "cancel").await["deleted"], true);
        assert_ne!(handle.status(), xharness_agent::AgentStatus::Idle);
        provider.release.notify_one();
        idle(&handle).await;
        lab.wait_run(&plan, "completed").await;
        assert!(
            active_schedules(&lab.store.load("root").await.unwrap().unwrap())
                .unwrap()
                .is_empty()
        );
        handle.shutdown(Duration::from_secs(1)).await;
    }
}

static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xharness-job-ablation-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::AcqRel)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn ab_jsonl_reopen_preserves_paused_rule_phase_and_idempotency() {
    for arm in ARMS {
        let dir = TempDir::new();
        let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir.0).unwrap());
        store.create(SessionHeader::new("root")).await.unwrap();
        let lab = Lab::from_store(arm, store, 1);
        let plan = lab.plan("durable", true).await;
        let phase = lab.view(&plan).await["scheduledAt"].clone();
        lab.control(&plan, "pause").await;
        lab.unified.schedules.shutdown().await.unwrap();
        drop(lab);
        let reopened = Lab::from_store(arm, Arc::new(JsonlSessionStore::new(&dir.0).unwrap()), 1);
        reopened.clock.0.store(3000000, Ordering::Release);
        assert_eq!(reopened.view(&plan).await["state"], "paused");
        assert_eq!(reopened.view(&plan).await["scheduledAt"], phase);
        assert_eq!(reopened.plan("durable", true).await.id(), plan.id());
        assert_eq!(reopened.control(&plan, "resume").await["state"], "overdue");
        let provider = TestProvider::new(false, false);
        let (handle, owner) = reopened.bind(provider.clone()).await;
        drive(&owner).await;
        idle(&handle).await;
        assert_eq!(reopened.wait_run(&plan, "completed").await["runCount"], 1);
        assert_eq!(provider.calls.load(Ordering::Acquire), 1);
        handle.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn b_unified_owner_and_kind_are_not_inferred_from_untrusted_ids() {
    let lab = Lab::new(Arm::Unified, 1).await;
    lab.store.create(SessionHeader::new("other")).await.unwrap();
    let (run, lease) = lab.run(noop_cancel()).await.unwrap();
    let plan = lab.plan("typed", true).await;
    assert!(lab
        .unified
        .output(&plan, &JobOutputCursor::start(plan.id()))
        .is_err());
    assert!(lab.control(&run, "pause").await.get("error").is_some());
    let foreign = UnifiedJobs {
        owner: "other".into(),
        ..lab.unified.clone()
    };
    assert!(foreign
        .output(&run, &JobOutputCursor::start(run.id()))
        .is_err());
    assert!(foreign.control(&plan, "view").await.get("code").is_some());
    lease.finish(JobOutcome::completed("done"));
}

#[tokio::test]
async fn ab_completion_event_is_available_without_model_polling() {
    for arm in ARMS {
        let lab = Lab::new(arm, 1).await;
        let mut events = lab.unified.jobs.subscribe();
        let (id, lease) = lab.run(noop_cancel()).await.unwrap();
        lease.finish(JobOutcome::completed("fast completion"));
        let finished = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.kind == JobEventKind::Finished {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(finished.job.id.as_str(), id.id());
        assert_eq!(finished.job.status, JobStatus::Completed);
        // This only proves registry notification; no durable inbox bridge is claimed.
    }
}

#[tokio::test]
async fn c_remove_trigger_execution_split_exhausts_real_process_quota() {
    let registry = JobRegistry::new(JobRegistryConfig {
        max_concurrent_jobs_per_owner: 1,
        ..JobRegistryConfig::default()
    });
    let (_, future) = registry
        .reserve("root", "schedule", "sleep until tomorrow", None)
        .unwrap()
        .commit(None, noop_cancel())
        .unwrap();
    assert!(
        registry
            .reserve("root", "bash", "execute now", None)
            .is_err(),
        "negative control must reproduce quota starvation"
    );
    future.finish(JobOutcome::killed("negative control cleanup"));
    eprintln!(
        "NEGATIVE_CONTROL trigger_execution_split: future rule consumes active-process quota"
    );
}

#[tokio::test]
async fn c_remove_durable_schedule_loses_future_rule_on_registry_restart() {
    let registry = JobRegistry::default();
    let (_, future) = registry
        .reserve("root", "schedule", "volatile future rule", None)
        .unwrap()
        .commit(None, noop_cancel())
        .unwrap();
    registry.shutdown(Duration::from_millis(1)).await;
    drop(future);
    drop(registry);
    assert!(
        JobRegistry::default().list("root").is_empty(),
        "negative control must lose the future rule"
    );
    eprintln!(
        "NEGATIVE_CONTROL durable_schedule: process registry alone cannot recover future rules"
    );
}

#[tokio::test]
async fn c_remove_run_identity_alias_overwrites_previous_output() {
    let lab = Lab::new(Arm::Unified, 1).await;
    let mut collapsed = HashMap::new();
    let (first, lease) = lab.run(noop_cancel()).await.unwrap();
    lease.publish_stdout("first output");
    lease.finish(JobOutcome::completed("first"));
    collapsed.insert("periodic-plan", first.clone());
    let (second, lease) = lab.run(noop_cancel()).await.unwrap();
    lease.publish_stdout("second output");
    lease.finish(JobOutcome::completed("second"));
    collapsed.insert("periodic-plan", second);
    assert_eq!(
        lab.output(&first, &JobOutputCursor::start(first.id()))
            .stdout,
        "first output"
    );
    let ambiguous = &collapsed["periodic-plan"];
    assert_ne!(
        lab.output(ambiguous, &JobOutputCursor::start(ambiguous.id()))
            .stdout,
        "first output",
        "negative control must overwrite the plan alias"
    );
    eprintln!("NEGATIVE_CONTROL run_identity: one plan id cannot address both occurrences");
}

#[tokio::test]
async fn regression_restart_never_resolves_an_old_run_to_a_new_producer() {
    for arm in ARMS {
        let old = Lab::new(arm, 1).await;
        let (old_id, lease) = old.run(noop_cancel()).await.unwrap();
        lease.finish(JobOutcome::completed("old Host run"));
        let old_cursor = JobOutputCursor::start(old_id.id());
        let same_session_store = old.store.clone();
        drop(old);
        let restarted = Lab::from_store(arm, same_session_store, 1);
        let (new_id, lease) = restarted.run(noop_cancel()).await.unwrap();
        lease.publish_stdout("new Host output");
        lease.finish(JobOutcome::completed("new Host run"));
        assert_ne!(old_id.id(), new_id.id());
        assert!(restarted
            .unified
            .jobs
            .read_since("root", old_id.id(), &old_cursor)
            .is_err());
    }
    eprintln!("REGRESSION A_AND_B: expired runtime identity fails closed after registry restart");
}

#[tokio::test]
async fn diagnostic_in_memory_adapter_cost_is_reported_not_a_release_sla() {
    let mut timings = [Vec::new(), Vec::new()];
    for round in 0..12 {
        for index in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
            let lab = Lab::new(ARMS[index], 1).await;
            let start = Instant::now();
            for _ in 0..200 {
                let (id, lease) = lab.run(noop_cancel()).await.unwrap();
                lease.publish_stdout("fixture");
                lease.finish(JobOutcome::completed("done"));
                assert_eq!(
                    lab.output(&id, &JobOutputCursor::start(id.id())).stdout,
                    "fixture"
                );
            }
            timings[index].push(start.elapsed().as_nanos() / 200);
        }
    }
    for series in &mut timings {
        series.sort_unstable();
    }
    eprintln!(
        "ABLATION_METRICS {}",
        json!({"profile":"debug","operations_per_sample":200,"samples_per_arm":12,"a_median_ns":timings[0][6],"b_median_ns":timings[1][6],"note":"in-memory fixture only; no model, OS startup or release latency claim"})
    );
}
