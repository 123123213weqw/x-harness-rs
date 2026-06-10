//! XHarness extension routes for the Web terminal dock.
//!
//! These endpoints are deliberately outside the frozen upstream RPC method
//! directory (`xharness-api`'s 52 fixed methods): the terminal is an
//! XHarness-owned surface, so it keeps its own plain-JSON contracts under
//! `/api/terminal/*` while sitting behind the same readiness and desktop-token
//! layers as every other `/api` route.

use std::{collections::BTreeMap, env, ffi::OsString, path::PathBuf, sync::Arc};

use axum::{
    body::Bytes,
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use xharness_process::SpawnSpec;
use xharness_terminal::{
    TerminalOpenSpec, TerminalRegistry, TerminalSignal, TerminalSize, DEFAULT_COLS, DEFAULT_ROWS,
};

/// All Web terminals share one owner namespace. The desktop token in front of
/// `/api` already identifies the single trusted user; the owner only separates
/// Web terminals from any future agent-owned terminals.
pub const WEB_TERMINAL_OWNER: &str = "web";

/// Terminal input is keystrokes, not file transfer. A single paste above this
/// size is rejected instead of being split across many PTY writes.
const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_ARGS: usize = 64;
const SAFE_INHERITED_ENV: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "COLORTERM",
];

#[derive(Clone, Default)]
pub struct TerminalRouterState {
    registry: Option<Arc<TerminalRegistry>>,
}

impl TerminalRouterState {
    pub const fn new(registry: Option<Arc<TerminalRegistry>>) -> Self {
        Self { registry }
    }
}

pub fn terminal_routes(state: TerminalRouterState) -> Router {
    Router::new()
        .route("/api/terminal/open", post(terminal_open))
        .route("/api/terminal/send", post(terminal_send))
        .route("/api/terminal/read", post(terminal_read))
        .route("/api/terminal/resize", post(terminal_resize))
        .route("/api/terminal/signal", post(terminal_signal))
        .route("/api/terminal/close", post(terminal_close))
        .route("/api/terminal/list", post(terminal_list))
        .with_state(state)
}

#[derive(Deserialize)]
struct OpenRequest {
    name: String,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
    /// Overrides the default shell. `program` and `args` are passed to `exec`
    /// directly; the command line is never parsed.
    #[serde(default)]
    program: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct NameRequest {
    name: String,
}

#[derive(Deserialize)]
struct SendRequest {
    name: String,
    input: String,
}

#[derive(Deserialize)]
struct ReadRequest {
    name: String,
    #[serde(default)]
    cursor: Option<u64>,
}

#[derive(Deserialize)]
struct ResizeRequest {
    name: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct SignalRequest {
    name: String,
    signal: TerminalSignal,
}

fn ok(mut payload: Value) -> Response {
    payload["ok"] = json!(true);
    Json(payload).into_response()
}

fn failure(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_TYPE, "application/json"),
        ],
        Json(json!({
            "ok": false,
            "error": {"code": code, "message": message.into()},
        })),
    )
        .into_response()
}

fn parse_body<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(body)
        .map_err(|error| failure(StatusCode::BAD_REQUEST, "invalid_request", error.to_string()))
}

async fn registry(
    state: &TerminalRouterState,
) -> Result<Arc<TerminalRegistry>, Response> {
    state.registry.clone().ok_or_else(|| {
        failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal_unavailable",
            "this host was started without the terminal registry",
        )
    })
}

fn terminal_error(error: xharness_terminal::TerminalError) -> Response {
    use xharness_terminal::TerminalError;
    let status = match &error {
        TerminalError::InvalidConfig
        | TerminalError::InvalidOwner
        | TerminalError::InvalidName
        | TerminalError::EmptyProgram
        | TerminalError::CursorAhead { .. } => StatusCode::BAD_REQUEST,
        TerminalError::InvalidSize => StatusCode::BAD_REQUEST,
        TerminalError::DuplicateName { .. } => StatusCode::CONFLICT,
        TerminalError::SessionLimit => StatusCode::TOO_MANY_REQUESTS,
        TerminalError::NotFound { .. } => StatusCode::NOT_FOUND,
        TerminalError::Exited { .. } | TerminalError::RegistryClosed => StatusCode::CONFLICT,
        TerminalError::Unsupported { .. } => StatusCode::NOT_IMPLEMENTED,
        TerminalError::Io { .. } => StatusCode::INTERNAL_SERVER_ERROR,
    };
    failure(status, "terminal_error", error.to_string())
}

fn default_shell() -> OsString {
    #[cfg(unix)]
    {
        for candidate in [
            env::var_os("SHELL"),
            Some("/bin/bash".into()),
            Some("/bin/sh".into()),
        ]
        .into_iter()
        .flatten()
        {
            return candidate;
        }
        unreachable!("a unix shell fallback always matches")
    }
    #[cfg(windows)]
    {
        env::var_os("SHELL")
            .or_else(|| Some("pwsh.exe".into()))
            .expect("a windows shell fallback always matches")
    }
}

