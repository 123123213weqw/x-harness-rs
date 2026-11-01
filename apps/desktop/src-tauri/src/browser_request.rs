//! Authenticated requests stay in the desktop, never in Host/model credentials.
//! No renderer command: only the authenticated, session-bound private bridge.
#![forbid(unsafe_code)]

#[path = "browser_request/data.rs"]
mod data;
#[cfg(test)]
#[path = "browser_request/tests.rs"]
mod tests;

use std::{sync::atomic::Ordering, sync::Arc, time::Duration};

use serde_json::Value;
use tauri::Webview;

use crate::{browser::BrowserState, browser_inspect::Inspector};
pub(super) use data::Responses;
use data::{Request, Response};

const TIMEOUT: Duration = Duration::from_secs(10);

/// Rechecked after every await and while the transport is pending. Navigation,
/// hide/close, owner changes and revoke invalidate both delivery and cached reads.
fn authorize(
    state: &BrowserState,
    view: &Webview,
    inspector: &Arc<Inspector>,
    owner: &str,
    epoch: u64,
    action: bool,
) -> Result<url::Url, String> {
    state.native_dispatch_target(view.label(), inspector)?;
    if inspector.navigation_epoch.load(Ordering::SeqCst) != epoch {
        return Err("browser binding changed during request".into());
    }
    crate::browser_inspect::authorize(view, inspector, Some(owner), action)?;
    view.url().map_err(|_| "browser URL unavailable".into())
}

pub(super) async fn request(
    state: &BrowserState,
    tab: &str,
    owner: &str,
    arguments: Value,
) -> Result<Value, String> {
    let request: Request = serde_json::from_value(arguments)
        .map_err(|_| "invalid browser request; no headers, credentials or tab override allowed")?;
    state.loaded_receipt(owner, tab)?;
    let (view, inspector) = state.inspection_target(tab)?;
    let _gate = tokio::time::timeout(TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "native browser busy")?;
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    let page = authorize(state, &view, &inspector, owner, epoch, request.action())?;
    let url = request.validate(&page)?;
    inspector.responses.clear();
    let transport = async {
        let cookies = crate::browser_login::read(&view, url.clone()).await?;
        authorize(state, &view, &inspector, owner, epoch, request.action())?;
        let (response, updates) = send(&url, &request, cookies).await?;
        authorize(state, &view, &inspector, owner, epoch, request.action())?;
        crate::browser_login::apply(&view, updates).await?;
        authorize(state, &view, &inspector, owner, epoch, request.action())?;
        inspector.responses.insert(owner, epoch, response)
    };
    let changed = async {
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            authorize(state, &view, &inspector, owner, epoch, request.action())?;
        }
        #[allow(unreachable_code)]
        Ok::<(), String>(())
    };
    tokio::select! {
        biased;
        changed = changed => Err(changed.err().unwrap_or_else(|| "browser binding changed".into())),
        result = tokio::time::timeout(TIMEOUT, transport) => result.map_err(|_| "browser request timed out; effect unknown; do not replay automatically")?,
    }
}

pub(super) async fn read_response(
    state: &BrowserState,
    tab: &str,
    owner: &str,
    arguments: Value,
) -> Result<Value, String> {
    let read: data::Read =
        serde_json::from_value(arguments).map_err(|_| "invalid browser response read")?;
    let (view, inspector) = state.inspection_target(tab)?;
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    authorize(state, &view, &inspector, owner, epoch, false)?;
    inspector.responses.read(owner, epoch, read)
}

async fn send(
    url: &url::Url,
    request: &Request,
    cookies: Vec<tauri::webview::Cookie<'static>>,
) -> Result<(Response, Vec<tauri::webview::Cookie<'static>>), String> {
    let (header, mut secrets) = data::cookie_header(cookies, url)?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .timeout(TIMEOUT)
        .build()
        .map_err(|_| "browser request transport unavailable")?;
    let mut builder = client.request(request.method(), url.clone()).header(
        reqwest::header::ACCEPT,
        "application/json, text/plain, text/html",
    );
    if !header.is_empty() {
        let mut header = reqwest::header::HeaderValue::from_str(&header)
            .map_err(|_| "native login state cannot be used for HTTP")?;
        header.set_sensitive(true);
        builder = builder.header(reqwest::header::COOKIE, header);
    }
    if let Some(body) = &request.json_body {
        builder = builder.json(body);
    }
    // Never return reqwest's error text (may include URL/query/header details).
    let mut reply = builder
        .send()
        .await
        .map_err(|_| "browser request failed; effect unknown; inspect before retrying")?;
    let status = reply.status().as_u16();
    // Only a fixed normalized media type crosses the bridge. In particular,
    // Cookie, Set-Cookie, Authorization and Location are not output fields.
    let format = data::media_type(reply.headers().get(reqwest::header::CONTENT_TYPE));
    let mut updates = Vec::new();
    if reply
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .count()
        > 32
    {
        return Err("browser response exceeds cookie update budget; do not replay writes".into());
    }
    for header in reply.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(raw) = header.to_str() {
            if let Ok(cookie) = tauri::webview::Cookie::parse(raw.to_owned()) {
                secrets.push(cookie.value().to_owned());
                if let Some(cookie) = data::cookie_update(cookie, url) {
                    updates.push(cookie);
                }
            }
        }
    }
    if request.method() != reqwest::Method::HEAD
        && reply
            .content_length()
            .is_some_and(|length| length > data::MAX_BODY as u64)
    {
        return Err("browser response exceeds 1 MiB; use the page or a narrower endpoint; do not replay writes".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reply
        .chunk()
        .await
        .map_err(|_| "browser response interrupted; effect unknown; do not replay automatically")?
    {
        if bytes.len().saturating_add(chunk.len()) > data::MAX_BODY {
            return Err("browser response exceeds 1 MiB; use the page or a narrower endpoint; do not replay writes".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "browser response is not UTF-8 text")?;
    let text = data::sanitize(&body, secrets)?;
    Ok((
        Response {
            status,
            format,
            text,
        },
        updates,
    ))
}
