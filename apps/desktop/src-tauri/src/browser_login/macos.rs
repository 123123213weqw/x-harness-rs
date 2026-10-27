//! Preserve NSHTTPCookie's raw domain/host-only metadata before cookie::Cookie
//! normalizes it. Wry 0.55 cookies_for_url doesn't correctly filter this store.
use block2::RcBlock;
use objc2_foundation::{NSArray, NSHTTPCookie};
use objc2_web_kit::WKWebView;
use std::{ptr::NonNull, sync::Mutex};
use tauri::webview::{Cookie, PlatformWebview};
use tokio::sync::oneshot::Sender;
use url::Url;

pub(super) fn read(
    handle: PlatformWebview,
    url: Url,
    reply: Sender<Result<Vec<Cookie<'static>>, String>>,
    permit: tokio::sync::SemaphorePermit<'static>,
) {
    let ptr = handle.inner().cast::<WKWebView>();
    if ptr.is_null() {
        let _ = reply.send(Err("WKWebView unavailable".into()));
        return;
    }
    // SAFETY: Tauri supplies a live WKWebView on its owning main thread. No
    // native pointer crosses this closure; the OS retains its completion block.
    let view = unsafe { &*ptr };
    if reply.is_closed() {
        return;
    }
    let reply = Mutex::new(Some((reply, permit)));
    let callback = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
        let Ok(mut slot) = reply.lock() else { return };
        let Some((reply, _permit)) = slot.take() else {
            return;
        };
        if reply.is_closed() {
            return;
        }
        // SAFETY: WKHTTPCookieStore promises a non-null NSArray for the duration
        // of this main-thread completion. Only owned Rust strings leave it.
        let cookies = unsafe { cookies.as_ref() };
        let mut selected = Vec::new();
        for cookie in cookies.iter() {
            let domain = cookie.domain().to_string();
            let path = cookie.path().to_string();
            let expires = cookie
                .expiresDate()
                .map(|date| date.timeIntervalSince1970());
            if !super::matches_scope(&domain, &path, cookie.isSecure(), expires, &url) {
                continue;
            }
            let mut selected_cookie =
                Cookie::new(cookie.name().to_string(), cookie.value().to_string());
            selected_cookie.set_domain(url.host_str().unwrap_or_default().to_owned());
            selected_cookie.set_path(path);
            selected_cookie.set_secure(cookie.isSecure());
            selected_cookie.set_http_only(cookie.isHTTPOnly());
            if selected.len() == 256 {
                let _ = reply.send(Err("native login state exceeds cookie count budget".into()));
                return;
            }
            selected.push(selected_cookie);
        }
        let _ = reply.send(Ok(selected));
    });
    // SAFETY: fixed public selectors on the owned main-thread WKWebView/store.
    // The callback reads only cookies; it neither runs guest JS nor exports them.
    unsafe {
        view.configuration()
            .websiteDataStore()
            .httpCookieStore()
            .getAllCookies(&callback);
    }
}
