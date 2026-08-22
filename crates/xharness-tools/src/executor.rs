use std::{
    any::Any,
    collections::HashMap,
    fmt,
    panic::AssertUnwindSafe,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant, SystemTime},
};

use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    validate_arguments, ApprovalDecision, ApprovalProvider, ApprovalRequest, AroundMiddleware,
    AroundNext, ExecutionId, FinalizeMiddleware, GuardDecision, GuardVerdict, MonotonicGuard,
    PostMiddleware, PreMiddleware, ToolConcurrency, ToolExecutionContext, ToolHandlerError,
    ToolLifecycle, ToolObserver, ToolOutcome, ToolOutput, ToolRegistry, ToolSpec,
};

static NEXT_EXECUTION_ID: AtomicU64 = AtomicU64::new(1);
const HANDLER_CLEANUP_GRACE: Duration = Duration::from_secs(5);

/// One raw model/host invocation.
#[derive(Clone, Debug)]
pub struct ToolRequest {
    pub name: String,
    pub arguments_json: String,
    pub cancellation: CancellationToken,
    pub execution_id: Option<ExecutionId>,
    /// Fail-safe per-invocation override, used when a durable pending approval
    /// is resumed under a newly projected registry.
    pub requires_approval: bool,
}

impl ToolRequest {
    pub fn new(name: impl Into<String>, arguments_json: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            arguments_json: arguments_json.into(),
            cancellation: CancellationToken::new(),
            execution_id: None,
            requires_approval: false,
        }
    }

    pub fn with_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    /// Bind an already-durable Harness execution identity. The executor uses
    /// this exact value in middleware, approvals, observers and its result
    /// instead of minting a process-local identity.
    pub fn with_execution_id(
        mut self,
        execution_id: impl Into<String>,
    ) -> Result<Self, crate::ExecutionIdError> {
        self.execution_id = Some(ExecutionId::new(execution_id)?);
        Ok(self)
    }

    pub fn requiring_approval(mut self, required: bool) -> Self {
        self.requires_approval = required;
        self
    }
}

/// Stable failure classification. All variants are returned as values rather
/// than bubbling through the executor API.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolFailureKind {
    UnknownTool,
    InvalidArguments,
    Preflight,
    GuardDenied,
    ApprovalUnavailable,
    ApprovalDenied,
    Concurrency,
    Lifecycle,
    Handler,
    TimedOut,
    Panicked,
    Cancelled,
    PostProcess,
    Finalize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolFailure {
    pub kind: ToolFailureKind,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

impl ToolFailure {
    pub fn new(kind: ToolFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable: false,
        }
    }

    fn retryable(kind: ToolFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable: true,
        }
    }
}

/// Fully materialized terminal record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub execution_id: ExecutionId,
    pub tool_name: String,
    pub output: Option<ToolOutput>,
    pub failure: Option<ToolFailure>,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub duration_ms: u64,
    /// Observer diagnostics do not rewrite the finalized tool outcome.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observer_errors: Vec<String>,
}

impl ToolResult {
    pub fn is_ok(&self) -> bool {
        self.failure.is_none()
    }

    pub fn failure_kind(&self) -> Option<ToolFailureKind> {
        self.failure.as_ref().map(|failure| failure.kind)
    }
}

/// Immutable pipeline. Builders consume `self`, preventing a running executor
/// from observing middleware reordering.
#[derive(Clone)]
pub struct ToolExecutor {
    registry: Arc<ToolRegistry>,
    pre: Arc<[Arc<dyn PreMiddleware>]>,
    guards: Arc<[Arc<dyn MonotonicGuard>]>,
    around: Arc<[Arc<dyn AroundMiddleware>]>,
    post: Arc<[Arc<dyn PostMiddleware>]>,
    finalize: Arc<[Arc<dyn FinalizeMiddleware>]>,
    observers: Arc<[Arc<dyn ToolObserver>]>,
    lifecycle: Option<Arc<dyn ToolLifecycle>>,
    approval: Option<Arc<dyn ApprovalProvider>>,
    approval_timeout: Duration,
    concurrency: ConcurrencyGate,
}

