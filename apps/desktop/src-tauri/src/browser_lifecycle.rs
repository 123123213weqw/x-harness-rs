//! Model → UI rendezvous. The UI remains the sole owner of pane geometry and
//! presentation. A receipt is issued only after the native guest is loaded and
//! bound to the requesting chat. Dropping a request cancels its provisional tab.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::sync::oneshot;

pub(crate) const OPEN_TIMEOUT: Duration = Duration::from_secs(30);

use crate::browser::{self, BrowserState};

#[derive(Default)]
pub struct BrowserLifecycle(Mutex<HashMap<String, Pending>>);
struct Pending {
    started: bool,
    close_tab: Option<String>,
    owner: String,
    reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenEvent {
    request_id: String,
    owner: String,
    url: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlRequest {
    Status {},
    Open { url: String },
    Close {},
}
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlReply {
    Ready { tab_id: String },
    Failed {},
    Closed { tab_id: String },
}

pub fn descriptor(state: &BrowserState, owner: &str) -> Value {
    json!({"available":true,"bound":state.delegated_tab(owner).is_ok(),"version":2,
        "engine":"tauri-webview","capabilities":{
            "open":true,"close":true,"observe":true,"dom_actions":true,"browser_input_actions":["click","move","key"],"cross_origin_pointer":true,"global_os_input":false,
            "authenticated_requests":true,"response_read":true,"request_redirects":false,"native_input":true,"cross_origin_frames":false,
            "screenshot":true,"screenshot_scope":"system WebView viewport snapshot; accelerated media may be omitted","recording":false,"hidden_tab_actions":false
        },"constraints":["open requires the requesting chat to be visible; no focus stealing",
            "observe/perform/screenshot/input/request/read_response require a loaded, visible, chat-bound tab",
            "perform uses DOM actions; input uses browser-owned native events, not global OS input",
            "cross-origin iframe pixels/pointer input supported; cross-origin DOM traversal and recording unsupported"]})
}

struct Guard {
    app: AppHandle,
    request_id: String,
    completed: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Some(state) = self.app.try_state::<BrowserLifecycle>() {
            if let Ok(mut pending) = state.0.lock() {
                pending.remove(&self.request_id);
            }
        }
        // Cancel only an unfinished, provisional tab.
        // Only a matching provisional tab is removable by this event.
        let _ = self
            .app
            .emit_to("main", "xharness-browser-control-cancel", &self.request_id);
    }
}

fn interrupted_receipt(started: bool) -> Value {
    json!({"ok":false,"effect":if started {"unknown"} else {"not_started"},
        "message":"browser UI cannot open this page now: select the requesting chat and dismiss overlays before retrying; do not replay an unknown effect automatically"})
}

impl BrowserLifecycle {
    pub(super) fn mark_started(&self, tab_id: &str) {
        if let Some(id) = tab_id.strip_prefix("browser:") {
            if let Ok(mut pending) = self.0.lock() {
                if let Some(call) = pending.get_mut(id) {
                    call.started = true;
                }
            }
        }
    }
    pub async fn open(&self, app: &AppHandle, owner: &str, url: String) -> Result<Value, String> {
        let url = browser::web_url(&url)?.to_string();
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "browser request entropy unavailable")?;
        let request_id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let (reply, receive) = oneshot::channel();
        {
            let mut pending = self.0.lock().map_err(|_| "browser lifecycle unavailable")?;
            if pending.len() >= 4 || pending.values().any(|call| call.owner == owner) {
                return Err("browser open already pending; wait for its receipt".into());
            }
            pending.insert(
                request_id.clone(),
                Pending {
                    started: false,
                    close_tab: None,
                    owner: owner.to_owned(),
                    reply,
                },
            );
        }
        let mut guard = Guard {
            app: app.clone(),
            request_id: request_id.clone(),
            completed: false,
        };
        let _activity = crate::browser_activity::Activity::start(
            owner,
            &format!("browser:{request_id}"),
            crate::browser_activity::Operation::Open,
            |event| {
                let _ = app.emit_to("main", "xharness-browser-activity", event);
            },
        );
        app.emit_to(
            "main",
            "xharness-browser-control-open",
            OpenEvent {
                request_id,
                owner: owner.into(),
                url,
            },
        )
        .map_err(|_| "browser UI unavailable")?;
        let result = tokio::time::timeout(OPEN_TIMEOUT, receive)
            .await
            .map_err(|_| "browser open timed out; provisional tab cancelled")?
            .map_err(|_| "browser open cancelled")?;
        if result.as_ref().is_ok_and(|receipt| receipt["ok"] == true) {
            // Completed tabs are no longer provisional. No late cancel event.
            guard.completed = true;
        }
        result
    }
    /// UI removes exactly the captured tab. A newer selection is not a new
    /// target, and closure is acknowledged only after native destruction.
    pub async fn close(&self, app: &AppHandle, owner: &str) -> Result<Value, String> {
        let tab_id = app.state::<BrowserState>().delegated_tab(owner)?;
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "browser request entropy unavailable")?;
        let request_id: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let (reply, receive) = oneshot::channel();
        {
            let mut pending = self.0.lock().map_err(|_| "browser lifecycle unavailable")?;
            if pending.len() >= 4 || pending.values().any(|call| call.owner == owner) {
                return Err("browser control already pending; wait for its receipt".into());
            }
            pending.insert(
                request_id.clone(),
                Pending {
                    started: true,
                    close_tab: Some(tab_id.clone()),
                    owner: owner.into(),
                    reply,
                },
            );
        }
        let mut guard = Guard {
            app: app.clone(),
            request_id: request_id.clone(),
            completed: false,
        };
        let _activity = crate::browser_activity::Activity::start(
            owner,
            &tab_id,
            crate::browser_activity::Operation::Close,
            |event| {
                let _ = app.emit_to("main", "xharness-browser-activity", event);
            },
        );
        app.emit_to(
            "main",
            "xharness-browser-control-close",
            json!({"requestId":request_id,"owner":owner,"tabId":tab_id}),
        )
        .map_err(|_| "browser UI unavailable")?;
        let result = tokio::time::timeout(Duration::from_secs(10), receive)
            .await
            .map_err(|_| {
                "browser close receipt timed out; effect unknown; check status before retrying"
            })?
            .map_err(|_| "browser close cancelled; effect unknown")?;
        guard.completed = result.as_ref().is_ok_and(|receipt| receipt["ok"] == true);
        result
    }
}

