//! Embedded, provider-neutral access to the existing XHarness durable runtime.
//!
//! This crate adds no agent loop, conversation store, scheduler, source consumer,
//! HTTP listener, built-in tool permissions, or automatic recovery scan. The
//! embedding product supplies its model registry, tool factory, authoritative
//! store and lease manager. Each operation delegates to those same native
//! components. See the crate README for ownership and compatibility boundaries.
//!
//! Version 0.1 is an integration API, not a stable 1.0 contract. Public native
//! request/event types intentionally retain their original identities. Consumers
//! must pin a single runtime revision for all XHarness crates they use.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

mod runtime;
pub use runtime::{Error, Runtime, RuntimeBuilder, Turn};

/// Models and request/response types for deployment-supplied provider adapters.
pub mod models {
    pub use tokio_util::sync::CancellationToken;
    pub use xharness_core::{
        AgentMessage, FinishReason, ModelCapabilities, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream, Role, TokenUsage,
    };
    pub use xharness_host::{
        ModelDescriptor, ModelReasoning, ModelReasoningEffort, ModelRegistry, ModelRegistryError,
        ModelRoute, RegisteredModel,
    };
}

/// Native execution requests, events and controls. No product-specific concepts.
pub mod execution {
    pub use xharness_agent::{AgentShutdownOutcome, AgentShutdownReport};
    pub use xharness_core::{
        LoopCommand, LoopControlError, LoopEvent, LoopEventKind, LoopResult, LoopStatus,
    };
    pub use xharness_host::{
        AgentResumeReport, AgentRuntimeError, AgentSessionRequest, AgentTurnRequest, ExecutionGate,
        PermissionPreset,
    };
}

/// One authoritative session store and native execution leases, supplied by the host.
pub mod storage {
    pub use xharness_agent::{FileLeaseManager, LeaseError, LeaseManager, MemoryLeaseManager};
    pub use xharness_session::{
        EventData, MemorySessionStore, Session, SessionEvent, SessionHeader, Store, StoreError,
    };
    pub use xharness_session_jsonl::JsonlSessionStore;
}

/// Tool schema, handler and execution registration. Factories retain responsibility
/// for per-session permission policy; the SDK grants no filesystem/process access.
pub mod tools {
    pub use xharness_host::{NoTools, SessionToolFactory};
    pub use xharness_tools::{
        RegistryError, ToolDefinition, ToolExecutionContext, ToolExecutor, ToolHandlerError,
        ToolOutput, ToolRegistry, ToolSpec,
    };
}

/// Context policy and deterministic prompt assembly remain deployment-injected.
pub mod context {
    pub use xharness_compaction::CompactionConfig;
    pub use xharness_core::{
        ContextError, ContextPolicy, ContextPolicyId, ContextRequest, ContextSurface,
        IdentityContextPolicy, SurfaceEdit, SurfaceEditKind,
    };
    pub use xharness_prompt::PromptAssembly;
}
