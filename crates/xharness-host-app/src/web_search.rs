//! Search composition is independent of the selected model and its route.
#![forbid(unsafe_code)]

use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;
use xharness_host::{BasicHost, WebSearchSettings};
use xharness_web::{DeepSeekSearchProvider, SearchProvider, SearchResult, WebError};

use crate::model_settings::CredentialStore;

pub struct NativeSearch {
    host: OnceLock<Weak<BasicHost>>,
    credentials: Arc<dyn CredentialStore>,
    provider: DeepSeekSearchProvider,
}

impl NativeSearch {
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Result<Self, WebError> {
        Ok(Self {
            host: OnceLock::new(),
            credentials,
            provider: DeepSeekSearchProvider::new("")?,
        })
    }

    pub fn bind_host(&self, host: &Arc<BasicHost>) -> Result<(), String> {
        self.host
            .set(Arc::downgrade(host))
            .map_err(|_| "Search Host is already bound".into())
    }

    async fn options(&self) -> Result<WebSearchSettings, WebError> {
        self.host
            .get()
            .and_then(Weak::upgrade)
            .ok_or(WebError::SearchUnavailable)?
            .web_search_settings()
            .await
            .map_err(|_| {
                WebError::Provider("DeepSeek search settings are invalid or unavailable".into())
            })
    }

    async fn key(&self, settings: &WebSearchSettings) -> Result<Option<String>, WebError> {
        if !settings.enabled {
            return Ok(None);
        }
        if let Ok(key) = std::env::var(&settings.api_key_env) {
            if !key.trim().is_empty() {
                return Ok(Some(key));
            }
        }
        let key = tokio::time::timeout(
            Duration::from_secs(2),
            self.credentials.get(&settings.api_key_env),
        )
        .await
        .map_err(|_| WebError::TimedOut)?
        .map_err(|_| {
            WebError::Provider("DeepSeek search credential store is unavailable".into())
        })?;
        Ok(key.filter(|value| !value.trim().is_empty()))
    }
}

#[async_trait]
impl SearchProvider for NativeSearch {
    fn id(&self) -> &str {
        self.provider.id()
    }

    async fn available(&self) -> bool {
        let Ok(settings) = self.options().await else {
            return false;
        };
        matches!(self.key(&settings).await, Ok(Some(_)))
    }

    async fn search(
        &self,
        query: &str,
        limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SearchResult>, WebError> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(WebError::Cancelled),
            result = async {
                let settings = self.options().await?;
                let key = self.key(&settings).await?.ok_or(WebError::SearchUnavailable)?;
                // One settings/credential snapshot owns this operation. Model
                // switches and concurrent settings writes cannot redirect it.
                self.provider.with_api_key(key).search(query, limit, cancellation).await
            } => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::BTreeMap, sync::Mutex};
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_host::{HostConfig, NoTools, SessionToolFactory, WEB_SEARCH_SETTINGS_NAMESPACE};

    #[derive(Default)]
    struct Credentials(Mutex<BTreeMap<String, String>>);
    #[async_trait]
    impl CredentialStore for Credentials {
        async fn get(&self, reference: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(reference).cloned())
        }
        async fn set(&self, reference: &str, value: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(reference.into(), value.into());
            Ok(())
        }
        async fn delete(&self, reference: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(reference);
            Ok(())
        }
    }

    async fn configure(host: &BasicHost, enabled: bool) {
        let result = host.call(RpcId::new(format!("search-{enabled}")), RpcMethod::SettingsUpdate,
            json!({"ns":WEB_SEARCH_SETTINGS_NAMESPACE,"patch":{"enabled":enabled,"apiKeyEnv":"XHARNESS_SEARCH_TEST_CREDENTIAL"}}), CancellationToken::new()).await;
        assert!(matches!(result, RpcResult::Success { .. }), "{result:?}");
    }

    #[tokio::test]
    async fn unrelated_models_use_the_same_independent_credential_and_live_switch() {
        let credentials = Arc::new(Credentials::default());
        credentials
            .set("XHARNESS_SEARCH_TEST_CREDENTIAL", "fixture-key")
            .await
            .unwrap();
        for (provider, model) in [
            ("deepseek", "deepseek-fixture"),
            ("other-provider", "other-model"),
        ] {
            let mut config = HostConfig::new(std::env::temp_dir());
            config.provider_id = provider.into();
            config.model_id = model.into();
            let host = BasicHost::new(config, None, Arc::new(NoTools));
            let search = Arc::new(NativeSearch::new(credentials.clone()).unwrap());
            let factory = crate::NativeToolFactory::new(
                xharness_web::WebRuntime::default().with_search_provider(search.clone()),
            );
            assert!(!search.available().await);
            search.bind_host(&host).unwrap();
            configure(&host, true).await;
            assert!(search.available().await);
            let cwd = std::env::temp_dir();
            let tools = factory
                .executor(
                    "search-test",
                    &cwd.to_string_lossy(),
                    xharness_host::PermissionPreset::DangerFullAccess,
                )
                .await
                .unwrap();
            assert!(tools
                .registry()
                .definitions()
                .await
                .iter()
                .any(|tool| tool.name == "web_search"));
            assert_eq!(
                search
                    .key(&search.options().await.unwrap())
                    .await
                    .unwrap()
                    .as_deref(),
                Some("fixture-key")
            );
            configure(&host, false).await;
            assert!(!search.available().await);
            let tools = factory
                .executor(
                    "search-test",
                    &cwd.to_string_lossy(),
                    xharness_host::PermissionPreset::DangerFullAccess,
                )
                .await
                .unwrap();
            assert!(!tools
                .registry()
                .definitions()
                .await
                .iter()
                .any(|tool| tool.name == "web_search"));
            assert!(matches!(
                search.search("rust", 8, &CancellationToken::new()).await,
                Err(WebError::SearchUnavailable)
            ));
        }
    }

    #[tokio::test]
    async fn missing_rotated_and_removed_credentials_are_rechecked_without_a_restart() {
        let credentials = Arc::new(Credentials::default());
        let host = BasicHost::new(
            HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(NoTools),
        );
        let search = NativeSearch::new(credentials.clone()).unwrap();
        search.bind_host(&host).unwrap();
        configure(&host, true).await;
        assert!(!search.available().await);
        credentials
            .set("XHARNESS_SEARCH_TEST_CREDENTIAL", "first")
            .await
            .unwrap();
        let snapshot = search.options().await.unwrap();
        assert_eq!(
            search.key(&snapshot).await.unwrap().as_deref(),
            Some("first")
        );
        credentials
            .set("XHARNESS_SEARCH_TEST_CREDENTIAL", "second")
            .await
            .unwrap();
        assert_eq!(
            search.key(&snapshot).await.unwrap().as_deref(),
            Some("second")
        );
        credentials
            .delete("XHARNESS_SEARCH_TEST_CREDENTIAL")
            .await
            .unwrap();
        assert!(!search.available().await);
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            search.search("rust", 8, &token).await,
            Err(WebError::Cancelled)
        ));
    }

    #[tokio::test]
    async fn search_keeps_only_a_weak_host_reference() {
        let host = BasicHost::new(
            HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(NoTools),
        );
        let weak = Arc::downgrade(&host);
        let search = NativeSearch::new(Arc::new(Credentials::default())).unwrap();
        search.bind_host(&host).unwrap();
        assert!(search.bind_host(&host).is_err());
        drop(host);
        assert!(weak.upgrade().is_none());
        assert!(!search.available().await);
    }
}
