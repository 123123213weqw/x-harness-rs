//! Provider-neutral tool registration and policy-aware execution.
//!
//! The executor deliberately keeps permission policy outside handlers. A tool
//! invocation passes through preflight hooks, monotonic guards, an optional
//! fail-closed approval seam, around middleware, post-processing, finalizers,
//! and read-only observers. Every attempted invocation receives an execution
//! id and returns a materialized result, including invalid input, denial,
//! timeout, cancellation, and panic paths.

mod batch;
mod definition;
mod executor;
mod middleware;
mod registry;
mod schema;

pub use batch::*;
pub use definition::*;
pub use executor::*;
pub use middleware::*;
pub use registry::*;
pub use schema::{validate_arguments, validate_tool_schema, SchemaViolation};