impl ToolExecutor {
    pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            pre: Arc::from([]),
            guards: Arc::from([]),
            around: Arc::from([]),
            post: Arc::from([]),
            finalize: Arc::from([]),
            observers: Arc::from([]),
            lifecycle: None,
            approval: None,
            approval_timeout: Self::DEFAULT_APPROVAL_TIMEOUT,
            concurrency: ConcurrencyGate::default(),
        }
    }

    pub fn with_pre(mut self, middleware: Vec<Arc<dyn PreMiddleware>>) -> Self {
        self.pre = middleware.into();
        self
    }

    pub fn with_guards(mut self, guards: Vec<Arc<dyn MonotonicGuard>>) -> Self {
        self.guards = guards.into();
        self
    }

    pub fn with_around(mut self, middleware: Vec<Arc<dyn AroundMiddleware>>) -> Self {
        self.around = middleware.into();
        self
    }

    pub fn with_post(mut self, middleware: Vec<Arc<dyn PostMiddleware>>) -> Self {
        self.post = middleware.into();
        self
    }

    pub fn with_finalize(mut self, middleware: Vec<Arc<dyn FinalizeMiddleware>>) -> Self {
        self.finalize = middleware.into();
        self
    }

    pub fn with_observers(mut self, observers: Vec<Arc<dyn ToolObserver>>) -> Self {
        self.observers = observers.into();
        self
    }

    /// Install the host lifecycle sink used to durably acknowledge the
    /// side-effect boundary before a handler starts.
    pub fn with_lifecycle(mut self, lifecycle: Arc<dyn ToolLifecycle>) -> Self {
        self.lifecycle = Some(lifecycle);
        self
    }

    pub fn with_approval_provider(mut self, approval: Arc<dyn ApprovalProvider>) -> Self {
        self.approval = Some(approval);
        self
    }

    /// Set the maximum time an approval backend may hold one invocation.
    /// Zero is rejected rather than silently disabling the fail-closed bound.
    pub fn with_approval_timeout(mut self, timeout: Duration) -> Result<Self, ExecutorConfigError> {
        if timeout.is_zero() {
            return Err(ExecutorConfigError::ZeroApprovalTimeout);
        }
        self.approval_timeout = timeout;
        Ok(self)
    }

    pub fn registry(&self) -> &Arc<ToolRegistry> {
        &self.registry
    }

    pub async fn execute(&self, request: ToolRequest) -> ToolResult {
        let execution_id = request
            .execution_id
            .clone()
            .unwrap_or_else(next_execution_id);
        let started_at_ms = unix_timestamp_ms();
        let started = Instant::now();
        let name = request.name.clone();

        let Some(spec) = self.registry.get(&request.name).await else {
            return self
                .finish_without_context(
                    execution_id,
                    name,
                    started_at_ms,
                    started,
                    ToolOutcome::failure(ToolFailure::new(
                        ToolFailureKind::UnknownTool,
                        format!("unknown tool {:?}", request.name),
                    )),
                )
                .await;
        };

        let arguments: Value = match serde_json::from_str(&request.arguments_json) {
            Ok(arguments) => arguments,
            Err(error) => {
                return self
                    .finish_without_context(
                        execution_id,
                        name,
                        started_at_ms,
                        started,
                        ToolOutcome::failure(ToolFailure::new(
                            ToolFailureKind::InvalidArguments,
                            format!("tool arguments are not valid JSON: {error}"),
                        )),
                    )
                    .await;
            }
        };
        if let Err(violation) = validate_arguments(&spec.definition.parameters, &arguments) {
            return self
                .finish_without_context(
                    execution_id,
                    name,
                    started_at_ms,
                    started,
                    ToolOutcome::failure(ToolFailure::new(
                        ToolFailureKind::InvalidArguments,
                        violation.to_string(),
                    )),
                )
                .await;
        }

        let run_cancellation = request.cancellation.child_token();
        let context = ToolExecutionContext {
            execution_id: execution_id.clone(),
            definition: Arc::new(spec.definition.clone()),
            arguments: Arc::new(arguments),
            arguments_json: Arc::from(request.arguments_json),
            cancellation: run_cancellation.clone(),
        };

        let mut attempted_handler = false;
        let mut outcome = if request.cancellation.is_cancelled() {
            ToolOutcome::failure(ToolFailure::new(
                ToolFailureKind::Cancelled,
                "tool invocation was cancelled before preflight",
            ))
        } else if let Some(failure) = self.run_pre(&context).await {
            ToolOutcome::failure(failure)
        } else {
            let verdict = self
                .run_guards(
                    &context,
                    spec.requires_approval || request.requires_approval,
                )
                .await;
            match verdict {
                GuardVerdict::Deny { reasons } => ToolOutcome::failure(ToolFailure::new(
                    ToolFailureKind::GuardDenied,
                    join_reasons("tool execution denied", &reasons),
                )),
                GuardVerdict::RequireApproval { reasons } => {
                    match self.request_approval(&context, reasons).await {
                        Ok(()) => {
                            attempted_handler = true;
                            self.run_handler(&spec, &context, &request.cancellation)
                                .await
                        }
                        Err(failure) => ToolOutcome::failure(failure),
                    }
                }
                GuardVerdict::Allow => {
                    attempted_handler = true;
                    self.run_handler(&spec, &context, &request.cancellation)
                        .await
                }
            }
        };

        if attempted_handler {
            self.run_post(&context, &mut outcome).await;
        }
        self.run_finalize(&context, &mut outcome).await;
        self.finish(execution_id, name, started_at_ms, started, outcome)
            .await
    }

    async fn run_pre(&self, context: &ToolExecutionContext) -> Option<ToolFailure> {
        for middleware in self.pre.iter() {
            let result = AssertUnwindSafe(middleware.pre(context))
                .catch_unwind()
                .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return Some(ToolFailure::new(ToolFailureKind::Preflight, error.message));
                }
                Err(panic) => {
                    return Some(ToolFailure::new(
                        ToolFailureKind::Preflight,
                        format!("preflight middleware panicked: {}", panic_message(panic)),
                    ));
                }
            }
        }
        None
    }

    async fn run_guards(
        &self,
        context: &ToolExecutionContext,
        requires_approval: bool,
    ) -> GuardVerdict {
        let mut verdict = if requires_approval {
            GuardVerdict::Allow.restrict(GuardDecision::require_approval(
                "tool registration requires approval",
            ))
        } else {
            GuardVerdict::Allow
        };
        for guard in self.guards.iter() {
            let decision = AssertUnwindSafe(guard.evaluate(context))
                .catch_unwind()
                .await;
            verdict = verdict.restrict(match decision {
                Ok(Ok(decision)) => decision,
                Ok(Err(error)) => {
                    GuardDecision::deny(format!("guard failed closed: {}", error.message))
                }
                Err(panic) => GuardDecision::deny(format!(
                    "guard panicked and failed closed: {}",
                    panic_message(panic)
                )),
            });
        }
        verdict
    }

    async fn request_approval(
        &self,
        context: &ToolExecutionContext,
        reasons: Vec<String>,
    ) -> Result<(), ToolFailure> {
        let Some(provider) = &self.approval else {
            return Err(ToolFailure::new(
                ToolFailureKind::ApprovalUnavailable,
                join_reasons("approval required but no provider is configured", &reasons),
            ));
        };

        let request = ApprovalRequest {
            context: context.clone(),
            reasons,
        };
        let future = AssertUnwindSafe(provider.request_approval(request)).catch_unwind();
        let timed = tokio::time::timeout(self.approval_timeout, future);
        let response = tokio::select! {
            _ = context.cancellation.cancelled() => {
                return Err(ToolFailure::new(
                    ToolFailureKind::Cancelled,
                    "tool invocation was cancelled while awaiting approval",
                ));
            }
            response = timed => response,
        };
        match response {
            Err(_) => Err(ToolFailure::new(
                ToolFailureKind::ApprovalUnavailable,
                format!(
                    "approval provider exceeded its {} ms deadline and failed closed",
                    duration_ms(self.approval_timeout)
                ),
            )),
            Ok(Ok(Ok(ApprovalDecision::Approved))) => Ok(()),
            Ok(Ok(Ok(ApprovalDecision::Denied { reason }))) => Err(ToolFailure::new(
                ToolFailureKind::ApprovalDenied,
                format!("approval denied: {reason}"),
            )),
            Ok(Ok(Err(error))) => Err(ToolFailure::new(
                ToolFailureKind::ApprovalUnavailable,
                format!("approval provider failed closed: {}", error.message),
            )),
            Ok(Err(panic)) => Err(ToolFailure::new(
                ToolFailureKind::ApprovalUnavailable,
                format!(
                    "approval provider panicked and failed closed: {}",
                    panic_message(panic)
                ),
            )),
        }
    }

    async fn run_handler(
        &self,
        spec: &Arc<ToolSpec>,
        context: &ToolExecutionContext,
        request_cancellation: &CancellationToken,
    ) -> ToolOutcome {
        let acquire = self.concurrency.acquire(spec, &context.arguments);
        let permit = match tokio::select! {
            permit = acquire => permit,
            _ = request_cancellation.cancelled() => {
                context.cancellation.cancel();
                return ToolOutcome::failure(ToolFailure::new(
                    ToolFailureKind::Cancelled,
                    "tool invocation was cancelled while waiting for its concurrency permit",
                ));
            }
        } {
            Ok(permit) => permit,
            Err(failure) => return ToolOutcome::failure(failure),
        };
        if request_cancellation.is_cancelled() {
            context.cancellation.cancel();
            return ToolOutcome::failure(ToolFailure::new(
                ToolFailureKind::Cancelled,
                "tool invocation was cancelled before handler execution",
            ));
        }

        if let Some(lifecycle) = &self.lifecycle {
            let notified = AssertUnwindSafe(lifecycle.started(context))
                .catch_unwind()
                .await;
            match notified {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return ToolOutcome::failure(ToolFailure::new(
                        ToolFailureKind::Lifecycle,
                        format!("tool lifecycle failed closed: {}", error.message),
                    ));
                }
                Err(panic) => {
                    return ToolOutcome::failure(ToolFailure::new(
                        ToolFailureKind::Lifecycle,
                        format!(
                            "tool lifecycle panicked and failed closed: {}",
                            panic_message(panic)
                        ),
                    ));
                }
            }
        }

        let next = AroundNext {
            middleware: Arc::clone(&self.around),
            index: 0,
            handler: Arc::clone(&spec.handler),
        };
        let run_context = context.clone();
        let chain = AssertUnwindSafe(async move { next.run(run_context).await }).catch_unwind();
        tokio::pin!(chain);
        let deadline = tokio::time::sleep(spec.timeout);
        tokio::pin!(deadline);
        let outcome = tokio::select! {
            biased;
            _ = request_cancellation.cancelled() => {
                context.cancellation.cancel();
                // Cancellation is cooperative. Give the handler a bounded window to
                // tear down owned subprocesses before reporting the tool as settled.
                let _ = tokio::time::timeout(HANDLER_CLEANUP_GRACE, &mut chain).await;
                ToolOutcome::failure(ToolFailure::new(
                    ToolFailureKind::Cancelled,
                    "tool invocation was cancelled during handler execution",
                ))
            }
            _ = &mut deadline => {
                context.cancellation.cancel();
                let _ = tokio::time::timeout(HANDLER_CLEANUP_GRACE, &mut chain).await;
                ToolOutcome::failure(ToolFailure::retryable(
                    ToolFailureKind::TimedOut,
                    format!("tool execution exceeded {} ms", duration_ms(spec.timeout)),
                ))
            }
            outcome = &mut chain => match outcome {
                Err(panic) => ToolOutcome::failure(ToolFailure::new(
                    ToolFailureKind::Panicked,
                    format!("tool handler panicked: {}", panic_message(panic)),
                )),
                Ok(Err(error)) => ToolOutcome::failure(handler_failure(error)),
                Ok(Ok(output)) => ToolOutcome::success(output),
            }
        };
        drop(permit);
        outcome
    }

    async fn run_post(&self, context: &ToolExecutionContext, outcome: &mut ToolOutcome) {
        for middleware in self.post.iter() {
            let prior_failure = outcome.failure.clone();
            let result = AssertUnwindSafe(middleware.post(context, outcome))
                .catch_unwind()
                .await;
            let failure = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(ToolFailure::new(
                    ToolFailureKind::PostProcess,
                    error.message,
                )),
                Err(panic) => Some(ToolFailure::new(
                    ToolFailureKind::PostProcess,
                    format!("post middleware panicked: {}", panic_message(panic)),
                )),
            };
            if let Some(failure) = failure {
                *outcome = ToolOutcome::failure(failure);
            } else if let Some(failure) = prior_failure {
                if outcome.failure.is_none() {
                    *outcome = ToolOutcome::failure(failure);
                }
            }
        }
    }

    async fn run_finalize(&self, context: &ToolExecutionContext, outcome: &mut ToolOutcome) {
        for middleware in self.finalize.iter() {
            let prior_failure = outcome.failure.clone();
            let result = AssertUnwindSafe(middleware.finalize(context, outcome))
                .catch_unwind()
                .await;
            let failure = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(ToolFailure::new(ToolFailureKind::Finalize, error.message)),
                Err(panic) => Some(ToolFailure::new(
                    ToolFailureKind::Finalize,
                    format!("finalize middleware panicked: {}", panic_message(panic)),
                )),
            };
            if let Some(failure) = failure {
                *outcome = ToolOutcome::failure(failure);
            } else if let Some(failure) = prior_failure {
                if outcome.failure.is_none() {
                    *outcome = ToolOutcome::failure(failure);
                }
            }
        }
    }

    async fn finish_without_context(
        &self,
        execution_id: ExecutionId,
        tool_name: String,
        started_at_ms: u64,
        started: Instant,
        outcome: ToolOutcome,
    ) -> ToolResult {
        self.finish(execution_id, tool_name, started_at_ms, started, outcome)
            .await
    }

    async fn finish(
        &self,
        execution_id: ExecutionId,
        tool_name: String,
        started_at_ms: u64,
        started: Instant,
        outcome: ToolOutcome,
    ) -> ToolResult {
        let mut result = ToolResult {
            execution_id,
            tool_name,
            output: outcome.output,
            failure: outcome.failure,
            started_at_ms,
            completed_at_ms: unix_timestamp_ms(),
            duration_ms: duration_ms(started.elapsed()),
            observer_errors: Vec::new(),
        };
        for observer in self.observers.iter() {
            let observed = AssertUnwindSafe(observer.observe(&result))
                .catch_unwind()
                .await;
            match observed {
                Ok(Ok(())) => {}
                Ok(Err(error)) => result.observer_errors.push(error.message),
                Err(panic) => result
                    .observer_errors
                    .push(format!("observer panicked: {}", panic_message(panic))),
            }
        }
        result
    }
}

