//! Native device authorization only. Wallets/billing remain in the account service;
//! credentials are handed only to the trusted main UI's existing keyring writer.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tauri::{State, WebviewWindow};
use tokio::sync::Mutex;
use url::Url;
#[derive(Default)]
pub struct ManagedAccountState(Mutex<Option<Flow>>);
struct Flow {
    client: reqwest::Client,
    origin: Url,
    device: String,
    verifier: String,
    next: Instant,
    expires: Instant,
    result: Option<Value>,
    code: String,
}
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("account_access_denied".into())
    }
}
fn origin() -> Result<Url, String> {
    let raw = option_env!("XHARNESS_ACCOUNT_ORIGIN").unwrap_or("https://engine.xxdevs.com");
    let u = Url::parse(raw).map_err(|_| "account_origin_invalid")?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err("account_origin_invalid".into());
    }
    Ok(u)
}
fn secret() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "account_entropy_unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn text(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "account_response_invalid".into())
}
async fn post(c: &reqwest::Client, u: Url, v: Value) -> Result<Value, String> {
    let mut r = c
        .post(u)
        .json(&v)
        .send()
        .await
        .map_err(|_| "account_network_unavailable")?;
    if !r.status().is_success() {
        return Err(match r.status().as_u16() {
            401 => "account_login_expired",
            403 => "account_access_unavailable",
            409 => "account_poll_pending",
            _ => "account_service_unavailable",
        }
        .into());
    }
    if r.content_length().is_some_and(|n| n > 65536) {
        return Err("account_response_invalid".into());
    }
    let mut bytes = Vec::new();
    while let Some(b) = r.chunk().await.map_err(|_| "account_network_unavailable")? {
        if bytes.len() + b.len() > 65536 {
            return Err("account_response_invalid".into());
        }
        bytes.extend_from_slice(&b)
    }
    serde_json::from_slice(&bytes).map_err(|_| "account_response_invalid".into())
}
#[tauri::command]
pub async fn desktop_account_start(
    window: WebviewWindow,
    state: State<'_, ManagedAccountState>,
) -> Result<Value, String> {
    main_only(&window)?;
    let mut flow = state.0.lock().await;
    if flow.is_some() {
        return Err("account_connection_in_progress".into());
    }
    let origin = origin()?;
    let verifier = secret()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "account_client_unavailable")?;
    let result=post(&client,origin.join("api/account/device/start").map_err(|_|"account_origin_invalid")?,json!({"name":format!("XHarness ({})",std::env::consts::OS),"verifier_hash":format!("{:x}",Sha256::digest(verifier.as_bytes()))})).await?;
    let device = text(&result, "deviceCode")?;
    let code = text(&result, "userCode")?;
    let verification = text(&result, "verificationUri")?;
    if device.len() != 43
        || !device
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || code.len() != 12
        || !code.bytes().all(|b| b.is_ascii_hexdigit())
        || verification
            != origin
                .join("account")
                .map_err(|_| "account_origin_invalid")?
                .as_str()
    {
        return Err("account_response_invalid".into());
    }
    *flow = Some(Flow {
        client,
        origin,
        device,
        verifier,
        next: Instant::now() + Duration::from_secs(5),
        expires: Instant::now() + Duration::from_secs(300),
        result: None,
        code: code.clone(),
    });
    Ok(json!({"userCode":code,"verificationUri":verification}))
}
fn validate_access(v: &Value, origin: &Url) -> Result<(), String> {
    let token = text(v, "accessToken")?;
    let base = text(v, "baseURL")?;
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || base
            != origin
                .join("api/inference/v1")
                .map_err(|_| "account_origin_invalid")?
                .as_str()
    {
        return Err("account_response_invalid".into());
    }
    let models = v
        .get("models")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= 16)
        .ok_or("account_response_invalid")?;
    let mut ids = std::collections::HashSet::new();
    for m in models {
        let id = text(m, "id")?;
        let ctx = m
            .get("contextWindow")
            .and_then(Value::as_u64)
            .ok_or("account_response_invalid")?;
        let max = m
            .get("maxTokens")
            .and_then(Value::as_u64)
            .ok_or("account_response_invalid")?;
        if id.is_empty()
            || id.len() > 100
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
            || !ids.insert(id)
            || max == 0
            || max >= ctx
            || ctx > 10_000_000
        {
            return Err("account_response_invalid".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_account_status(
    window: WebviewWindow,
    state: State<'_, ManagedAccountState>,
) -> Result<Value, String> {
    main_only(&window)?;
    let state = state.0.lock().await;
    Ok(match state.as_ref() {
        Some(f) => {
            json!({"userCode":f.code,"verificationUri":f.origin.join("account").map_err(|_|"account_origin_invalid")?.as_str()})
        }
        None => json!({}),
    })
}
#[tauri::command]
pub async fn desktop_account_open(window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    window
        .shell()
        .open(
            origin()?
                .join("account")
                .map_err(|_| "account_origin_invalid")?
                .as_str(),
            None,
        )
        .map_err(|_| "account_browser_unavailable".into())
}
#[tauri::command]
pub async fn desktop_account_poll(
    window: WebviewWindow,
    state: State<'_, ManagedAccountState>,
) -> Result<Value, String> {
    main_only(&window)?;
    let mut state = state.0.lock().await;
    let f = state.as_mut().ok_or("account_connection_missing")?;
    if let Some(v) = &f.result {
        return Ok(v.clone());
    }
    if Instant::now() > f.expires {
        *state = None;
        return Err("account_connection_expired".into());
    }
    if Instant::now() < f.next {
        return Ok(json!({"status":"pending"}));
    }
    f.next = Instant::now() + Duration::from_secs(5);
    let result = post(
        &f.client,
        f.origin
            .join("api/account/device/poll")
            .map_err(|_| "account_origin_invalid")?,
        json!({"device_code":f.device,"verifier":f.verifier}),
    )
    .await?;
    match result.get("status").and_then(Value::as_str) {
        Some("pending") => Ok(json!({"status":"pending"})),
        Some("authorized") => {
            validate_access(&result, &f.origin)?;
            f.result = Some(result.clone());
            Ok(result)
        }
        _ => Err("account_response_invalid".into()),
    }
}
#[tauri::command]
pub async fn desktop_account_finish(
    window: WebviewWindow,
    state: State<'_, ManagedAccountState>,
    saved: bool,
) -> Result<(), String> {
    main_only(&window)?;
    let mut guard = state.0.lock().await;
    let Some(f) = guard.take() else { return Ok(()) };
    if !saved {
        if let Some(v) = f.result {
            let token = text(&v, "accessToken")?;
            let r = f
                .client
                .post(
                    f.origin
                        .join("api/account/device/disconnect")
                        .map_err(|_| "account_origin_invalid")?,
                )
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "account_revocation_pending")?;
            if !r.status().is_success() {
                return Err("account_revocation_pending".into());
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credentials_pointing_at_another_origin() {
        let u = Url::parse("https://engine.xxdevs.com").unwrap();
        let v = json!({"accessToken":"a".repeat(43),"baseURL":"https://evil.invalid/api/inference/v1","models":[{"id":"m","contextWindow":1000,"maxTokens":100}]});
        assert!(validate_access(&v, &u).is_err());
        let mut good = v;
        good["baseURL"] = json!("https://engine.xxdevs.com/api/inference/v1");
        assert!(validate_access(&good, &u).is_ok());
        good["models"][0]["maxTokens"] = json!(1001);
        assert!(validate_access(&good, &u).is_err())
    }
}
