//! Unrestricted page-world JavaScript, scoped to the native chat/tab binding.
//! A timeout stops waiting, not page effects; uncertain calls are never replayed.
#![forbid(unsafe_code)]

use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::atomic::Ordering, sync::Arc, time::Duration};
use tauri::Webview;

use super::{authorize, decode_callback, evaluate, frame_id, Inspector, TIMEOUT};
use crate::browser::BrowserState;

const RUNTIME: &str = include_str!("browser_evaluate.js");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    code: String,
    #[serde(default)]
    args: Value,
    #[serde(default = "default_timeout")]
    pub(crate) timeout_ms: u64,
}
fn default_timeout() -> u64 {
    5000
}

impl Request {
    pub(crate) fn parse(value: Value) -> Result<Self, String> {
        let request: Self =
            serde_json::from_value(value).map_err(|_| "invalid JavaScript arguments")?;
        if request.code.trim().is_empty()
            || request.code.len() > 12000
            || !(1..=10000).contains(&request.timeout_ms)
        {
            return Err(
                "JavaScript requires 1..12000 UTF-8 bytes of code and timeout_ms=1..10000".into(),
            );
        }
        Ok(request)
    }
    pub(crate) fn script(&self, id: &str) -> String {
        let options = json!({"id":id,"timeout_ms":self.timeout_ms,"args":self.args});
        format!(
            "({RUNTIME})({options},async function(args){{\n{}\n}})",
            self.code
        )
    }
}

pub(crate) fn poll_script(id: &str) -> String {
    let id = json!(id);
    format!("(()=>{{const s=globalThis[Symbol.for('xharness.browser.executions')];const e=s?.[{id}];if(!e)return JSON.stringify({{id:{id},state:'missing'}});if(!e.done)return JSON.stringify({{id:{id},state:'pending'}});delete s[{id}];return e.result;}})()")
}

pub(crate) fn decode(raw: &str, id: &str) -> Result<Value, String> {
    let result = decode_callback(raw)?;
    if result["id"].as_str() != Some(id) {
        return Err("JavaScript callback belongs to another execution".into());
    }
    Ok(result)
}

pub(crate) fn unknown(message: &str) -> Value {
    json!({"ok":false,"effect":"unknown","status":"interrupted","message":message,"retry":"Do not replay automatically; inspect actual page state. Pending script effects are not rolled back."})
}

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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scripts_are_not_filtered_but_targets_and_limits_are_fixed() {
        for code in [
            "return document.cookie",
            "return await fetch('/api',{method:'POST'})",
            "window.changed=true; console.log('ok'); return 42",
        ] {
            let request = Request::parse(json!({"code":code})).unwrap();
            assert!(request.script("nonce").contains(code));
        }
        for args in [
            json!({"code":""}),
            json!({"code":"return 1","owner":"other"}),
            json!({"code":"return 1","tab_id":"main"}),
            json!({"code":"return 1","timeout_ms":10001}),
            json!({"code":"x".repeat(12001)}),
        ] {
            assert!(Request::parse(args).is_err());
        }
    }
    #[test]
    fn callbacks_are_correlated_and_uncertain_effects_are_explicit() {
        let raw =
            serde_json::to_string(&json!({"id":"a","state":"finished","ok":true}).to_string())
                .unwrap();
        assert!(decode(&raw, "a").is_ok());
        assert!(decode(&raw, "b").is_err());
        assert_eq!(unknown("lost")["effect"], "unknown");
        assert_eq!(unknown("lost")["ok"], false);
    }
}
