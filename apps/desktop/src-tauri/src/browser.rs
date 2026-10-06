//! Native, unprivileged child WebViews for the desktop workspace browser.
//! Only the `main` WebView has a Tauri capability; visited pages never inherit
//! its IPC permissions, even though they share the same native window.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl,
};
use url::Url;

const MAX_LIVE_WEBVIEWS: usize = 16;
const MAX_TAB_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl BrowserBounds {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width >= 1.0
            && self.height >= 1.0
            && self.width <= 10000.0
            && self.height <= 10000.0
    }

    fn rect(self) -> tauri::Rect {
        tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(self.x, self.y)),
            size: tauri::Size::Logical(LogicalSize::new(self.width, self.height)),
        }
    }
}

#[derive(Default)]
struct BrowserInner {
    tabs: HashMap<String, BrowserTab>,
    active: Option<String>,
    bounds: Option<BrowserBounds>,
    next_label: u64,
    clock: u64,
}

struct BrowserTab {
    webview: Webview,
    last_used: u64,
    inspector: Arc<crate::browser_inspect::Inspector>,
    loaded: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct BrowserState(Mutex<BrowserInner>);

impl BrowserState {
    pub(super) fn inspection_target(
        &self,
        tab_id: &str,
    ) -> Result<(Webview, Arc<crate::browser_inspect::Inspector>), String> {
        if !valid_tab_id(tab_id) {
            return Err("invalid browser tab".into());
        }
        let inner = self.0.lock().map_err(|_| "browser state unavailable")?;
        if inner.active.as_deref() != Some(tab_id) || inner.bounds.is_none() {
            return Err("only the active, laid-out browser tab can be inspected".into());
        }
        let tab = inner.tabs.get(tab_id).ok_or("browser tab is not open")?;
        Ok((tab.webview.clone(), Arc::clone(&tab.inspector)))
    }
    pub(super) fn loaded_receipt(
        &self,
        owner: &str,
        tab_id: &str,
    ) -> Result<serde_json::Value, String> {
        if self.delegated_tab(owner)? != tab_id {
            return Err("browser owner changed".into());
        }
        let inner = self.0.lock().map_err(|_| "browser state unavailable")?;
        let tab = inner.tabs.get(tab_id).ok_or("browser tab closed")?;
        if inner.active.as_deref() != Some(tab_id) || !tab.loaded.load(Ordering::SeqCst) {
            return Err("browser page is not ready".into());
        }
        let url = tab.webview.url().map_err(|_| "browser URL unavailable")?;
        if !tab.inspector.delegation.permits(owner, &url, false) {
            return Err("browser binding changed".into());
        }
        Ok(
            serde_json::json!({"ok":true,"effect":"applied","state":"ready","tab_id":tab_id,"url":url.to_string()}),
        )
    }
    pub(super) fn delegated_tab(&self, owner: &str) -> Result<String, String> {
        let inner = self.0.lock().map_err(|_| "browser state unavailable")?;
        let id = inner.active.as_ref().ok_or("native browser is hidden")?;
        let tab = inner.tabs.get(id).ok_or("native browser is not open")?;
        if inner.bounds.is_none()
            || !tab.inspector.delegation.permits(
                owner,
                &tab.webview.url().map_err(|_| "browser URL unavailable")?,
                false,
            )
        {
            return Err("native browser is not delegated to this session".into());
        }
        Ok(id.clone())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvent {
    tab_id: String,
    kind: &'static str,
    value: String,
}

fn emit(app: &AppHandle, tab_id: &str, kind: &'static str, value: impl Into<String>) {
    let _ = app.emit_to(
        "main",
        "xharness-browser-event",
        BrowserEvent {
            tab_id: tab_id.to_owned(),
            kind,
            value: value.into(),
        },
    );
}

#[derive(Serialize)]
pub struct BrowserPageState {
    url: String,
    loaded: bool,
}

/// Frame-agnostic navigation callbacks are hints, never address authority.
/// Only the trusted shell may sample the native top-level location/readiness.
#[tauri::command]
pub async fn desktop_browser_page_state(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserPageState, String> {
    ensure_main(&caller)?;
    let inner = state.0.lock().map_err(|_| "browser state unavailable")?;
    if inner.active.as_deref() != Some(&tab_id) || inner.bounds.is_none() {
        return Err("only the active, laid-out browser tab can be sampled".into());
    }
    let tab = inner.tabs.get(&tab_id).ok_or("browser tab is not open")?;
    Ok(BrowserPageState {
        url: tab
            .webview
            .url()
            .map_err(|_| "browser URL unavailable")?
            .to_string(),
        loaded: tab.loaded.load(Ordering::SeqCst),
    })
}

pub(super) fn ensure_main(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("browser controls are available only to the XHarness UI".into())
    }
}

fn valid_tab_id(tab_id: &str) -> bool {
    !tab_id.is_empty()
        && tab_id.len() <= 64
        && tab_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_'))
}

pub(super) fn web_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 4096 {
        return Err("URL is too long".into());
    }
    let url = Url::parse(raw).map_err(|_| "invalid URL".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("only http and https pages are supported".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in browser URLs are not supported".into());
    }
    Ok(url)
}

fn safe_download_name(url: &Url) -> String {
    let raw = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let name: String = raw
        .chars()
        .take(96)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if name == "." || name == ".." || name.is_empty() {
        "download".into()
    } else {
        name
    }
}

fn tab_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("browser-tabs.json"))
}

fn validate_tab_snapshot(snapshot: &str) -> Result<(), String> {
    if snapshot.len() > MAX_TAB_SNAPSHOT_BYTES {
        return Err("browser tab snapshot is too large".into());
    }
    if !serde_json::from_str::<serde_json::Value>(snapshot)
        .map_err(|error| error.to_string())?
        .is_object()
    {
        return Err("browser tab snapshot must be a JSON object".into());
    }
    Ok(())
}

/// Restore tab metadata from the app's stable config path, not origin-scoped
/// localStorage (the authenticated Host selects a fresh loopback port).
#[tauri::command]
pub async fn desktop_browser_restore(
    app: AppHandle,
    caller: Webview,
) -> Result<Option<String>, String> {
    ensure_main(&caller)?;
    let path = tab_snapshot_path(&app)?;
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_TAB_SNAPSHOT_BYTES as u64 => {
            return Err("browser tab snapshot is too large".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        _ => {}
    }
    let snapshot = match std::fs::read_to_string(path) {
        Ok(snapshot) => snapshot,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    validate_tab_snapshot(&snapshot)?;
    Ok(Some(snapshot))
}

#[tauri::command]
pub async fn desktop_browser_persist(
    app: AppHandle,
    caller: Webview,
    snapshot: String,
) -> Result<(), String> {
    ensure_main(&caller)?;
    validate_tab_snapshot(&snapshot)?;
    let path = tab_snapshot_path(&app)?;
    let parent = path.parent().ok_or("invalid browser tab snapshot path")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temp.write_all(snapshot.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    temp.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

/// Create a tab on first navigation; reuse its native WebView afterwards.
/// This command is async so `add_child` never blocks the UI event thread.
#[tauri::command]
pub async fn desktop_browser_navigate(
    app: AppHandle,
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    ensure_main(&caller)?;
    if !valid_tab_id(&tab_id) {
        return Err("invalid browser tab".into());
    }
    let target = web_url(&url)?;
    // Before a navigation can enter native dispatch, record its admission.
    // Closing/switching the pane after this point must not claim no effect.
    if let Some(lifecycle) = app.try_state::<crate::browser_lifecycle::BrowserLifecycle>() {
        lifecycle.mark_started(&tab_id);
    }
    let mut inner = state.0.lock().map_err(|_| "browser state unavailable")?;
    if inner.tabs.contains_key(&tab_id) {
        inner.clock += 1;
        let clock = inner.clock;
        let tab = inner.tabs.get_mut(&tab_id).expect("tab was present");
        tab.last_used = clock;
        // Explicit UI navigation is a top-level intent. Invalidate before it
        // enters native dispatch, even if the old document is still visible.
        tab.inspector.revoke();
        tab.loaded.store(false, Ordering::SeqCst);
        return tab
            .webview
            .navigate(target)
            .map_err(|error| error.to_string());
    }
    if inner.tabs.len() >= MAX_LIVE_WEBVIEWS {
        // Suspend the least recently used hidden page, not its persisted URL.
        // Selecting that tab later creates a fresh WebView on demand.
        let oldest = inner
            .tabs
            .iter()
            .filter(|(id, _)| inner.active.as_deref() != Some(id.as_str()))
            .min_by_key(|(_, tab)| tab.last_used)
            .map(|(id, _)| id.clone())
            .ok_or("no inactive browser tab can be suspended")?;
        if let Some(tab) = inner.tabs.remove(&oldest) {
            tab.inspector.revoke();
            tab.webview.close().map_err(|error| error.to_string())?;
            emit(&app, &oldest, "suspended", "");
        }
    }
    let bounds = inner.bounds.ok_or("browser pane is not laid out yet")?;
    if !bounds.valid() {
        return Err("invalid browser pane bounds".into());
    }
    let window = app.get_window("main").ok_or("main window is unavailable")?;
    let browser_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("browser-webviews");
    std::fs::create_dir_all(&browser_data).map_err(|error| error.to_string())?;
    inner.next_label += 1;
    let label = format!("browser-{}", inner.next_label);
    let event_app = app.clone();
    let event_id = tab_id.clone();
    let title_app = app.clone();
    let title_id = tab_id.clone();
    let load_app = app.clone();
    let load_id = tab_id.clone();
    let popup_app = app.clone();
    let popup_id = tab_id.clone();
    let download_app = app.clone();
    let download_id = tab_id.clone();
    let inspector = Arc::new(crate::browser_inspect::Inspector::default());
    let navigation_inspector = Arc::clone(&inspector);
    let load_inspector = Arc::clone(&inspector);
    let loaded = Arc::new(AtomicBool::new(false));
    let load_ready = Arc::clone(&loaded);
    let builder = WebviewBuilder::new(label, WebviewUrl::External(target))
        .data_directory(browser_data)
        .on_navigation(move |url| {
            if matches!(url.scheme(), "http" | "https") {
                // Wry 0.55 also calls this policy for subframe navigations on
                // WKWebView. It provides no main-frame bit. Do not publish its
                // URL, reset top-level readiness or revoke the page's origin
                // binding here. Still invalidate action refs conservatively.
                navigation_inspector.invalidate();
                // Hash/history navigations need not emit a page-load callback.
                // Ask the UI to sample WebView.url(), never this frame's URL.
                emit(&event_app, &event_id, "navigation-policy", "");
                true
            } else {
                emit(&event_app, &event_id, "blocked-url", url.as_str());
                false
            }
        })
        .on_document_title_changed(move |_, title| {
            emit(&title_app, &title_id, "title", title);
        })
        .on_page_load(move |_, payload| {
            load_ready.store(
                matches!(payload.event(), PageLoadEvent::Finished),
                Ordering::SeqCst,
            );
            let status = match payload.event() {
                PageLoadEvent::Started => {
                    load_inspector.delegation.navigate(payload.url());
                    load_inspector.invalidate();
                    "loading"
                }
                PageLoadEvent::Finished => {
                    load_inspector.delegation.navigate(payload.url());
                    "loaded"
                }
            };
            // Page-load callbacks carry the native top-level URL, unlike the
            // navigation policy. Publish it before readiness so redirects are
            // synchronized before the UI attempts an exact-origin binding.
            emit(&load_app, &load_id, "url", payload.url().as_str());
            emit(&load_app, &load_id, status, payload.url().as_str());
        })
        .on_new_window(move |url, _| {
            if web_url(url.as_str()).is_ok() {
                emit(&popup_app, &popup_id, "popup", url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| match event {
            DownloadEvent::Requested { url, destination } => {
                let Ok(directory) = download_app.path().download_dir() else {
                    emit(
                        &download_app,
                        &download_id,
                        "download-error",
                        "Downloads folder is unavailable",
                    );
                    return false;
                };
                let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
                    return false;
                };
                let name = safe_download_name(&url);
                *destination = directory.join(format!("xh-{}-{name}", now.as_nanos()));
                emit(
                    &download_app,
                    &download_id,
                    "download-start",
                    destination.display().to_string(),
                );
                true
            }
            DownloadEvent::Finished { path, success, .. } => {
                let kind = if success {
                    "download-complete"
                } else {
                    "download-error"
                };
                emit(
                    &download_app,
                    &download_id,
                    kind,
                    path.map(|path| path.display().to_string())
                        .unwrap_or_default(),
                );
                true
            }
            _ => true,
        });
    let child = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| error.to_string())?;
    if inner.active.as_deref() != Some(&tab_id) {
        let _ = child.hide();
    }
    inner.clock += 1;
    let last_used = inner.clock;
    inner.tabs.insert(
        tab_id,
        BrowserTab {
            webview: child,
            last_used,
            inspector,
            loaded,
        },
    );
    Ok(())
}

/// Select a tab. An empty ID hides all child WebViews (settings, modal, etc.).
#[tauri::command]
pub async fn desktop_browser_activate(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: Option<String>,
) -> Result<bool, String> {
    ensure_main(&caller)?;
    if tab_id.as_deref().is_some_and(|id| !valid_tab_id(id)) {
        return Err("invalid browser tab".into());
    }
    let mut inner = state.0.lock().map_err(|_| "browser state unavailable")?;
    if inner.active != tab_id {
        // Hiding and then returning to the same tab must not revive a pending
        // observation or an old action frame.
        for id in [inner.active.as_ref(), tab_id.as_ref()]
            .into_iter()
            .flatten()
        {
            if let Some(tab) = inner.tabs.get(id) {
                tab.inspector.revoke();
            }
        }
    }
    inner.clock += 1;
    let clock = inner.clock;
    inner.active = tab_id;
    let active = inner.active.clone();
    if let Some(id) = active.as_deref() {
        if let Some(tab) = inner.tabs.get_mut(id) {
            tab.last_used = clock;
        }
    }
    for (id, tab) in &inner.tabs {
        let result = if inner.active.as_deref() == Some(id.as_str()) && inner.bounds.is_some() {
            tab.webview.show()
        } else {
            tab.webview.hide()
        };
        result.map_err(|error| error.to_string())?;
    }
    Ok(active.is_some_and(|id| inner.tabs.contains_key(&id)))
}

#[tauri::command]
pub async fn desktop_browser_bounds(
    caller: Webview,
    state: State<'_, BrowserState>,
    bounds: BrowserBounds,
) -> Result<(), String> {
    ensure_main(&caller)?;
    if !bounds.valid() {
        return Err("invalid browser pane bounds".into());
    }
    let mut inner = state.0.lock().map_err(|_| "browser state unavailable")?;
    inner.bounds = Some(bounds);
    if let Some(id) = inner.active.as_deref() {
        if let Some(tab) = inner.tabs.get(id) {
            tab.webview
                .set_bounds(bounds.rect())
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_browser_action(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    action: String,
) -> Result<(), String> {
    ensure_main(&caller)?;
    let inner = state.0.lock().map_err(|_| "browser state unavailable")?;
    let tab = inner.tabs.get(&tab_id).ok_or("browser tab is not open")?;
    match action.as_str() {
        "back" => tab.webview.eval("history.back()"),
        "forward" => tab.webview.eval("history.forward()"),
        "reload" => tab.webview.reload(),
        "stop" => tab.webview.eval("window.stop()"),
        _ => return Err("unknown browser action".into()),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_browser_close(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    ensure_main(&caller)?;
    let mut inner = state.0.lock().map_err(|_| "browser state unavailable")?;
    if inner.active.as_deref() == Some(&tab_id) {
        inner.active = None;
    }
    if let Some(tab) = inner.tabs.remove(&tab_id) {
        tab.inspector.revoke();
        tab.webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn close_all(app: &AppHandle) {
    let Some(state) = app.try_state::<BrowserState>() else {
        return;
    };
    if let Ok(mut inner) = state.0.lock() {
        for (_, tab) in inner.tabs.drain() {
            tab.inspector.revoke();
            let _ = tab.webview.close();
        }
        inner.active = None;
    };
}

#[cfg(test)]
mod tests {
    use super::{safe_download_name, valid_tab_id, validate_tab_snapshot, web_url, BrowserBounds};

    #[test]
    fn only_web_pages_and_safe_tab_ids() {
        assert!(web_url("https://example.com/path").is_ok());
        assert!(web_url("http://localhost:3090/").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "https://u:p@example.com",
        ] {
            assert!(web_url(url).is_err(), "{url}");
        }
        assert!(valid_tab_id("browser:12"));
        assert!(!valid_tab_id("../../main"));
    }

    #[test]
    fn rejects_invalid_bounds() {
        assert!(BrowserBounds {
            x: 10.0,
            y: 10.0,
            width: 500.0,
            height: 300.0
        }
        .valid());
        assert!(!BrowserBounds {
            x: f64::NAN,
            y: 0.0,
            width: 500.0,
            height: 300.0
        }
        .valid());
        assert!(!BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 300.0
        }
        .valid());
    }

    #[test]
    fn download_filename_cannot_escape_download_directory() {
        let url = url::Url::parse("https://example.com/path/evil%2Fname.zip").unwrap();
        assert!(!safe_download_name(&url).contains('/'));
    }

    #[test]
    fn persisted_tabs_require_a_bounded_json_object() {
        assert!(validate_tab_snapshot(r#"{"session":{"items":[]}}"#).is_ok());
        for bad in ["[]", "null", "not json"] {
            assert!(validate_tab_snapshot(bad).is_err());
        }
        assert!(validate_tab_snapshot(&"x".repeat(super::MAX_TAB_SNAPSHOT_BYTES + 1)).is_err());
    }
}
