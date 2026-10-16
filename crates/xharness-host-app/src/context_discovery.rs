//! Read-only, same-origin deployment discovery. Missing metadata is unknown,
//! not a guessed model maximum. Architecture/training lengths are not limits.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use xharness_core::ContextWindowCapability;

type Contexts = BTreeMap<String, ContextWindowCapability>;
type CachedContexts = (Instant, Contexts);

#[derive(Default)]
pub(crate) struct ContextDiscovery {
    cache: Mutex<BTreeMap<String, CachedContexts>>,
}

fn positive(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0 && *n <= 1_000_000_000)
}

/// Only exact model rows, with provider-owned operational fields. Never use
/// n_ctx_train/max_position_embeddings, guesses from names, or output limits.
pub(crate) fn listed_contexts(listing: &Value) -> BTreeMap<String, ContextWindowCapability> {
    let mut result = BTreeMap::new();
    let Some(rows) = listing["data"].as_array() else {
        return result;
    };
    for row in rows.iter().take(512) {
        let Some(id) = row["id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let reported = ["/context_window", "/contextWindow", "/context_length"]
            .into_iter()
            .filter_map(|path| row.pointer(path).and_then(positive))
            .min();
        let deployed = ["/max_model_len", "/meta/n_ctx"]
            .into_iter()
            .filter_map(|path| row.pointer(path).and_then(positive))
            .min();
        let mut capability = reported
            .map(ContextWindowCapability::reported)
            .unwrap_or_default();
        if let Some(deployed) = deployed {
            capability.deployment_limit =
                ContextWindowCapability::deployment_reported(deployed).deployment_limit;
        }
        if let Some(limit) = capability.effective_hard_max() {
            result
                .entry(id.to_owned())
                .and_modify(|old: &mut ContextWindowCapability| {
                    if old.effective_hard_max().is_some_and(|n| limit < n) {
                        *old = capability.clone();
                    }
                })
                .or_insert(capability);
        }
    }
    result
}

fn props_url(base: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(base).ok()?;
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/v1")?;
    let path = format!("{path}/props");
    url.set_path(&path);
    Some(url)
}

async fn read_json(
    client: &reqwest::Client,
    url: reqwest::Url,
    key: Option<&str>,
) -> Option<Value> {
    let mut query = client.get(url);
    if let Some(key) = key.filter(|key| !key.is_empty()) {
        query = query.bearer_auth(key);
    }
    let mut response = query.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

impl ContextDiscovery {
    pub(crate) async fn get(
        &self,
        base: &str,
        key: Option<&str>,
        force: bool,
        timeout: Duration,
    ) -> BTreeMap<String, ContextWindowCapability> {
        // Credential identity participates in the cache; credentials are never
        // stored in cache keys, errors, events or logs. No redirect follows keys.
        let identity = hex::encode(Sha256::digest(
            format!("{base}\0{}", key.unwrap_or_default()).as_bytes(),
        ));
        if !force {
            if let Some((until, value)) = self.cache.lock().await.get(&identity) {
                if *until > Instant::now() {
                    return value.clone();
                }
            }
        }
        let mut observed = BTreeMap::new();
        let result = tokio::time::timeout(timeout, async {
            let client = xharness_provider_openai::client_builder_for_endpoint(base)
                .timeout(timeout.min(Duration::from_secs(3)))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()?;
            let url =
                reqwest::Url::parse(&format!("{}/models", base.trim_end_matches('/'))).ok()?;
            let listing = read_json(&client, url, key).await?;
            let mut contexts = listed_contexts(&listing);
            // Optional /props may hang or fail. Do not discard deployment
            // metadata already read from the exact /models response.
            observed = contexts.clone();
            // llama-server /props reports per-slot deployment n_ctx. Match a
            // single exact listed route before using global properties; a
            // multi-model gateway must supply per-model metadata instead.
            if let Some(rows) = listing["data"].as_array().filter(|rows| rows.len() == 1) {
                if let (Some(id), Some(url)) = (rows[0]["id"].as_str(), props_url(base)) {
                    if let Some(props) = read_json(&client, url, key).await {
                        if let Some(n) = props
                            .pointer("/default_generation_settings/n_ctx")
                            .and_then(positive)
                        {
                            let n = contexts
                                .get(id)
                                .and_then(ContextWindowCapability::effective_hard_max)
                                .map_or(n, |old| n.min(old));
                            contexts.insert(
                                id.to_owned(),
                                ContextWindowCapability::deployment_reported(n),
                            );
                        }
                    }
                }
            }
            Some(contexts)
        })
        .await;
        let value = result.ok().flatten().unwrap_or(observed);
        let mut cache = self.cache.lock().await;
        // Expired entries do not accumulate when users edit endpoint/keys.
        cache.retain(|_, (until, _)| *until > Instant::now());
        if cache.len() >= 64 {
            cache.clear();
        }
        let ttl = if value.is_empty() { 30 } else { 300 };
        cache.insert(
            identity,
            (Instant::now() + Duration::from_secs(ttl), value.clone()),
        );
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture(
        multiple: bool,
    ) -> (
        String,
        Arc<AtomicU64>,
        Arc<AtomicU64>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let window = Arc::new(AtomicU64::new(65_536));
        let requests = Arc::new(AtomicU64::new(0));
        let w = window.clone();
        let r = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0; 1];
                    if socket.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    bytes.push(byte[0]);
                }
                r.fetch_add(1, Ordering::SeqCst);
                let request = String::from_utf8(bytes).unwrap();
                let body = if request.starts_with("GET /v1/models ") {
                    if multiple {
                        json!({"data":[{"id":"m","meta":{"n_ctx_train":1000000}},{"id":"other"}]})
                    } else {
                        json!({"data":[{"id":"m","meta":{"n_ctx":262144,"n_ctx_train":1000000}}]})
                    }
                } else {
                    assert!(request.starts_with("GET /props "));
                    if w.load(Ordering::SeqCst) == 0 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    json!({"default_generation_settings":{"n_ctx":w.load(Ordering::SeqCst)}})
                }
                .to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
            }
        });
        (base, window, requests, task)
    }

    #[tokio::test]
    async fn deployed_slot_limit_refreshes_and_cache_is_credential_scoped() {
        let (base, window, requests, task) = fixture(false).await;
        let discovery = ContextDiscovery::default();
        let fetch = |key, force| discovery.get(&base, key, force, Duration::from_secs(2));
        assert_eq!(
            fetch(Some("test-key-a"), false).await["m"].effective_hard_max(),
            Some(65_536)
        );
        window.store(262_144, Ordering::SeqCst);
        assert_eq!(
            fetch(Some("test-key-a"), false).await["m"].effective_hard_max(),
            Some(65_536)
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        assert_eq!(
            fetch(Some("test-key-a"), true).await["m"].effective_hard_max(),
            Some(262_144)
        );
        assert_eq!(
            fetch(Some("test-key-b"), false).await["m"].effective_hard_max(),
            Some(262_144)
        );
        assert_eq!(requests.load(Ordering::SeqCst), 6);
        task.abort();
    }

    #[tokio::test]
    async fn multi_model_gateway_and_unreachable_server_stay_unknown() {
        let (base, _, requests, task) = fixture(true).await;
        let discovery = ContextDiscovery::default();
        assert!(discovery
            .get(&base, None, false, Duration::from_secs(1))
            .await
            .is_empty());
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "global /props cannot be assigned to several model routes"
        );
        assert!(discovery
            .get(
                "http://127.0.0.1:0/v1",
                None,
                false,
                Duration::from_millis(100)
            )
            .await
            .is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn optional_props_timeout_preserves_already_observed_model_capacity() {
        let (base, window, _, task) = fixture(false).await;
        window.store(0, Ordering::SeqCst);
        let result = ContextDiscovery::default()
            .get(&base, None, true, Duration::from_millis(100))
            .await;
        assert_eq!(result["m"].effective_hard_max(), Some(262_144));
        task.abort();
    }

    #[tokio::test]
    async fn discovery_does_not_follow_redirects_with_credentials() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let location = format!("http://{}/leak", target.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let _ = stream.read(&mut bytes).await.unwrap();
            stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        assert!(ContextDiscovery::default()
            .get(&base, Some("test-credential"), true, Duration::from_secs(1))
            .await
            .is_empty());
        task.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "read-only actual deployment metadata; requires an explicit endpoint"]
    async fn actual_deployment_reports_a_capacity_not_the_temporary_32k_budget() {
        let base = std::env::var("XHARNESS_CONTEXT_PROBE_BASE").unwrap();
        let model = std::env::var("XHARNESS_CONTEXT_PROBE_MODEL").unwrap();
        let limits = ContextDiscovery::default()
            .get(&base, None, true, Duration::from_secs(3))
            .await;
        let maximum = limits[&model].effective_hard_max().unwrap();
        assert!(maximum > 32_768);
        println!("actual deployment context: {maximum}");
    }
    #[test]
    fn operational_fields_are_positive_exact_and_never_architectural_guesses() {
        for field in [
            "context_window",
            "contextWindow",
            "context_length",
            "max_model_len",
        ] {
            let row = json!({"id":"same", (field):262144});
            assert_eq!(
                listed_contexts(&json!({"data":[row]}))["same"].effective_hard_max(),
                Some(262144)
            );
            for invalid in [
                json!(0),
                json!(-1),
                json!("262144"),
                json!(1.5),
                json!(null),
            ] {
                let row = json!({"id":"same",(field):invalid});
                assert!(listed_contexts(&json!({"data":[row]})).is_empty());
            }
        }
        assert!(listed_contexts(&json!({"data":[{"id":"one","max_tokens":65536,"max_position_embeddings":1000000,"meta":{"n_ctx_train":1000000}}]})).is_empty());
        assert_eq!(listed_contexts(&json!({"data":[{"id":"a","context_window":262144,"meta":{"n_ctx":65536}},{"id":"b","context_length":1000000}]}))["a"].effective_hard_max(),Some(65536));
        assert_eq!(
            props_url("http://localhost:8080/gateway/v1/")
                .unwrap()
                .as_str(),
            "http://localhost:8080/gateway/props"
        );
        assert!(props_url("http://localhost:8080/custom/api").is_none());
    }
}
