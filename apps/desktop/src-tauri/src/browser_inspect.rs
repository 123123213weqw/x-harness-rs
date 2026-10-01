//! Trusted native observation seam. Only the main UI may request observations;
//! guest pages receive no Host, updater or observation IPC grant. Observation
//! does not change page inputs; its bounded refs can arm one separate DOM action.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::{collections::HashSet, sync::Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{State, Webview};
use tokio::sync::{oneshot, Mutex};

use crate::browser::{ensure_main, BrowserState};

pub(super) const SCRIPT: &str = include_str!("browser_observe.js");
pub(super) const MAX_CALLBACK_BYTES: usize = 32 * 1024;
const MAX_OBSERVATION_BYTES: usize = 8 * 1024;
pub(super) const TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Page,
    Main,
    Dialog,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InspectRequest {
    #[serde(default)]
    scope: Scope,
    #[serde(default)]
    text_offset: usize,
    #[serde(default)]
    node_offset: usize,
    #[serde(default)]
    option_offset: usize,
}

impl InspectRequest {
    fn validate(&self) -> Result<(), String> {
        if self.text_offset > 1_000_000
            || self.node_offset > 1_000_000
            || self.option_offset > 1_000_000
        {
            return Err("observation offset exceeds inspection limits".into());
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct Inspector {
    pub(super) gate: Mutex<()>,
    pub(super) navigation_epoch: AtomicU64,
    latest: StdMutex<Option<Frame>>,
}

struct Frame {
    id: String,
    epoch: u64,
    refs: HashSet<String>,
}

impl Inspector {
    pub(super) fn invalidate(&self) {
        self.navigation_epoch.fetch_add(1, Ordering::SeqCst);
    }

    fn remember(&self, snapshot: &Value, epoch: u64) -> Result<(), String> {
        let frame = Frame {
            id: snapshot["frame_id"].as_str().ok_or("missing frame")?.into(),
            epoch,
            refs: snapshot["nodes"]
                .as_array()
                .ok_or("missing nodes")?
                .iter()
                .filter_map(|node| node["ref"].as_str().map(str::to_owned))
                .collect(),
        };
        *self
            .latest
            .lock()
            .map_err(|_| "browser frame unavailable")? = Some(frame);
        Ok(())
    }

    fn forget(&self) -> Result<(), String> {
        *self
            .latest
            .lock()
            .map_err(|_| "browser frame unavailable")? = None;
        Ok(())
    }

    /// Consume before scheduling an effect. Even a lost/late callback cannot
    /// authorize the same action again; a new observation is required.
    pub(super) fn claim(&self, id: &str, reference: Option<&str>) -> Result<(), String> {
        let mut latest = self
            .latest
            .lock()
            .map_err(|_| "browser frame unavailable")?;
        let frame = latest.as_ref().ok_or("stale_frame: observe again")?;
        if frame.id != id || frame.epoch != self.navigation_epoch.load(Ordering::SeqCst) {
            return Err("stale_frame: observe again".into());
        }
        if reference.is_some_and(|reference| !frame.refs.contains(reference)) {
            return Err("stale_ref: observe again".into());
        }
        *latest = None;
        Ok(())
    }
}

fn frame_id() -> Result<String, String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "observation entropy unavailable")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn script(request: &InspectRequest, frame: &str) -> Result<String, String> {
    request.validate()?;
    let mut arguments = serde_json::to_value(request).map_err(|error| error.to_string())?;
    arguments["frame_id"] = Value::String(frame.to_owned());
    Ok(format!("({SCRIPT})({arguments})"))
}

pub(super) fn decode_callback(raw: &str) -> Result<Value, String> {
    if raw.len() > MAX_CALLBACK_BYTES {
        return Err("native observation callback is too large".into());
    }
    // Tauri's native callback JSON-serializes the returned JS string. It is not
    // a guest-origin network callback and never accepts a page-supplied command.
    let serialized: String =
        serde_json::from_str(raw).map_err(|_| "invalid native observation callback".to_owned())?;
    if serialized.len() > MAX_OBSERVATION_BYTES {
        return Err("native observation is too large".into());
    }
    serde_json::from_str(&serialized).map_err(|_| "invalid guest-page evidence".to_owned())
}

fn decode(raw: &str, frame: &str) -> Result<Value, String> {
    let snapshot = decode_callback(raw)?;
    if snapshot.get("error").is_some() {
        return Err("guest-page observation unavailable; re-observe page scope".into());
    }
    if snapshot.get("frame_id").and_then(Value::as_str) != Some(frame)
        || !snapshot.get("nodes").is_some_and(Value::is_array)
        || !snapshot.get("text").is_some_and(Value::is_string)
    {
        return Err("invalid guest-page observation contract".into());
    }
    Ok(snapshot)
}

pub(super) async fn evaluate(target: &Webview, script: String) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    let sender = StdMutex::new(Some(sender));
    target
        .eval_with_callback(script, move |raw| {
            if let Ok(mut slot) = sender.lock() {
                if let Some(sender) = slot.take() {
                    let reply = if raw.len() <= MAX_CALLBACK_BYTES {
                        Ok(raw)
                    } else {
                        Err("native callback is too large".to_owned())
                    };
                    // Late callbacks cannot resolve another operation.
                    let _ = sender.send(reply);
                }
            }
        })
        .map_err(|_| "native evaluation could not be scheduled")?;
    tokio::time::timeout(TIMEOUT, receiver)
        .await
        .map_err(|_| "native evaluation timed out")?
        .map_err(|_| "native callback unavailable")?
}

#[tauri::command]
pub async fn desktop_browser_inspect(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    request: InspectRequest,
) -> Result<Value, String> {
    ensure_main(&caller)?;
    request.validate()?;
    let (target, inspector) = state.inspection_target(&tab_id)?;
    let _gate = tokio::time::timeout(TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "native observation is busy")?;
    // Selection/close can change while waiting for the per-tab gate.
    let (current, current_inspector) = state.inspection_target(&tab_id)?;
    if current.label() != target.label() || !Arc::ptr_eq(&inspector, &current_inspector) {
        return Err("browser tab changed before inspection".into());
    }
    let frame = frame_id()?;
    inspector.forget()?;
    let navigation_epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    let raw = evaluate(&target, script(&request, &frame)?).await?;
    let (current, current_inspector) = state.inspection_target(&tab_id)?;
    if current.label() != target.label() || !Arc::ptr_eq(&inspector, &current_inspector) {
        return Err("browser tab changed during inspection".into());
    }
    if inspector.navigation_epoch.load(Ordering::SeqCst) != navigation_epoch {
        return Err("browser navigation changed during inspection; observe again".into());
    }
    let mut snapshot = decode(&raw, &frame)?;
    snapshot["source"] = json!({
        "engine": "tauri-webview", "untrusted": true,
        "tab_id": tab_id,
        "native_origin": target.url().map_err(|_| "browser URL unavailable")?.origin().ascii_serialization(),
        "capabilities": ["observe", "click", "fill", "select", "scroll"],
        "interaction": "dom-script; not native pointer/keyboard input",
    });
    if serde_json::to_vec(&snapshot)
        .map_err(|_| "invalid observation")?
        .len()
        > MAX_OBSERVATION_BYTES
    {
        return Err("native observation exceeds output budget".into());
    }
    inspector.remember(&snapshot, navigation_epoch)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_has_no_arbitrary_script_selector_or_negative_offsets() {
        for request in [
            json!({"script": "alert(1)"}),
            json!({"scope": "arbitrary css"}),
            json!({"text_offset": -1}),
        ] {
            assert!(serde_json::from_value::<InspectRequest>(request).is_err());
        }
        assert!(script(&InspectRequest::default(), "frame").is_ok());
        assert!(InspectRequest {
            node_offset: 1_000_001,
            ..Default::default()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn native_callback_is_correlated_bounded_and_not_a_command_channel() {
        let valid = json!({"frame_id": "frame", "nodes": [], "text": "untrusted page"});
        let raw = serde_json::to_string(&valid.to_string()).unwrap();
        assert!(decode(&raw, "frame").is_ok());
        assert!(decode(&raw, "different-frame").is_err());
        assert!(decode(&valid.to_string(), "frame").is_err());
        assert!(decode(&"x".repeat(MAX_CALLBACK_BYTES + 1), "frame").is_err());
        let error = serde_json::to_string(&json!({"error": "guest error"}).to_string()).unwrap();
        assert!(decode(&error, "frame").is_err());
    }

    #[test]
    fn navigation_invalidates_even_same_url_document_reloads() {
        let inspector = Inspector::default();
        let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
        inspector.invalidate();
        assert_ne!(inspector.navigation_epoch.load(Ordering::SeqCst), epoch);
    }

    #[test]
    fn a_frame_authorizes_at_most_one_effect_and_only_observed_refs() {
        let inspector = Inspector::default();
        let snapshot = json!({"frame_id":"frame", "nodes":[{"ref":"n0"}]});
        inspector.remember(&snapshot, 0).unwrap();
        assert!(inspector.claim("other", Some("n0")).is_err());
        assert!(inspector.claim("frame", Some("n1")).is_err());
        assert!(inspector.claim("frame", Some("n0")).is_ok());
        assert!(inspector.claim("frame", Some("n0")).is_err());
        inspector.remember(&snapshot, 0).unwrap();
        inspector.invalidate();
        assert!(inspector.claim("frame", None).is_err());
    }
}