fn default_cwd() -> PathBuf {
    #[cfg(unix)]
    let home = env::var_os("HOME");
    #[cfg(windows)]
    let home = env::var_os("USERPROFILE");
    home.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// The terminal registry spawns with a cleared environment, so the Web
/// terminal must build one: a safe inherited subset plus the request's own
/// entries and a terminal-capable `TERM`.
fn terminal_env(extra: &BTreeMap<String, String>) -> BTreeMap<OsString, OsString> {
    let mut environment = BTreeMap::new();
    for (key, value) in env::vars_os() {
        let Ok(key) = key.into_string() else {
            continue;
        };
        if SAFE_INHERITED_ENV.contains(&key.as_str()) || key.starts_with("LC_") {
            environment.insert(OsString::from(key), value);
        }
    }
    environment.insert("TERM".into(), "xterm-256color".into());
    for (key, value) in extra {
        environment.insert(OsString::from(key), OsString::from(value));
    }
    environment
}

async fn terminal_open(
    State(state): State<TerminalRouterState>,
    body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    let request = match parse_body::<OpenRequest>(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if request.args.len() > MAX_ARGS {
        return failure(
            StatusCode::BAD_REQUEST,
            "too_many_args",
            format!("terminal args are capped at {MAX_ARGS}"),
        );
    }
    let size = TerminalSize {
        cols: request.cols.unwrap_or(DEFAULT_COLS),
        rows: request.rows.unwrap_or(DEFAULT_ROWS),
    };
    let mut process = xharness_process_spec(&request);
    process.env = terminal_env(&request.env);
    let spec = TerminalOpenSpec {
        owner: WEB_TERMINAL_OWNER.to_owned(),
        name: request.name,
        process,
        size,
    };
    match registry.open(spec).await {
        Ok(descriptor) => ok(json!({"terminal": descriptor})),
        Err(error) => terminal_error(error),
    }
}

fn xharness_process_spec(request: &OpenRequest) -> xharness_process::SpawnSpec {
    let program = request
        .program
        .clone()
        .map(OsString::from)
        .unwrap_or_else(default_shell);
    let cwd = request
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(default_cwd);
    SpawnSpec::new(program, cwd).args(request.args.iter().map(OsString::from))
}

async fn terminal_send(
    State(state): State<TerminalRouterState>,
    body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    let request = match parse_body::<SendRequest>(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if request.input.len() > MAX_INPUT_BYTES {
        return failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "input_too_large",
            format!("terminal input is capped at {MAX_INPUT_BYTES} bytes"),
        );
    }
    match registry
        .send(WEB_TERMINAL_OWNER, &request.name, request.input.as_bytes())
        .await
    {
        Ok(bytes) => ok(json!({"written": bytes})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_read(
    State(state): State<TerminalRouterState>,
    body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    let request = match parse_body::<ReadRequest>(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match registry
        .read(WEB_TERMINAL_OWNER, &request.name, request.cursor)
        .await
    {
        Ok(read) => ok(json!({"read": read})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_resize(
    State(state): State<TerminalRouterState>,
    body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    let request = match parse_body::<ResizeRequest>(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let size = TerminalSize {
        cols: request.cols,
        rows: request.rows,
    };
    match registry
        .resize(WEB_TERMINAL_OWNER, &request.name, size)
        .await
    {
        Ok(()) => ok(json!({})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_signal(
    State(state): State<TerminalRouterState>,
    body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    let request = match parse_body::<SignalRequest>(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match registry
        .signal(WEB_TERMINAL_OWNER, &request.name, request.signal)
        .await
    {
        Ok(()) => ok(json!({})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_close(
    State(state): State<TerminalRouterState>,
    body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    let request = match parse_body::<NameRequest>(&body) {
        Ok(request) => request,
        Err(response) => return response,
    };
    match registry.close(WEB_TERMINAL_OWNER, &request.name).await {
        Ok(read) => ok(json!({"read": read})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_list(
    State(state): State<TerminalRouterState>,
    _body: Bytes,
) -> Response {
    let registry = match registry(&state).await {
        Ok(registry) => registry,
        Err(response) => return response,
    };
    match registry.list(WEB_TERMINAL_OWNER).await {
        Ok(terminals) => ok(json!({"terminals": terminals})),
        Err(error) => terminal_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_env_always_sets_term_and_merges_request_entries() {
        let mut extra = BTreeMap::new();
        extra.insert("XHARNESS_WEB_TERMINAL".to_owned(), "1".to_owned());
        let environment = terminal_env(&extra);
        assert_eq!(
            environment.get(&OsString::from("TERM")),
            Some(&OsString::from("xterm-256color"))
        );
        assert_eq!(
            environment.get(&OsString::from("XHARNESS_WEB_TERMINAL")),
            Some(&OsString::from("1"))
        );
    }
}
