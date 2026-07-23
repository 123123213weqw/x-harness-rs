use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_coding_tools::CodingToolBundle;
use xharness_jobs::{JobLease, JobOutcome, JobRegistry};
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_tools::{ToolExecutor, ToolRequest, ToolResult};
use xharness_web::WebRuntime;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    jobs: Arc<JobRegistry>,
    executor: ToolExecutor,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xh-job-timeout-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let jobs = Arc::new(JobRegistry::default());
        let bundle = CodingToolBundle::new(
            Arc::new(NativePlatform::new(PlatformConfig::new(&root).full_access()).unwrap()),
            Arc::clone(&jobs),
            Arc::new(WebRuntime::default()),
            "test",
            "owner",
        );
        Self {
            root,
            jobs,
            executor: ToolExecutor::new(bundle.registry().await.unwrap()),
        }
    }
    fn job(&self, owner: &str) -> (String, JobLease) {
        let (id, lease) = self
            .jobs
            .reserve(owner, "test", "fixture", None)
            .unwrap()
            .commit(None, Arc::new(|_| Ok(())))
            .unwrap();
        (id.as_str().to_owned(), lease)
    }
    async fn output(&self, args: Value) -> ToolResult {
        tokio::time::timeout(
            Duration::from_secs(2),
            self.executor
                .execute(ToolRequest::new("job_output", args.to_string())),
        )
        .await
        .expect("job_output hung")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn output(result: ToolResult) -> Value {
    assert!(result.is_ok(), "{result:?}");
    serde_json::from_str(&result.output.unwrap().content).unwrap()
}

#[tokio::test]
async fn invalid_wait_values_are_not_silently_defaulted_even_for_completed_jobs() {
    let f = Fixture::new().await;
    let (id, lease) = f.job("owner");
    lease.finish(JobOutcome::completed("done"));
    for value in [
        json!(-1),
        json!(i64::MIN),
        json!(0),
        json!(600001),
        json!(u64::MAX),
        json!(null),
        json!(1.5),
        json!("100"),
        json!(true),
    ] {
        let r = f
            .output(json!({"job_id":id,"wait":true,"timeout_ms":value}))
            .await;
        assert!(!r.is_ok(), "accepted invalid {value}: {r:?}");
    }
}
#[tokio::test]
async fn completed_jobs_accept_omitted_default_and_valid_boundaries() {
    let f = Fixture::new().await;
    let (id, lease) = f.job("owner");
    lease.publish_stdout("done");
    lease.finish(JobOutcome::completed("done"));
    for timeout in [None, Some(1), Some(30000), Some(600000)] {
        let mut args = json!({"job_id":id,"wait":true});
        if let Some(v) = timeout {
            args["timeout_ms"] = json!(v);
        }
        let v = output(f.output(args).await);
        assert_eq!(v["stdout"], "done");
        assert_eq!(v["snapshot"]["status"], "completed");
    }
}
#[tokio::test]
async fn running_wait_timeout_preserves_job_and_cursor_is_incremental() {
    let f = Fixture::new().await;
    let (id, lease) = f.job("owner");
    lease.publish_stdout("first");
    let a = output(
        f.output(json!({"job_id":id,"wait":true,"timeout_ms":10}))
            .await,
    );
    assert_eq!(a["snapshot"]["status"], "running");
    assert_eq!(a["stdout"], "first");
    lease.publish_stdout("second");
    lease.publish_stderr("err");
    let b = output(
        f.output(json!({"job_id":id,"cursor":a["next_cursor"]}))
            .await,
    );
    assert_eq!(b["stdout"], "second");
    assert_eq!(b["stderr"], "err");
    let c = output(
        f.output(json!({"job_id":id,"cursor":b["next_cursor"]}))
            .await,
    );
    assert_eq!(c["stdout"], "");
    assert_eq!(c["stderr"], "");
    lease.finish(JobOutcome::completed("done"));
}
#[tokio::test]
async fn cancelling_wait_does_not_cancel_background_job() {
    let f = Fixture::new().await;
    let (id, lease) = f.job("owner");
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        trigger.cancel();
    });
    let r = tokio::time::timeout(
        Duration::from_secs(2),
        f.executor.execute(
            ToolRequest::new(
                "job_output",
                json!({"job_id":id,"wait":true,"timeout_ms":600000}).to_string(),
            )
            .with_cancellation(cancel),
        ),
    )
    .await
    .unwrap();
    task.await.unwrap();
    assert!(!r.is_ok(), "{r:?}");
    let v = output(f.output(json!({"job_id":id})).await);
    assert_eq!(v["snapshot"]["status"], "running");
    lease.finish(JobOutcome::completed("done"));
}
#[tokio::test]
async fn job_completion_wakes_wait_and_does_not_block_other_job() {
    let f = Fixture::new().await;
    let (id, lease) = f.job("owner");
    let (other, other_lease) = f.job("owner");
    other_lease.publish_stdout("independent");
    let finish = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        lease.publish_stdout("finished");
        lease.finish(JobOutcome::completed("done"));
    });
    let (a, b) = tokio::join!(
        f.output(json!({"job_id":id,"wait":true,"timeout_ms":1000})),
        f.output(json!({"job_id":other}))
    );
    let a = output(a);
    let b = output(b);
    assert_eq!(a["stdout"], "finished");
    assert_eq!(a["snapshot"]["status"], "completed");
    assert_eq!(b["stdout"], "independent");
    finish.await.unwrap();
    other_lease.finish(JobOutcome::completed("done"));
}
#[tokio::test]
async fn ownership_cursor_and_wait_option_errors_remain_errors() {
    let f = Fixture::new().await;
    let (id, lease) = f.job("owner");
    let (foreign, foreign_lease) = f.job("other-owner");
    for args in [
        json!({"job_id":foreign}),
        json!({"job_id":"missing"}),
        json!({"job_id":id,"timeout_ms":1}),
        json!({"job_id":id,"wait":false,"timeout_ms":1}),
        json!({"job_id":id,"cursor":{"job_id":"wrong","stdout":0,"stderr":0}}),
        json!({"job_id":id,"cursor":{"job_id":id,"stdout":1000,"stderr":0}}),
    ] {
        let r = f.output(args).await;
        assert!(!r.is_ok(), "{r:?}");
    }
    lease.finish(JobOutcome::completed("done"));
    foreign_lease.finish(JobOutcome::completed("done"));
}