impl fmt::Debug for ToolExecutor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolExecutor")
            .field("pre", &self.pre.len())
            .field("guards", &self.guards.len())
            .field("around", &self.around.len())
            .field("post", &self.post.len())
            .field("finalize", &self.finalize.len())
            .field("observers", &self.observers.len())
            .field("lifecycle_configured", &self.lifecycle.is_some())
            .field("approval_configured", &self.approval.is_some())
            .field("approval_timeout", &self.approval_timeout)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ExecutorConfigError {
    #[error("approval timeout must be greater than zero")]
    ZeroApprovalTimeout,
}

fn handler_failure(error: ToolHandlerError) -> ToolFailure {
    ToolFailure {
        kind: ToolFailureKind::Handler,
        message: error.message,
        retryable: error.retryable,
    }
}

#[derive(Clone, Default)]
struct ConcurrencyGate {
    barrier: Arc<RwLock<()>>,
    keys: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl ConcurrencyGate {
    async fn acquire(
        &self,
        spec: &ToolSpec,
        arguments: &Value,
    ) -> Result<ConcurrencyPermit, ToolFailure> {
        match spec.concurrency {
            ToolConcurrency::Parallel => Ok(ConcurrencyPermit::Shared {
                _barrier: Arc::clone(&self.barrier).read_owned().await,
            }),
            ToolConcurrency::Exclusive => Ok(ConcurrencyPermit::Exclusive {
                _barrier: Arc::clone(&self.barrier).write_owned().await,
            }),
            ToolConcurrency::Keyed => {
                let key = match &spec.resource_key_resolver {
                    Some(resolver) => {
                        match std::panic::catch_unwind(AssertUnwindSafe(|| resolver(arguments))) {
                            Ok(key) => key.filter(|key| !key.is_empty()),
                            Err(panic) => {
                                return Err(ToolFailure::new(
                                    ToolFailureKind::Concurrency,
                                    format!(
                                        "resource-key resolver panicked: {}",
                                        panic_message(panic)
                                    ),
                                ));
                            }
                        }
                    }
                    None => None,
                };
                let Some(key) = key else {
                    return Ok(ConcurrencyPermit::Exclusive {
                        _barrier: Arc::clone(&self.barrier).write_owned().await,
                    });
                };
                let lock = {
                    let mut keys = self.keys.lock().await;
                    keys.retain(|_, lock| lock.strong_count() > 0);
                    match keys.get(&key).and_then(Weak::upgrade) {
                        Some(lock) => lock,
                        None => {
                            let lock = Arc::new(Mutex::new(()));
                            keys.insert(key, Arc::downgrade(&lock));
                            lock
                        }
                    }
                };
                let key_guard = lock.lock_owned().await;
                let barrier = Arc::clone(&self.barrier).read_owned().await;
                Ok(ConcurrencyPermit::Keyed {
                    _key: key_guard,
                    _barrier: barrier,
                })
            }
        }
    }
}

enum ConcurrencyPermit {
    Shared {
        _barrier: OwnedRwLockReadGuard<()>,
    },
    Exclusive {
        _barrier: OwnedRwLockWriteGuard<()>,
    },
    Keyed {
        _key: OwnedMutexGuard<()>,
        _barrier: OwnedRwLockReadGuard<()>,
    },
}

fn next_execution_id() -> ExecutionId {
    let sequence = NEXT_EXECUTION_ID.fetch_add(1, Ordering::Relaxed);
    ExecutionId(format!(
        "exec-{}-{}-{sequence}",
        std::process::id(),
        unix_timestamp_ms()
    ))
}

fn unix_timestamp_ms() -> u64 {
    let millis = SystemTime::UNIX_EPOCH
        .elapsed()
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn join_reasons(prefix: &str, reasons: &[String]) -> String {
    if reasons.is_empty() {
        prefix.to_owned()
    } else {
        format!("{prefix}: {}", reasons.join("; "))
    }
}

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    match panic.downcast::<String>() {
        Ok(message) => *message,
        Err(panic) => match panic.downcast::<&'static str>() {
            Ok(message) => (*message).to_owned(),
            Err(_) => "non-string panic payload".to_owned(),
        },
    }
}
