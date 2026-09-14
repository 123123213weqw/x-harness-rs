//! Native composition of reusable Host model settings and credential storage.
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};
use xharness_debug::DebugRecorder;
use xharness_host::{
    parse_model_settings, valid_credential_reference, DurableLoopAgentRuntime, ModelRegistry,
    ModelSettingsBackend,
};

/// Injectable for deterministic tests. Production never falls back to plaintext.
#[async_trait]
pub trait CredentialStore: Send + Sync + 'static {
    async fn get(&self, reference: &str) -> Result<Option<String>, String>;
    async fn set(&self, reference: &str, value: &str) -> Result<(), String>;
    async fn delete(&self, reference: &str) -> Result<(), String>;
}

pub struct NativeCredentialStore {
    service: String,
    gate: Arc<std::sync::Mutex<()>>,
}

impl NativeCredentialStore {
    pub fn new(state_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(state_dir)
            .map_err(|_| "Cannot create model state directory".to_owned())?;
        let path = std::fs::canonicalize(state_dir)
            .map_err(|_| "Cannot resolve model state directory".to_owned())?;
        let digest = Sha256::digest(path.to_string_lossy().as_bytes());
        Ok(Self {
            service: format!("com.xlang.xharness.models.{digest:x}"),
            gate: Arc::new(std::sync::Mutex::new(())),
        })
    }

    async fn entry<T: Send + 'static>(
        &self,
        reference: &str,
        action: impl FnOnce(keyring::Entry) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if !valid_credential_reference(reference) {
            return Err("Invalid credential reference".to_owned());
        }
        let service = self.service.clone();
        let reference = reference.to_owned();
        let gate = Arc::clone(&self.gate);
        tokio::task::spawn_blocking(move || {
            let _guard = gate.lock().map_err(|_| store_error())?;
            let entry = keyring::Entry::new(&service, &reference).map_err(|_| store_error())?;
            action(entry)
        })
        .await
        .map_err(|_| store_error())?
    }
}

fn store_error() -> String {
    "Native credential store unavailable. Unlock the system keychain/Secret Service and retry; no plaintext fallback is used.".to_owned()
}

#[async_trait]
impl CredentialStore for NativeCredentialStore {
    async fn get(&self, reference: &str) -> Result<Option<String>, String> {
        self.entry(reference, |entry| match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            keyring_result => match keyring_result {
                Err(keyring::Error::NoEntry) => Ok(None),
                _ => Err(store_error()),
            },
        })
        .await
    }
    async fn set(&self, reference: &str, value: &str) -> Result<(), String> {
        let value = value.to_owned();
        self.entry(reference, move |entry| {
            entry.set_password(&value).map_err(|_| store_error())
        })
        .await
    }
    async fn delete(&self, reference: &str) -> Result<(), String> {
        self.entry(reference, |entry| match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            _ => Err(store_error()),
        })
        .await
    }
}

pub struct NativeModelSettings {
    runtime: Arc<DurableLoopAgentRuntime>,
    credentials: Arc<dyn CredentialStore>,
    debug: DebugRecorder,
    /// Compatibility credentials explicitly passed to the process are not
    /// persisted; they remain read-only, just like environment overrides.
    process_keys: BTreeMap<String, String>,
    discovery: crate::reasoning_discovery::ReasoningDiscovery,
    attachments: Option<Arc<dyn xharness_attachments::AttachmentStore>>,
}

impl NativeModelSettings {
    pub fn new(
        runtime: Arc<DurableLoopAgentRuntime>,
        credentials: Arc<dyn CredentialStore>,
        debug: DebugRecorder,
    ) -> Self {
        Self {
            runtime,
            credentials,
            debug,
            process_keys: BTreeMap::new(),
            discovery: Default::default(),
            attachments: None,
        }
    }
    pub fn with_capability_cache(mut self, path: std::path::PathBuf) -> Self {
        self.discovery = crate::reasoning_discovery::ReasoningDiscovery::with_path(path);
        self
    }
    pub fn with_attachments(
        mut self,
        store: Arc<dyn xharness_attachments::AttachmentStore>,
    ) -> Self {
        self.attachments = Some(store);
        self
    }
    pub fn with_process_key(mut self, reference: String, value: String) -> Self {
        if !value.is_empty() {
            self.process_keys.insert(reference, value);
        }
        self
    }
    fn environment_key(&self, reference: &str) -> Option<String> {
        std::env::var(reference)
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| self.process_keys.get(reference).cloned())
    }
    async fn key(&self, reference: &str) -> Result<Option<String>, String> {
        if let Some(value) = self.environment_key(reference) {
            return Ok(Some(value));
        }
        self.credentials.get(reference).await
    }
}

