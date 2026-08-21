//! Native deployment composition for the reusable [`xharness_host`] control
//! plane.
//!
//! This crate owns OS-facing tool construction. The Host library itself stays
//! independent from Linux/macOS process, filesystem, sandbox, terminal and Web
//! implementations.

use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;
use xharness_coding_tools::CodingToolBundle;
use xharness_core::ToolSpec;
use xharness_host::{PermissionPreset, SessionToolFactory};
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_sandbox::SandboxMode;
use xharness_terminal::TerminalRegistry;
use xharness_web::WebRuntime;

/// Native Linux/macOS implementation of the standard fourteen-tool factory.
/// Platforms are cached per canonical workspace so filesystem observations
/// survive across turns, while terminal ownership remains per session.
pub struct NativeToolFactory {
    terminals: Arc<TerminalRegistry>,
    web: Arc<WebRuntime>,
    platforms: RwLock<BTreeMap<(String, PermissionPreset), Arc<NativePlatform>>>,
}

impl NativeToolFactory {
    pub fn new(web: WebRuntime) -> Arc<Self> {
        Arc::new(Self {
            terminals: Arc::new(TerminalRegistry::with_defaults()),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
        })
    }

    async fn platform(
        &self,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<Arc<NativePlatform>, String> {
        let key = (cwd.to_owned(), permission);
        if let Some(platform) = self.platforms.read().await.get(&key).cloned() {
            return Ok(platform);
        }
        let sandbox_mode = match permission {
            PermissionPreset::WorkspaceWrite => SandboxMode::WorkspaceWrite,
            PermissionPreset::DangerFullAccess => SandboxMode::DangerFullAccess,
        };
        let platform = Arc::new(
            NativePlatform::new(PlatformConfig::new(cwd).sandbox_mode(sandbox_mode))
                .map_err(|error| error.to_string())?,
        );
        let mut platforms = self.platforms.write().await;
        Ok(platforms
            .entry(key)
            .or_insert_with(|| Arc::clone(&platform))
            .clone())
    }
}

#[async_trait]
impl SessionToolFactory for NativeToolFactory {
    async fn tools(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<Vec<ToolSpec>, String> {
        let platform = self.platform(cwd, permission).await?;
        let mut specs = CodingToolBundle::new(
            platform,
            Arc::clone(&self.terminals),
            Arc::clone(&self.web),
            session_id,
            session_id,
        )
        .core_specs()
        .await
        .map_err(|error| error.to_string())?;
        if permission == PermissionPreset::DangerFullAccess {
            for spec in &mut specs {
                spec.requires_approval = false;
            }
        }
        Ok(specs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempWorkspace(std::path::PathBuf);

    impl TempWorkspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "xharness-host-app-permission-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn full_access_removes_per_tool_prompts_after_the_product_risk_gate() {
        let workspace = TempWorkspace::new();
        let factory = NativeToolFactory::new(WebRuntime::default());
        let cwd = workspace.0.to_string_lossy();
        let guarded = factory
            .tools("guarded", &cwd, PermissionPreset::WorkspaceWrite)
            .await
            .unwrap();
        assert!(guarded.iter().any(|spec| spec.requires_approval));

        let full_access = factory
            .tools("full", &cwd, PermissionPreset::DangerFullAccess)
            .await
            .unwrap();
        assert!(full_access.iter().all(|spec| !spec.requires_approval));
    }
}
