//! Native store adapter. Secrets never leave this desktop process.
use tauri::{webview::Cookie, Webview};
use url::Url;

static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[cfg(target_os = "macos")]
#[path = "browser_login/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
pub(super) async fn read(view: &Webview, url: Url) -> Result<Vec<Cookie<'static>>, String> {
    let permit = SLOT
        .acquire()
        .await
        .map_err(|_| "native cookie store busy")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |handle| macos::read(handle, url, tx, permit))
        .map_err(|_| "native login state dispatch unavailable")?;
    rx.await
        .map_err(|_| "native login state callback unavailable".into())?
}

#[cfg(not(target_os = "macos"))]
pub(super) async fn read(view: &Webview, url: Url) -> Result<Vec<Cookie<'static>>, String> {
    // WebView2/WebKitGTK filter using the native store's host-only metadata.
    // Native getters can rendezvous with the UI thread: never block an async
    // worker/UI handler. A stuck getter retains the single permit after timeout.
    let permit = SLOT
        .acquire()
        .await
        .map_err(|_| "native cookie store busy")?;
    let target = view.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut cookies = target
            .cookies_for_url(url.clone())
            .map_err(|_| "native login state unavailable")?;
        // Scope was checked by the engine. Normalize transient domain metadata
        // for the HTTP adapter; never change a cookie in the browser store here.
        for cookie in &mut cookies {
            cookie.set_domain(url.host_str().unwrap_or_default().to_owned());
        }
        Ok(cookies)
    })
    .await
    .map_err(|_| "native login state callback failed")?
}

/// Cookie-store setters may rendezvous with the engine too. Bound both getters
/// and setters without blocking the UI/async executor or accumulating abandoned
/// work after timeout. These values never cross the private bridge.
pub(super) async fn apply(view: &Webview, cookies: Vec<Cookie<'static>>) -> Result<(), String> {
    if cookies.is_empty() {
        return Ok(());
    }
    let permit = SLOT
        .acquire()
        .await
        .map_err(|_| "native cookie store busy")?;
    let target = view.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        for cookie in cookies {
            target
                .set_cookie(cookie)
                .map_err(|_| "native login state update unavailable; do not replay request")?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "native login state update callback failed; do not replay request")?
}

#[cfg(any(target_os = "macos", test))]
fn matches_scope(domain: &str, path: &str, secure: bool, expires: Option<f64>, url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let domain_matches = if let Some(domain) = domain.strip_prefix('.') {
        host.eq_ignore_ascii_case(domain)
            || host
                .to_ascii_lowercase()
                .ends_with(&format!(".{}", domain.to_ascii_lowercase()))
    } else {
        host.eq_ignore_ascii_case(domain)
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(f64::MAX);
    domain_matches
        && (url.path() == path
            || (url.path().starts_with(path)
                && (path.ends_with('/') || url.path().as_bytes().get(path.len()) == Some(&b'/'))))
        && (!secure || url.scheme() == "https")
        && expires.is_none_or(|expiry| expiry > now)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_domain_metadata_preserves_host_only_path_secure_and_expiry() {
        let url = Url::parse("https://sub.example.com/api/items").unwrap();
        assert!(matches_scope(".example.com", "/api", true, None, &url));
        for (domain, path, secure, expires) in [
            ("example.com", "/api", false, None),
            (".evilexample.com", "/api", false, None),
            (".example.com", "/apis", false, None),
            (".example.com", "/api", false, Some(0.0)),
        ] {
            assert!(!matches_scope(domain, path, secure, expires, &url));
        }
        assert!(!matches_scope(
            ".example.com",
            "/",
            true,
            None,
            &Url::parse("http://sub.example.com/").unwrap()
        ));
    }
}
