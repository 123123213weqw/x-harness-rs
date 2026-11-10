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
        if session
            .active_permission
            .unwrap_or(session.permission_preset)
            != crate::PermissionPreset::DangerFullAccess
        {
            return Err("editable plugin panels require the full-access preset; no permission is changed automatically".into());
        }
        Ok(session.cwd.clone())
    }
}
