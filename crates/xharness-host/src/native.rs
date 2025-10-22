use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;
use xharness_coding_tools::CodingToolBundle;
use xharness_core::ToolSpec;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_terminal::TerminalRegistry;
use xharness_web::WebRuntime;

use crate::SessionToolFactory;

/// Native Linux/macOS implementation of the standard fourteen-tool factory.
/// Platforms are cached per canonical workspace so filesystem observations
/// survive across turns, while terminal ownership remains per session.
pub struct NativeToolFactory {
    terminals: Arc<TerminalRegistry>,
    web: Arc<WebRuntime>,
    platforms: RwLock<BTreeMap<String, Arc<NativePlatform>>>,
}

impl NativeToolFactory {
    pub fn new(web: WebRuntime) -> Arc<Self> {
        Arc::new(Self {
            terminals: Arc::new(TerminalRegistry::with_defaults()),
            web: Arc::new(web),
            platforms: RwLock::new(BTreeMap::new()),
        })
    }

    async fn platform(&self, cwd: &str) -> Result<Arc<NativePlatform>, String> {
        if let Some(platform) = self.platforms.read().await.get(cwd).cloned() {
            return Ok(platform);
        }
        let platform = Arc::new(
            NativePlatform::new(PlatformConfig::new(cwd)).map_err(|error| error.to_string())?,
        );
        let mut platforms = self.platforms.write().await;
        Ok(platforms
            .entry(cwd.to_owned())
            .or_insert_with(|| Arc::clone(&platform))
            .clone())
    }
}

#[async_trait]
impl SessionToolFactory for NativeToolFactory {
    async fn tools(&self, session_id: &str, cwd: &str) -> Result<Vec<ToolSpec>, String> {
        let platform = self.platform(cwd).await?;
        CodingToolBundle::new(
            platform,
            Arc::clone(&self.terminals),
            Arc::clone(&self.web),
            session_id,
            session_id,
        )
        .core_specs()
        .await
        .map_err(|error| error.to_string())
    }
}
