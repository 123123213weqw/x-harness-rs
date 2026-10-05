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
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use xharness_process::SpawnSpec;
use xharness_terminal::{
    TerminalOpenSpec, TerminalRegistry, TerminalSignal, TerminalSize, DEFAULT_COLS, DEFAULT_ROWS,
};

/// Legacy callers without a session id keep their original namespace. New
/// clients scope PTYs to a conversation so switching chats cannot attach the
/// previous chat's shell.
pub const WEB_TERMINAL_OWNER: &str = "web";
const MAX_SESSION_ID_BYTES: usize = 128;

/// Terminal input is keystrokes, not file transfer. A single paste above this
/// size is rejected instead of being split across many PTY writes.
const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_ARGS: usize = 64;
const SAFE_INHERITED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "COLORTERM",
    "SystemRoot",
    "SystemDrive",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "TEMP",
    "TMP",
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
    #[serde(default)]
    session_id: Option<String>,
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
    #[serde(default)]
    session_id: Option<String>,
    name: String,
}

#[derive(Deserialize)]
struct SendRequest {
    #[serde(default)]
    session_id: Option<String>,
    name: String,
    input: String,
}

#[derive(Deserialize)]
struct ReadRequest {
    #[serde(default)]
    session_id: Option<String>,
    name: String,
    #[serde(default)]
    cursor: Option<u64>,
}

