//! XHarness' embeddable, provider-independent agent loop.

mod checkpoint;
mod compaction;
mod context_composition;
mod context_working_set;
pub use checkpoint::CheckpointConfig;
mod engine;
mod plan_context;
mod reception;
mod retry;
mod session;
mod tool;
mod types;

pub use engine::{LoopEngine, LoopEventStream, LoopRun};
pub use session::{MemorySessionStore, SessionStore};
pub use tool::{tool_result_for_model, MIN_TOOL_RESULT_LIMIT_BYTES};
pub use types::*;
pub use xharness_context::{
    ContextError, ContextPolicy, ContextPolicyId, ContextRequest, ContextSurface,
    IdentityContextPolicy, SurfaceEdit, SurfaceEditKind, ToolResultPruningContextPolicy,
    MAX_REQUEST_IMAGE_BYTES,
};
pub use xharness_token::{
    ConservativeByteMeter, ContextComposition, ContextMessageOrigin, ProviderInputTokenCount,
    TokenBreakdown, TokenBudget, TokenBudgetError, TokenBudgetReport, TokenCountAccuracy,
    TokenEstimateRequest, TokenGuard, TokenMeter, TokenMeterError,
};
