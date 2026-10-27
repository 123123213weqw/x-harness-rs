//! Browser-owned native input/snapshots. Never posts global OS input, evaluates
//! caller scripts, or accepts tab/owner overrides. Every dispatch is rechecked
//! on the WebView UI thread; cancelled/expired queued closures do no work.
use crate::{
    browser::BrowserState,
    browser_inspect::{self, Inspector},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::{Manager, Webview};
use tokio::sync::oneshot;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;
const TIMEOUT: Duration = Duration::from_secs(8);
pub const MAX_PNG: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum InputRequest {
    Click {
        frame_id: String,
        x: f64,
        y: f64,
    },
    Move {
        frame_id: String,
        x: f64,
        y: f64,
    },
    Key {
        frame_id: String,
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
    },
}
impl InputRequest {
    pub(super) fn frame(&self) -> &str {
        match self {
            Self::Click { frame_id, .. }
            | Self::Move { frame_id, .. }
            | Self::Key { frame_id, .. } => frame_id,
        }
    }
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.frame().len() != 32 || !self.frame().bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid frame_id".into());
        }
        match self {
            Self::Click { x, y, .. } | Self::Move { x, y, .. }
                if !x.is_finite()
                    || !y.is_finite()
                    || *x < 0.0
                    || *y < 0.0
                    || *x > 8192.0
                    || *y > 8192.0 =>
            {
                Err("invalid CSS viewport point".into())
            }
            Self::Key { key, modifiers, .. } => {
                key_spec(key)?;
                if modifiers.len() > 4
                    || modifiers
                        .iter()
                        .any(|m| !["Shift", "Control", "Alt", "Meta"].contains(&m.as_str()))
                    || modifiers
                        .iter()
                        .enumerate()
                        .any(|(i, m)| modifiers[..i].contains(m))
                {
                    return Err("invalid key modifiers".into());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
// Explicit portable subset, not layout-dependent arbitrary keycode input.
// Text entry stays in DOM fill; native keys cover navigation/shortcuts.
pub(super) struct KeySpec {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub text: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    pub windows: u32,
    #[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
    pub mac: u16,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub gdk: u32,
}
pub(super) fn key_spec(key: &str) -> Result<KeySpec, String> {
    let (text,windows,mac,gdk) = match key {
        "Enter" => ("\r",13,36,0xff0d), "Tab" => ("\t",9,48,0xff09),
        "Escape" => ("\u{1b}",27,53,0xff1b), "Backspace" => ("\u{8}",8,51,0xff08),
        "Delete" => ("\u{f728}",46,117,0xffff), "Space" => (" ",32,49,32),
        "ArrowLeft" => ("\u{f702}",37,123,0xff51), "ArrowRight" => ("\u{f703}",39,124,0xff53),
        "ArrowUp" => ("\u{f700}",38,126,0xff52), "ArrowDown" => ("\u{f701}",40,125,0xff54),
        "Home" => ("\u{f729}",36,115,0xff50), "End" => ("\u{f72b}",35,119,0xff57),
        "PageUp" => ("\u{f72c}",33,116,0xff55), "PageDown" => ("\u{f72d}",34,121,0xff56),
        _ if key.len()==1 && key.as_bytes()[0].is_ascii_lowercase() => {
            let c=key.as_bytes()[0];
            const MAC:[u16;26]=[0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6];
            return Ok(KeySpec{text:key.into(),windows:u32::from(c.to_ascii_uppercase()),mac:MAC[usize::from(c-b'a')],gdk:u32::from(c)});
        }
        _=>return Err("unsupported browser key; use Enter/Tab/Escape/Backspace/Delete/Space, arrows, Home/End/PageUp/PageDown or a-z".into()),
    };
    Ok(KeySpec {
        text: text.into(),
        windows,
        mac,
        gdk,
    })
}

async fn dispatch<T: Send + 'static>(
    view: &Webview,
    inspector: &Arc<Inspector>,
    owner: &str,
    action: bool,
    operation: impl FnOnce(tauri::webview::PlatformWebview, oneshot::Sender<Result<T, String>>)
        + Send
        + 'static,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    let app = view.app_handle().clone();
    let target = view.clone();
    let inspector = Arc::clone(inspector);
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    let owner = owner.to_owned();
    let deadline = Instant::now() + TIMEOUT;
    view.with_webview(move |handle| {
        if tx.is_closed() || Instant::now() >= deadline {
            return;
        }
        let state = app.state::<BrowserState>();
        let valid = state
            .native_dispatch_target(target.label(), &inspector)
            .is_ok()
            && inspector.navigation_epoch.load(Ordering::SeqCst) == epoch;
        if !valid || browser_inspect::authorize(&target, &inspector, Some(&owner), action).is_err()
        {
            let _ = tx.send(Err("browser binding changed before native dispatch".into()));
            return;
        }
        operation(handle, tx);
    })
    .map_err(|_| "native dispatch unavailable")?;
    tokio::time::timeout(TIMEOUT, rx)
        .await
        .map_err(|_| "native callback timed out")?
        .map_err(|_| "native callback closed")?
}

pub async fn layout(view: &Webview, rect: (f64, f64, f64, f64)) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = oneshot::channel();
        view.with_webview(move |handle| {
            if !tx.is_closed() {
                linux::layout(handle, rect, tx);
            }
        })
        .map_err(|_| "native layout dispatch failed")?;
        tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| "native layout timed out")?
            .map_err(|_| "native layout callback closed")?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (view, rect);
        Ok(())
    }
}

