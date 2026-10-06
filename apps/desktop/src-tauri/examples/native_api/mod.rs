//! Test-only public native API prototypes. No production permissions or tool
//! flags are changed by a successful prototype. Never use on the user's display.
use std::time::Duration;
use tauri::Webview;
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

pub async fn click(view: &Webview, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x > 2000.0 || y > 2000.0 {
        return Err("invalid probe point".into());
    }
    for pressed in [true, false] {
        let (tx, rx) = oneshot::channel();
        view.with_webview(move |view| platform::button(view, x, y, pressed, tx))
            .map_err(|_| "native probe dispatch failed")?;
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|_| "native input callback timed out")?
            .map_err(|_| "native input callback closed")??;
    }
    Ok(())
}

pub async fn key_z(view: &Webview) -> Result<(), String> {
    for pressed in [true, false] {
        let (tx, rx) = oneshot::channel();
        view.with_webview(move |view| platform::key_z(view, pressed, tx))
            .map_err(|_| "native key dispatch failed")?;
        tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .map_err(|_| "native key callback timed out")?
            .map_err(|_| "native key callback closed")??;
    }
    Ok(())
}

pub async fn snapshot(view: &Webview) -> Result<Vec<u8>, String> {
    let (tx, rx) = oneshot::channel();
    view.with_webview(move |view| platform::snapshot(view, tx))
        .map_err(|_| "native snapshot dispatch failed")?;
    let bytes = tokio::time::timeout(Duration::from_secs(8), rx)
        .await
        .map_err(|_| "native snapshot callback timed out")?
        .map_err(|_| "native snapshot callback closed")??;
    if bytes.len() > 8 * 1024 * 1024 || bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("invalid or oversized native PNG".into());
    }
    Ok(bytes)
}
