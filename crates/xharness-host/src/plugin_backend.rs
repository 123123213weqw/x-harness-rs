//! Plugin control-plane seam. Native download, filesystem and capability
//! execution remain in the host-app composition layer.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::BasicHost;

#[async_trait]
pub trait PluginBackend: Send + Sync {
    async fn call(&self, endpoint: &str, payload: &Value) -> Result<Value, String>;
}

impl BasicHost {
    pub fn install_plugins(&self, backend: Arc<dyn PluginBackend>) -> Result<(), String> {
        self.plugins
            .set(backend)
            .map_err(|_| "plugin backend already installed".into())
    }
}
