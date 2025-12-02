use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::{Barrier, Mutex, Notify};
use tokio_util::sync::CancellationToken;
use xharness_debug::{DebugRecorder, MemoryDebugSink};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, AroundMiddleware, AroundNext,
    ExecutorConfigError, FinalizeMiddleware, GuardDecision, MiddlewareError, MonotonicGuard,
    PostMiddleware, PreMiddleware, RegistryError, ToolBatchEvent, ToolBatchRequest,
    ToolConcurrency, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolFailureKind,
    ToolHandlerError, ToolLifecycle, ToolObserver, ToolOutcome, ToolOutput, ToolRegistry,
    ToolRequest, ToolResult, ToolSpec,
};

fn definition(name: &str) -> ToolDefinition {
    ToolDefinition::new(
        name,
        format!("Run {name}"),
        json!({
            "type": "object",
            "properties": {
                "value": { "type": "string" }
            },
            "required": ["value"],
            "additionalProperties": false
        }),
    )
}

fn successful_spec(name: &str) -> ToolSpec {
    ToolSpec::new(definition(name), |_context| async move {
        Ok(ToolOutput::text("ok"))
    })
}

#[test]
fn unannotated_tools_default_to_the_exclusive_lane() {
    assert_eq!(
        successful_spec("safe_default").concurrency,
        ToolConcurrency::Exclusive
    );
    assert_eq!(ToolConcurrency::default(), ToolConcurrency::Exclusive);
}

#[tokio::test]
async fn caller_supplied_execution_id_reaches_context_and_result_unchanged() {
    assert!(ToolRequest::new("echo", r#"{"value":"x"}"#)
        .with_execution_id("  ")
        .is_err());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("echo"), {
            let seen = Arc::clone(&seen);
            move |context| {
                let seen = Arc::clone(&seen);
                async move {
                    seen.lock().await.push(context.execution_id.to_string());
                    Ok(ToolOutput::text("ok"))
                }
            }
        }))
        .await
        .unwrap();
    let result = ToolExecutor::new(registry)
        .execute(
            ToolRequest::new("echo", r#"{"value":"x"}"#)
                .with_execution_id("session/turn/step/call")
                .unwrap(),
        )
        .await;
    assert_eq!(result.execution_id.as_str(), "session/turn/step/call");
    assert_eq!(seen.lock().await.as_slice(), ["session/turn/step/call"]);
}

struct CountingApproval(Arc<AtomicUsize>);

#[async_trait]
impl ApprovalProvider for CountingApproval {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(ApprovalDecision::Approved)
    }
}

