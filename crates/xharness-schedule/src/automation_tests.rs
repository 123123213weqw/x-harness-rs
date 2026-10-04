use super::*;
use async_trait::async_trait;
use futures::stream;
use std::sync::atomic::{AtomicI64, AtomicUsize};
use xharness_agent::{AgentRegistry, MemoryLeaseManager, TurnRequestFactory};
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{MemorySessionStore, SessionHeader};
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire)
    }
}
fn command(value: Value) -> AutomationCommand {
    serde_json::from_value(value).unwrap()
}
async fn fixture() -> (Arc<dyn Store>, Arc<ScheduleManager>, Arc<TestClock>) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    store.create(SessionHeader::new("root")).await.unwrap();
    let clock = Arc::new(TestClock(AtomicI64::new(0)));
    let manager = ScheduleManager::with_clock(store.clone(), clock.clone());
    (store, manager, clock)
}
async fn create(manager: &ScheduleManager, extra: Value) -> Value {
    let mut args = json!({"action":"create","prompt":"check training","after_seconds":1,"idempotency_key":"one"});
    for (k, v) in extra.as_object().unwrap() {
        if v.is_null() {
            args.as_object_mut().unwrap().remove(k);
        } else {
            args[k] = v.clone();
        }
    }
    manager.execute("root", "invocation", command(args)).await
}
async fn action(manager: &ScheduleManager, action: &str, id: &str) -> Value {
    manager
        .execute("root", "control", command(json!({"action":action,"id":id})))
        .await
}

#[tokio::test]
async fn single_tool_schema_is_closed_and_owner_is_not_model_controlled() {
    let (_, manager, _) = fixture().await;
    let specs = manager.specs("root");
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].definition.name, "automation");
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(specs.into_iter().next().unwrap())
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);
    for value in [
        json!({"action":"list","prompt":"x"}),
        json!({"action":"create","prompt":"x","after_seconds":1,"session_id":"other"}),
        json!({"action":"pause"}),
        json!({"action":"invalid"}),
    ] {
        assert!(!executor
            .execute(ToolRequest::new("automation", value.to_string()))
            .await
            .is_ok());
    }
    let result = executor
        .execute(ToolRequest::new(
            "automation",
            json!({"action":"create","prompt":"hello","mode":"task","after_seconds":1}).to_string(),
        ))
        .await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        serde_json::from_str::<Value>(&result.output.unwrap().content).unwrap()["mode"],
        "task"
    );
}

