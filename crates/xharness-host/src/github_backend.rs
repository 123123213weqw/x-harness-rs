//! Read-only GitHub feature seam. Authentication and network/process ownership
//! belong to native composition, not Agent tools or model settings.
use crate::BasicHost;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use xharness_api::RpcError;

#[async_trait]
pub trait GitHubBackend: Send + Sync {
    async fn read(
        &self,
        endpoint: &str,
        payload: &Value,
        cancellation: CancellationToken,
    ) -> Result<Value, RpcError>;
}
impl BasicHost {
    pub fn install_github(&self, backend: Arc<dyn GitHubBackend>) -> Result<(), String> {
        self.github
            .set(backend)
            .map_err(|_| "GitHub backend already installed".into())
    }
}