impl NativeModelSettings {
    async fn prepare_with_key(
        &self,
        section: &Value,
        replacement: Option<(&str, Option<&str>)>,
        force_discovery: bool,
    ) -> Result<ModelRegistry, String> {
        let mut doc = parse_model_settings(section)?;
        let mut keys = BTreeMap::new();
        for profile in doc.providers.values() {
            if let Some(reference) = &profile.api_key_env {
                if !keys.contains_key(reference) {
                    let key = match replacement.filter(|(name, _)| *name == reference) {
                        Some((_, value)) => value.map(str::to_owned),
                        None => self.key(reference).await?,
                    };
                    keys.insert(reference.clone(), key);
                }
            }
        }
        let mut observations = BTreeMap::new();
        let discovery_deadline = std::time::Instant::now() + Duration::from_secs(10);
        for (id, profile) in &mut doc.providers {
            let (discovered, provenance) = if let Some(spec) = &profile.reasoning_discovery {
                let spec = serde_json::from_value(spec.clone())
                    .map_err(|_| "Invalid reasoningDiscovery configuration")?;
                self.discovery
                    .get_with_timeout(
                        &profile.base_url,
                        &profile.api,
                        profile
                            .api_key_env
                            .as_ref()
                            .and_then(|r| keys.get(r))
                            .and_then(|v| v.as_deref()),
                        &spec,
                        force_discovery,
                        discovery_deadline.saturating_duration_since(std::time::Instant::now()),
                    )
                    .await?
            } else {
                (BTreeMap::new(), json!({"source":"unknown"}))
            };
            for model in &mut profile.models {
                let upstream = model.upstream_model.as_deref().unwrap_or(&model.id);
                let mut observation = json!({"state":"unknown","source":"unknown"});
                if let Some(explicit) = &model.reasoning {
                    observation = json!({"state":if explicit.is_null() {"disabled"} else {"supported"},"source":"configured"});
                } else if let Some(value) = discovered.get(upstream) {
                    model.reasoning = Some(value.clone());
                    observation = provenance.clone();
                    observation["state"] = json!("supported");
                } else {
                    let protocol = if profile.api == "openai-responses" {
                        xharness_provider_openai::OpenAiProtocol::Responses
                    } else {
                        xharness_provider_openai::OpenAiProtocol::ChatCompletions
                    };
                    if let Some(value) = crate::config::reasoning_catalog::builtin(
                        &profile.base_url,
                        upstream,
                        protocol,
                    ) {
                        model.reasoning = Some(
                            serde_json::to_value(value)
                                .map_err(|_| "Invalid documented reasoning profile")?,
                        );
                        observation = json!({"state":"supported","source":"documented","verifiedAt":"2026-09-14"});
                    } else if profile.reasoning_discovery.is_some() {
                        observation = provenance.clone();
                        observation["state"] = json!("unknown");
                    }
                }
                observations.insert((id.clone(), model.id.clone()), observation);
            }
        }
        tokio::time::timeout(
            Duration::from_secs(20),
            crate::config::registry_from_resolved_settings(
                &doc,
                &keys,
                self.debug.clone(),
                self.attachments.clone(),
                &observations,
            ),
        )
        .await
        .map_err(|_| {
            "Model configuration validation timed out; existing configuration is unchanged"
                .to_owned()
        })?
    }
}