/// Query only the owned native content geometry, never the desktop screen.
pub async fn content_inset(view: &Webview) -> Result<f64, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = oneshot::channel();
        view.with_webview(move |handle| {
            let _ = tx.send(macos::content_inset(handle));
        })
        .map_err(|_| "native browser geometry dispatch failed")?;
        tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| "native browser geometry timed out")?
            .map_err(|_| "native browser geometry callback closed")?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = view;
        Ok(0.0)
    }
}

async fn image_size(view: &Webview) -> Result<(u32, u32), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let (tx, rx) = oneshot::channel();
        view.with_webview(move |handle| {
            let view = handle.inner();
            let allocation = view.allocation();
            let result = (|| {
                let scale =
                    u32::try_from(view.scale_factor()).map_err(|_| "invalid native pixel scale")?;
                let width = u32::try_from(allocation.width())
                    .ok()
                    .and_then(|w| w.checked_mul(scale))
                    .ok_or("invalid native pixel width")?;
                let height = u32::try_from(allocation.height())
                    .ok()
                    .and_then(|h| h.checked_mul(scale))
                    .ok_or("invalid native pixel height")?;
                Ok((width, height))
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| "native image geometry dispatch failed")?;
        tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| "native image geometry timed out")?
            .map_err(|_| "native image geometry callback closed")?
            .map_err(str::to_owned)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let size = view.size().map_err(|_| "browser size unavailable")?;
        Ok((size.width, size.height))
    }
}

