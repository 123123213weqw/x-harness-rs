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
use xharness_debug::DebugRecorder;
use xharness_host::{PermissionPreset, SessionToolFactory};
use xharness_platform::{CapabilityReport, NativePlatform, PlatformConfig};
use xharness_terminal::TerminalRegistry;
use xharness_tools::{ToolExecutor, ToolRegistry, ToolSpec};
use xharness_web::WebRuntime;

/// Native Linux/macOS implementation of the standard fourteen-tool factory.
/// Platforms are cached per canonical workspace so filesystem observations
/// survive across turns, while terminal ownership remains per session.
pub struct NativeToolFactory {
    terminals: Arc<TerminalRegistry>,
    web: Arc<WebRuntime>,
    platforms: RwLock<BTreeMap<(String, PermissionPreset), Arc<NativePlatform>>>,
    debug: DebugRecorder,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeToolReadiness {
    pub platform: CapabilityReport,
    pub search_available: bool,
    pub existing_terminals: usize,
}

impl NativeToolFactory {
    pub fn new(web: WebRuntime) -> Arc<Self> {
        Self::new_with_debug(web, DebugRecorder::disabled())
    }

    pub fn new_with_debug(web: WebRuntime, debug: DebugRecorder) -> Arc<Self> {
        Arc::new(Self {
            terminals: Arc::new(TerminalRegistry::with_defaults().with_debug(debug.clone())),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
            debug,
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
        let config = match permission {
            PermissionPreset::WorkspaceWrite => PlatformConfig::new(cwd),
            PermissionPreset::DangerFullAccess => PlatformConfig::new(cwd).full_access(),
        };
        let platform = Arc::new(
            NativePlatform::with_debug(config, self.debug.clone())
                .map_err(|error| error.to_string())?,
        );
        let mut platforms = self.platforms.write().await;
        Ok(platforms
            .entry(key)
            .or_insert_with(|| Arc::clone(&platform))
            .clone())
    }

    pub async fn readiness(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<NativeToolReadiness, String> {
        let platform = self.platform(cwd, permission).await?;
        let terminals = self
            .terminals
            .list(session_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(NativeToolReadiness {
            platform: platform.capability_report().await,
            search_available: self.web.has_search_provider(),
            existing_terminals: terminals.len(),
        })
    }
}

fn project_tools(specs: &mut Vec<ToolSpec>, readiness: &NativeToolReadiness) {
    let process_available = readiness.platform.restricted_process.is_available();
    let terminal_open_available = readiness.platform.terminal_open.is_available();
    let terminal_management_available = terminal_open_available || readiness.existing_terminals > 0;
    specs.retain(|spec| match spec.definition.name.as_str() {
        "bash" | "glob" | "grep" => process_available,
        "terminal_open" => terminal_open_available,
        "terminal_send" | "terminal_read" | "terminal_signal" | "terminal_close" => {
            terminal_management_available
        }
        "web_search" => readiness.search_available,
        _ => true,
    });
}

#[async_trait]
impl SessionToolFactory for NativeToolFactory {
    async fn executor(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let platform = self.platform(cwd, permission).await?;
        let readiness = self.readiness(session_id, cwd, permission).await?;
        let mut specs = CodingToolBundle::new(
            platform,
            Arc::clone(&self.terminals),
            Arc::clone(&self.web),
            session_id,
            session_id,
        )
        .specs();
        project_tools(&mut specs, &readiness);
        if permission == PermissionPreset::DangerFullAccess {
            for spec in &mut specs {
                spec.requires_approval = false;
            }
        }
        let registry = Arc::new(ToolRegistry::new());
        for spec in specs {
            registry
                .register(spec)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(ToolExecutor::new(registry).with_debug(self.debug.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use xharness_platform::CapabilityState;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    struct TempWorkspace(std::path::PathBuf);

    impl TempWorkspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "xharness-host-app-permission-{}-{}",
                std::process::id(),
                NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
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
            .executor("guarded", &cwd, PermissionPreset::WorkspaceWrite)
            .await
            .unwrap();
        let guarded_names = guarded.registry().definitions().await;
        assert!(!guarded_names.is_empty());
        assert!(
            guarded
                .registry()
                .get("write")
                .await
                .unwrap()
                .requires_approval
        );

        let full_access = factory
            .executor("full", &cwd, PermissionPreset::DangerFullAccess)
            .await
            .unwrap();
        let full_definitions = full_access.registry().definitions().await;
        for definition in &full_definitions {
            assert!(
                !full_access
                    .registry()
                    .get(&definition.name)
                    .await
                    .unwrap()
                    .requires_approval
            );
        }
        assert!(full_definitions
            .iter()
            .all(|definition| definition.name != "web_search"));
        assert!(full_definitions
            .iter()
            .any(|definition| definition.name == "bash"));
    }

    #[tokio::test]
    async fn unavailable_capabilities_are_removed_before_model_projection() {
        let workspace = TempWorkspace::new();
        let platform =
            Arc::new(NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap());
        let mut specs = CodingToolBundle::new(
            platform,
            Arc::new(TerminalRegistry::with_defaults()),
            Arc::new(WebRuntime::default()),
            "session",
            "session",
        )
        .specs();
        project_tools(
            &mut specs,
            &NativeToolReadiness {
                platform: CapabilityReport {
                    filesystem_read: CapabilityState::Available,
                    filesystem_mutation: CapabilityState::Available,
                    restricted_process: CapabilityState::Unavailable {
                        reason: "RTM_NEWADDR denied".to_owned(),
                    },
                    terminal_open: CapabilityState::Unavailable {
                        reason: "RTM_NEWADDR denied".to_owned(),
                    },
                    process_network: CapabilityState::Unavailable {
                        reason: "RTM_NEWADDR denied".to_owned(),
                    },
                    sandbox_backend: "bubblewrap".to_owned(),
                },
                search_available: false,
                existing_terminals: 0,
            },
        );
        let mut names = specs
            .iter()
            .map(|spec| spec.definition.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            ["edit", "read", "terminal_list", "web_fetch", "write"]
        );
    }
}
