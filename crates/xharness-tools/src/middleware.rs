use std::{fmt, sync::Arc};

use async_trait::async_trait;

use crate::{HandlerFuture, ToolExecutionContext, ToolHandler, ToolOutput, ToolResult};

/// A hook failure. Guard and approval failures are always interpreted
/// fail-closed by the executor.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct MiddlewareError {
    pub message: String,
}

impl MiddlewareError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Read-only preflight stage, run after JSON parsing/schema validation and
/// before any policy or side effect.
#[async_trait]
pub trait PreMiddleware: Send + Sync + 'static {
    async fn pre(&self, context: &ToolExecutionContext) -> Result<(), MiddlewareError>;
}

/// One independent restriction proposal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardDecision {
    Allow,
    RequireApproval { reason: String },
    Deny { reason: String },
}

impl GuardDecision {
    pub fn require_approval(reason: impl Into<String>) -> Self {
        Self::RequireApproval {
            reason: reason.into(),
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self::Deny {
            reason: reason.into(),
        }
    }
}

/// Accumulated guard result. `restrict` is monotonic: `Allow < Approval <
/// Deny`, so a later permissive guard cannot undo an earlier restriction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardVerdict {
    Allow,
    RequireApproval { reasons: Vec<String> },
    Deny { reasons: Vec<String> },
}

impl GuardVerdict {
    pub fn restrict(self, decision: GuardDecision) -> Self {
        match (self, decision) {
            (Self::Deny { reasons }, _) => Self::Deny { reasons },
            (Self::RequireApproval { reasons }, GuardDecision::Allow) => {
                Self::RequireApproval { reasons }
            }
            (Self::Allow, GuardDecision::Allow) => Self::Allow,
            (Self::Allow, GuardDecision::RequireApproval { reason }) => Self::RequireApproval {
                reasons: vec![reason],
            },
            (Self::RequireApproval { mut reasons }, GuardDecision::RequireApproval { reason }) => {
                reasons.push(reason);
                Self::RequireApproval { reasons }
            }
            (Self::Allow, GuardDecision::Deny { reason }) => Self::Deny {
                reasons: vec![reason],
            },
            (Self::RequireApproval { mut reasons }, GuardDecision::Deny { reason }) => {
                reasons.push(reason);
                Self::Deny { reasons }
            }
        }
    }
}

#[async_trait]
pub trait MonotonicGuard: Send + Sync + 'static {
    async fn evaluate(
        &self,
        context: &ToolExecutionContext,
    ) -> Result<GuardDecision, MiddlewareError>;
}

/// Immutable approval request issued only after every guard has been folded.
#[derive(Clone, Debug)]
pub struct ApprovalRequest {
    pub context: ToolExecutionContext,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Denied { reason: String },
}

impl ApprovalDecision {
    pub fn denied(reason: impl Into<String>) -> Self {
        Self::Denied {
            reason: reason.into(),
        }
    }
}

/// Host-owned user/policy approval channel. Absence, error, panic, or
/// cancellation never becomes implicit approval.
#[async_trait]
pub trait ApprovalProvider: Send + Sync + 'static {
    async fn request_approval(
        &self,
        request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError>;
}

/// Host-facing lifecycle seam invoked after policy, approval and concurrency
/// admission, immediately before the handler can perform a side effect.
///
/// Implementations may durably publish a `tool/started` boundary and must
/// return only after that boundary is visible. Failure is fail-closed: the
/// handler is not entered.
#[async_trait]
pub trait ToolLifecycle: Send + Sync + 'static {
    async fn started(&self, context: &ToolExecutionContext) -> Result<(), MiddlewareError>;
}

/// One around link. Calling `next.run(context)` enters the following link or
/// the handler. An around middleware may deliberately short-circuit.
pub trait AroundMiddleware: Send + Sync + 'static {
    fn around(&self, context: ToolExecutionContext, next: AroundNext) -> HandlerFuture;
}

/// Cloneable continuation used by around middleware.
#[derive(Clone)]
pub struct AroundNext {
    pub(crate) middleware: Arc<[Arc<dyn AroundMiddleware>]>,
    pub(crate) index: usize,
    pub(crate) handler: ToolHandler,
}

impl AroundNext {
    pub fn run(self, context: ToolExecutionContext) -> HandlerFuture {
        match self.middleware.get(self.index).cloned() {
            Some(middleware) => middleware.around(
                context,
                Self {
                    middleware: self.middleware,
                    index: self.index + 1,
                    handler: self.handler,
                },
            ),
            None => (self.handler)(context),
        }
    }
}

impl fmt::Debug for AroundNext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AroundNext")
            .field("index", &self.index)
            .field(
                "remaining",
                &self.middleware.len().saturating_sub(self.index),
            )
            .finish_non_exhaustive()
    }
}

/// Runs only after an around/handler execution was attempted, including
/// handler error, timeout, cancellation, or panic.
#[async_trait]
pub trait PostMiddleware: Send + Sync + 'static {
    async fn post(
        &self,
        context: &ToolExecutionContext,
        outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError>;
}

/// Runs for every known, schema-valid invocation after preflight, policy, and
/// any handler/post path. This is the place for stable rendering, truncation,
/// and result metadata.
#[async_trait]
pub trait FinalizeMiddleware: Send + Sync + 'static {
    async fn finalize(
        &self,
        context: &ToolExecutionContext,
        outcome: &mut ToolOutcome,
    ) -> Result<(), MiddlewareError>;
}

/// Read-only terminal sink. Observer failures are attached to the returned
/// result and never change the already finalized tool outcome.
#[async_trait]
pub trait ToolObserver: Send + Sync + 'static {
    async fn observe(&self, result: &ToolResult) -> Result<(), MiddlewareError>;
}

/// Mutable result material available only to post/finalize middleware.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutcome {
    pub(crate) output: Option<ToolOutput>,
    pub(crate) failure: Option<crate::ToolFailure>,
}

impl ToolOutcome {
    pub(crate) fn success(output: ToolOutput) -> Self {
        Self {
            output: Some(output),
            failure: None,
        }
    }

    pub(crate) fn failure(failure: crate::ToolFailure) -> Self {
        Self {
            output: None,
            failure: Some(failure),
        }
    }

    pub fn is_ok(&self) -> bool {
        self.failure.is_none()
    }

    pub fn output(&self) -> Option<&ToolOutput> {
        self.output.as_ref()
    }

    pub fn output_mut(&mut self) -> Option<&mut ToolOutput> {
        self.output.as_mut()
    }

    pub fn failure_ref(&self) -> Option<&crate::ToolFailure> {
        self.failure.as_ref()
    }

    /// Replace an already-successful payload. A finalizer cannot turn any
    /// preflight, policy, approval, timeout, or handler failure into success.
    pub fn replace_output(&mut self, output: ToolOutput) -> bool {
        if self.failure.is_some() {
            return false;
        }
        self.output = Some(output);
        true
    }

    /// Monotonically restrict an outcome to failure.
    pub fn fail(&mut self, failure: crate::ToolFailure) {
        self.output = None;
        self.failure = Some(failure);
    }
}
