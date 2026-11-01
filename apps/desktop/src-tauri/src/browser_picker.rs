//! User-initiated selection only. Guest pages receive no privileged callback.
use crate::{
    browser::{ensure_main, BrowserState},
    browser_inspect,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{State, Webview};
const SCRIPT: &str = include_str!("browser_picker.js");
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum PickRequest {
    Start { owner: String },
    Poll { token: String },
    Cancel { token: String },
}
#[derive(Clone)]
pub(super) struct Lease {
    token: String,
    owner: String,
    epoch: u64,
    deadline: Instant,
}
fn decode(raw: &str) -> Result<Value, String> {
    let text: String = serde_json::from_str(raw).map_err(|_| "invalid picker callback")?;
    if text.len() > 28 * 1024 {
        return Err("selected component evidence is too large".into());
    }
    serde_json::from_str(&text).map_err(|_| "invalid picker evidence".into())
}
fn script(action: &str, token: &str) -> String {
    format!("({SCRIPT})({})", json!({"action":action,"token":token}))
}
fn validate_selection(value: &Value) -> Result<(), String> {
    for key in ["x", "y", "width", "height"] {
        let n = value["bounds"][key]
            .as_f64()
            .ok_or("invalid selection geometry")?;
        if !n.is_finite()
            || n < 0.0
            || n > 16384.0
            || ((key == "width" || key == "height") && n < 1.0)
        {
            return Err("invalid selection geometry".into());
        }
    }
    let elements = value["elements"]
        .as_array()
        .ok_or("missing selected elements")?;
    if elements.is_empty() || elements.len() > 8 || value["untrusted"] != true {
        return Err("invalid component selection".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_browser_pick(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    request: PickRequest,
) -> Result<Value, String> {
    ensure_main(&caller)?;
    let (view, inspector) = state.inspection_target(&tab_id)?;
    let gate = tokio::time::timeout(browser_inspect::TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "browser picker busy")?;
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    let cancel = matches!(&request, PickRequest::Cancel { .. });
    let (action, lease) = match request {
        PickRequest::Start { owner } => {
            state.loaded_receipt(&owner, &tab_id)?;
            browser_inspect::authorize(&view, &inspector, Some(&owner), false)?;
            let lease = Lease {
                token: browser_inspect::frame_id()?,
                owner,
                epoch,
                deadline: Instant::now() + Duration::from_secs(90),
            };
            *inspector
                .picker
                .lock()
                .map_err(|_| "picker state unavailable")? = Some(lease.clone());
            ("start", lease)
        }
        PickRequest::Poll { token } | PickRequest::Cancel { token } => {
            let mut slot = inspector
                .picker
                .lock()
                .map_err(|_| "picker state unavailable")?;
            let lease = slot
                .as_ref()
                .filter(|l| l.token == token)
                .cloned()
                .ok_or("stale component picker")?;
            if cancel || lease.epoch != epoch || Instant::now() >= lease.deadline {
                slot.take();
            }
            if !cancel && (lease.epoch != epoch || Instant::now() >= lease.deadline) {
                return Err("component picker expired or page changed".into());
            }
            (if cancel { "cancel" } else { "poll" }, lease)
        }
    };
    let result = decode(&browser_inspect::evaluate(&view, script(action, &lease.token)).await?)?;
    let (current, other) = state.inspection_target(&tab_id)?;
    if current.label() != view.label()
        || !std::sync::Arc::ptr_eq(&other, &inspector)
        || inspector.navigation_epoch.load(Ordering::SeqCst) != epoch
    {
        return Err("browser changed during selection".into());
    }
    if action == "start" {
        return Ok(json!({"status":"pending","token":lease.token}));
    }
    if result["status"] == "pending" {
        return Ok(json!({"status":"pending"}));
    }
    inspector
        .picker
        .lock()
        .map_err(|_| "picker state unavailable")?
        .take();
    if result["status"] == "empty" {
        return Ok(json!({"status":"empty"}));
    }
    if result["status"] != "selected" {
        return Ok(json!({"status":"cancelled"}));
    }
    validate_selection(&result["selection"])?;
    drop(gate);
    let image = crate::browser_native::screenshot(&state, &tab_id, &lease.owner).await?;
    if inspector.navigation_epoch.load(Ordering::SeqCst) != epoch {
        return Err("page changed before selection screenshot".into());
    }
    let geometry = decode(
        &browser_inspect::evaluate(
            &view,
            "JSON.stringify({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})".into(),
        )
        .await?,
    )?;
    if geometry != result["selection"]["viewport"]
        || image["viewport"]["width"] != geometry["width"]
        || image["viewport"]["height"] != geometry["height"]
    {
        return Err("page geometry changed; select the component again".into());
    }
    let (current, other) = state.inspection_target(&tab_id)?;
    if current.label() != view.label()
        || !std::sync::Arc::ptr_eq(&other, &inspector)
        || inspector.navigation_epoch.load(Ordering::SeqCst) != epoch
    {
        return Err("browser changed before returning selection".into());
    }
    browser_inspect::authorize(&view, &inspector, Some(&lease.owner), false)?;
    Ok(json!({"status":"selected","selection":result["selection"],"image":image}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_are_closed() {
        for v in [
            json!({"action":"eval","script":"x"}),
            json!({"action":"poll","token":"a","owner":"other"}),
            json!({"action":"start","owner":"a","url":"x"}),
        ] {
            assert!(serde_json::from_value::<PickRequest>(v).is_err());
        }
    }
    #[test]
    fn selection_is_bounded() {
        let mut v =
            json!({"bounds":{"x":0,"y":0,"width":40,"height":20},"elements":[{}],"untrusted":true});
        assert!(validate_selection(&v).is_ok());
        v["bounds"]["width"] = json!(0);
        assert!(validate_selection(&v).is_err());
        v["bounds"]["width"] = json!(40);
        v["elements"] = json!(vec![json!({}); 9]);
        assert!(validate_selection(&v).is_err());
    }
}