#[async_trait]
impl ModelSettingsBackend for NativeModelSettings {
    async fn prepare(&self, section: &Value) -> Result<ModelRegistry, String> {
        self.prepare_with_key(section, None, false).await
    }
    async fn refresh(&self, section: &Value) -> Result<ModelRegistry, String> {
        self.prepare_with_key(section, None, true).await
    }
    fn activate(&self, registry: ModelRegistry) {
        self.runtime.replace_model_registry(registry);
    }
    async fn credential_info(&self, reference: &str) -> Result<Value, String> {
        if self.environment_key(reference).is_some() {
            return Ok(json!({"configured":true,"source":"env","writable":false}));
        }
        match self.credentials.get(reference).await? {
            Some(_) => Ok(json!({"configured":true,"source":"keychain","writable":true})),
            None => Ok(json!({"configured":false,"writable":true})),
        }
    }
    async fn set_credential(
        &self,
        reference: &str,
        value: &str,
        section: &Value,
    ) -> Result<ModelRegistry, String> {
        if self.environment_key(reference).is_some() {
            return Err("An environment/process credential overrides this reference; change it outside the app".to_owned());
        }
        if value.trim() != value || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("API key contains whitespace/control characters or is too long".to_owned());
        }
        let registry = self
            .prepare_with_key(section, Some((reference, Some(value))), false)
            .await?;
        self.credentials.set(reference, value).await?;
        Ok(registry)
    }
    async fn unset_credential(
        &self,
        reference: &str,
        section: &Value,
    ) -> Result<ModelRegistry, String> {
        if self.environment_key(reference).is_some() {
            return Err("An environment/process credential is read-only".to_owned());
        }
        let registry = self
            .prepare_with_key(section, Some((reference, None)), false)
            .await?;
        self.credentials.delete(reference).await?;
        Ok(registry)
    }
    async fn discover(&self, section: &Value, request: &Value) -> Result<Value, String> {
        let doc = parse_model_settings(section)?;
        let profile = request["provider"]
            .as_str()
            .and_then(|id| doc.providers.get(id));
        let base = request["baseURL"]
            .as_str()
            .or_else(|| profile.map(|p| p.base_url.as_str()))
            .ok_or_else(|| "Enter an endpoint before fetching models".to_owned())?;
        let api = request["api"]
            .as_str()
            .or_else(|| profile.map(|p| p.api.as_str()))
            .unwrap_or("openai-completions");
        // Reuse validation; local model servers are intentional, not blocked by
        // a blanket private-network denylist. Never follow redirects with keys.
        parse_model_settings(
            &json!({"providers":{"probe":{"baseURL":base,"api":api,"models":[{"id":"probe"}]}}}),
        )?;
        let key = if let Some(value) = request["apiKey"].as_str() {
            Some(value.to_owned())
        } else if let Some(p) = profile.filter(|p| p.base_url == base) {
            match &p.api_key_env {
                Some(r) => self.key(r).await?,
                None => None,
            }
        } else {
            None
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Cannot initialize model discovery".to_owned())?;
        let mut query = client.get(format!("{}/models", base.trim_end_matches('/')));
        if let Some(key) = key.as_ref().filter(|k| !k.is_empty()) {
            query = query.bearer_auth(key);
        }
        let mut response = query
            .send()
            .await
            .map_err(|_| "Cannot reach model endpoint (connection or TLS error)".to_owned())?;
        if !response.status().is_success() {
            return Err(format!(
                "Model discovery returned HTTP {}; check endpoint and credential",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Cannot read model listing".to_owned())?
        {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("Model listing exceeds 2 MiB".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        let listing: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Endpoint did not return a JSON model listing".to_owned())?;
        let data = listing["data"]
            .as_array()
            .ok_or_else(|| "Endpoint did not return a data array".to_owned())?;
        let remote_profiles =
            if let Some(p) = profile.filter(|p| p.base_url == base && p.api == api) {
                if let Some(spec) = &p.reasoning_discovery {
                    let spec = serde_json::from_value(spec.clone())
                        .map_err(|_| "Invalid reasoningDiscovery configuration")?;
                    self.discovery
                        .get(base, api, key.as_deref(), &spec, true)
                        .await?
                        .0
                } else {
                    BTreeMap::new()
                }
            } else {
                BTreeMap::new()
            };
        let models = data
            .iter()
            .filter_map(|m| {
                m["id"].as_str().filter(|id| !id.is_empty()).map(|id| {
                    let mut item = json!({"id":id,"name":m["name"].as_str().unwrap_or(id)});
                    // Only explicit discovery specs authorize interpreting nonstandard remote profiles.
                    let configured = profile
                        .filter(|p| p.base_url == base && p.api == api)
                        .and_then(|p| p.models.iter().find(|model| model.id == id))
                        .and_then(|m| m.reasoning.clone());
                    let protocol = if api == "openai-responses" {
                        xharness_provider_openai::OpenAiProtocol::Responses
                    } else {
                        xharness_provider_openai::OpenAiProtocol::ChatCompletions
                    };
                    let documented = crate::config::reasoning_catalog::builtin(base, id, protocol)
                        .and_then(|p| serde_json::to_value(p).ok());
                    if let Some(value) = configured
                        .or_else(|| remote_profiles.get(id).cloned())
                        .or(documented)
                    {
                        item["reasoning"] = value;
                    }
                    item
                })
            })
            .take(512)
            .collect::<Vec<_>>();
        Ok(json!({"models":models}))
    }
}