pub async fn screenshot(state: &BrowserState, tab: &str, owner: &str) -> Result<Value, String> {
    state.loaded_receipt(owner, tab)?;
    let (view, inspector) = state.inspection_target(tab)?;
    let _gate = tokio::time::timeout(TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "native browser busy")?;
    browser_inspect::authorize(&view, &inspector, Some(owner), false)?;
    // GTK allocated_size() includes layout margins, not just image content.
    // Budget the actual native content pixels before asking WebKit to capture.
    let (width, height) = image_size(&view).await?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16 * 1024 * 1024 {
        return Err("browser viewport exceeds snapshot pixel budget".into());
    }
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    inspector.forget()?;
    let viewport = browser_inspect::decode_callback(
        &browser_inspect::evaluate(
            &view,
            "JSON.stringify({width:innerWidth,height:innerHeight})".into(),
        )
        .await?,
    )?;
    state.verify_viewport(tab, &viewport)?;
    let png = dispatch(&view, &inspector, owner, false, platform::snapshot).await?;
    if png.len() < 24 || png.len() > MAX_PNG || &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("invalid or oversized native PNG".into());
    }
    let image_width = u32::from_be_bytes(png[16..20].try_into().map_err(|_| "invalid PNG width")?);
    let image_height =
        u32::from_be_bytes(png[20..24].try_into().map_err(|_| "invalid PNG height")?);
    if image_width == 0
        || image_height == 0
        || u64::from(image_width) * u64::from(image_height) > 16 * 1024 * 1024
    {
        return Err("native PNG exceeds pixel budget".into());
    }
    let (current, other) = state.inspection_target(tab)?;
    if current.label() != view.label()
        || !Arc::ptr_eq(&inspector, &other)
        || inspector.navigation_epoch.load(Ordering::SeqCst) != epoch
    {
        return Err("browser changed during screenshot; observe again".into());
    }
    browser_inspect::authorize(&view, &inspector, Some(owner), false)?;
    let frame = browser_inspect::frame_id()?;
    let snapshot = json!({"frame_id":frame,"nodes":[],"viewport":viewport});
    inspector.remember(&snapshot, epoch)?;
    Ok(
        json!({"frame_id":frame,"viewport":viewport,"image":{"width":image_width,"height":image_height},"coordinate_space":"CSS viewport pixels; use viewport dimensions to map the attached image","source":{"engine":"tauri-webview","untrusted":true,"native_origin":view.url().map_err(|_|"browser URL unavailable")?.origin().ascii_serialization()},"png_base64":base64::engine::general_purpose::STANDARD.encode(png)}),
    )
}

pub async fn input(
    state: &BrowserState,
    tab: &str,
    owner: &str,
    request: InputRequest,
) -> Result<Value, String> {
    request.validate()?;
    state.loaded_receipt(owner, tab)?;
    let (view, inspector) = state.inspection_target(tab)?;
    let _gate = tokio::time::timeout(TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "native browser busy; no input scheduled")?;
    browser_inspect::authorize(&view, &inspector, Some(owner), true)?;
    let (current, other) = state.inspection_target(tab)?;
    if current.label() != view.label() || !Arc::ptr_eq(&inspector, &other) {
        return Err("browser changed; no input scheduled".into());
    }
    let frame = request.frame().to_owned();
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    if let InputRequest::Click { x, y, .. } | InputRequest::Move { x, y, .. } = &request {
        inspector.check_point(&frame, *x, *y)?;
    }
    let viewport = inspector.frame_viewport(&frame)?;
    inspector.claim(&frame, None)?;
    let result = dispatch(&view, &inspector, owner, true, move |handle, reply| {
        platform::input(handle, request, viewport, reply)
    })
    .await;
    let valid = state.inspection_target(tab).is_ok_and(|(current, other)| {
        current.label() == view.label()
            && Arc::ptr_eq(&inspector, &other)
            && inspector.navigation_epoch.load(Ordering::SeqCst) == epoch
    }) && browser_inspect::authorize(&view, &inspector, Some(owner), true).is_ok();
    match result {
        Ok(()) if valid => Ok(
            json!({"ok":true,"effect":"applied","frame_id":frame,"message":"native input dispatched; observe actual state to verify task success"}),
        ),
        _ => Ok(
            json!({"ok":false,"effect":"unknown","frame_id":frame,"message":"native input completion unavailable or browser changed; effect may have occurred; do not replay automatically; observe again"}),
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_is_closed_bounded_and_action_specific() {
        for value in [
            json!({"action":"click","frame_id":"a".repeat(32),"x":1,"y":2,"owner":"other"}),
            json!({"action":"eval","script":"x"}),
            json!({"action":"key","frame_id":"a".repeat(32),"key":"z","x":1}),
        ] {
            assert!(serde_json::from_value::<InputRequest>(value).is_err());
        }
        for value in [
            json!({"action":"click","frame_id":"a".repeat(32),"x":-1,"y":0}),
            json!({"action":"key","frame_id":"a".repeat(32),"key":"z","modifiers":["Meta","Meta"]}),
            json!({"action":"key","frame_id":"a".repeat(32),"key":"arbitrary"}),
        ] {
            assert!(serde_json::from_value::<InputRequest>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert_eq!(key_spec("z").unwrap().mac, 6);
        assert_eq!(key_spec("Enter").unwrap().windows, 13);
    }
}