#[tokio::test]
async fn durable_request_can_force_approval_after_registry_reprojection() {
    let approvals = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry.register(successful_spec("safe")).await.unwrap();
    let result = ToolExecutor::new(registry)
        .with_approval_provider(Arc::new(CountingApproval(Arc::clone(&approvals))))
        .execute(ToolRequest::new("safe", r#"{"value":"x"}"#).requiring_approval(true))
        .await;
    assert!(result.is_ok());
    assert_eq!(approvals.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn registry_rejects_duplicate_names_atomically() {
    let registry = ToolRegistry::new();
    registry
        .register(successful_spec("read_file"))
        .await
        .unwrap();
    let error = registry
        .register(successful_spec("read_file"))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        RegistryError::DuplicateName {
            name: "read_file".to_owned()
        }
    );
    assert_eq!(registry.len().await, 1);
    assert_eq!(registry.definitions().await.len(), 1);
}

#[tokio::test]
async fn registry_rejects_non_object_or_malformed_schemas() {
    let registry = ToolRegistry::new();
    for (name, schema) in [
        (
            "array_root",
            json!({"type": "array", "items": {"type": "string"}}),
        ),
        (
            "bad_required",
            json!({"type": "object", "required": "value"}),
        ),
        (
            "bad_property",
            json!({"type": "object", "properties": {"value": true}}),
        ),
    ] {
        let error = registry
            .register(ToolSpec::new(
                ToolDefinition::new(name, "invalid", schema),
                |_context| async move { Ok(ToolOutput::text("never")) },
            ))
            .await
            .unwrap_err();
        assert!(matches!(error, RegistryError::InvalidSchema { .. }));
    }
    assert!(registry.is_empty().await);
}

#[tokio::test]
async fn malformed_or_schema_invalid_arguments_never_reach_handler() {
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("echo"), {
            let calls = Arc::clone(&calls);
            move |_context| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(ToolOutput::text("called"))
                }
            }
        }))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);

    let mut execution_ids = HashSet::new();
    for arguments in [
        "not-json",
        "[]",
        r#"{}"#,
        r#"{"value":3}"#,
        r#"{"value":"ok","extra":true}"#,
    ] {
        let result = executor.execute(ToolRequest::new("echo", arguments)).await;
        assert_eq!(
            result.failure_kind(),
            Some(ToolFailureKind::InvalidArguments),
            "arguments={arguments}"
        );
        assert!(!result.execution_id.as_str().is_empty());
        assert!(execution_ids.insert(result.execution_id));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

struct FixedGuard {
    decision: GuardDecision,
}

#[async_trait]
impl MonotonicGuard for FixedGuard {
    async fn evaluate(
        &self,
        _context: &ToolExecutionContext,
    ) -> Result<GuardDecision, MiddlewareError> {
        Ok(self.decision.clone())
    }
}

struct PanicPre;

#[async_trait]
impl PreMiddleware for PanicPre {
    async fn pre(&self, _context: &ToolExecutionContext) -> Result<(), MiddlewareError> {
        panic!("pre panic")
    }
}

struct PanicGuard;

#[async_trait]
impl MonotonicGuard for PanicGuard {
    async fn evaluate(
        &self,
        _context: &ToolExecutionContext,
    ) -> Result<GuardDecision, MiddlewareError> {
        panic!("guard panic")
    }
}

struct PanicPost;

#[async_trait]
impl PostMiddleware for PanicPost {
    async fn post(
        &self,
        _context: &ToolExecutionContext,
        _outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError> {
        panic!("post panic")
    }
}

struct PanicFinalize;

#[async_trait]
impl FinalizeMiddleware for PanicFinalize {
    async fn finalize(
        &self,
        _context: &ToolExecutionContext,
        _outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError> {
        panic!("finalize panic")
    }
}

#[tokio::test]
async fn every_mutating_middleware_stage_materializes_panics() {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(successful_spec("panic_stage"))
        .await
        .unwrap();
    let request = || ToolRequest::new("panic_stage", r#"{"value":"x"}"#);

    let result = ToolExecutor::new(Arc::clone(&registry))
        .with_pre(vec![Arc::new(PanicPre)])
        .execute(request())
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::Preflight));
    assert!(result.failure.unwrap().message.contains("pre panic"));

    let result = ToolExecutor::new(Arc::clone(&registry))
        .with_guards(vec![Arc::new(PanicGuard)])
        .execute(request())
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::GuardDenied));
    assert!(result.failure.unwrap().message.contains("guard panic"));

    let result = ToolExecutor::new(Arc::clone(&registry))
        .with_post(vec![Arc::new(PanicPost)])
        .execute(request())
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::PostProcess));
    assert!(result.failure.unwrap().message.contains("post panic"));

    let result = ToolExecutor::new(registry)
        .with_finalize(vec![Arc::new(PanicFinalize)])
        .execute(request())
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::Finalize));
    assert!(result.failure.unwrap().message.contains("finalize panic"));
}

#[tokio::test]
async fn a_later_allow_cannot_reverse_an_approval_or_denial_guard() {
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("danger"), {
            let calls = Arc::clone(&calls);
            move |_context| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(ToolOutput::text("ran"))
                }
            }
        }))
        .await
        .unwrap();

    let approval_then_allow = ToolExecutor::new(Arc::clone(&registry)).with_guards(vec![
        Arc::new(FixedGuard {
            decision: GuardDecision::require_approval("side effects"),
        }),
        Arc::new(FixedGuard {
            decision: GuardDecision::Allow,
        }),
    ]);
    let result = approval_then_allow
        .execute(ToolRequest::new("danger", r#"{"value":"x"}"#))
        .await;
    assert_eq!(
        result.failure_kind(),
        Some(ToolFailureKind::ApprovalUnavailable)
    );

    let deny_then_allow = ToolExecutor::new(registry).with_guards(vec![
        Arc::new(FixedGuard {
            decision: GuardDecision::deny("policy denied"),
        }),
        Arc::new(FixedGuard {
            decision: GuardDecision::Allow,
        }),
    ]);
    let result = deny_then_allow
        .execute(ToolRequest::new("danger", r#"{"value":"x"}"#))
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::GuardDenied));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

struct BrokenApproval;

#[async_trait]
impl ApprovalProvider for BrokenApproval {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        Err(MiddlewareError::new("approval transport offline"))
    }
}

struct PendingApproval;

#[async_trait]
impl ApprovalProvider for PendingApproval {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        std::future::pending().await
    }
}

