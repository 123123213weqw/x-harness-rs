use std::{
    env, fs, io,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{self, Instant},
};
use url::Url;

const HOST_START_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_STOP_TIMEOUT: Duration = Duration::from_secs(15);

pub struct DesktopState {
    pub(crate) child: Mutex<Option<CommandChild>>,
    pub(crate) running: AtomicBool,
    pub(crate) closing: AtomicBool,
    pub(crate) endpoint: Mutex<Option<String>>,
    pub(crate) shutdown_file: PathBuf,
    ready_file: PathBuf,
    token: String,
    workspace: PathBuf,
    state_dir: PathBuf,
    static_dir: PathBuf,
    providers_file: Option<PathBuf>,
    provider_env: Vec<(String, String)>,
    pub(crate) pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    pub(crate) update_busy: AtomicBool,
}

impl DesktopState {
    pub fn initialize(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let app_data = app.path().app_data_dir()?;
        let app_cache = app.path().app_cache_dir()?;
        let app_config = app.path().app_config_dir()?;
        let workspace = env::var_os("XHARNESS_WORKSPACE")
            .map(PathBuf::from)
            .unwrap_or_else(|| app_data.join("workspace"));
        let state_dir = env::var_os("XHARNESS_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| app_data.join("state"));
        let runtime_dir = app_cache.join("runtime");
        std::fs::create_dir_all(&workspace)?;
        std::fs::create_dir_all(&state_dir)?;
        std::fs::create_dir_all(&runtime_dir)?;
        std::fs::create_dir_all(&app_config)?;

        let token = random_token()?;
        let runtime_id = random_token()?;
        let shutdown_file = runtime_dir.join(format!("shutdown-{runtime_id}.request"));
        let ready_file = runtime_dir.join(format!("ready-{runtime_id}.address"));
        let static_dir = app.path().resolve("web", BaseDirectory::Resource)?;
        let providers_file = env::var_os("XHARNESS_PROVIDERS_FILE")
            .map(PathBuf::from)
            .or_else(|| {
                let candidate = app_config.join("providers.json");
                candidate.is_file().then_some(candidate)
            });
        let provider_env = providers_file
            .as_deref()
            .map(|path| load_provider_env(path, &app_config))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            child: Mutex::new(None),
            running: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            endpoint: Mutex::new(None),
            shutdown_file,
            ready_file,
            token,
            workspace,
            state_dir,
            static_dir,
            providers_file,
            provider_env,
            pending_update: Mutex::new(None),
            update_busy: AtomicBool::new(false),
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    desktop: bool,
    version: &'static str,
    host_running: bool,
    host_endpoint: Option<String>,
    updater_configured: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEvent {
    phase: &'static str,
    message: String,
}

#[tauri::command]
pub fn desktop_status(state: State<'_, DesktopState>) -> DesktopStatus {
    DesktopStatus {
        desktop: true,
        version: env!("CARGO_PKG_VERSION"),
        host_running: state.running.load(Ordering::SeqCst),
        host_endpoint: state
            .endpoint
            .lock()
            .expect("endpoint mutex poisoned")
            .clone(),
        updater_configured: crate::updater::configured(),
    }
}

pub async fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = start_claimed(app).await;
    if result.is_err() {
        force_stop(app);
    }
    result
}

async fn start_claimed(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let mut args = vec![
        "--bind".to_owned(),
        "127.0.0.1:0".to_owned(),
        "--workspace".to_owned(),
        path_text(&state.workspace),
        "--state-dir".to_owned(),
        path_text(&state.state_dir),
        "--static-dir".to_owned(),
        path_text(&state.static_dir),
        "--shutdown-file".to_owned(),
        path_text(&state.shutdown_file),
        "--ready-file".to_owned(),
        path_text(&state.ready_file),
    ];
    if let Some(providers_file) = &state.providers_file {
        args.extend(["--providers-file".to_owned(), path_text(providers_file)]);
    }

    let mut command = app
        .shell()
        .sidecar("xharness-host")
        .map_err(|error| format!("无法定位 xharness-host sidecar：{error}"))?
        .args(args)
        .env("XHARNESS_DESKTOP_TOKEN", &state.token);
    for (name, value) in &state.provider_env {
        command = command.env(name, value);
    }
    let command = command.current_dir(&state.workspace);
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("无法启动 xharness-host：{error}"))?;
    *state.child.lock().expect("child mutex poisoned") = Some(child);

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_owned();
                    if !message.is_empty() {
                        let _ = event_app.emit(
                            "xharness-host",
                            HostEvent {
                                phase: "log",
                                message,
                            },
                        );
                    }
                }
                CommandEvent::Error(message) => {
                    let _ = event_app.emit(
                        "xharness-host",
                        HostEvent {
                            phase: "error",
                            message,
                        },
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let state = event_app.state::<DesktopState>();
                    state.running.store(false, Ordering::SeqCst);
                    *state.endpoint.lock().expect("endpoint mutex poisoned") = None;
                    state.child.lock().expect("child mutex poisoned").take();
                    let _ = event_app.emit(
                        "xharness-host",
                        HostEvent {
                            phase: "stopped",
                            message: format!("XHarness Host 已停止：{payload:?}"),
                        },
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    let endpoint = wait_until_ready(app, &state.ready_file).await?;
    *state.endpoint.lock().expect("endpoint mutex poisoned") = Some(endpoint.clone());

    let mut bootstrap = Url::parse(&format!("{endpoint}/desktop/bootstrap"))
        .map_err(|error| format!("无法构造桌面入口：{error}"))?;
    bootstrap
        .query_pairs_mut()
        .append_pair("token", &state.token);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_owned())?;
    window
        .navigate(bootstrap)
        .map_err(|error| format!("无法打开 XHarness Web UI：{error}"))?;
    let _ = app.emit(
        "xharness-bootstrap",
        HostEvent {
            phase: "ready",
            message: endpoint,
        },
    );
    Ok(())
}

pub async fn graceful_stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if !state.running.load(Ordering::SeqCst) {
        return Ok(());
    }
    tokio::fs::write(&state.shutdown_file, b"shutdown")
        .await
        .map_err(|error| format!("无法请求 Host 安全退出：{error}"))?;
    let deadline = Instant::now() + HOST_STOP_TIMEOUT;
    while state.running.load(Ordering::SeqCst) && Instant::now() < deadline {
        time::sleep(Duration::from_millis(100)).await;
    }
    if state.running.load(Ordering::SeqCst) {
        force_stop(app);
        return Err("Host 未在 15 秒内安全退出，已强制终止".to_owned());
    }
    let _ = tokio::fs::remove_file(&state.shutdown_file).await;
    let _ = tokio::fs::remove_file(&state.ready_file).await;
    Ok(())
}

pub fn force_stop(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    state.running.store(false, Ordering::SeqCst);
    *state.endpoint.lock().expect("endpoint mutex poisoned") = None;
    let child = state.child.lock().expect("child mutex poisoned").take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

async fn wait_until_ready(app: &AppHandle, ready_file: &Path) -> Result<String, String> {
    let deadline = Instant::now() + HOST_START_TIMEOUT;
    loop {
        if !app.state::<DesktopState>().running.load(Ordering::SeqCst) {
            return Err("XHarness Host 在 Readiness 之前退出，请检查桌面日志".to_owned());
        }
        let address = match tokio::fs::read_to_string(ready_file).await {
            Ok(value) => valid_ready_address(&value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("无法读取 Host Readiness：{error}")),
        };
        if let Some(address) = address {
            let port = address.port();
            let endpoint = format!("http://127.0.0.1:{port}");
            if let Ok(mut stream) = TcpStream::connect(address).await {
                let request = format!(
                    "GET /health/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
                );
                if stream.write_all(request.as_bytes()).await.is_ok() {
                    let mut response = [0_u8; 512];
                    if let Ok(read) = stream.read(&mut response).await {
                        if response[..read].starts_with(b"HTTP/1.1 200") {
                            return Ok(endpoint);
                        }
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("XHarness Host 启动超时，请检查桌面日志".to_owned());
        }
        time::sleep(Duration::from_millis(100)).await;
    }
}

fn valid_ready_address(value: &str) -> Option<SocketAddr> {
    value
        .trim()
        .parse::<SocketAddr>()
        .ok()
        .filter(|address| address.ip().is_loopback() && address.port() != 0)
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| std::io::Error::other(format!("系统随机数不可用：{error}")))?;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    Ok(output)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn load_provider_env(
    providers_file: &Path,
    app_config: &Path,
) -> io::Result<Vec<(String, String)>> {
    let document: serde_json::Value = serde_json::from_slice(&fs::read(providers_file)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut loaded = Vec::new();
    for name in provider_key_env_names(&document) {
        if env::var_os(&name).is_some() {
            continue;
        }
        let Some(value) = provider_secret_candidates(app_config, &name)
            .into_iter()
            .find_map(|path| read_nonempty_secret(&path))
        else {
            continue;
        };
        loaded.push((name, value));
    }
    Ok(loaded)
}

fn provider_key_env_names(document: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();
    let providers = document
        .get("providers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten();
    for provider in providers {
        let Some(name) = provider
            .get("api_key_env")
            .and_then(serde_json::Value::as_str)
            .filter(|name| valid_env_name(name))
        else {
            continue;
        };
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_owned());
        }
    }
    names
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn provider_secret_candidates(app_config: &Path, name: &str) -> Vec<PathBuf> {
    let normalized = name.to_ascii_lowercase();
    let mut paths = vec![
        app_config.join("secrets").join(name),
        app_config.join("secrets").join(&normalized),
    ];
    #[cfg(target_os = "macos")]
    if let Some(home) = env::var_os("HOME") {
        paths.push(
            PathBuf::from(home)
                .join("Library/Application Support/XHarness/secrets")
                .join(normalized),
        );
    }
    paths
}

fn read_nonempty_secret(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let value = fs::read_to_string(path).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_tokens_are_full_width_hex() {
        let token = random_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn readiness_accepts_only_nonzero_loopback_addresses() {
        assert_eq!(
            valid_ready_address("127.0.0.1:3082"),
            Some("127.0.0.1:3082".parse().unwrap())
        );
        assert!(valid_ready_address("0.0.0.0:3082").is_none());
        assert!(valid_ready_address("127.0.0.1:0").is_none());
        assert!(valid_ready_address("not-an-address").is_none());
    }

    #[test]
    fn provider_secret_projection_is_deduplicated_and_path_safe() {
        let document = serde_json::json!({
            "providers": [
                { "api_key_env": "DEEPSEEK_API_KEY" },
                { "api_key_env": "DEEPSEEK_API_KEY" },
                { "api_key_env": "../../ESCAPE" },
                { "api_key_env": "SECONDARY_TOKEN" }
            ]
        });
        assert_eq!(
            provider_key_env_names(&document),
            vec!["DEEPSEEK_API_KEY", "SECONDARY_TOKEN"]
        );

        let candidates = provider_secret_candidates(Path::new("/app/config"), "DEEPSEEK_API_KEY");
        assert_eq!(
            candidates[0],
            Path::new("/app/config/secrets/DEEPSEEK_API_KEY")
        );
        assert_eq!(
            candidates[1],
            Path::new("/app/config/secrets/deepseek_api_key")
        );
    }
}
