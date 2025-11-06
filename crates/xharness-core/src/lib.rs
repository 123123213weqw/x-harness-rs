//! XHarness' embeddable, provider-independent agent loop.

mod engine;
mod session;
mod tool;
mod types;

pub use engine::{LoopEngine, LoopEventStream, LoopRun};
pub use session::{MemorySessionStore, SessionStore};
pub use tool::{tool_result_for_model, MIN_TOOL_RESULT_LIMIT_BYTES};
pub use types::*;
pub use xharness_context::{
    ContextError, ContextPolicy, ContextPolicyId, ContextRequest, ContextSurface,
    IdentityContextPolicy, SurfaceEdit, SurfaceEditKind,
};
pub use xharness_token::{
    ConservativeByteMeter, TokenBreakdown, TokenBudget, TokenBudgetError, TokenBudgetReport,
    TokenEstimateRequest, TokenGuard, TokenMeter, TokenMeterError,
};
