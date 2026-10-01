//! One-shot DOM actions over the native WebView seam. This is not native input
//! synthesis and is not yet delegated to models. Main-only IPC, current tab,
//! native frame consumption and navigation epochs own authorization; page-local
//! refs are only untrusted identity evidence. No arbitrary JS/selector is accepted.

use std::sync::{atomic::Ordering, Arc};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, Webview};

use crate::browser::{ensure_main, BrowserState};
use crate::browser_inspect::{decode_callback, evaluate, SCRIPT, TIMEOUT};

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum PerformRequest {
    Click {
        frame_id: String,
        r#ref: String,
    },
    Fill {
        frame_id: String,
        r#ref: String,
        text: String,
    },
    Select {
        frame_id: String,
        r#ref: String,
        value: String,
    },
    Scroll {
        frame_id: String,
        delta_y: i32,
    },
}

impl PerformRequest {
    fn frame(&self) -> &str {
        match self {
            Self::Click { frame_id, .. }
            | Self::Fill { frame_id, .. }
            | Self::Select { frame_id, .. }
            | Self::Scroll { frame_id, .. } => frame_id,
        }
    }

    fn reference(&self) -> Option<&str> {
        match self {
            Self::Click { r#ref, .. } | Self::Fill { r#ref, .. } | Self::Select { r#ref, .. } => {
                Some(r#ref)
            }
            Self::Scroll { .. } => None,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.frame().len() != 32 || !self.frame().bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid frame_id".into());
        }
        if self.reference().is_some_and(|reference| {
            !reference.starts_with('n')
                || reference.len() > 8
                || reference[1..].is_empty()
                || !reference[1..].bytes().all(|byte| byte.is_ascii_digit())
        }) {
            return Err("invalid observed ref".into());
        }
        match self {
            Self::Fill { text, .. } if text.len() > 16000 => {
                Err("fill text exceeds byte limit".into())
            }
            Self::Select { value, .. } if value.len() > 500 => {
                Err("select value exceeds byte limit".into())
            }
            Self::Scroll { delta_y, .. } if *delta_y == 0 || delta_y.unsigned_abs() > 5000 => {
                Err("invalid scroll delta".into())
            }
            _ => Ok(()),
        }
    }

    fn script(&self) -> Result<String, String> {
        let mut arguments = serde_json::to_value(self).map_err(|_| "invalid DOM action")?;
        // Expire queued script work before the callback deadline. A stalled
        // renderer must not execute a forgotten action arbitrarily later.
        arguments["deadline_epoch_ms"] = Value::from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "clock unavailable")?
                .as_millis() as u64
                + 5000,
        );
        Ok(format!("({SCRIPT})({arguments})"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    NotStarted,
    Applied,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PerformResult {
    pub ok: bool,
    pub effect: Effect,
    frame_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PerformResult {
    fn unknown(frame: &str, message: &str) -> Self {
        Self {
            ok: false,
            effect: Effect::Unknown,
            frame_id: frame.into(),
            message: Some(message.into()),
        }
    }

    fn decode(raw: &str, frame: &str) -> Result<Self, String> {
        let reply: Self =
            serde_json::from_value(decode_callback(raw)?).map_err(|_| "invalid action receipt")?;
        if reply.frame_id != frame
            || reply.ok != (reply.effect == Effect::Applied)
            || reply
                .message
                .as_ref()
                .is_some_and(|message| message.len() > 500)
        {
            return Err("invalid action receipt".into());
        }
        Ok(reply)
    }
}

#[tauri::command]
pub async fn desktop_browser_perform(
    caller: Webview,
    state: State<'_, BrowserState>,
    tab_id: String,
    request: PerformRequest,
) -> Result<PerformResult, String> {
    ensure_main(&caller)?;
    request.validate()?;
    let (target, inspector) = state.inspection_target(&tab_id)?;
    let _gate = tokio::time::timeout(TIMEOUT, inspector.gate.lock())
        .await
        .map_err(|_| "native browser is busy; no action was scheduled")?;
    let (current, current_inspector) = state.inspection_target(&tab_id)?;
    if current.label() != target.label() || !Arc::ptr_eq(&inspector, &current_inspector) {
        return Err("browser tab changed before action; no action was scheduled".into());
    }
    let script = request.script()?;
    let epoch = inspector.navigation_epoch.load(Ordering::SeqCst);
    inspector.claim(request.frame(), request.reference())?;
    // After scheduling, even a timeout/selection change is uncertain, NOT an
    // ordinary retryable error. Never couple this receipt to auto-observation.
    let raw = match evaluate(&target, script).await {
        Ok(raw) => raw,
        Err(_) => return Ok(PerformResult::unknown(request.frame(), "native callback unavailable; effect may have occurred; observe before deciding whether to retry")),
    };
    let still_current =
        state
            .inspection_target(&tab_id)
            .is_ok_and(|(current, current_inspector)| {
                current.label() == target.label()
                    && Arc::ptr_eq(&inspector, &current_inspector)
                    && inspector.navigation_epoch.load(Ordering::SeqCst) == epoch
            });
    if !still_current {
        return Ok(PerformResult::unknown(
            request.frame(),
            "browser changed during action; effect may have occurred; observe again",
        ));
    }
    Ok(
        PerformResult::decode(&raw, request.frame()).unwrap_or_else(|_| {
            PerformResult::unknown(
                request.frame(),
                "invalid native receipt; effect may have occurred; observe again",
            )
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_is_action_specific_bounded_and_has_no_script_selector_or_submit() {
        for request in [
            json!({"action":"click","frame_id":"a".repeat(32),"ref":"n0","text":"extra"}),
            json!({"action":"eval","script":"alert(1)"}),
            json!({"action":"submit","frame_id":"a".repeat(32),"ref":"n0"}),
        ] {
            assert!(serde_json::from_value::<PerformRequest>(request).is_err());
        }
        for request in [
            json!({"action":"click","frame_id":"bad","ref":"n0"}),
            json!({"action":"click","frame_id":"a".repeat(32),"ref":"#selector"}),
            json!({"action":"fill","frame_id":"a".repeat(32),"ref":"n0","text":"x".repeat(16001)}),
            json!({"action":"scroll","frame_id":"a".repeat(32),"delta_y":i32::MIN}),
        ] {
            assert!(serde_json::from_value::<PerformRequest>(request)
                .unwrap()
                .validate()
                .is_err());
        }
        let literal = json!({"action":"fill","frame_id":"a".repeat(32),"ref":"n0","text":"'); window.escape=true; //"});
        let request: PerformRequest = serde_json::from_value(literal).unwrap();
        assert!(request.validate().is_ok());
        assert!(request.script().unwrap().contains("deadline_epoch_ms"));
    }

    #[test]
    fn receipt_requires_matching_frame_and_consistent_effect_not_user_success_text() {
        for reply in [
            json!({"ok":true,"effect":"unknown","frame_id":"frame"}),
            json!({"ok":false,"effect":"applied","frame_id":"frame"}),
            json!({"ok":true,"effect":"applied","frame_id":"other"}),
            json!({"ok":true,"effect":"applied","frame_id":"frame","script":"bad"}),
        ] {
            assert!(PerformResult::decode(
                &serde_json::to_string(&reply.to_string()).unwrap(),
                "frame"
            )
            .is_err());
        }
        let reply =
            json!({"ok":false,"effect":"not_started","frame_id":"frame","message":"stale target"});
        assert_eq!(
            PerformResult::decode(&serde_json::to_string(&reply.to_string()).unwrap(), "frame")
                .unwrap()
                .effect,
            Effect::NotStarted
        );
        assert_eq!(
            PerformResult::unknown("frame", "lost callback").effect,
            Effect::Unknown
        );
    }
}
