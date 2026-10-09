//! Native device authorization only. Wallets/billing remain in the account service;
//! credentials are handed only to the trusted main UI's existing keyring writer.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State, WebviewWindow};
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
    callback_state: String,
    authorization_code: Option<String>,
}
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("account_access_denied".into())
    }
}
// Dedicated account edge; the download site on 443 is not an account backend.
const DEFAULT_ACCOUNT_ORIGIN: &str = "https://engine.xxdevs.com:8443";
fn origin() -> Result<Url, String> {
    let raw = option_env!("XHARNESS_ACCOUNT_ORIGIN").unwrap_or(DEFAULT_ACCOUNT_ORIGIN);
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
    let callback_state = secret()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "account_client_unavailable")?;
    let result=post(&client,origin.join("api/account/device/start").map_err(|_|"account_origin_invalid")?,json!({"name":format!("XHarness ({})",std::env::consts::OS),"code_challenge":URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),"code_challenge_method":"S256","callback_state":callback_state})).await?;
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
        callback_state,
        authorization_code: None,
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
pub async fn desktop_account_open(
    window: WebviewWindow,
    state: State<'_, ManagedAccountState>,
) -> Result<(), String> {
    main_only(&window)?;
    let guard = state.0.lock().await;
    let f = guard
        .as_ref()
        .filter(|f| Instant::now() <= f.expires)
        .ok_or("account_connection_expired")?;
    let mut u = f
        .origin
        .join("account")
        .map_err(|_| "account_origin_invalid")?;
    u.query_pairs_mut().append_pair("connect", &f.code);
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    window
        .shell()
        .open(u.as_str(), None)
        .map_err(|_| "account_browser_unavailable".into())
}
/// The OS URL is never trusted to provide credentials or a server origin.
async fn receive_callback(app: tauri::AppHandle, raw: String) {
    let store = app.state::<ManagedAccountState>();
    let mut guard = store.0.lock().await;
    let Some(f) = guard.as_mut() else {
        return;
    }; // cold launch requires a new login
    if !accept_callback(f, &raw) {
        return;
    }
    drop(guard);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Only a wakeup reaches the trusted UI, never code/state/token.
        let _ = window.emit("xharness-account-ready", ());
    }
}
fn accept_callback(f: &mut Flow, raw: &str) -> bool {
    let Some((code, state)) = crate::account_callback::parse(raw) else {
        return false;
    };
    if Instant::now() > f.expires
        || f.callback_state != state
        || f.authorization_code.is_some()
        || f.result.is_some()
    {
        return false;
    }
    f.authorization_code = Some(code);
    f.next = Instant::now();
    true
}
pub fn install_callbacks(app: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    #[cfg(any(target_os = "linux", windows))]
    {
        let _ = app.deep_link().register_all();
    } // user-level; polling if unavailable
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            tauri::async_runtime::spawn(receive_callback(handle.clone(), url.into()));
        }
    });
    // A cold callback cannot authorize without a matching live local proof.
    // No verifier or pending authorization is persisted in plaintext.
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
    let callback = f.authorization_code.take();
    let (path, body) = if let Some(code) = callback {
        (
            "api/account/device/exchange",
            json!({"device_code":f.device,"verifier":f.verifier,"code":code,"state":f.callback_state}),
        )
    } else {
        (
            "api/account/device/poll",
            json!({"device_code":f.device,"verifier":f.verifier}),
        )
    };
    let result = post(
        &f.client,
        f.origin.join(path).map_err(|_| "account_origin_invalid")?,
        body,
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
    let Some(f) = guard.as_ref() else {
        return Ok(());
    };
    if !saved {
        if let Some(v) = &f.result {
            let token = text(v, "accessToken")?;
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
    *guard = None;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_is_bound_to_a_live_initiated_flow() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let expected = secret().unwrap();
        let uri = format!(
            "{}?code={}&state={}",
            crate::account_callback::CALLBACK,
            secret().unwrap(),
            expected
        );
        let mut flow = Flow {
            client: reqwest::Client::new(),
            origin: Url::parse(DEFAULT_ACCOUNT_ORIGIN).unwrap(),
            device: secret().unwrap(),
            verifier: secret().unwrap(),
            next: Instant::now(),
            expires: Instant::now() + Duration::from_secs(300),
            result: None,
            code: "ABCDEF012345".into(),
            callback_state: expected.clone(),
            authorization_code: None,
        };
        assert!(!accept_callback(
            &mut flow,
            &uri.replace(&expected, &secret().unwrap())
        ));
        assert!(accept_callback(&mut flow, &uri));
        assert!(!accept_callback(&mut flow, &uri));
        flow.authorization_code = None;
        flow.expires = Instant::now() - Duration::from_secs(1);
        assert!(!accept_callback(&mut flow, &uri));
        flow.expires = Instant::now() + Duration::from_secs(300);
        flow.result = Some(json!({"status":"authorized"}));
        assert!(!accept_callback(&mut flow, &uri));
    }
    #[test]
    fn rejects_credentials_pointing_at_another_origin() {
        let u = Url::parse(DEFAULT_ACCOUNT_ORIGIN).unwrap();
        let v = json!({"accessToken":"a".repeat(43),"baseURL":"https://evil.invalid/api/inference/v1","models":[{"id":"m","contextWindow":1000,"maxTokens":100}]});
        assert!(validate_access(&v, &u).is_err());
        let mut good = v;
        good["baseURL"] = json!("https://engine.xxdevs.com/api/inference/v1");
        assert!(validate_access(&good, &u).is_err());
        good["baseURL"] = json!("https://engine.xxdevs.com:8443/api/inference/v1");
        assert!(validate_access(&good, &u).is_ok());
        good["models"][0]["maxTokens"] = json!(1001);
        assert!(validate_access(&good, &u).is_err())
    }
}
