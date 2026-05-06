//! Host capability, filesystem browser, skill, and request-snapshot adapter.

use std::path::Path;

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};

use crate::{
    driver::{agent_runtime_error, rpc_error},
    BasicHost,
};

use super::{
    bad_request, breadcrumb_entries, canonical_directory, directory_roots, nonempty,
    require_object, required_string, session_not_found, valid_directory_name,
};

const MAX_DIRECTORY_ENTRIES: usize = 1_000;

pub(super) async fn describe(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    let (attached, startup_issues, model_settings_error) = {
        let state = host.state.read().await;
        (
            state.sessions.len(),
            state.startup_issues.clone(),
            state.model_settings_error.clone(),
        )
    };
    Ok(json!({
        "version": host.config.version,
        "cwd": host.config.cwd,
        "provider": host.config.provider_id,
        "model": host.config.model_id,
        "attachedSessions": attached,
        "home": host.config.home,
        "canOpenPath": cfg!(target_os = "macos"),
        // Durable sessions that startup could not publish. Reported here so
        // the surface can tell the user what was skipped instead of
        // presenting a silently shorter session list.
        "startupIssues": startup_issues,
        // Why the persisted model settings are not live. Without this the
        // user sees every configured provider listed while every session
        // reports its model as unavailable.
        "modelSettingsError": model_settings_error,
    }))
}

pub(super) async fn pick_directory(_host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    Ok(json!({"path": Value::Null}))
}

pub(super) async fn list_directory(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let requested = match require_object(payload)?.get("path") {
        None => host.config.home.to_string_lossy().into_owned(),
        Some(Value::String(path)) => path.clone(),
        Some(_) => return Err(bad_request("path, when present, must be a string")),
    };
    // Empty path is a virtual location overview, not the process cwd.
    // Omitted path retains the existing home-directory wire contract.
    if requested.is_empty() {
        let roots = directory_roots().map_err(|message| {
            rpc_error(
                RpcErrorCode::DirectoryUnreadable,
                message,
                json!({"path": ""}),
            )
        })?;
        let entries = roots
            .iter()
            .map(|path| json!({"name": path, "path": path, "hidden": false}))
            .collect::<Vec<_>>();
        return Ok(json!({
            "path": "", "home": host.config.home,
            "crumbs": [], "entries": entries, "truncated": false,
        }));
    }
    let path = canonical_directory(&requested).map_err(|message| {
        rpc_error(
            RpcErrorCode::DirectoryUnreadable,
            message,
            json!({"path": requested}),
        )
    })?;
    let mut entries = std::fs::read_dir(&path)
        .map_err(|error| {
            rpc_error(
                RpcErrorCode::DirectoryUnreadable,
                error.to_string(),
                json!({"path": path}),
            )
        })?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() || kind.is_symlink())
        })
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
                "hidden": name.starts_with('.'),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    let truncated = entries.len() > MAX_DIRECTORY_ENTRIES;
    entries.truncate(MAX_DIRECTORY_ENTRIES);
    let crumbs = breadcrumb_entries(Path::new(&path));
    Ok(json!({
        "path": path,
        "home": host.config.home,
        "crumbs": crumbs,
        "entries": entries,
        "truncated": truncated,
    }))
}

pub(super) async fn create_directory(
    _host: &BasicHost,
    payload: &Value,
) -> Result<Value, RpcError> {
    let parent = required_string(payload, "path")?;
    let name = required_string(payload, "name")?;
    if !valid_directory_name(&name) {
        return Err(bad_request("name must be one valid, non-blank folder name"));
    }
    let parent = canonical_directory(&parent).map_err(|message| {
        rpc_error(
            RpcErrorCode::DirectoryUnreadable,
            message,
            json!({"path": parent}),
        )
    })?;
    let created = Path::new(&parent).join(name);
    match std::fs::create_dir(&created) {
        Ok(()) => Ok(json!({"path": created.to_string_lossy()})),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(rpc_error(
            RpcErrorCode::DirectoryExists,
            error.to_string(),
            json!({"path": created.to_string_lossy()}),
        )),
        Err(error) => Err(rpc_error(
            RpcErrorCode::DirectoryCreateFailed,
            error.to_string(),
            json!({"path": created.to_string_lossy()}),
        )),
    }
}

pub(super) async fn open_path(_host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let path = nonempty(required_string(payload, "path")?, "path")?;
    if !Path::new(&path).exists() {
        return Err(rpc_error(
            RpcErrorCode::DirectoryUnreadable,
            "path does not exist",
            json!({"path": path}),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(&path)
            .spawn()
            .map_err(|error| RpcError::internal(format!("could not open path: {error}")))?;
        Ok(json!({"opened": true}))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(RpcError::internal(
            "native path opening is unavailable on this host",
        ))
    }
}

pub(super) async fn skill_list(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    if !host.state.read().await.sessions.contains_key(&session_id) {
        return Err(session_not_found(&session_id));
    }
    Ok(json!({
        "skills": [{
            "name": "coding",
            "description": "Inspect and modify a local workspace with XHarness coding tools.",
            "whenToUse": "Use for software development, debugging, testing, and repository maintenance.",
            "modelInvocable": true,
        }],
    }))
}

pub(super) async fn request_snapshot(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let id = required_string(payload, "sessionId")?;
    let seq = payload
        .get("seq")
        .and_then(Value::as_u64)
        .ok_or_else(|| bad_request("seq must be a nonnegative integer"))?;
    if !host.state.read().await.sessions.contains_key(&id) {
        return Err(session_not_found(&id));
    }
    let header = host
        .agent_runtime
        .request_header(&id, seq)
        .await
        .map_err(agent_runtime_error)?
        .ok_or_else(|| bad_request("request snapshot not found at this sequence"))?;
    Ok(json!({"sessionId":id,"seq":seq,"header":header}))
}
