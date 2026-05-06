//! Shared wire validation and compatibility helpers for RPC adapters.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use xharness_api::{RpcError, RpcErrorCode};
use xharness_session::{
    ApprovalPolicy, EventData as SessionEventData, SessionEvent, SessionSandboxMode,
};

use crate::{driver::rpc_error, runtime::AgentRuntimeError, state::now_ms};

pub(crate) fn prompt_fingerprint(
    mode: &str,
    content: &[Value],
    client_time_zone: Option<&str>,
) -> String {
    let canonical = json!({
        "version": 1,
        "mode": mode,
        "content": content,
        "clientTimeZone": client_time_zone,
    });
    let encoded = serde_json::to_vec(&canonical).expect("JSON value serialization cannot fail");
    let digest = Sha256::digest(encoded);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

pub(super) fn require_object(value: &Value) -> Result<&Map<String, Value>, RpcError> {
    value
        .as_object()
        .ok_or_else(|| bad_request("payload must be a JSON object"))
}

pub(super) fn required_string(value: &Value, field: &str) -> Result<String, RpcError> {
    require_object(value)?
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| bad_request(format!("{field} must be a non-empty string")))
}

pub(super) fn optional_string(value: &Value, field: &str) -> Result<Option<String>, RpcError> {
    match require_object(value)?.get(field) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(bad_request(format!(
            "{field}, when present, must be a non-empty string"
        ))),
    }
}

pub(super) fn optional_u64(value: &Value, field: &str) -> Result<Option<u64>, RpcError> {
    match require_object(value)?.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| bad_request(format!("{field} must be a non-negative integer"))),
    }
}

pub(super) fn required_array<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a Vec<Value>, RpcError> {
    require_object(value)?
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request(format!("{field} must be an array")))
}

pub(super) fn nonempty(value: String, field: &str) -> Result<String, RpcError> {
    if value.trim().is_empty() {
        Err(bad_request(format!("{field} must not be blank")))
    } else {
        Ok(value)
    }
}

pub(super) fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, json!([]))
}

pub(super) fn session_not_found(session_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SessionNotFound,
        format!("session {session_id:?} was not found"),
        json!({"sessionId": session_id}),
    )
}

pub(super) fn canonical_directory(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("select a filesystem directory, not the location overview".to_owned());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("could not resolve directory {path:?}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("path {path:?} is not a directory"));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

pub(super) fn directory_roots() -> Result<Vec<std::path::PathBuf>, String> {
    #[cfg(windows)]
    {
        // Do not stat every drive: disconnected mapped drives and empty media
        // should not delay the overview. Read errors belong to the chosen path.
        xharness_win32::logical_drive_roots().map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        Ok(vec![
            std::path::PathBuf::from("/"),
            #[cfg(target_os = "macos")]
            std::path::PathBuf::from("/Volumes"),
        ])
    }
}

pub(super) fn valid_directory_name(name: &str) -> bool {
    // Path::join replaces the parent for absolute/prefixed paths on Windows.
    // Validate a component, not just the absence of slash characters.
    if name.trim().is_empty() || name.contains(['/', '\\', '\0']) {
        return false;
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return false;
    }
    #[cfg(windows)]
    {
        // Reject Win32 aliases even with a verbatim canonical parent path:
        // folders must remain accessible to Explorer and ordinary tools.
        if name.ends_with(['.', ' ']) || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c)) {
            return false;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or(name)
            .trim_end()
            .to_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) {
            return false;
        }
        if let Some(suffix) = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
        {
            if matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ) {
                return false;
            }
        }
    }
    true
}

pub(super) fn breadcrumb_entries(path: &Path) -> Vec<Value> {
    let mut current = PathBuf::new();
    path.components()
        .filter_map(|component| {
            current.push(component.as_os_str());
            // A Windows drive prefix (e.g. C: or \\?\C:) is not a complete
            // absolute directory. Emit it together with the following root.
            if matches!(component, std::path::Component::Prefix(_)) {
                return None;
            }
            let display = current.to_string_lossy().into_owned();
            let name = component.as_os_str().to_string_lossy();
            Some(json!({
                "name": if matches!(component, std::path::Component::RootDir) || name.is_empty() { display.clone() } else { name.into_owned() },
                "path": display,
                "hidden": false,
            }))
        })
        .collect()
}

pub(super) fn visible_text(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<String>()
}

pub(super) fn permission_command_input(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("/permission")?;
    if rest.is_empty() || matches!(rest.chars().next(), Some(' ' | '\t' | '\n' | '\r')) {
        Some(rest)
    } else {
        None
    }
}

pub(super) fn plan_command_input(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("/plan")?;
    if rest.is_empty() || matches!(rest.chars().next(), Some(' ' | '\t' | '\n' | '\r')) {
        Some(rest)
    } else {
        None
    }
}

pub(crate) fn permission_events(preset: crate::PermissionPreset) -> Vec<SessionEvent> {
    vec![
        SessionEventData::PermissionPreset {
            preset: preset.as_str().to_owned(),
        }
        .into(),
        SessionEventData::SandboxMode {
            mode: match preset {
                crate::PermissionPreset::WorkspaceWrite => SessionSandboxMode::WorkspaceWrite,
                crate::PermissionPreset::DangerFullAccess => SessionSandboxMode::DangerFullAccess,
            },
            source: None,
        }
        .into(),
        SessionEventData::ApprovalPolicy {
            policy: match preset {
                crate::PermissionPreset::WorkspaceWrite => ApprovalPolicy::Ask,
                crate::PermissionPreset::DangerFullAccess => ApprovalPolicy::Never,
            },
            source: None,
        }
        .into(),
    ]
}

pub(super) fn queue_item_not_found(item_id: &str, error: AgentRuntimeError) -> RpcError {
    rpc_error(
        RpcErrorCode::QueueItemNotFound,
        "queued item is no longer pending",
        json!({"itemId": item_id, "reason": error.to_string()}),
    )
}

pub(super) fn mint_stream_id(next_id: &AtomicU64, prefix: &str) -> String {
    let ordinal = next_id.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{ordinal}", now_ms())
}
