//! XHarness' embeddable, provider-independent agent loop.

mod engine;
mod session;
mod tool;
mod types;

pub use engine::{LoopEngine, LoopRun};
pub use session::{ContextPolicy, IdentityContextPolicy, MemorySessionStore, SessionStore};
pub use tool::tool_result_for_model;
pub use types::*;
