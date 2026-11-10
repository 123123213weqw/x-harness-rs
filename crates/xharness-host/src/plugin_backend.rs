//! Plugin control-plane seam. Native download, filesystem and capability
//! execution remain in the host-app composition layer.

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

impl BasicHost {
    /// The authenticated UI chooses an existing session, never an arbitrary cwd.
    pub async fn plugin_panel_workspace(&self, session_id: &str) -> Result<String, String> {
        let state = self.state.read().await;
        if state.deleted_sessions.contains(session_id)
            || state.archived_sessions.contains(session_id)
        {
            return Err("session unavailable".into());
        }
        let session = state
            .sessions
            .get(session_id)
            .ok_or("session unavailable")?;
        // UI launch/save are explicit user actions in all three current
        // workspace-writing presets. Model calls retain their own approval
        // policy; a panel must never change the session-wide preset.
        Ok(session.cwd.clone())
    }
}