struct NotifyingPendingApproval {
    entered: Arc<Notify>,
}

#[async_trait]
impl ApprovalProvider for NotifyingPendingApproval {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        self.entered.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn unavailable_approval_provider_fails_closed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(
            ToolSpec::new(definition("write"), {
                let calls = Arc::clone(&calls);
                move |_context| {
                    let calls = Arc::clone(&calls);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(ToolOutput::text("wrote"))
                    }
                }
            })
            .requiring_approval(true),
        )
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry).with_approval_provider(Arc::new(BrokenApproval));
    let result = executor
        .execute(ToolRequest::new("write", r#"{"value":"x"}"#))
        .await;
    assert_eq!(
        result.failure_kind(),
        Some(ToolFailureKind::ApprovalUnavailable)
    );
    assert!(result.failure.as_ref().unwrap().message.contains("offline"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn approval_deadline_fails_closed_when_provider_never_answers() {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(successful_spec("approve_me").requiring_approval(true))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry)
        .with_approval_provider(Arc::new(PendingApproval))
        .with_approval_timeout(Duration::from_secs(30))
        .unwrap();

    let result = executor
        .execute(ToolRequest::new("approve_me", r#"{"value":"x"}"#))
        .await;
    assert_eq!(
        result.failure_kind(),
        Some(ToolFailureKind::ApprovalUnavailable)
    );
    assert!(result.failure.unwrap().message.contains("deadline"));
}

#[tokio::test]
async fn zero_approval_deadline_is_rejected() {
    let registry = Arc::new(ToolRegistry::new());
    let error = ToolExecutor::new(registry)
        .with_approval_timeout(Duration::ZERO)
        .unwrap_err();
    assert_eq!(error, ExecutorConfigError::ZeroApprovalTimeout);
}

#[tokio::test]
async fn cancellation_while_waiting_for_approval_is_distinct_from_unavailability() {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(successful_spec("cancel_approval").requiring_approval(true))
        .await
        .unwrap();
    let entered = Arc::new(Notify::new());
    let executor =
        ToolExecutor::new(registry).with_approval_provider(Arc::new(NotifyingPendingApproval {
            entered: Arc::clone(&entered),
        }));
    let cancellation = CancellationToken::new();
    let run = tokio::spawn({
        let cancellation = cancellation.clone();
        async move {
            executor
                .execute(
                    ToolRequest::new("cancel_approval", r#"{"value":"x"}"#)
                        .with_cancellation(cancellation),
                )
                .await
        }
    });

    entered.notified().await;
    cancellation.cancel();
    let result = run.await.unwrap();
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::Cancelled));
}

#[tokio::test]
async fn timeout_and_handler_panic_are_materialized() {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(
            ToolSpec::new(definition("slow"), |context| async move {
                context.cancellation.cancelled().await;
                Ok(ToolOutput::text("late"))
            })
            .with_timeout(Duration::from_millis(5)),
        )
        .await
        .unwrap();
    registry
        .register(ToolSpec::new(definition("panic"), |_context| async move {
            panic!("handler exploded");
            #[allow(unreachable_code)]
            Ok(ToolOutput::text("unreachable"))
        }))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);

    let timed_out = executor
        .execute(ToolRequest::new("slow", r#"{"value":"x"}"#))
        .await;
    assert_eq!(timed_out.failure_kind(), Some(ToolFailureKind::TimedOut));
    assert!(timed_out.failure.unwrap().retryable);

    let panicked = executor
        .execute(ToolRequest::new("panic", r#"{"value":"x"}"#))
        .await;
    assert_eq!(panicked.failure_kind(), Some(ToolFailureKind::Panicked));
    assert!(panicked
        .failure
        .unwrap()
        .message
        .contains("handler exploded"));
}

type Trace = Arc<Mutex<Vec<&'static str>>>;

struct TracePre(Trace);

#[async_trait]
impl PreMiddleware for TracePre {
    async fn pre(&self, _context: &ToolExecutionContext) -> Result<(), MiddlewareError> {
        self.0.lock().await.push("pre");
        Ok(())
    }
}

struct TraceGuard(Trace);

#[async_trait]
impl MonotonicGuard for TraceGuard {
    async fn evaluate(
        &self,
        _context: &ToolExecutionContext,
    ) -> Result<GuardDecision, MiddlewareError> {
        self.0.lock().await.push("guard");
        Ok(GuardDecision::require_approval("test"))
    }
}

struct TraceApproval(Trace);

#[async_trait]
impl ApprovalProvider for TraceApproval {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        self.0.lock().await.push("approval");
        Ok(ApprovalDecision::Approved)
    }
}

struct TraceAround(Trace);

impl AroundMiddleware for TraceAround {
    fn around(
        &self,
        context: ToolExecutionContext,
        next: AroundNext,
    ) -> xharness_tools::HandlerFuture {
        let trace = Arc::clone(&self.0);
        Box::pin(async move {
            trace.lock().await.push("around-enter");
            let result = next.run(context).await;
            trace.lock().await.push("around-exit");
            result
        })
    }
}

struct TracePost(Trace);

#[async_trait]
impl PostMiddleware for TracePost {
    async fn post(
        &self,
        _context: &ToolExecutionContext,
        outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError> {
        self.0.lock().await.push("post");
        outcome.output_mut().unwrap().content.push_str("|post");
        Ok(())
    }
}

struct TraceFinalize(Trace);

#[async_trait]
impl FinalizeMiddleware for TraceFinalize {
    async fn finalize(
        &self,
        _context: &ToolExecutionContext,
        outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError> {
        self.0.lock().await.push("finalize");
        outcome.output_mut().unwrap().content.push_str("|finalize");
        Ok(())
    }
}

struct AttemptRecoveryFinalize;

#[async_trait]
impl FinalizeMiddleware for AttemptRecoveryFinalize {
    async fn finalize(
        &self,
        _context: &ToolExecutionContext,
        outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError> {
        assert!(!outcome.replace_output(ToolOutput::text("unsafe recovery")));
        Ok(())
    }
}

struct TraceObserver(Trace);

#[async_trait]
impl ToolObserver for TraceObserver {
    async fn observe(&self, result: &ToolResult) -> Result<(), MiddlewareError> {
        assert_eq!(
            result.output.as_ref().unwrap().content,
            "handler|post|finalize"
        );
        self.0.lock().await.push("observer");
        Ok(())
    }
}

#[tokio::test]
async fn pipeline_order_is_stable() {
    let trace: Trace = Arc::new(Mutex::new(Vec::new()));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("ordered"), {
            let trace = Arc::clone(&trace);
            move |_context| {
                let trace = Arc::clone(&trace);
                async move {
                    trace.lock().await.push("handler");
                    Ok(ToolOutput::text("handler"))
                }
            }
        }))
        .await
        .unwrap();

    let executor = ToolExecutor::new(registry)
        .with_pre(vec![Arc::new(TracePre(Arc::clone(&trace)))])
        .with_guards(vec![Arc::new(TraceGuard(Arc::clone(&trace)))])
        .with_approval_provider(Arc::new(TraceApproval(Arc::clone(&trace))))
        .with_around(vec![Arc::new(TraceAround(Arc::clone(&trace)))])
        .with_post(vec![Arc::new(TracePost(Arc::clone(&trace)))])
        .with_finalize(vec![Arc::new(TraceFinalize(Arc::clone(&trace)))])
        .with_observers(vec![Arc::new(TraceObserver(Arc::clone(&trace)))]);

    let result = executor
        .execute(ToolRequest::new("ordered", r#"{"value":"x"}"#))
        .await;
    assert!(result.is_ok());
    assert_eq!(
        trace.lock().await.as_slice(),
        [
            "pre",
            "guard",
            "approval",
            "around-enter",
            "handler",
            "around-exit",
            "post",
            "finalize",
            "observer"
        ]
    );
}

#[tokio::test]
async fn finalizer_cannot_turn_a_policy_denial_into_success() {
    let registry = Arc::new(ToolRegistry::new());
    registry.register(successful_spec("denied")).await.unwrap();
    let executor = ToolExecutor::new(registry)
        .with_guards(vec![Arc::new(FixedGuard {
            decision: GuardDecision::deny("read-only policy"),
        })])
        .with_finalize(vec![Arc::new(AttemptRecoveryFinalize)]);

    let result = executor
        .execute(ToolRequest::new("denied", r#"{"value":"x"}"#))
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::GuardDenied));
    assert!(result.output.is_none());
}

#[derive(Default)]
struct Activity {
    active: AtomicUsize,
    max_active: AtomicUsize,
}

impl Activity {
    fn enter(&self) {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
    }

    fn exit(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }

    fn reset_max(&self) {
        assert_eq!(self.active.load(Ordering::SeqCst), 0);
        self.max_active.store(0, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn keyed_concurrency_serializes_equal_keys_but_not_distinct_keys() {
    let activity = Arc::new(Activity::default());
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(
            ToolSpec::new(definition("keyed"), {
                let activity = Arc::clone(&activity);
                move |_context| {
                    let activity = Arc::clone(&activity);
                    async move {
                        activity.enter();
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        activity.exit();
                        Ok(ToolOutput::text("ok"))
                    }
                }
            })
            .with_concurrency(ToolConcurrency::Keyed)
            .with_resource_key_resolver(|arguments| {
                arguments
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            }),
        )
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);

    let (first, second) = tokio::join!(
        executor.execute(ToolRequest::new("keyed", r#"{"value":"same"}"#)),
        executor.execute(ToolRequest::new("keyed", r#"{"value":"same"}"#)),
    );
    assert!(first.is_ok() && second.is_ok());
    assert_eq!(activity.max_active.load(Ordering::SeqCst), 1);

    activity.reset_max();
    let (first, second) = tokio::join!(
        executor.execute(ToolRequest::new("keyed", r#"{"value":"a"}"#)),
        executor.execute(ToolRequest::new("keyed", r#"{"value":"b"}"#)),
    );
    assert!(first.is_ok() && second.is_ok());
    assert_eq!(activity.max_active.load(Ordering::SeqCst), 2);
}

struct RecordingLifecycle {
    seen: Arc<Mutex<Vec<String>>>,
    fail: bool,
}

struct PendingLifecycle {
    entered: Arc<Notify>,
}

#[async_trait]
impl ToolLifecycle for PendingLifecycle {
    async fn started(&self, _context: &ToolExecutionContext) -> Result<(), MiddlewareError> {
        self.entered.notify_one();
        std::future::pending().await
    }
}

#[async_trait]
impl ToolLifecycle for RecordingLifecycle {
    async fn started(&self, context: &ToolExecutionContext) -> Result<(), MiddlewareError> {
        self.seen
            .lock()
            .await
            .push(context.execution_id.to_string());
        if self.fail {
            Err(MiddlewareError::new("durable start boundary unavailable"))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn lifecycle_is_acknowledged_before_handler_side_effects_and_fails_closed() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handler_calls = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("effect"), {
            let handler_calls = Arc::clone(&handler_calls);
            move |_context| {
                let handler_calls = Arc::clone(&handler_calls);
                async move {
                    handler_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(ToolOutput::text("effect"))
                }
            }
        }))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry).with_lifecycle(Arc::new(RecordingLifecycle {
        seen: Arc::clone(&seen),
        fail: true,
    }));
    let result = executor
        .execute(
            ToolRequest::new("effect", r#"{"value":"x"}"#)
                .with_execution_id("durable/effect/1")
                .unwrap(),
        )
        .await;
    assert_eq!(result.failure_kind(), Some(ToolFailureKind::Lifecycle));
    assert_eq!(handler_calls.load(Ordering::SeqCst), 0);
    assert_eq!(seen.lock().await.as_slice(), ["durable/effect/1"]);
}

#[tokio::test]
async fn cancellation_unblocks_a_pending_lifecycle_ack_without_running_the_handler() {
    let entered = Arc::new(Notify::new());
    let handler_calls = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("effect"), {
            let handler_calls = Arc::clone(&handler_calls);
            move |_context| {
                let handler_calls = Arc::clone(&handler_calls);
                async move {
                    handler_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(ToolOutput::text("must not run"))
                }
            }
        }))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry).with_lifecycle(Arc::new(PendingLifecycle {
        entered: Arc::clone(&entered),
    }));
    let mut batch = executor
        .start_batch(
            vec![ToolBatchRequest::new(
                0,
                ToolRequest::new("effect", r#"{"value":"x"}"#),
            )],
            1,
        )
        .await
        .unwrap();
    entered.notified().await;

    batch.cancel();
    while batch.next_event().await.is_some() {}
    let results = batch.result().await.unwrap();

    assert_eq!(handler_calls.load(Ordering::SeqCst), 0);
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].result.failure_kind(),
        Some(ToolFailureKind::Cancelled)
    );
}

#[tokio::test]
async fn batch_scheduler_owns_limit_barriers_completion_order_and_replay_order() {
    let activity = Arc::new(Activity::default());
    let timeline = Arc::new(Mutex::new(Vec::<String>::new()));
    let registry = Arc::new(ToolRegistry::new());

    for (name, delay_ms, mode) in [
        ("slow", 40u64, ToolConcurrency::Parallel),
        ("fast", 5u64, ToolConcurrency::Parallel),
        ("barrier", 1u64, ToolConcurrency::Exclusive),
        ("after", 1u64, ToolConcurrency::Parallel),
    ] {
        registry
            .register(
                ToolSpec::new(definition(name), {
                    let activity = Arc::clone(&activity);
                    let timeline = Arc::clone(&timeline);
                    let name = name.to_owned();
                    move |_context| {
                        let activity = Arc::clone(&activity);
                        let timeline = Arc::clone(&timeline);
                        let name = name.clone();
                        async move {
                            activity.enter();
                            timeline.lock().await.push(format!("{name}:start"));
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                            timeline.lock().await.push(format!("{name}:end"));
                            activity.exit();
                            Ok(ToolOutput::text(name))
                        }
                    }
                })
                .with_concurrency(mode),
            )
            .await
            .unwrap();
    }

    let executor = ToolExecutor::new(registry);
    let requests = ["slow", "fast", "barrier", "after"]
        .into_iter()
        .enumerate()
        .map(|(order, name)| {
            ToolBatchRequest::new(
                order,
                ToolRequest::new(name, r#"{"value":"x"}"#)
                    .with_execution_id(format!("batch/{order}"))
                    .unwrap(),
            )
        })
        .collect();
    let mut batch = executor.start_batch(requests, 2).await.unwrap();
    let mut completion_order = Vec::new();
    while let Some(event) = batch.next_event().await {
        let ToolBatchEvent::Completed(completed) = event;
        completion_order.push(completed.order);
    }
    let results = batch.result().await.unwrap();

    assert_eq!(completion_order, [1, 0, 2, 3]);
    assert_eq!(
        results
            .iter()
            .map(|result| result.order)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(activity.max_active.load(Ordering::SeqCst), 2);
    let timeline = timeline.lock().await;
    let slow_end = timeline.iter().position(|item| item == "slow:end").unwrap();
    let fast_end = timeline.iter().position(|item| item == "fast:end").unwrap();
    let barrier_start = timeline
        .iter()
        .position(|item| item == "barrier:start")
        .unwrap();
    let barrier_end = timeline
        .iter()
        .position(|item| item == "barrier:end")
        .unwrap();
    let after_start = timeline
        .iter()
        .position(|item| item == "after:start")
        .unwrap();
    assert!(barrier_start > slow_end && barrier_start > fast_end);
    assert!(after_start > barrier_end);
}

#[tokio::test]
async fn batch_rejects_invalid_shape_and_empty_batch_settles_cleanly() {
    let executor = ToolExecutor::new(Arc::new(ToolRegistry::new()));

    let zero = executor.start_batch(Vec::new(), 0).await.err().unwrap();
    assert_eq!(zero, xharness_tools::ToolBatchError::ZeroConcurrency);

    let duplicate = executor
        .start_batch(
            vec![
                ToolBatchRequest::new(7, ToolRequest::new("missing", "{}")),
                ToolBatchRequest::new(7, ToolRequest::new("missing", "{}")),
            ],
            1,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(duplicate, xharness_tools::ToolBatchError::DuplicateOrder(7));

    let mut empty = executor.start_batch(Vec::new(), 1).await.unwrap();
    assert!(empty.next_event().await.is_none());
    assert!(empty.result().await.unwrap().is_empty());
}

#[tokio::test]
async fn batch_cancel_waits_for_each_cooperative_handler_to_quiesce() {
    let entered = Arc::new(Barrier::new(3));
    let cleaned = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(
            ToolSpec::new(definition("cooperative"), {
                let entered = Arc::clone(&entered);
                let cleaned = Arc::clone(&cleaned);
                move |context| {
                    let entered = Arc::clone(&entered);
                    let cleaned = Arc::clone(&cleaned);
                    async move {
                        entered.wait().await;
                        context.cancellation.cancelled().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        cleaned.fetch_add(1, Ordering::SeqCst);
                        Ok(ToolOutput::text("cleaned"))
                    }
                }
            })
            .with_concurrency(ToolConcurrency::Parallel),
        )
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);
    let requests = (0..2)
        .map(|order| {
            ToolBatchRequest::new(
                order,
                ToolRequest::new("cooperative", r#"{"value":"x"}"#)
                    .with_execution_id(format!("cancel/{order}"))
                    .unwrap(),
            )
        })
        .collect();
    let mut batch = executor.start_batch(requests, 2).await.unwrap();
    entered.wait().await;

    batch.cancel();
    let mut completions = 0;
    while batch.next_event().await.is_some() {
        completions += 1;
    }
    let results = batch.result().await.unwrap();

    assert_eq!(completions, 2);
    assert_eq!(cleaned.load(Ordering::SeqCst), 2);
    assert_eq!(results.len(), 2);
    assert!(results
        .iter()
        .all(|result| result.result.failure_kind() == Some(ToolFailureKind::Cancelled)));
}

#[tokio::test(start_paused = true)]
async fn uncooperative_handler_is_reported_as_cleanup_timeout() {
    let entered = Arc::new(Notify::new());
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(ToolSpec::new(definition("uncooperative"), {
            let entered = Arc::clone(&entered);
            move |_context| {
                let entered = Arc::clone(&entered);
                async move {
                    entered.notify_one();
                    std::future::pending::<Result<ToolOutput, ToolHandlerError>>().await
                }
            }
        }))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);
    let mut batch = executor
        .start_batch(
            vec![ToolBatchRequest::new(
                0,
                ToolRequest::new("uncooperative", r#"{"value":"x"}"#)
                    .with_execution_id("cleanup-timeout")
                    .unwrap(),
            )],
            1,
        )
        .await
        .unwrap();
    entered.notified().await;
    batch.cancel();
    tokio::time::advance(Duration::from_secs(6)).await;
    while batch.next_event().await.is_some() {}
    let results = batch.result().await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].result.failure_kind(),
        Some(ToolFailureKind::CleanupTimeout)
    );
}

#[tokio::test]
async fn full_debug_records_validated_arguments_pipeline_and_final_result() {
    let registry = Arc::new(ToolRegistry::new());
    registry.register(successful_spec("debug")).await.unwrap();
    let sink = Arc::new(MemoryDebugSink::default());
    let result = ToolExecutor::new(registry)
        .with_debug(DebugRecorder::new(sink.clone()))
        .execute(
            ToolRequest::new("debug", r#"{"value":"visible"}"#)
                .with_execution_id("execution-debug")
                .unwrap(),
        )
        .await;
    assert!(result.is_ok());
    let events = sink.events().await;
    for expected in [
        "execute.request",
        "arguments.validated",
        "pipeline.guards.completed",
        "handler.started",
        "handler.completed",
        "execute.completed",
    ] {
        assert!(events.iter().any(|event| event.event == expected));
    }
    assert!(events.iter().any(|event| {
        event.event == "execute.completed"
            && event.payload["result"]["execution_id"] == "execution-debug"
    }));
}