#[tauri::command]
pub async fn desktop_browser_control_reply(
    app: AppHandle,
    caller: Webview,
    state: State<'_, BrowserLifecycle>,
    request_id: String,
    reply: ControlReply,
) -> Result<bool, String> {
    browser::ensure_main(&caller)?;
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "browser lifecycle unavailable")?;
    let Some(call) = pending.get(&request_id) else {
        return Ok(false);
    };
    let ready = matches!(
        reply,
        ControlReply::Ready { .. } | ControlReply::Closed { .. }
    );
    let result = match reply {
        ControlReply::Failed {} => Ok(if call.close_tab.is_some() {
            json!({"ok":false,"effect":"unknown","message":"browser close was not confirmed; check status before retrying"})
        } else {
            interrupted_receipt(call.started)
        }),
        ControlReply::Closed { tab_id } => {
            if call.close_tab.as_deref() != Some(tab_id.as_str()) {
                return Ok(false);
            }
            app.state::<BrowserState>().closed_receipt(&tab_id)
        }
        ControlReply::Ready { tab_id } => {
            if call.close_tab.is_some() || tab_id != format!("browser:{request_id}") {
                return Ok(false);
            }
            app.state::<BrowserState>()
                .loaded_receipt(&call.owner, &tab_id)
        }
    };
    // A forged/premature Ready does not settle the pending request.
    if result.is_err() && ready {
        return Ok(false);
    }
    let call = pending.remove(&request_id).ok_or("browser request ended")?;
    Ok(call.reply.send(result).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_an_admitted_navigation_is_not_reported_as_unstarted() {
        assert_eq!(interrupted_receipt(false)["effect"], "not_started");
        assert_eq!(interrupted_receipt(true)["effect"], "unknown");
    }
    #[test]
    fn lifecycle_contract_rejects_unknown_controls_and_fields() {
        assert!(serde_json::from_value::<ControlRequest>(json!({"action":"close"})).is_ok());
        assert!(serde_json::from_value::<ControlRequest>(
            json!({"action":"open","url":"https://example.com"})
        )
        .is_ok());
        for value in [
            json!({"action":"open","url":"x","owner":"other"}),
            json!({"action":"eval","script":"x"}),
            json!({"action":"close","tab_id":"x"}),
            json!({"action":"close","owner":"other"}),
            json!({"action":"status","tab_id":"x"}),
        ] {
            assert!(serde_json::from_value::<ControlRequest>(value).is_err());
        }
        assert!(serde_json::from_value::<ControlReply>(
            json!({"status":"ready","tab_id":"x","owner":"other"})
        )
        .is_err());
    }
    #[test]
    fn empty_browser_is_discoverable_with_precise_native_capability_limits() {
        let status = descriptor(&BrowserState::default(), "chat");
        assert_eq!(status["available"], true);
        assert_eq!(status["capabilities"]["native_input"], true);
        assert_eq!(status["capabilities"]["close"], true);
        assert_eq!(status["capabilities"]["screenshot"], true);
        assert_eq!(status["bound"], false);
        for capability in [
            "cross_origin_frames",
            "recording",
            "hidden_tab_actions",
            "global_os_input",
        ] {
            assert_eq!(status["capabilities"][capability], false);
        }
    }
}