#[tokio::test]
async fn concurrent_creates_replay_once_and_key_conflicts_fail_closed() {
    let (store, manager, clock) = fixture().await;
    let mut jobs = Vec::new();
    for _ in 0..32 {
        let manager = manager.clone();
        jobs.push(tokio::spawn(
            async move { create(&manager, json!({})).await },
        ));
    }
    let mut id = None;
    for job in jobs {
        let value = job.await.unwrap();
        let next = value["id"].as_str().unwrap().to_owned();
        if let Some(id) = &id {
            assert_eq!(id, &next);
        } else {
            id = Some(next);
        }
    }
    clock.0.store(123000, Ordering::Release);
    assert_eq!(create(&manager, json!({})).await["replayed"], true);
    assert_eq!(
        create(&manager, json!({"prompt":"different"})).await["code"],
        "idempotency_conflict"
    );
    assert_eq!(store.load("root").await.unwrap().unwrap().events().len(), 1);
    assert_eq!(
        action(&manager, "delete", id.as_deref().unwrap()).await["deleted"],
        true
    );
    assert_eq!(create(&manager, json!({})).await["state"], "inactive");
    assert!(
        active_schedules(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn update_pause_resume_recover_without_changing_time_phase_or_legacy_semantics() {
    let (store, manager, clock) = fixture().await;
    let legacy = manager
        .create_value("root", "legacy reminder".into(), Selector::Every(300))
        .await;
    let id = legacy["id"].as_str().unwrap();
    let updated = manager
        .execute(
            "root",
            "edit",
            command(json!({"action":"update","id":id,"prompt":"changed"})),
        )
        .await;
    assert_eq!(updated["mode"], "reminder");
    assert_eq!(updated["target"], "current_chat");
    assert_eq!(updated["scheduledAt"], legacy["scheduledAt"]);
    action(&manager, "pause", id).await;
    clock.0.store(999999, Ordering::Release);
    let restarted = ScheduleManager::with_clock(store.clone(), clock.clone());
    assert!(!has_active_schedules(&store.load("root").await.unwrap().unwrap()).unwrap());
    assert_eq!(action(&restarted, "view", id).await["state"], "paused");
    assert!(matches!(
        due_decision(
            &fold_schedule_events(&store.load("root").await.unwrap().unwrap()).unwrap(),
            clock.now_ms()
        )
        .unwrap(),
        DueDecision::Wait(None)
    ));
    assert_eq!(action(&restarted, "resume", id).await["state"], "overdue");
    let enabled = restarted
        .execute(
            "root",
            "edit",
            command(json!({"action":"update","id":id,"mode":"task"})),
        )
        .await;
    assert_eq!(enabled["mode"], "task");
    assert_eq!(enabled["scheduledAt"], legacy["scheduledAt"]);
    let record = active_schedules(&store.load("root").await.unwrap().unwrap())
        .unwrap()
        .remove(0);
    assert!(
        automation::scheduled_message("root", &record, &record.scheduled_at)
            .message
            .content
            .contains("[SCHEDULED USER TASK]")
    );
}

#[tokio::test]
async fn invalid_time_and_unavailable_independent_target_never_create_work() {
    let (store, manager, _) = fixture().await;
    assert_eq!(
        create(&manager, json!({"target":"new_chat"})).await["code"],
        "target_unavailable"
    );
    for (args, code) in [
        (json!({"after_seconds":0}), "invalid_rule"),
        (json!({"every_seconds":299}), "invalid_selector"),
        (
            json!({"after_seconds":null,"every_seconds":299}),
            "frequency_too_high",
        ),
    ] {
        assert_eq!(create(&manager, args).await["code"], code);
    }
    assert!(store
        .load("root")
        .await
        .unwrap()
        .unwrap()
        .events()
        .is_empty());
}

struct TestProvider {
    calls: AtomicUsize,
    entered: Notify,
    release: Notify,
    block: AtomicBool,
    fail: AtomicBool,
}
impl TestProvider {
    fn new(block: bool, fail: bool) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            entered: Notify::new(),
            release: Notify::new(),
            block: AtomicBool::new(block),
            fail: AtomicBool::new(fail),
        })
    }
}
#[async_trait]
impl ModelProvider for TestProvider {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        self.entered.notify_one();
        if self.block.swap(false, Ordering::AcqRel) {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::Acquire) {
            return Err(ProviderError::new("test provider rejection"));
        }
        Ok(Box::pin(stream::iter(vec![
            Ok(ProviderEvent::TextDelta("checked".into())),
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
async fn worker(
    store: Arc<dyn Store>,
    id: &str,
    provider: Arc<TestProvider>,
) -> DurableAgentHandle {
    let registry = AgentRegistry::new(store, Arc::new(MemoryLeaseManager::default()));
    DurableAgentHandle::start(
        registry.activate(SessionHeader::new(id)).await.unwrap(),
        Arc::new(TestFactory(provider)),
        64,
    )
}
async fn settle(handle: &DurableAgentHandle) {
    tokio::time::timeout(Duration::from_secs(3), handle.when_idle())
        .await
        .unwrap()
        .unwrap();
}
async fn wait_run(manager: &ScheduleManager, id: &str, state: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let view = action(manager, "view", id).await;
            if view["runs"][0]["state"] == state {
                return view;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn task_waits_for_idle_then_has_a_real_terminal_outcome() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(true, false);
    let handle = worker(store.clone(), "root", provider.clone()).await;
    handle
        .followup(InboxMessage::user("user-first", "ongoing work"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), provider.entered.notified())
        .await
        .unwrap();
    let value = create(&manager, json!({"mode":"task"})).await;
    let id = value["id"].as_str().unwrap();
    clock.0.store(1000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Busy(_, None)
    ));
    assert!(
        fold_schedule_events(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .pending_runs
            .is_empty()
    );
    provider.release.notify_one();
    settle(&handle).await;
    assert!(matches!(owner.drive_once().await, DriveAction::Continue)); // reservation
    assert!(matches!(owner.drive_once().await, DriveAction::Continue)); // admission
    wait_run(&manager, id, "completed").await;
    assert_eq!(provider.calls.load(Ordering::Acquire), 2);
    let session = store.load("root").await.unwrap().unwrap();
    assert_eq!(fold_schedule_events(&session).unwrap().runs.len(), 1);
    assert!(session
        .derive_messages()
        .iter()
        .any(|m| m.content.contains("[SCHEDULED USER TASK]")));
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Wait(None, _)
    ));
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn fork_keeps_history_without_rearming_the_sources_automation() {
    let (store, manager, clock) = fixture().await;
    let original = create(&manager, json!({"mode":"task"})).await;
    let original_id = original["id"].as_str().unwrap();
    let source = store.load("root").await.unwrap().unwrap();
    let mut copied = source
        .events()
        .iter()
        .map(|e| e.event.clone())
        .collect::<Vec<_>>();
    copied.push(
        EventData::SessionForkOrigin {
            parent_session_id: "root".into(),
            before_user_seq: None,
        }
        .into(),
    );
    store.create(SessionHeader::new("fork")).await.unwrap();
    store
        .append("fork", xharness_session::Revision::ZERO, copied)
        .await
        .unwrap();
    store.flush("fork").await.unwrap();
    clock.0.store(1000, Ordering::Release);
    let provider = TestProvider::new(false, false);
    let handle = worker(store.clone(), "fork", provider.clone()).await;
    let owner = manager.owner("fork").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    assert!(!has_active_schedules(&store.load("fork").await.unwrap().unwrap()).unwrap());
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Wait(None, _)
    ));
    let view = manager
        .execute(
            "fork",
            "view",
            command(json!({"action":"view","id":original_id})),
        )
        .await;
    assert_eq!(view["state"], "inherited");
    assert_eq!(provider.calls.load(Ordering::Acquire), 0);
    let own = manager.execute("fork", "own", command(json!({"action":"create","prompt":"own authorized task","mode":"task","after_seconds":1,"idempotency_key":"one"}))).await;
    assert_ne!(own["id"], original["id"]);
    clock.0.store(2000, Ordering::Release);
    owner.drive_once().await;
    owner.drive_once().await;
    settle(&handle).await;
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
    assert_eq!(
        fold_schedule_events(&store.load("fork").await.unwrap().unwrap())
            .unwrap()
            .runs
            .len(),
        1
    );
    assert_eq!(
        active_schedules(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .len(),
        1
    );
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn provider_failure_is_not_reported_as_completed() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(false, true);
    let handle = worker(store.clone(), "root", provider).await;
    let value = create(&manager, json!({"mode":"task"})).await;
    clock.0.store(1000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    owner.drive_once().await;
    owner.drive_once().await;
    let view = wait_run(&manager, value["id"].as_str().unwrap(), "failed").await;
    assert_ne!(view["runs"][0]["state"], "completed");
    handle.shutdown(Duration::from_secs(1)).await;
}

struct TestTargets {
    store: Arc<dyn Store>,
    handles: Mutex<HashMap<String, DurableAgentHandle>>,
    provider: Arc<TestProvider>,
    fail_prepare: AtomicBool,
    allowed: AtomicBool,
}
#[async_trait]
impl AutomationTargetProvider for TestTargets {
    async fn check_source(&self, _: &str) -> Result<(), String> {
        if self.allowed.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err("source archived".into())
        }
    }
    async fn prepare(&self, _: &str, target: &str) -> Result<DurableAgentHandle, String> {
        if self.fail_prepare.swap(false, Ordering::AcqRel) {
            return Err("transient target preparation failure".into());
        }
        let mut handles = self.handles.lock().await;
        if let Some(handle) = handles.get(target) {
            return Ok(handle.clone());
        }
        let handle = worker(self.store.clone(), target, self.provider.clone()).await;
        handles.insert(target.into(), handle.clone());
        Ok(handle)
    }
}

#[tokio::test]
async fn busy_current_chat_does_not_starve_an_independent_due_task() {
    let (store, manager, clock) = fixture().await;
    let root_provider = TestProvider::new(true, false);
    let source = worker(store.clone(), "root", root_provider.clone()).await;
    let targets = Arc::new(TestTargets {
        store: store.clone(),
        handles: Mutex::new(HashMap::new()),
        provider: TestProvider::new(false, false),
        fail_prepare: AtomicBool::new(false),
        allowed: AtomicBool::new(true),
    });
    manager.bind_targets(targets.clone()).unwrap();
    source
        .followup(InboxMessage::user("user-first", "ongoing work"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), root_provider.entered.notified())
        .await
        .unwrap();
    let current = create(&manager, json!({"mode":"task"})).await;
    let independent = create(&manager, json!({"mode":"task","target":"new_chat","after_seconds":10,"idempotency_key":"independent"})).await;
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(source.clone());
    clock.0.store(1000, Ordering::Release);
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Busy(_, Some(10000))
    ));
    clock.0.store(10000, Ordering::Release);
    owner.drive_once().await;
    owner.drive_once().await;
    wait_run(&manager, independent["id"].as_str().unwrap(), "completed").await;
    assert_eq!(root_provider.calls.load(Ordering::Acquire), 1);
    assert_eq!(
        action(&manager, "view", current["id"].as_str().unwrap()).await["runCount"],
        0
    );
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Busy(_, None)
    ));
    root_provider.release.notify_one();
    settle(&source).await;
    owner.drive_once().await;
    owner.drive_once().await;
    wait_run(&manager, current["id"].as_str().unwrap(), "completed").await;
    assert_eq!(root_provider.calls.load(Ordering::Acquire), 2);
    for target in targets.handles.lock().await.values() {
        target.shutdown(Duration::from_secs(1)).await;
    }
    source.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn new_chat_reservation_survives_long_outage_and_prevents_overlapping_runs() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(true, false);
    let targets = Arc::new(TestTargets {
        store: store.clone(),
        handles: Mutex::new(HashMap::new()),
        provider: provider.clone(),
        fail_prepare: AtomicBool::new(true),
        allowed: AtomicBool::new(true),
    });
    manager.bind_targets(targets.clone()).unwrap();
    let source = worker(store.clone(), "root", TestProvider::new(false, false)).await;
    let value = create(
        &manager,
        json!({"after_seconds":null,"every_seconds":300,"mode":"task","target":"new_chat"}),
    )
    .await;
    let id = value["id"].as_str().unwrap();
    clock.0.store(300000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(source.clone());
    owner.drive_once().await;
    assert!(matches!(owner.drive_once().await, DriveAction::Continue)); // failed target enters per-run cooldown
    let reserved = fold_schedule_events(&store.load("root").await.unwrap().unwrap())
        .unwrap()
        .pending_runs[0]
        .0
        .clone();
    let preparing = action(&manager, "view", id).await;
    assert_eq!(preparing["runCount"], 1);
    assert_eq!(preparing["admittedRunCount"], 0);
    assert_eq!(preparing["runs"][0]["state"], "preparing");
    assert_eq!(action(&manager, "pause", id).await["state"], "paused");
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Wait(None, _)
    ));
    assert_eq!(
        action(&manager, "view", id).await["runs"][0]["runId"],
        reserved.run_id
    );
    assert_ne!(action(&manager, "resume", id).await["state"], "paused");
    clock.0.store(2100000, Ordering::Release); // six missed intervals, after reservation
    let restarted = ScheduleManager::with_clock(store.clone(), clock.clone());
    restarted.bind_targets(targets.clone()).unwrap();
    let owner = restarted.owner("root").await.unwrap();
    *owner.handle.write().await = Some(source.clone());
    owner.drive_once().await;
    tokio::time::timeout(Duration::from_secs(2), provider.entered.notified())
        .await
        .unwrap();
    let view = action(&restarted, "view", id).await;
    assert_eq!(view["runs"][0]["runId"], reserved.run_id);
    assert_eq!(view["runs"][0]["state"], "running");
    assert_eq!(view["runCount"], 1);
    assert_eq!(view["admittedRunCount"], 1);
    assert!(matches!(owner.drive_once().await, DriveAction::Wait(_, _)));
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
    assert!(!store
        .load("root")
        .await
        .unwrap()
        .unwrap()
        .derive_messages()
        .iter()
        .any(|m| m.content.contains("[SCHEDULED USER TASK]")));
    let target = targets
        .handles
        .lock()
        .await
        .get(&reserved.session_id)
        .unwrap()
        .clone();
    provider.release.notify_one();
    wait_run(&restarted, id, "completed").await;
    action(&restarted, "pause", id).await;
    clock.0.store(2400000, Ordering::Release);
    assert!(matches!(
        owner.drive_once().await,
        DriveAction::Wait(None, _)
    ));
    action(&restarted, "resume", id).await;
    owner.drive_once().await;
    owner.drive_once().await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while provider.calls.load(Ordering::Acquire) != 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(targets.handles.lock().await.len(), 2);
    for handle in targets.handles.lock().await.values() {
        handle.shutdown(Duration::from_secs(1)).await;
    }
    source.shutdown(Duration::from_secs(1)).await;
    target.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn restart_after_admission_before_receipt_does_not_repeat_a_task() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(false, false);
    let handle = worker(store.clone(), "root", provider.clone()).await;
    let value = create(&manager, json!({"mode":"task"})).await;
    let id = value["id"].as_str().unwrap();
    clock.0.store(1000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    owner.drive_once().await;
    let snapshot = store.load("root").await.unwrap().unwrap();
    let record = fold_schedule_events(&snapshot).unwrap().active.remove(0);
    let message = automation::scheduled_message("root", &record, &record.scheduled_at);
    handle.maintenance_followup(message).await.unwrap();
    settle(&handle).await;
    let restarted = ScheduleManager::with_clock(store.clone(), clock.clone());
    let owner = restarted.owner("root").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    owner.drive_once().await;
    owner.drive_once().await;
    assert_eq!(
        action(&restarted, "view", id).await["runs"][0]["state"],
        "completed"
    );
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
    assert_eq!(
        fold_schedule_events(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .runs
            .len(),
        1
    );
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn unavailable_source_does_not_trigger_or_reserve_a_task() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(false, false);
    let handle = worker(store.clone(), "root", provider.clone()).await;
    manager
        .bind_targets(Arc::new(TestTargets {
            store: store.clone(),
            handles: Mutex::new(HashMap::new()),
            provider: provider.clone(),
            fail_prepare: AtomicBool::new(false),
            allowed: AtomicBool::new(false),
        }))
        .unwrap();
    create(&manager, json!({"mode":"task"})).await;
    clock.0.store(1000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    assert!(matches!(owner.drive_once().await, DriveAction::Wait(_, _)));
    assert_eq!(provider.calls.load(Ordering::Acquire), 0);
    assert!(
        fold_schedule_events(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .pending_runs
            .is_empty()
    );
    handle.shutdown(Duration::from_secs(1)).await;
}

struct SelectivelyFailingTargets {
    inner: TestTargets,
    blocked: Mutex<Option<String>>,
    attempts: AtomicUsize,
}
#[async_trait]
impl AutomationTargetProvider for SelectivelyFailingTargets {
    async fn check_source(&self, source: &str) -> Result<(), String> {
        self.inner.check_source(source).await
    }
    async fn prepare(&self, source: &str, target: &str) -> Result<DurableAgentHandle, String> {
        let mut blocked = self.blocked.lock().await;
        let failed = blocked.get_or_insert_with(|| target.to_owned()).as_str() == target;
        drop(blocked);
        if failed {
            self.attempts.fetch_add(1, Ordering::AcqRel);
            return Err("permanent failure for this target only".into());
        }
        self.inner.prepare(source, target).await
    }
}

#[tokio::test]
async fn failed_target_is_backed_off_without_starving_other_targets_and_can_be_deleted() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(false, false);
    let targets = Arc::new(SelectivelyFailingTargets {
        inner: TestTargets {
            store: store.clone(),
            handles: Mutex::new(HashMap::new()),
            provider: provider.clone(),
            fail_prepare: AtomicBool::new(false),
            allowed: AtomicBool::new(true),
        },
        blocked: Mutex::new(None),
        attempts: AtomicUsize::new(0),
    });
    manager.bind_targets(targets.clone()).unwrap();
    let source = worker(store.clone(), "root", TestProvider::new(false, false)).await;
    let bad = create(&manager, json!({"mode":"task", "target":"new_chat"})).await;
    clock.0.store(1000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(source.clone());
    owner.drive_once().await; // reserve bad occurrence
    assert!(matches!(owner.drive_once().await, DriveAction::Continue)); // preparation failed
    for _ in 0..5 {
        assert!(matches!(
            owner.drive_once().await,
            DriveAction::Wait(Some(2000), _)
        ));
    }
    assert_eq!(targets.attempts.load(Ordering::Acquire), 1); // no hot polling
    let good = create(
        &manager,
        json!({"mode":"task", "target":"new_chat", "idempotency_key":"healthy"}),
    )
    .await;
    clock.0.store(2000, Ordering::Release);
    owner.drive_once().await; // retry bad once, next deadline 4000
    owner.drive_once().await; // reserve independent good
    owner.drive_once().await; // admit good despite bad pending reservation
    wait_run(&manager, good["id"].as_str().unwrap(), "completed").await;
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
    assert_eq!(
        action(&manager, "view", bad["id"].as_str().unwrap()).await["admittedRunCount"],
        0
    );
    assert_eq!(
        action(&manager, "delete", bad["id"].as_str().unwrap()).await["deleted"],
        true
    );
    assert_eq!(
        action(&manager, "delete", bad["id"].as_str().unwrap()).await["deleted"],
        false
    );
    let cancelled = action(&manager, "view", bad["id"].as_str().unwrap()).await;
    assert_eq!(cancelled["runCount"], 1);
    assert_eq!(cancelled["admittedRunCount"], 0);
    assert_eq!(cancelled["runs"][0]["state"], "cancelled");

    let restarted = ScheduleManager::with_clock(store.clone(), clock.clone());
    restarted.bind_targets(targets.clone()).unwrap();
    let restored = restarted.owner("root").await.unwrap();
    *restored.handle.write().await = Some(source.clone());
    clock.0.store(100000, Ordering::Release);
    assert!(matches!(
        restored.drive_once().await,
        DriveAction::Wait(None, _)
    ));
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
    assert!(
        fold_schedule_events(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .pending_runs
            .is_empty()
    );
    for target in targets.inner.handles.lock().await.values() {
        target.shutdown(Duration::from_secs(1)).await;
    }
    source.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn control_after_restart_reconciles_already_admitted_run_before_deleting() {
    let (store, manager, clock) = fixture().await;
    let provider = TestProvider::new(false, false);
    let handle = worker(store.clone(), "root", provider.clone()).await;
    let value = create(
        &manager,
        json!({"mode":"task", "after_seconds":null, "every_seconds":300}),
    )
    .await;
    let id = value["id"].as_str().unwrap();
    clock.0.store(300000, Ordering::Release);
    let owner = manager.owner("root").await.unwrap();
    *owner.handle.write().await = Some(handle.clone());
    owner.drive_once().await;
    let folded = fold_schedule_events(&store.load("root").await.unwrap().unwrap()).unwrap();
    let record = &folded.active[0];
    let message =
        automation::scheduled_message("root", record, &folded.pending_runs[0].0.occurrence_at);
    handle.maintenance_followup(message).await.unwrap();
    settle(&handle).await;
    let restarted = ScheduleManager::with_clock(store.clone(), clock.clone());
    assert_eq!(action(&restarted, "delete", id).await["deleted"], true);
    let view = action(&restarted, "view", id).await;
    assert_eq!(view["state"], "deleted");
    assert_eq!(view["admittedRunCount"], 1);
    assert_eq!(view["runs"][0]["state"], "completed");
    assert_eq!(provider.calls.load(Ordering::Acquire), 1);
    assert!(
        fold_schedule_events(&store.load("root").await.unwrap().unwrap())
            .unwrap()
            .pending_runs
            .is_empty()
    );
    handle.shutdown(Duration::from_secs(1)).await;
}
