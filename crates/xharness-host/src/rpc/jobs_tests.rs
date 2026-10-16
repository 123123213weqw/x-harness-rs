use super::*;
use crate::{
    AgentRuntime, AgentRuntimeError, AgentTurnRequest, HostConfig, ModelRoute, RunningTurn,
};

#[test]
fn version_one_execution_fixture_roundtrips_the_real_rust_dto() {
    let expected: Value =
        serde_json::from_str(include_str!("../../../../fixtures/job-contract-v1.json")).unwrap();
    let catalog: JobCatalog = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(catalog.version, VERSION);
    assert_eq!(serde_json::to_value(catalog).unwrap(), expected);
}
use async_trait::async_trait;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcResult};
use xharness_jobs::{JobLease, JobOutcome, JobRegistry};
use xharness_session::{MemorySessionStore, Session, SessionHeader, Store};
struct Runtime {
    store: Arc<dyn Store>,
    schedules: Arc<xharness_schedule::ScheduleManager>,
    jobs: JobRegistry,
}
#[async_trait]
impl AgentRuntime for Runtime {
    fn has_available_route(&self) -> bool {
        false
    }
    fn can_route(&self, _: &ModelRoute) -> bool {
        false
    }
    fn has_authoritative_sessions(&self) -> bool {
        true
    }
    async fn authoritative_session(&self, id: &str) -> Result<Option<Session>, AgentRuntimeError> {
        self.store
            .load(id)
            .await
            .map_err(|e| AgentRuntimeError::Preparation {
                message: e.to_string(),
            })
    }
    async fn automation_command(
        &self,
        id: &str,
        invocation: &str,
        c: xharness_schedule::AutomationCommand,
    ) -> Result<Value, AgentRuntimeError> {
        Ok(self.schedules.execute(id, invocation, c).await)
    }
    async fn process_runs(&self, id: &str) -> Result<Vec<JobRun>, String> {
        Ok(self
            .jobs
            .list(id)
            .into_iter()
            .map(JobRun::process)
            .collect())
    }
    async fn process_output(
        &self,
        id: &str,
        run: &str,
        cursor: JobOutputCursor,
    ) -> Result<xharness_jobs::JobRead, String> {
        self.jobs
            .read_since(id, run, &cursor)
            .map_err(|e| e.to_string())
    }
    async fn cancel_process_run(&self, id: &str, run: &str) -> Result<(), String> {
        self.jobs
            .kill(id, run, None)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    async fn start_turn(
        &self,
        _: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        panic!("execution inspection must not start a model turn")
    }
}
async fn fixture() -> (Arc<BasicHost>, Arc<Runtime>, String, JobLease) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    for id in ["a", "b"] {
        store.create(SessionHeader::new(id)).await.unwrap();
    }
    let runtime = Arc::new(Runtime {
        schedules: xharness_schedule::ScheduleManager::new(store.clone()),
        store: store.clone(),
        jobs: JobRegistry::default(),
    });
    let (id, lease) = runtime
        .jobs
        .reserve("a", "bash", "private command", None)
        .unwrap()
        .commit(None, Arc::new(|_| Ok(())))
        .unwrap();
    let host =
        BasicHost::with_agent_runtime(HostConfig::new(std::env::temp_dir()), runtime.clone());
    host.restore_from_store(store).await.unwrap();
    (host, runtime, id.to_string(), lease)
}
async fn call(host: &BasicHost, session: &str, command: Value) -> RpcResult {
    host.call_dynamic(
        RpcId::new("job-test"),
        "job/manage",
        json!({"sessionId":session,"command":command}),
        CancellationToken::new(),
    )
    .await
    .unwrap()
}
fn value(result: RpcResult) -> Value {
    match result {
        RpcResult::Success { value } => value.unwrap(),
        other => panic!("{other:?}"),
    }
}
#[tokio::test]
async fn catalog_and_output_are_owned_and_generation_fenced() {
    let (host, _, id, lease) = fixture().await;
    lease.publish_stdout("private output");
    let a = value(call(&host, "a", json!({"action":"list"})).await);
    assert_eq!(a["version"], 1);
    assert_eq!(a["runs"][0]["id"], id);
    assert_eq!(a["runs"][0]["state"], "running");
    assert!(
        value(call(&host, "b", json!({"action":"list"})).await)["runs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let output = value(
        call(
            &host,
            "a",
            json!({"action":"output","reference":{"kind":"process","id":id}}),
        )
        .await,
    );
    assert_eq!(output["stdout"], "private output");
    let cursor = output["nextCursor"].clone();
    assert_eq!(
        value(
            call(
                &host,
                "a",
                json!({"action":"output","reference":{"kind":"process","id":id},"cursor":cursor})
            )
            .await
        )["stdout"],
        ""
    );
    assert!(matches!(
        call(
            &host,
            "b",
            json!({"action":"output","reference":{"kind":"process","id":id}})
        )
        .await,
        RpcResult::Failure { .. }
    ));
    assert!(matches!(
        call(
            &host,
            "a",
            json!({"action":"output","reference":{"kind":"process","id":"bash-1"}})
        )
        .await,
        RpcResult::Failure { .. }
    ));
    lease.finish(JobOutcome::completed("done"));
    assert_eq!(
        value(call(&host, "a", json!({"action":"list"})).await)["runs"][0]["state"],
        "completed"
    );
}
#[tokio::test]
async fn cancel_future_is_not_cancel_run_and_cancellation_ack_is_not_completion() {
    let (host, runtime, id, lease) = fixture().await;
    let plan = runtime
        .schedules
        .execute(
            "a",
            "create",
            serde_json::from_value(
                json!({"action":"create","prompt":"future task","every_seconds":300,"mode":"task"}),
            )
            .unwrap(),
        )
        .await;
    let p = plan["id"].as_str().unwrap();
    value(call(&host, "a", json!({"action":"pause_plan","planId":p})).await);
    let snapshot = value(call(&host, "a", json!({"action":"list"})).await);
    assert_eq!(snapshot["plans"][0]["state"], "paused");
    assert_eq!(snapshot["runs"][0]["state"], "running");
    value(
        call(
            &host,
            "a",
            json!({"action":"cancel_run","reference":{"kind":"process","id":id}}),
        )
        .await,
    );
    let snapshot = value(call(&host, "a", json!({"action":"list"})).await);
    assert_eq!(snapshot["plans"][0]["state"], "paused");
    assert_eq!(snapshot["runs"][0]["state"], "stopping");
    lease.finish(JobOutcome::killed("cancelled by producer"));
    value(call(&host, "a", json!({"action":"cancel_future","planId":p})).await);
    let snapshot = value(call(&host, "a", json!({"action":"list"})).await);
    assert_eq!(snapshot["plans"][0]["state"], "deleted");
    assert_eq!(snapshot["runs"][0]["state"], "cancelled");
    assert!(matches!(
        call(&host, "b", json!({"action":"resume_plan","planId":p})).await,
        RpcResult::Failure { .. }
    ));
}
#[test]
fn finished_plan_does_not_claim_agent_execution_success_or_actual_start_time() {
    let view = json!({"id":"p","prompt":"task","scheduledAt":"2026-10-13T00:00:00Z","state":"finished","runs":[{"runId":"schedule:a:p:one","sessionId":"a","occurrenceAt":"2026-10-13T00:00:00Z","state":"running"},{"runId":"schedule:a:p:two","sessionId":"a","state":"failed"}]});
    let (plan, runs) = normalize_automation("a", &view).unwrap();
    assert_eq!(plan.state, PlanState::Finished);
    assert_eq!(runs[0].state, RunState::Running);
    assert_eq!(runs[1].state, RunState::Failed);
    assert_ne!(runs[0].id, runs[1].id);
    assert!(runs[0].started_at_ms.is_none());
    assert!(runs[0].scheduled_at_ms.is_some());
    assert!(
        !runs[0].capabilities.cancel_run,
        "no unsafe session-wide cancel fallback"
    );
}
