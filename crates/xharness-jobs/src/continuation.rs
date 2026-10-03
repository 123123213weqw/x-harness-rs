//! Optional deployment-owned continuation port. No provider, tool or Host dependency.
use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait JobContinuationPort: Send + Sync {
    async fn defer(&self, owner: &str, job_id: &str, continuation: &str) -> Result<Value, String>;
    async fn cancel_defer(&self, owner: &str, job_id: &str) -> Result<Value, String>;
    /// A bounded immutable terminal snapshot, not a cursor-enabled live stream.
    async fn archived_output(&self, owner: &str, job_id: &str) -> Result<Option<Value>, String>;
}
