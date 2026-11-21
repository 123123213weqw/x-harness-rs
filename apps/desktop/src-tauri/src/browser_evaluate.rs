//! Unrestricted page-world JavaScript, scoped to the native chat/tab binding.
//! A timeout stops waiting, not page effects; uncertain calls are never replayed.
#![forbid(unsafe_code)]

use serde_json::{json, Value};
use std::{sync::atomic::Ordering, sync::Arc, time::Duration};
use tauri::Webview;

use super::{authorize, evaluate, frame_id, Inspector, TIMEOUT};
use crate::browser::BrowserState;

use xharness_browser::execution::{decode, poll_script, unknown, Request};

fn verify(
    state: &BrowserState,
    tab: &str,
    target: &Webview,
    inspector: &Arc<Inspector>,
    owner: &str,
    epoch: u64,
) -> Result<(), String> {
    let (current, other) = state.inspection_target(tab)?;
    if current.label() != target.label()
        || !Arc::ptr_eq(inspector, &other)
        || inspector.navigation_epoch.load(Ordering::SeqCst) != epoch
    {
        return Err("browser tab/navigation changed during JavaScript execution".into());
    }
    authorize(target, inspector, Some(owner), true)
}

pub(crate) async fn execute(
    state: &BrowserState,
    tab: &str,
    owner: &str,
    arguments: Value,
) -> Result<Value, String> {
    // Err is reserved for a provably unstarted operation.
    let request = Request::parse(arguments)?;
    let (target, inspector) = state.inspection_target(tab)?;
    let _gate = tokio::time::timeout(TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "browser JavaScript is busy")?;
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    verify(state, tab, &target, &inspector, owner, epoch)?;
    let id = frame_id()?;
    inspector.forget()?;
    inspector.responses.clear();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms + 1500);
    let result = async {
        let started = decode(&evaluate(&target, request.script(&id)).await?, &id)?;
        if started["state"] != "started" {
            return Err("invalid JavaScript start callback".to_owned());
        }
        loop {
            verify(state, tab, &target, &inspector, owner, epoch)?;
            let result = decode(&evaluate(&target, poll_script(&id)).await?, &id)?;
            verify(state, tab, &target, &inspector, owner, epoch)?;
            match result["state"].as_str() {
                Some("finished") => return Ok(result),
                Some("pending") => tokio::time::sleep(Duration::from_millis(25)).await,
                _ => return Err("JavaScript execution state is unavailable".into()),
            }
        }
    };
    let mut receipt = match tokio::time::timeout_at(deadline, result).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => unknown(&error),
        Err(_) => unknown("Native JavaScript wait timed out; code may still be running"),
    };
    receipt["source"] = json!({"engine":"tauri-webview","untrusted":true,"tab_id":tab});
    Ok(receipt)
}
