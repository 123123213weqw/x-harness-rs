//! Opt-in capability discovery. No inference from model names on arbitrary proxies.
//! Profiles are validated request mappings, not remotely supplied arbitrary settings.
use crate::config::ModelReasoningConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoverySpec {
    pub url: String,
    #[serde(default = "models_pointer")]
    pub models_pointer: String,
    #[serde(default = "id_pointer")]
    pub id_pointer: String,
    #[serde(default = "profile_pointer")]
    pub profile_pointer: String,
    #[serde(default = "ttl")]
    pub ttl_seconds: u64,
    /// Alternative for endpoints advertising effort IDs instead of full profiles.
    #[serde(default)]
    pub efforts_pointer: Option<String>,
    #[serde(default)]
    pub default_effort_pointer: Option<String>,
    /// Exact "$effort" string values are substituted; field names stay configured.
    #[serde(default)]
    pub request_template: Option<Value>,
}
fn models_pointer() -> String {
    "/data".into()
}
fn id_pointer() -> String {
    "/id".into()
}
fn profile_pointer() -> String {
    "/reasoning".into()
}
fn ttl() -> u64 {
    3600
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn validated_profile(value: &Value) -> Result<Value, String> {
    let profile: ModelReasoningConfig = serde_json::from_value(value.clone())
        .map_err(|_| "Invalid reasoning profile".to_owned())?;
    profile.adapter_profile()?;
    if serde_json::to_vec(value)
        .map_err(|_| "Invalid reasoning profile")?
        .len()
        > 32768
    {
        return Err("Reasoning profile exceeds 32 KiB".into());
    }
    serde_json::to_value(profile).map_err(|_| "Invalid reasoning profile".to_owned())
}

pub fn validate_spec(base: &str, spec: &DiscoverySpec) -> Result<(), String> {
    let base = reqwest::Url::parse(base).map_err(|_| "Invalid provider URL")?;
    let url = reqwest::Url::parse(&spec.url).map_err(|_| "Invalid capability URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(30..=86400).contains(&spec.ttl_seconds)
        || [
            &spec.models_pointer,
            &spec.id_pointer,
            &spec.profile_pointer,
        ]
        .iter()
        .any(|s| !s.is_empty() && !s.starts_with('/'))
    {
        return Err(
            "Capability discovery requires the same origin, valid JSON pointers and TTL 30..86400"
                .into(),
        );
    }
    if spec.efforts_pointer.is_some() != spec.request_template.is_some() {
        return Err("effortsPointer and requestTemplate must be configured together".into());
    }
    for pointer in [&spec.efforts_pointer, &spec.default_effort_pointer]
        .into_iter()
        .flatten()
    {
        if !pointer.is_empty() && !pointer.starts_with('/') {
            return Err("Invalid reasoning JSON pointer".into());
        }
    }
    Ok(())
}

fn materialize_template(value: &Value, effort: &str) -> Value {
    match value {
        Value::String(s) if s == "$effort" => json!(effort),
        Value::Array(v) => {
            Value::Array(v.iter().map(|v| materialize_template(v, effort)).collect())
        }
        Value::Object(v) => Value::Object(
            v.iter()
                .map(|(k, v)| (k.clone(), materialize_template(v, effort)))
                .collect(),
        ),
        other => other.clone(),
    }
}
fn model_profile(model: &Value, spec: &DiscoverySpec) -> Result<Value, String> {
    if let (Some(pointer), Some(template)) = (&spec.efforts_pointer, &spec.request_template) {
        let ids = model
            .pointer(pointer)
            .and_then(Value::as_array)
            .ok_or("Missing effort list")?;
        if ids.len() > 64 {
            return Err("Too many effort levels".into());
        }
        let mut efforts = Vec::new();
        for value in ids {
            let id = value
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or("Invalid effort ID")?;
            efforts
                .push(json!({"id":id,"name":id,"request_patch":materialize_template(template,id)}));
        }
        let mut profile = json!({"efforts":efforts});
        if let Some(pointer) = &spec.default_effort_pointer {
            if let Some(default) = model.pointer(pointer) {
                profile["default_effort"] = default.clone();
            }
        }
        validated_profile(&profile)
    } else {
        validated_profile(
            model
                .pointer(&spec.profile_pointer)
                .ok_or("Missing reasoning profile")?,
        )
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Cached {
    profiles: BTreeMap<String, Value>,
    checked_at: u64,
    #[serde(default)]
    stale: bool,
}
#[derive(Default)]
pub struct ReasoningDiscovery {
    cache: Mutex<BTreeMap<String, Cached>>,
    path: Option<PathBuf>,
}
impl ReasoningDiscovery {
    pub fn with_path(path: PathBuf) -> Self {
        let cache = std::fs::metadata(&path)
            .ok()
            .filter(|m| m.len() <= 2 * 1024 * 1024)
            .and_then(|_| std::fs::read(&path).ok())
            .and_then(|b| serde_json::from_slice::<BTreeMap<String, Cached>>(&b).ok())
            .unwrap_or_default();
        // Treat disk state as untrusted; reject unsafe patches on restore too.
        let cache = cache
            .into_iter()
            .filter(|(_, v)| {
                v.profiles.len() <= 512 && v.profiles.values().all(|p| validated_profile(p).is_ok())
            })
            .take(128)
            .collect();
        Self {
            cache: Mutex::new(cache),
            path: Some(path),
        }
    }
    pub async fn get(
        &self,
        base: &str,
        api: &str,
        key: Option<&str>,
        spec: &DiscoverySpec,
        force: bool,
    ) -> Result<(BTreeMap<String, Value>, Value), String> {
        self.get_with_timeout(base, api, key, spec, force, Duration::from_secs(5))
            .await
    }
    pub async fn get_with_timeout(
        &self,
        base: &str,
        api: &str,
        key: Option<&str>,
        spec: &DiscoverySpec,
        force: bool,
        budget: Duration,
    ) -> Result<(BTreeMap<String, Value>, Value), String> {
        validate_spec(base, spec)?;
        let identity = format!(
            "{base}\n{api}\n{}\n{}",
            serde_json::to_string(spec).unwrap_or_default(),
            key.unwrap_or("")
        );
        let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
        let cached = self.cache.lock().await.get(&hash).cloned();
        if !force {
            if let Some(c) = cached
                .as_ref()
                .filter(|c| now().saturating_sub(c.checked_at) < spec.ttl_seconds)
            {
                return Ok((
                    c.profiles.clone(),
                    json!({"source":"provider_reported","checkedAt":c.checked_at,"stale":c.stale}),
                ));
            }
        }
        match fetch_profiles(base, key, spec, budget.min(Duration::from_secs(5))).await {
            Ok(profiles) => {
                let mut cache = self.cache.lock().await;
                // An incomplete successful listing must not silently delete last-good capabilities.
                let mut merged = cached
                    .as_ref()
                    .map(|c| c.profiles.clone())
                    .unwrap_or_default();
                let complete = profiles.keys().collect::<Vec<_>>();
                let retains_old = merged.keys().any(|id| !complete.contains(&id));
                merged.extend(profiles);
                let at = if retains_old {
                    cached.as_ref().map(|c| c.checked_at).unwrap_or_else(now)
                } else {
                    now()
                };
                if cache.len() >= 128 && !cache.contains_key(&hash) {
                    if let Some(oldest) = cache
                        .iter()
                        .min_by_key(|(_, c)| c.checked_at)
                        .map(|(k, _)| k.clone())
                    {
                        cache.remove(&oldest);
                    }
                }
                cache.insert(
                    hash,
                    Cached {
                        profiles: merged.clone(),
                        checked_at: at,
                        stale: retains_old,
                    },
                );
                while serde_json::to_vec(&*cache)
                    .map(|v| v.len() > 2 * 1024 * 1024)
                    .unwrap_or(true)
                {
                    if let Some(oldest) = cache
                        .iter()
                        .min_by_key(|(_, c)| c.checked_at)
                        .map(|(k, _)| k.clone())
                    {
                        cache.remove(&oldest);
                    } else {
                        break;
                    }
                }
                if let Some(path) = &self.path {
                    if let Ok(bytes) = serde_json::to_vec(&*cache) {
                        if let Some(parent) = path.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let tmp = path.with_extension("json.tmp");
                        if std::fs::write(&tmp, bytes).is_ok() {
                            let _ = std::fs::rename(tmp, path);
                        }
                    }
                }
                Ok((
                    merged,
                    json!({"source":"provider_reported","checkedAt":at,"stale":retains_old}),
                ))
            }
            Err(_) if cached.is_some() => {
                let c = cached.unwrap();
                Ok((
                    c.profiles,
                    json!({"source":"last_known_good","checkedAt":c.checked_at,"stale":true}),
                ))
            }
            Err(_) => Ok((
                BTreeMap::new(),
                json!({"source":"discovery_failed","state":"unknown","stale":true}),
            )),
        }
    }
}
async fn fetch_profiles(
    base: &str,
    key: Option<&str>,
    spec: &DiscoverySpec,
    budget: Duration,
) -> Result<BTreeMap<String, Value>, String> {
    validate_spec(base, spec)?;
    if budget.is_zero() {
        return Err("Discovery deadline elapsed".into());
    }
    let client = xharness_provider_openai::client_builder_for_endpoint(&spec.url)
        .timeout(budget)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Capability client failed")?;
    let mut request = client.get(&spec.url);
    if let Some(key) = key.filter(|s| !s.is_empty()) {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Capability request failed")?
        .error_for_status()
        .map_err(|_| "Capability HTTP error")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Capability body failed")?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Capability response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let doc: Value = serde_json::from_slice(&bytes).map_err(|_| "Capability JSON invalid")?;
    let models = doc
        .pointer(&spec.models_pointer)
        .and_then(Value::as_array)
        .ok_or("Capability models missing")?;
    let mut profiles = BTreeMap::new();
    for model in models.iter().take(512) {
        if let Some(id) = model
            .pointer(&spec.id_pointer)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 256)
        {
            if let Ok(profile) = model_profile(model, spec) {
                profiles.insert(id.into(), profile);
            }
        }
    }
    Ok(profiles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn profile() -> Value {
        json!({"default_effort":"adaptive","efforts":[{"id":"adaptive","name":"Adaptive","request_patch":{"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}}]})
    }
    fn spec(url: String) -> DiscoverySpec {
        DiscoverySpec {
            url,
            models_pointer: models_pointer(),
            id_pointer: id_pointer(),
            profile_pointer: profile_pointer(),
            ttl_seconds: 30,
            efforts_pointer: None,
            default_effort_pointer: None,
            request_template: None,
        }
    }
    #[test]
    fn profiles_validate_wire_mappings_and_origin_before_network() {
        assert!(validated_profile(&profile()).is_ok());
        for patch in [
            json!({"messages":[]}),
            json!({"model":"other"}),
            json!({"tools":[]}),
        ] {
            let mut p = profile();
            p["efforts"][0]["request_patch"] = patch;
            assert!(validated_profile(&p).is_err());
        }
        let mut p = profile();
        p["default_effort"] = json!("unknown");
        assert!(validated_profile(&p).is_err());
        let mut p = profile();
        p["efforts"] = json!([]);
        assert!(validated_profile(&p).is_err());
        for url in [
            "https://foreign.example/caps",
            "http://api.example/caps",
            "https://user:pass@api.example/caps",
        ] {
            assert!(validate_spec("https://api.example/v1", &spec(url.into())).is_err());
        }
        assert!(validate_spec(
            "https://api.example/v1",
            &spec("https://api.example/caps".into())
        )
        .is_ok());
    }
    #[tokio::test]
    async fn discovery_cache_failure_restart_and_route_isolation() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let fail = Arc::new(AtomicUsize::new(0));
        let fail_server = fail.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = [0u8; 4096];
                let _ = socket.read(&mut bytes).await;
                seen.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if fail_server.load(Ordering::SeqCst) > 0 {
                    ("503 Service Unavailable", json!({"error":"offline"}))
                } else {
                    (
                        "200 OK",
                        json!({"data":[{"id":"model-a","reasoning":profile()}]}),
                    )
                };
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let path = std::env::temp_dir().join(format!(
            "xh-reasoning-cache-{}-{}.json",
            std::process::id(),
            now()
        ));
        let resolver = ReasoningDiscovery::with_path(path.clone());
        let spec = spec(format!("{base}/caps"));
        let (first, info) = resolver
            .get(&base, "chat", Some("credential-a"), &spec, false)
            .await
            .unwrap();
        assert!(first.contains_key("model-a"));
        assert_eq!(info["stale"], false);
        resolver
            .get(&base, "chat", Some("credential-a"), &spec, false)
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        fail.store(1, Ordering::SeqCst);
        let (second, info) = resolver
            .get(&base, "chat", Some("credential-a"), &spec, true)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(info["stale"], true);
        let restored = ReasoningDiscovery::with_path(path.clone());
        let (third, info) = restored
            .get(&base, "chat", Some("credential-a"), &spec, true)
            .await
            .unwrap();
        assert_eq!(first, third);
        assert_eq!(info["source"], "last_known_good");
        for (api, key) in [("responses", "credential-a"), ("chat", "credential-b")] {
            let (other, info) = restored
                .get(&base, api, Some(key), &spec, true)
                .await
                .unwrap();
            assert!(other.is_empty());
            assert_eq!(info["state"], "unknown");
        }
        let file = std::fs::read_to_string(&path).unwrap();
        assert!(!file.contains("credential-a"));
        assert!(!file.contains(&base));
        task.abort();
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    #[test]
    fn vendor_fields_are_configured_not_guessed_and_preserve_native_levels() {
        let spec:DiscoverySpec=serde_json::from_value(json!({
            "url":"https://gateway.example/capabilities","modelsPointer":"/models", "idPointer":"/model",
            "effortsPointer":"/features/thinking/levels", "defaultEffortPointer":"/features/thinking/default",
            "requestTemplate":{"vendor_options":{"inference_depth":"$effort"}}
        })).unwrap();
        let model = json!({"features":{"thinking":{"levels":["brief","deep","adaptive"],"default":"adaptive"}}});
        let p = model_profile(&model, &spec).unwrap();
        assert_eq!(p["default_effort"], "adaptive");
        assert_eq!(p["efforts"][1]["id"], "deep");
        assert_eq!(
            p["efforts"][1]["request_patch"]["vendor_options"]["inference_depth"],
            "deep"
        );
        assert!(model_profile(&json!({}), &spec).is_err());
        let mut invalid = spec.clone();
        invalid.request_template = Some(json!({"messages":"$effort"}));
        assert!(model_profile(&model, &invalid).is_err());
    }
}
