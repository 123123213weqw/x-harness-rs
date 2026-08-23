use std::{collections::HashSet, fmt, pin::Pin, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures::{future::BoxFuture, Stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub use xharness_session::{Message as AgentMessage, MessageRole as Role, ToolCall};

pub type ProviderStream =
    Pin<Box<dyn Stream<Item = Result<ProviderEvent, ProviderError>> + Send + 'static>>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl ToolResult {
    pub fn success(content: impl Into<String>) -> Self {
        Self {
            ok: true,
            content: content.into(),
            error: String::new(),
            truncated: false,
            metadata: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            content: String::new(),
            error: error.into(),
            truncated: false,
            metadata: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolConcurrency {
    #[default]
    Parallel,
    Keyed,
    Exclusive,
}

#[derive(Clone, Debug)]
pub struct ToolInvocation {
    /// Durable Harness identity shared by Journal, Approval and Tool pipeline.
    pub execution_id: String,
    /// Provider-native identity retained only for wire replay correlation.
    pub provider_call_id: Option<String>,
    pub arguments: Value,
    pub cancellation: CancellationToken,
}

pub type ToolHandler =
    Arc<dyn Fn(ToolInvocation) -> BoxFuture<'static, ToolResult> + Send + Sync + 'static>;
pub type ResourceKeyResolver = Arc<dyn Fn(&Value) -> Option<String> + Send + Sync + 'static>;

#[derive(Clone)]
pub struct ToolSpec {
    pub definition: ToolDefinition,
    pub handler: ToolHandler,
    pub timeout: Duration,
    pub concurrency: ToolConcurrency,
    pub resource_key_resolver: Option<ResourceKeyResolver>,
    pub requires_approval: bool,
}

impl fmt::Debug for ToolSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolSpec")
            .field("definition", &self.definition)
            .field("timeout", &self.timeout)
            .field("concurrency", &self.concurrency)
            .field("requires_approval", &self.requires_approval)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct ProviderRequest {
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolDefinition>,
    pub step: usize,
    /// Provider-neutral generation ceiling. Adapters map this to their native
    /// `max_tokens`/`max_output_tokens` request field.
    pub max_output_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderEvent {
    TextDelta(String),
    ReasoningDelta(String),
    ToolCallDelta {
        index: usize,
        id: String,
        name: String,
        arguments_delta: String,
    },
    Completed {
        /// Adapters should set this whenever the wire protocol exposes a
        /// terminal reason. `None` remains accepted for legacy/custom
        /// adapters and is inferred from the presence of tool calls.
        finish_reason: Option<FinishReason>,
        usage: Option<TokenUsage>,
        provider_items: Vec<Value>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Uncached input tokens. Provider totals that include cached input are
    /// normalized by subtracting `cache_read_tokens` and
    /// `cache_write_tokens`.
    #[serde(default)]
    pub input_tokens: u64,
    /// Visible, non-reasoning output tokens. Provider totals that include
    /// reasoning are normalized by subtracting `reasoning_tokens`.
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
}

impl TokenUsage {
    pub fn saturating_add_assign(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    #[default]
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Incomplete(String),
    Other(String),
}

impl FinishReason {
    /// Only these reasons represent a complete, protocol-valid model turn.
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Stop | Self::ToolCalls)
    }

    pub fn description(&self) -> String {
        match self {
            Self::Stop => "stop".to_owned(),
            Self::ToolCalls => "tool calls".to_owned(),
            Self::Length => "output token limit".to_owned(),
            Self::ContentFilter => "content filter".to_owned(),
            Self::Incomplete(reason) => format!("incomplete: {reason}"),
            Self::Other(reason) => format!("unrecognized finish reason: {reason}"),
        }
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct ProviderError {
    pub message: String,
    pub retryable: bool,
    pub http_status: Option<u16>,
}

impl ProviderError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            http_status: None,
        }
    }

    pub fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            http_status: None,
        }
    }

    pub fn http(status: u16, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: status == 408 || status == 429 || status >= 500,
            http_status: Some(status),
        }
    }
}

#[async_trait]
pub trait ModelProvider: Send + Sync + 'static {
    /// Stable adapter identity written to durable request headers.
    fn provider_name(&self) -> &str {
        "custom"
    }

    /// Configured model identity when the adapter owns one.
    fn model_name(&self) -> Option<&str> {
        None
    }

    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopStatus {
    Completed,
    Failed,
    Cancelled,
    LimitReached,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectionMode {
    /// Add the message before the next model request without interrupting the
    /// model or any tools that are currently running.
    #[default]
    NextStep,
    /// Cancel the current model stream, preserve any partial assistant text as
    /// an interrupted turn, and continue with the injected message.
    InterruptModel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LoopCommand {
    InjectMessage {
        message: AgentMessage,
        mode: InjectionMode,
    },
    /// Shorthand for an `InjectMessage` using `InterruptModel`.
    Steer(AgentMessage),
    Pause,
    Resume,
    Cancel,
    ApproveTool {
        call_id: String,
    },
    RejectTool {
        call_id: String,
        reason: String,
    },
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum LoopControlError {
    #[error("loop is no longer accepting commands")]
    Closed,
    #[error("loop command rejected: {0}")]
    Rejected(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LoopEventKind {
    TextDelta(String),
    ReasoningDelta(String),
    /// One provider tool-call fragment. Exposing the fragment lets durable
    /// hosts publish every assistant stream record immediately while the
    /// append-only session log is written in batches.
    ToolCallDelta {
        index: usize,
        id: String,
        name: String,
        arguments_delta: String,
    },
    /// A bounded assistant stream batch is now visible in the authoritative
    /// Session store. Durable hosts use this signal to refresh the Web event
    /// cursor without reloading the complete log for every fragment.
    StreamCheckpoint,
    ToolStarted(ToolCall),
    ToolCompleted {
        call: ToolCall,
        result: ToolResult,
    },
    ToolApprovalRequested {
        approval_id: String,
        call: ToolCall,
    },
    ToolApprovalResolved {
        approval_id: String,
        call: ToolCall,
        approved: bool,
        reason: Option<String>,
    },
    MessageInjected {
        message: AgentMessage,
        mode: InjectionMode,
    },
    RunPaused,
    RunResumed,
    ModelInterrupted,
    ModelRetry {
        retry_id: String,
        attempt: usize,
        max_retries: usize,
        error: String,
    },
    /// The subscriber fell behind the bounded event journal. `resume_seq` is
    /// the first event sequence still available for deterministic replay.
    EventsLagged {
        missed: u64,
        resume_seq: u64,
    },
    RunCompleted {
        text: String,
    },
    RunFailed {
        error: String,
    },
    RunCancelled,
    LimitReached,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoopEvent {
    pub seq: u64,
    pub run_id: String,
    pub step: usize,
    pub kind: LoopEventKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoopResult {
    pub status: LoopStatus,
    #[serde(default)]
    pub final_text: String,
    #[serde(default)]
    pub messages: Vec<AgentMessage>,
    /// Saturating sum of every completed model step that reported usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Per-step usage in model request order, for requests whose provider
    /// reported usage.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_usage: Vec<StepUsage>,
    /// Finish reason of the most recent completed model request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<FinishReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepUsage {
    pub step: usize,
    pub usage: TokenUsage,
    pub finish_reason: FinishReason,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub messages: Vec<AgentMessage>,
    pub phase: String,
    pub step: usize,
    pub tool_batch_complete: bool,
}

#[derive(Clone, Debug)]
pub struct LoopConfig {
    pub max_steps: usize,
    pub max_tool_concurrency: usize,
    pub tool_result_limit_bytes: usize,
    pub provider_retries: usize,
    /// Maximum number of events retained by the non-blocking in-memory event
    /// journal. Slow subscribers receive an explicit lag record.
    pub event_buffer: usize,
    /// Aggregate serialized-byte budget of retained loop events. The journal
    /// evicts oldest events until both count and byte budgets are satisfied.
    pub event_buffer_bytes: usize,
    pub command_buffer: usize,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[error("{message}")]
pub struct LoopValidationError {
    pub message: String,
}

impl LoopValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            max_steps: 128,
            max_tool_concurrency: 8,
            tool_result_limit_bytes: 256 * 1024,
            provider_retries: 2,
            event_buffer: 128,
            event_buffer_bytes: 8 * 1024 * 1024,
            command_buffer: 64,
        }
    }
}

impl LoopConfig {
    pub fn validate(&self) -> Result<(), LoopValidationError> {
        if self.max_steps == 0 {
            return Err(LoopValidationError::new(
                "max_steps must be greater than zero",
            ));
        }
        if self.max_tool_concurrency == 0 {
            return Err(LoopValidationError::new(
                "max_tool_concurrency must be greater than zero",
            ));
        }
        if self.tool_result_limit_bytes < crate::MIN_TOOL_RESULT_LIMIT_BYTES {
            return Err(LoopValidationError::new(format!(
                "tool_result_limit_bytes must be at least {}",
                crate::MIN_TOOL_RESULT_LIMIT_BYTES
            )));
        }
        if self.command_buffer == 0 {
            return Err(LoopValidationError::new(
                "command_buffer must be greater than zero",
            ));
        }
        if self.event_buffer == 0 {
            return Err(LoopValidationError::new(
                "event_buffer must be greater than zero",
            ));
        }
        if self.event_buffer_bytes == 0 {
            return Err(LoopValidationError::new(
                "event_buffer_bytes must be greater than zero",
            ));
        }
        Ok(())
    }
}

pub struct LoopRequest {
    pub provider: Arc<dyn ModelProvider>,
    pub messages: Vec<AgentMessage>,
    /// Deterministic model-facing System Prompt. It is reassembled for each
    /// turn and never becomes transcript history.
    pub prompt: Option<xharness_prompt::PromptAssembly>,
    /// Hard admission guard evaluated after context projection and before any
    /// provider I/O. Production hosts should always configure one.
    pub token_guard: Option<xharness_token::TokenGuard>,
    /// Formal policy-aware tool runtime. New hosts should set this instead of
    /// populating the legacy `tools` compatibility registrations.
    pub tool_executor: Option<xharness_tools::ToolExecutor>,
    /// Temporary compatibility registrations. Removed after every embedder
    /// has migrated to `tool_executor`.
    pub tools: Vec<ToolSpec>,
    pub session_id: Option<String>,
    pub session_store: Arc<dyn crate::SessionStore>,
    /// Append-only source-of-truth store. When set, it replaces snapshot
    /// restoration for this run; the legacy `session_store` remains a v0
    /// migration bridge.
    pub journal_store: Option<Arc<dyn xharness_session::Store>>,
    /// Durable control-plane facts committed in the same atomic batch as the
    /// next `turn/start` and new user input. Long-lived agents use this to
    /// claim inbox messages without a crash window between dequeue and turn.
    pub journal_prelude: Vec<xharness_session::SessionEvent>,
    pub context_policy: Arc<dyn crate::ContextPolicy>,
    pub config: LoopConfig,
}

impl LoopRequest {
    pub fn new(provider: Arc<dyn ModelProvider>, messages: Vec<AgentMessage>) -> Self {
        Self {
            provider,
            messages,
            prompt: None,
            token_guard: None,
            tool_executor: None,
            tools: Vec::new(),
            session_id: None,
            session_store: Arc::new(crate::MemorySessionStore::default()),
            journal_store: None,
            journal_prelude: Vec::new(),
            context_policy: Arc::new(crate::IdentityContextPolicy),
            config: LoopConfig::default(),
        }
    }

    /// Validates configuration and tool declarations without invoking the
    /// provider, session store, context policy, or any tool handler.
    pub fn validate(&self) -> Result<(), LoopValidationError> {
        self.config.validate()?;
        if self.prompt.is_some()
            && self
                .messages
                .iter()
                .any(|message| message.role == Role::System)
        {
            return Err(LoopValidationError::new(
                "prompt assembly and explicit system messages cannot be combined",
            ));
        }
        if !self.journal_prelude.is_empty() && self.journal_store.is_none() {
            return Err(LoopValidationError::new(
                "journal_prelude requires journal_store",
            ));
        }
        if self.tool_executor.is_some() && !self.tools.is_empty() {
            return Err(LoopValidationError::new(
                "tool_executor and legacy tools cannot be configured together",
            ));
        }
        let mut names = HashSet::with_capacity(self.tools.len());
        for (index, tool) in self.tools.iter().enumerate() {
            let name = tool.definition.name.as_str();
            if name.trim().is_empty() {
                return Err(LoopValidationError::new(format!(
                    "tool at index {index} has an empty name"
                )));
            }
            if !names.insert(name) {
                return Err(LoopValidationError::new(format!(
                    "duplicate tool name: {name}"
                )));
            }
            if tool.timeout.is_zero() {
                return Err(LoopValidationError::new(format!(
                    "tool {name} timeout must be greater than zero"
                )));
            }
            if !tool.definition.parameters.is_object() {
                return Err(LoopValidationError::new(format!(
                    "tool {name} parameters schema must be a JSON object"
                )));
            }
            if tool.concurrency == ToolConcurrency::Keyed && tool.resource_key_resolver.is_none() {
                return Err(LoopValidationError::new(format!(
                    "keyed tool {name} requires a resource key resolver"
                )));
            }
        }
        Ok(())
    }
}
