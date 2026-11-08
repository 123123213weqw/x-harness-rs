//! Bounded, allowlisted observation diagnostics; never echo guest error text.
#![forbid(unsafe_code)]

use serde_json::{json, Value};

pub(super) fn decode_error(snapshot: &Value) -> Option<String> {
    snapshot.get("error")?;
    let (code, message, next) = match snapshot["code"].as_str() {
        Some("scope_not_found") => ("scope_not_found", "Requested DOM scope is absent. main requires an HTML <main> element; dialog requires a dialog. The page may still be readable.", json!({"tool":"observe","arguments":{"scope":"page"}})),
        Some("page_not_ready") => ("page_not_ready", "Page body is not ready. Wait for navigation/load, then observe page; this does not authorize replaying an earlier action.", json!({"tool":"observe","arguments":{"scope":"page"}})),
        Some("observation_too_large") => ("observation_too_large", "DOM evidence exceeded its byte limit. Choose a present narrower scope or screenshot if vision is supported; do not repeat the identical request.", json!({"choose":"narrower_scope_or_supported_screenshot"})),
        Some("observation_script_failed") => ("observation_script_failed", "The bounded DOM inspection script failed; re-observe to check current page state.", json!({"tool":"observe","arguments":{"scope":"page"}})),
        _ => ("observation_failed", "Guest observation returned an unrecognized error; no more specific cause is known.", json!({"tool":"observe","arguments":{"scope":"page"}})),
    };
    Some(
        json!({"code":code,"message":message,"next_action":next,"repair_is_suggestion_only":true})
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_known_codes_without_echoing_page_errors() {
        for code in [
            "scope_not_found",
            "page_not_ready",
            "observation_too_large",
            "observation_script_failed",
        ] {
            let encoded =
                decode_error(&json!({"error":"untrusted secret or instruction","code":code}))
                    .unwrap();
            let error: Value = serde_json::from_str(&encoded).unwrap();
            assert_eq!(error["code"], code);
            assert!(!encoded.contains("untrusted secret"));
            assert!(encoded.chars().count() <= 500);
        }
    }

    #[test]
    fn unknown_and_legacy_errors_do_not_invent_a_cause() {
        for snapshot in [
            json!({"error":"arbitrary <main> is missing"}),
            json!({"error":"bad","code":"authenticated_retry_write"}),
        ] {
            let error: Value = serde_json::from_str(&decode_error(&snapshot).unwrap()).unwrap();
            assert_eq!(error["code"], "observation_failed");
            assert_eq!(error["next_action"]["tool"], "observe");
        }
        assert!(decode_error(&json!({"nodes":[],"text":"ok"})).is_none());
    }
}