#[derive(Deserialize)]
struct ResizeRequest {
    #[serde(default)]
    session_id: Option<String>,
    name: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct SignalRequest {
    #[serde(default)]
    session_id: Option<String>,
    name: String,
    signal: TerminalSignal,
}

#[derive(Default, Deserialize)]
struct ListRequest {
    #[serde(default)]
    session_id: Option<String>,
}

fn terminal_owner(session_id: Option<&str>) -> Result<String, Box<Response>> {
    match session_id {
        None => Ok(WEB_TERMINAL_OWNER.to_owned()),
        Some(id)
            if !id.is_empty()
                && id.len() <= MAX_SESSION_ID_BYTES
                && !id.chars().any(char::is_control) =>
        {
            Ok(format!("{WEB_TERMINAL_OWNER}:session:{id}"))
        }
        Some(_) => Err(Box::new(failure(
            StatusCode::BAD_REQUEST,
            "invalid_session_id",
            format!("session_id must be 1-{MAX_SESSION_ID_BYTES} bytes without control characters"),
        ))),
    }
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

fn parse_body<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Box<Response>> {
    serde_json::from_slice(body).map_err(|error| {
        Box::new(failure(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            error.to_string(),
        ))
    })
}

fn registry(state: &TerminalRouterState) -> Result<Arc<TerminalRegistry>, Box<Response>> {
    state.registry.clone().ok_or_else(|| {
        Box::new(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal_unavailable",
            "this host was started without the terminal registry",
        ))
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

fn default_cwd() -> PathBuf {
    #[cfg(unix)]
    let home = env::var_os("HOME");
    #[cfg(windows)]
    let home = env::var_os("USERPROFILE");
    home.map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
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
        if SAFE_INHERITED_ENV
            .iter()
            .any(|safe| key.eq_ignore_ascii_case(safe))
            || key.starts_with("LC_")
        {
            environment.insert(OsString::from(key), value);
        }
    }
    environment.retain(|name, _| !name.eq_ignore_ascii_case("PATH"));
    environment.insert(
        "PATH".into(),
        xharness_process::shell::executable_search_path(),
    );
    environment.insert("TERM".into(), "xterm-256color".into());
    for (key, value) in extra {
        if key.eq_ignore_ascii_case("PATH") {
            environment.retain(|name, _| !name.eq_ignore_ascii_case("PATH"));
        }
        environment.insert(OsString::from(key), OsString::from(value));
    }
    environment
}

async fn terminal_open(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<OpenRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
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
    let mut process = match xharness_process_spec(&request) {
        Ok(process) => process,
        Err(error) => {
            return failure(
                StatusCode::BAD_REQUEST,
                "shell_unavailable",
                error.to_string(),
            )
        }
    };
    process.env = terminal_env(&request.env);
    let spec = TerminalOpenSpec {
        owner,
        name: request.name,
        process,
        size,
    };
    match registry.open(spec).await {
        Ok(descriptor) => ok(json!({"terminal": descriptor})),
        Err(error) => terminal_error(error),
    }
}

fn xharness_process_spec(
    request: &OpenRequest,
) -> Result<SpawnSpec, xharness_process::shell::ShellError> {
    process_spec_for_shell(request, xharness_process::shell::Shell::discover())
}

fn process_spec_for_shell(
    request: &OpenRequest,
    selected: Result<xharness_process::shell::Shell, xharness_process::shell::ShellError>,
) -> Result<SpawnSpec, xharness_process::shell::ShellError> {
    let (program, args) = match &request.program {
        Some(program) => (
            OsString::from(program),
            request.args.iter().map(OsString::from).collect(),
        ),
        None => {
            let shell = selected?;
            let args = if request.args.is_empty() {
                shell.interactive_args()
            } else {
                request.args.iter().map(OsString::from).collect()
            };
            (shell.program.into_os_string(), args)
        }
    };
    let cwd = request
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(default_cwd);
    Ok(SpawnSpec::new(program, cwd).args(args))
}

async fn terminal_send(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<SendRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    if request.input.len() > MAX_INPUT_BYTES {
        return failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "input_too_large",
            format!("terminal input is capped at {MAX_INPUT_BYTES} bytes"),
        );
    }
    match registry
        .send(&owner, &request.name, request.input.as_bytes())
        .await
    {
        Ok(bytes) => ok(json!({"written": bytes})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_read(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<ReadRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match registry
        .read_raw(&owner, &request.name, request.cursor)
        .await
    {
        Ok(read) => ok(json!({"read": {
            "id": read.id,
            "name": read.name,
            "content_base64": STANDARD.encode(&read.content),
            "cursor": read.cursor,
            "truncated_before_cursor": read.truncated_before_cursor,
            "running": read.running,
            "exit_code": read.exit_code,
            "exit_signal": read.exit_signal,
        }})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_resize(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<ResizeRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    let size = TerminalSize {
        cols: request.cols,
        rows: request.rows,
    };
    match registry.resize(&owner, &request.name, size).await {
        Ok(()) => ok(json!({})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_signal(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<SignalRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match registry.signal(&owner, &request.name, request.signal).await {
        Ok(()) => ok(json!({})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_close(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<NameRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match registry.close(&owner, &request.name).await {
        Ok(read) => ok(json!({"read": read})),
        Err(error) => terminal_error(error),
    }
}

async fn terminal_list(State(state): State<TerminalRouterState>, body: Bytes) -> Response {
    let registry = match registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let request = match parse_body::<ListRequest>(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let owner = match terminal_owner(request.session_id.as_deref()) {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match registry.list(&owner).await {
        Ok(terminals) => ok(json!({"terminals": terminals})),
        Err(error) => terminal_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_terminal_uses_the_shared_shell_and_interactive_not_batch_args() {
        use xharness_process::shell::{Shell, ShellKind};
        let request: OpenRequest = serde_json::from_value(json!({"name":"test"})).unwrap();
        let shell = Shell {
            kind: ShellKind::WindowsPowerShell,
            program: PathBuf::from("powershell.exe"),
        };
        let spec = process_spec_for_shell(&request, Ok(shell.clone())).unwrap();
        assert_eq!(spec.program, shell.program);
        assert_eq!(spec.args, shell.interactive_args());
        assert!(!spec
            .args
            .iter()
            .any(|a| a == "-Command" || a == "-NonInteractive"));
        let error = xharness_process::shell::ShellError::Unavailable;
        assert!(process_spec_for_shell(&request, Err(error.clone())).is_err());
        let request: OpenRequest = serde_json::from_value(
            json!({"name":"test","program":"custom.exe","args":["literal space"]}),
        )
        .unwrap();
        let spec = process_spec_for_shell(&request, Err(error)).unwrap();
        assert_eq!(spec.program, "custom.exe");
        assert_eq!(spec.args, [OsString::from("literal space")]);
    }

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
