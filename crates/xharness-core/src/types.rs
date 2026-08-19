use std::{fmt, pin::Pin, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures::{future::BoxFuture, Stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub type ProviderStream =
    Pin<Box<dyn Stream<Item = Result<ProviderEvent, ProviderError>> + Send + 'static>>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub index: usize,
    pub name: String,
    pub arguments_json: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentMessage {
    pub role: Role,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub provider_items: Vec<Value>,
    /// True when the assistant turn was cut short by runtime steering.
    #[serde(default)]
    pub interrupted: bool,
}

impl AgentMessage {
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            ..Self::default()
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::new(Role::User, content)
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::new(Role::System, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::new(Role::Assistant, content)
    }

    pub fn tool(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            ..Self::default()
        }
    }
}

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

pub type ToolHandler =
    Arc<dyn Fn(Value, CancellationToken) -> BoxFuture<'static, ToolResult> + Send + Sync + 'static>;
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
        usage: Option<Value>,
        provider_items: Vec<Value>,
    },
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
}

#[derive(Clone, Debug, PartialEq)]
pub enum LoopEventKind {
    TextDelta(String),
    ReasoningDelta(String),
    ToolStarted(ToolCall),
    ToolCompleted {
        call: ToolCall,
        result: ToolResult,
    },
    ToolApprovalRequested {
        call: ToolCall,
    },
    ToolApprovalResolved {
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
        attempt: usize,
        error: String,
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

#[derive(Clone, Debug, PartialEq)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
    pub event_buffer: usize,
    pub command_buffer: usize,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            max_steps: 128,
            max_tool_concurrency: 8,
            tool_result_limit_bytes: 256 * 1024,
            provider_retries: 2,
            event_buffer: 128,
            command_buffer: 64,
        }
    }
}

pub struct LoopRequest {
    pub provider: Arc<dyn ModelProvider>,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolSpec>,
    pub session_id: Option<String>,
    pub session_store: Arc<dyn crate::SessionStore>,
    pub context_policy: Arc<dyn crate::ContextPolicy>,
    pub config: LoopConfig,
}

impl LoopRequest {
    pub fn new(provider: Arc<dyn ModelProvider>, messages: Vec<AgentMessage>) -> Self {
        Self {
            provider,
            messages,
            tools: Vec::new(),
            session_id: None,
            session_store: Arc::new(crate::MemorySessionStore::default()),
            context_policy: Arc::new(crate::IdentityContextPolicy),
            config: LoopConfig::default(),
        }
    }
}
