use std::{fmt, future::Future, pin::Pin, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// Model-facing function declaration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema. The registry requires an object-shaped root and validates
    /// the portable subset implemented by this crate.
    pub parameters: Value,
}

impl ToolDefinition {
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

/// Declarative scheduling mode. `Keyed` serializes equal resource keys while
/// allowing distinct keys to overlap; a missing or empty key fails safe to an
/// exclusive execution.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolConcurrency {
    Parallel,
    Keyed,
    /// Safe default: an unannotated tool never overlaps another execution.
    #[default]
    Exclusive,
}

/// How the executor decides that a handler has exceeded its execution window.
///
/// `External` is reserved for durable human or external-system interactions.
/// It removes the ordinary handler deadline, but cancellation and structured
/// shutdown still have to settle within the executor cleanup grace.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSettlement {
    #[default]
    Bounded,
    External,
}

/// Whether one invocation may share a model-emitted tool batch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolBatchPolicy {
    #[default]
    Any,
    /// Reject the complete batch before starting any handler when another
    /// invocation is present. Used by durable human-interaction barriers.
    Standalone,
}

/// Successful handler payload before pipeline finalization.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolOutput {
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl ToolOutput {
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            metadata: None,
        }
    }
}

/// An expected handler failure. Panics and timeouts are classified by the
/// executor and do not use this type.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq, Serialize, Deserialize)]
#[error("{message}")]
pub struct ToolHandlerError {
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

impl ToolHandlerError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

/// Owned context shared by the handler and around middleware.
#[derive(Clone, Debug)]
pub struct ToolExecutionContext {
    pub execution_id: ExecutionId,
    pub definition: Arc<ToolDefinition>,
    pub arguments: Arc<Value>,
    pub arguments_json: Arc<str>,
    pub cancellation: CancellationToken,
}

impl ToolExecutionContext {
    pub fn tool_name(&self) -> &str {
        &self.definition.name
    }
}

pub type HandlerFuture =
    Pin<Box<dyn Future<Output = Result<ToolOutput, ToolHandlerError>> + Send + 'static>>;
pub type ToolHandler = Arc<dyn Fn(ToolExecutionContext) -> HandlerFuture + Send + Sync + 'static>;
pub type ResourceKeyResolver = Arc<dyn Fn(&Value) -> Option<String> + Send + Sync + 'static>;

/// Complete runtime registration. Construction accepts an ordinary async
/// closure and erases it only at the registry boundary.
#[derive(Clone)]
pub struct ToolSpec {
    pub definition: ToolDefinition,
    pub timeout: Duration,
    pub settlement: ToolSettlement,
    pub batch_policy: ToolBatchPolicy,
    pub concurrency: ToolConcurrency,
    pub requires_approval: bool,
    pub resource_key_resolver: Option<ResourceKeyResolver>,
    pub(crate) handler: ToolHandler,
}

impl ToolSpec {
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

    pub fn new<F, Fut>(definition: ToolDefinition, handler: F) -> Self
    where
        F: Fn(ToolExecutionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<ToolOutput, ToolHandlerError>> + Send + 'static,
    {
        Self {
            definition,
            timeout: Self::DEFAULT_TIMEOUT,
            settlement: ToolSettlement::Bounded,
            batch_policy: ToolBatchPolicy::Any,
            // Parallelism is an explicit capability claim. Unknown handlers
            // fail safe to the global exclusive lane.
            concurrency: ToolConcurrency::Exclusive,
            requires_approval: false,
            resource_key_resolver: None,
            handler: Arc::new(move |context| Box::pin(handler(context))),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Wait for an external durable settlement instead of applying the
    /// ordinary handler deadline. Cancellation remains mandatory and bounded.
    pub fn with_external_settlement(mut self) -> Self {
        self.settlement = ToolSettlement::External;
        self
    }

    pub fn requiring_standalone_batch(mut self) -> Self {
        self.batch_policy = ToolBatchPolicy::Standalone;
        self
    }

    pub fn with_concurrency(mut self, concurrency: ToolConcurrency) -> Self {
        self.concurrency = concurrency;
        self
    }

    pub fn with_resource_key_resolver<F>(mut self, resolver: F) -> Self
    where
        F: Fn(&Value) -> Option<String> + Send + Sync + 'static,
    {
        self.resource_key_resolver = Some(Arc::new(resolver));
        self
    }

    pub fn requiring_approval(mut self, required: bool) -> Self {
        self.requires_approval = required;
        self
    }
}

impl fmt::Debug for ToolSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolSpec")
            .field("definition", &self.definition)
            .field("timeout", &self.timeout)
            .field("settlement", &self.settlement)
            .field("batch_policy", &self.batch_policy)
            .field("concurrency", &self.concurrency)
            .field("requires_approval", &self.requires_approval)
            .field(
                "resource_key_resolver",
                &self.resource_key_resolver.as_ref().map(|_| "<resolver>"),
            )
            .finish_non_exhaustive()
    }
}

/// Process-local identity for one invocation attempt.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExecutionId(pub(crate) String);

impl ExecutionId {
    pub fn new(value: impl Into<String>) -> Result<Self, ExecutionIdError> {
        let value = value.into();
        if value.trim().is_empty() || value.contains('\0') {
            return Err(ExecutionIdError);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
#[error("tool execution id must be non-empty and contain no NUL byte")]
pub struct ExecutionIdError;

impl fmt::Display for ExecutionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}
