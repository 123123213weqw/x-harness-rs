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
use xharness_diagnostics::{
    Phase, Record, StartupFailureCode, StartupFailureReceipt, StartupProgressReceipt, StartupStage,
};

const HOST_START_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_START_MAX_TIMEOUT: Duration = Duration::from_secs(120);
const HOST_STOP_TIMEOUT: Duration = Duration::from_secs(15);

pub struct DesktopState {
    pub(crate) diagnostics: crate::diagnostics::Diagnostics,
    pub(crate) startup: crate::startup::StartupTimeline,
    stop_requested: AtomicBool,
    #[cfg(windows)]
    host_job: xharness_win32::Job,
    #[cfg(windows)]
    start_file: PathBuf,
    #[cfg(windows)]
    crash_context: PathBuf,
    #[cfg(windows)]
    crash_event: String,
    pub(crate) child: Mutex<Option<CommandChild>>,
    pub(crate) running: AtomicBool,
    pub(crate) closing: AtomicBool,
    pub(crate) endpoint: Mutex<Option<String>>,
    startup_error: Mutex<Option<String>>,
    pub(crate) shutdown_file: PathBuf,
    ready_file: PathBuf,
    progress_file: PathBuf,
    failure_file: PathBuf,
    token: String,
    workspace: PathBuf,
    state_dir: PathBuf,
    static_dir: PathBuf,
    providers_file: Option<PathBuf>,
    provider_env: Vec<(String, String)>,
    pub(crate) update_session: Mutex<crate::updater::UpdateSession<tauri_plugin_updater::Update>>,
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
        let progress_file = runtime_dir.join(format!("startup-progress-{runtime_id}.json"));
        let failure_file = runtime_dir.join(format!("startup-failure-{runtime_id}.json"));
        let static_dir = app.path().resolve("web", BaseDirectory::Resource)?;
        let providers_file = env::var_os("XHARNESS_PROVIDERS_FILE")
            .map(PathBuf::from)
            .or_else(|| {
                let candidate = app_config.join("providers.json");
                candidate.is_file().then_some(candidate)
            });
        let mut provider_env = providers_file
            .as_deref()
            .map(|path| load_provider_env(path, &app_config))
            .transpose()?
            .unwrap_or_default();
        // Finder/Explorer-launched apps do not reliably inherit shell exports.
        // Reuse the existing private secret-file convention for optional web
        // search, even when there is no providers.json.
        let inherited_exa_key = env::var("EXA_API_KEY")
            .ok()
            .is_some_and(|key| !key.trim().is_empty());
        let projected_exa_key = provider_env
            .iter()
            .any(|(name, value)| name == "EXA_API_KEY" && !value.trim().is_empty());
        if !inherited_exa_key && !projected_exa_key {
            if let Some(key) = provider_secret_candidates(&app_config, "EXA_API_KEY")
                .into_iter()
                .find_map(|path| read_nonempty_secret(&path))
            {
                provider_env.push(("EXA_API_KEY".to_owned(), key));
            }
        }
        Ok(Self {
            diagnostics: crate::diagnostics::Diagnostics::new(
                app_cache.join("diagnostics"),
                app_config.join("diagnostics.json"),
            ),
            startup: crate::startup::StartupTimeline::new(),
            stop_requested: AtomicBool::new(false),
            #[cfg(windows)]
            host_job: xharness_win32::Job::new_kill_on_close()?,
            #[cfg(windows)]
            start_file: runtime_dir.join(format!("start-{runtime_id}.permit")),
            #[cfg(windows)]
            crash_context: runtime_dir.join(format!("crash-{runtime_id}.context")),
            #[cfg(windows)]
            crash_event: format!("Local\\XHarnessCrash-{runtime_id}"),
            child: Mutex::new(None),
            running: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            endpoint: Mutex::new(None),
            startup_error: Mutex::new(None),
            shutdown_file,
            ready_file,
            progress_file,
            failure_file,
            token,
            workspace,
            state_dir,
            static_dir,
            providers_file,
            provider_env,
            update_session: Mutex::new(crate::updater::UpdateSession::default()),
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
    startup_error: Option<String>,
    startup: crate::startup::StartupSnapshot,
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
        startup_error: state
            .startup_error
            .lock()
            .expect("startup error mutex poisoned")
            .clone(),
        startup: state.startup.snapshot(),
    }
}

pub async fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    state.stop_requested.store(false, Ordering::SeqCst);
    *state
        .startup_error
        .lock()
        .expect("startup error mutex poisoned") = None;
    // Fail before launching, rather than letting a stale receipt be mistaken
    // for the result of this attempt when cleanup itself is denied.
    let result = [&state.failure_file, &state.progress_file]
        .into_iter()
        .try_for_each(|path| match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法清理旧的 Host 启动回执".to_owned()),
        });
    let result = match result {
        Ok(()) => start_claimed(app).await.map_err(|fallback| {
            match consume_startup_failure(&state.failure_file) {
                Some((record, message)) => {
                    state.diagnostics.record(record);
                    message
                }
                None => fallback,
            }
        }),
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        state.diagnostics.mark_incident();
        let _ = crate::diagnostics::open(app);
        *state
            .startup_error
            .lock()
            .expect("startup error mutex poisoned") = Some(error.clone());
        if state.child.lock().expect("child mutex poisoned").is_none() {
            state.running.store(false, Ordering::SeqCst);
        } else {
            force_stop(app);
        }
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
        "--startup-progress-file".to_owned(),
        path_text(&state.progress_file),
    ];
    if let Some(providers_file) = &state.providers_file {
        args.extend(["--providers-file".to_owned(), path_text(providers_file)]);
    }
    #[cfg(windows)]
    args.extend([
        "--desktop-start-file".to_owned(),
        path_text(&state.start_file),
    ]);

    let mut command = app
        .shell()
        .sidecar("xharness-host")
        .map_err(|error| format!("无法定位 xharness-host sidecar：{error}"))?
        .args(args)
        .env("XHARNESS_DESKTOP_TOKEN", &state.token)
        .env(
            "XHARNESS_DIAGNOSTICS_DIR",
            state.diagnostics.root.join("host"),
        )
        .env("XHARNESS_DIAGNOSTICS_CONTROL", &state.diagnostics.control)
        .env("XHARNESS_STARTUP_FAILURE_FILE", &state.failure_file);
    for (name, value) in &state.provider_env {
        command = command.env(name, value);
    }
    #[cfg(windows)]
    {
        command = command
            .env("XHARNESS_CRASH_CONTEXT", &state.crash_context)
            .env("XHARNESS_CRASH_EVENT", &state.crash_event);
        // Host cannot restore work/spawn children until assigned to our Job.
        match std::fs::remove_file(&state.start_file) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法清理旧 Host 启动许可：{error}")),
        }
    }
    let command = command.current_dir(&state.workspace);
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("无法启动 xharness-host：{error}"))?;
    let pid = child.pid();
    let mut started = Record::new(Phase::HostStart);
    started.pid = Some(pid);
    state.diagnostics.record(started);
    #[cfg(windows)]
    let observed = xharness_win32::ObservedProcess::open(pid).ok();
    #[cfg(windows)]
    if let Err(error) = state.host_job.assign_pid(child.pid()) {
        let _ = child.kill();
        return Err(format!("无法建立 Host 进程树退出保护：{error}"));
    }
    *state.child.lock().expect("child mutex poisoned") = Some(child);

    let generation_alive = std::sync::Arc::new(AtomicBool::new(true));
    #[cfg(windows)]
    match xharness_win32::CrashCapture::prepare(pid, &state.crash_event) {
        Ok(capture) => {
            let capture_app = app.clone();
            let capture_alive = generation_alive.clone();
            std::thread::spawn(move || {
                let state = capture_app.state::<DesktopState>();
                while capture_alive.load(Ordering::SeqCst) {
                    if std::fs::metadata(&state.crash_context).is_ok_and(|meta| meta.len() == 16) {
                        state.diagnostics.record(Record::new(Phase::CaptureStarted));
                        let destination = state.diagnostics.root.join("crash-latest.dmp");
                        let previous = state.diagnostics.root.join("crash-previous.dmp");
                        // Only these two fixed, application-owned dump files are
                        // retained; never scan/delete the user's CrashDumps.
                        if destination.is_file() {
                            let _ = std::fs::remove_file(&previous);
                            let _ = std::fs::rename(&destination, &previous);
                        }
                        let result = capture.capture(
                            &state.crash_context,
                            &destination,
                            state.diagnostics.full_memory(),
                        );
                        let mut record = Record::new(if result.is_ok() {
                            Phase::CaptureFinished
                        } else {
                            Phase::CaptureFailed
                        });
                        record.byte_count = result.ok();
                        state.diagnostics.record(record);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                let _ = std::fs::remove_file(&state.crash_context);
            });
        }
        Err(_) => state.diagnostics.record(Record::new(Phase::CaptureFailed)),
    }
    #[cfg(windows)]
    if let Some(observed) = observed {
        let sampler_app = app.clone();
        let sampler_alive = generation_alive.clone();
        // Blocking Win32 queries and filesystem writes stay off the async/UI
        // executor. The retained process handle cannot follow a recycled PID.
        std::thread::spawn(move || {
            while sampler_alive.load(Ordering::SeqCst) {
                let state = sampler_app.state::<DesktopState>();
                if let Ok(sample) = observed.sample() {
                    let mut record = Record::new(Phase::Sample);
                    record.pid = Some(pid);
                    record.resources = Some(xharness_diagnostics::Resources {
                        resident_bytes: Some(sample.resident_bytes),
                        private_bytes: Some(sample.private_bytes),
                        handles: Some(sample.handles),
                    });
                    state.diagnostics.record(record);
                }
                std::thread::sleep(state.diagnostics.interval());
            }
        });
    }

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    let mut record = Record::new(Phase::HostStderr);
                    record.pid = Some(pid);
                    record.byte_count = Some(bytes.len() as u64);
                    event_app.state::<DesktopState>().diagnostics.record(record);
                    let message = String::from_utf8_lossy(&bytes).trim().to_owned();
                    // Surface only recognized ownership diagnostics on the
                    // bootstrap screen, not arbitrary provider stderr/secrets.
                    if message.contains("XHarness 数据目录已被占用")
                        || message.contains("检测到旧版会话占用")
                    {
                        *event_app
                            .state::<DesktopState>()
                            .startup_error
                            .lock()
                            .expect("startup error mutex poisoned") = Some(message.clone());
                    }
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
                    event_app
                        .state::<DesktopState>()
                        .diagnostics
                        .record(Record::new(Phase::HostIoError));
                    let _ = event_app.emit(
                        "xharness-host",
                        HostEvent {
                            phase: "error",
                            message,
                        },
                    );
                }
                CommandEvent::Terminated(payload) => {
                    generation_alive.store(false, Ordering::SeqCst);
                    let state = event_app.state::<DesktopState>();
                    let expected = state.stop_requested.load(Ordering::SeqCst)
                        && payload.code == Some(0)
                        && payload.signal.is_none();
                    let mut record = Record::new(Phase::HostExit);
                    record.pid = Some(pid);
                    record.exit_code = payload.code;
                    record.signal = payload.signal;
                    record.expected = Some(expected);
                    state.diagnostics.record(record);
                    if !expected {
                        state.diagnostics.mark_incident();
                        *state
                            .startup_error
                            .lock()
                            .expect("startup error mutex poisoned") = Some(
                            "后台异常退出，已尝试保存诊断记录。请打开运行诊断；不会自动重跑工具。"
                                .to_owned(),
                        );
                        if !state.closing.load(Ordering::SeqCst) {
                            let _ = crate::diagnostics::open(&event_app);
                        }
                    }
                    *state.endpoint.lock().expect("endpoint mutex poisoned") = None;
                    state.child.lock().expect("child mutex poisoned").take();
                    // Publish stopped only after cleaning up this generation.
                    state.running.store(false, Ordering::SeqCst);
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
        generation_alive.store(false, Ordering::SeqCst);
    });

    #[cfg(windows)]
    tokio::fs::write(&state.start_file, b"owned")
        .await
        .map_err(|error| format!("无法释放 Host 启动门禁：{error}"))?;
    let (endpoint, address, mut budget) = wait_until_live(app, &state.ready_file).await?;
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
    wait_until_product_ready(app, address, &mut budget).await?;
    state.startup.host_ready(&state.diagnostics);
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
        #[cfg(windows)]
        if state
            .host_job
            .accounting()
            .map_err(|error| error.to_string())?
            .active_processes
            != 0
        {
            return Err("Host 子进程尚未全部退出，更新已暂停".to_owned());
        }
        return Ok(());
    }
    state.stop_requested.store(true, Ordering::SeqCst);
    if let Err(error) = tokio::fs::write(&state.shutdown_file, b"shutdown").await {
        state.stop_requested.store(false, Ordering::SeqCst);
        return Err(format!("无法请求 Host 安全退出：{error}"));
    }
    wait_for_stop(&state.running, HOST_STOP_TIMEOUT).await?;
    #[cfg(windows)]
    if state
        .host_job
        .accounting()
        .map_err(|error| error.to_string())?
        .active_processes
        != 0
    {
        return Err("Host 子进程尚未全部退出，更新已暂停".to_owned());
    }
    let _ = tokio::fs::remove_file(&state.shutdown_file).await;
    let _ = tokio::fs::remove_file(&state.ready_file).await;
    let _ = tokio::fs::remove_file(&state.progress_file).await;
    Ok(())
}

pub fn force_stop(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let child = state.child.lock().expect("child mutex poisoned").take();
    if let Some(child) = child {
        // kill is a request, not proof of exit. Only Terminated marks stopped.
        let _ = child.kill();
    }
}

async fn wait_for_stop(running: &AtomicBool, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while running.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err("Host 尚未确认退出，更新不会强制中断任务或替换程序".to_owned());
        }
        time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

fn startup_failure_message(code: StartupFailureCode) -> String {
    let cause = match code {
        StartupFailureCode::Arguments => "启动参数无效",
        StartupFailureCode::ProcessOwnership => "进程启动许可或数据目录所有权检查失败",
        StartupFailureCode::Diagnostics => "诊断系统初始化失败",
        StartupFailureCode::Workspace => "工作目录不可访问",
        StartupFailureCode::ProviderConfiguration => "模型 Provider 配置无法加载",
        StartupFailureCode::StateStore => "状态存储无法打开",
        StartupFailureCode::RuntimeInitialization => "运行时初始化失败",
        StartupFailureCode::ModelSettings => "模型设置无法加载",
        StartupFailureCode::SessionRestore => "历史会话恢复失败",
        StartupFailureCode::NetworkBind => "本地服务端口无法监听",
        StartupFailureCode::Readiness => "服务就绪信号发布失败",
        StartupFailureCode::Other => "未知的启动故障",
    };
    format!(
        "XHarness Host 启动失败：{cause}（代码 {}）。请打开运行诊断导出报告。",
        code.as_str()
    )
}

fn consume_startup_failure(path: &Path) -> Option<(Record, String)> {
    let receipt = StartupFailureReceipt::read(path).ok()?;
    let mut record = Record::new(Phase::HostStartupFailure);
    record.startup_failure = Some(receipt.code);
    let _ = fs::remove_file(path);
    Some((record, startup_failure_message(receipt.code)))
}

async fn wait_until_live(
    app: &AppHandle,
    ready_file: &Path,
) -> Result<(String, SocketAddr, StartupWaitBudget), String> {
    let mut budget = StartupWaitBudget::new(Instant::now());
    let mut last_stage = None;
    loop {
        ensure_host_running(app)?;
        observe_startup_progress(app, &mut budget, &mut last_stage);
        let address = match tokio::fs::read_to_string(ready_file).await {
            Ok(value) => valid_ready_address(&value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("无法读取 Host Readiness：{error}")),
        };
        if let Some(address) = address {
            let port = address.port();
            let endpoint = format!("http://127.0.0.1:{port}");
            if health_ok(address, "/health/live").await {
                return Ok((endpoint, address, budget));
            }
        }
        if budget.expired(Instant::now()) {
            return Err("XHarness Host 启动超时（最长 120 秒），请检查桌面日志".to_owned());
        }
        time::sleep(Duration::from_millis(100)).await;
    }
}

#[derive(Clone, Copy, Debug)]
struct StartupWaitBudget {
    absolute_deadline: Instant,
    idle_deadline: Instant,
    last_sequence: Option<u64>,
}

impl StartupWaitBudget {
    fn new(now: Instant) -> Self {
        Self {
            absolute_deadline: now + HOST_START_MAX_TIMEOUT,
            idle_deadline: now + HOST_START_IDLE_TIMEOUT,
            last_sequence: None,
        }
    }

    fn observe(&mut self, sequence: u64, now: Instant) -> bool {
        if self
            .last_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return false;
        }
        self.last_sequence = Some(sequence);
        self.idle_deadline = (now + HOST_START_IDLE_TIMEOUT).min(self.absolute_deadline);
        true
    }

    fn expired(&self, now: Instant) -> bool {
        now >= self.idle_deadline || now >= self.absolute_deadline
    }
}

async fn wait_until_product_ready(
    app: &AppHandle,
    address: SocketAddr,
    budget: &mut StartupWaitBudget,
) -> Result<(), String> {
    let mut last_stage = None;
    loop {
        ensure_host_running(app)?;
        observe_startup_progress(app, budget, &mut last_stage);
        if health_ok(address, "/health/ready").await {
            return Ok(());
        }
        if budget.expired(Instant::now()) {
            return Err("XHarness Host 恢复超时（最长 120 秒），请检查运行诊断".to_owned());
        }
        time::sleep(Duration::from_millis(100)).await;
    }
}

fn ensure_host_running(app: &AppHandle) -> Result<(), String> {
    if app.state::<DesktopState>().running.load(Ordering::SeqCst) {
        return Ok(());
    }
    Err(app
        .state::<DesktopState>()
        .startup_error
        .lock()
        .expect("startup error mutex poisoned")
        .clone()
        .unwrap_or_else(|| "XHarness Host 在就绪前退出，请检查桌面日志".to_owned()))
}

fn observe_startup_progress(
    app: &AppHandle,
    budget: &mut StartupWaitBudget,
    last_stage: &mut Option<StartupStage>,
) {
    let Ok(receipt) = StartupProgressReceipt::read(&app.state::<DesktopState>().progress_file)
    else {
        return;
    };
    if budget.observe(receipt.sequence, Instant::now()) && *last_stage != Some(receipt.stage) {
        *last_stage = Some(receipt.stage);
        let _ = app.emit(
            "xharness-bootstrap",
            HostEvent {
                phase: "progress",
                message: startup_stage_message(receipt.stage).to_owned(),
            },
        );
    }
}

async fn health_ok(address: SocketAddr, path: &str) -> bool {
    // A live TCP listener can still accept a socket without answering it.
    // Bound the *whole* probe so it cannot bypass the startup deadline.
    time::timeout(Duration::from_secs(2), async {
        let Ok(mut stream) = TcpStream::connect(address).await else {
            return false;
        };
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            address.port()
        );
        if stream.write_all(request.as_bytes()).await.is_err() {
            return false;
        }
        let mut response = [0_u8; 512];
        stream
            .read(&mut response)
            .await
            .is_ok_and(|read| response[..read].starts_with(b"HTTP/1.1 200"))
    })
    .await
    .unwrap_or(false)
}

fn startup_stage_message(stage: StartupStage) -> &'static str {
    match stage {
        StartupStage::BasicInitialization => "Host 正在完成基础初始化…",
        StartupStage::RuntimeInitialization => "Host 正在初始化 Agent 运行时…",
        StartupStage::NetworkBind => "Host 正在建立本地安全连接…",
        StartupStage::Live => "Host 已启动，正在恢复数据…",
        StartupStage::HistoryRestore => "正在恢复历史会话…",
        StartupStage::ModelReconciliation => "正在校验模型配置…",
        StartupStage::Ready => "Host 已就绪",
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
    #[cfg(target_os = "macos")]
    let mut paths = vec![
        app_config.join("secrets").join(name),
        app_config.join("secrets").join(&normalized),
    ];
    #[cfg(not(target_os = "macos"))]
    let paths = vec![
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
    fn startup_failure_receipt_becomes_safe_screen_text_and_diagnostic_metadata() {
        let path = std::env::temp_dir().join(format!(
            "xharness-startup-receipt-{}-{}",
            std::process::id(),
            random_token().unwrap()
        ));
        StartupFailureReceipt::new(StartupFailureCode::ProviderConfiguration)
            .write(&path)
            .unwrap();
        let (record, message) = consume_startup_failure(&path).unwrap();
        assert!(matches!(record.phase, Phase::HostStartupFailure));
        assert_eq!(
            record.startup_failure,
            Some(StartupFailureCode::ProviderConfiguration)
        );
        assert!(message.contains("Provider 配置"));
        assert!(message.contains("provider_configuration"));
        assert!(!path.exists());
        assert!(consume_startup_failure(&path).is_none());
    }

    #[test]
    fn stop_timeout_does_not_pretend_process_exited() {
        tauri::async_runtime::block_on(async {
            let running = AtomicBool::new(true);
            assert!(wait_for_stop(&running, Duration::from_millis(1))
                .await
                .is_err());
            assert!(running.load(Ordering::SeqCst));
            running.store(false, Ordering::SeqCst);
            assert!(wait_for_stop(&running, Duration::ZERO).await.is_ok());
        });
    }

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
    fn startup_wait_extends_only_for_new_progress_with_an_absolute_cap() {
        let start = Instant::now();
        let mut budget = StartupWaitBudget::new(start);
        assert!(!budget.expired(start + Duration::from_secs(29)));
        assert!(budget.observe(1, start + Duration::from_secs(29)));
        assert!(!budget.expired(start + Duration::from_secs(58)));
        assert!(!budget.observe(1, start + Duration::from_secs(58)));
        assert!(budget.expired(start + Duration::from_secs(59)));

        let mut progressing = StartupWaitBudget::new(start);
        assert!(progressing.observe(1, start + Duration::from_secs(29)));
        assert!(progressing.observe(2, start + Duration::from_secs(58)));
        assert!(progressing.observe(3, start + Duration::from_secs(87)));
        assert!(progressing.observe(4, start + Duration::from_secs(116)));
        assert!(!progressing.expired(start + Duration::from_secs(119)));
        assert!(progressing.expired(start + Duration::from_secs(120)));
    }

    #[test]
    fn silent_health_endpoint_cannot_stall_the_startup_deadline() {
        tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (_stream, _) = listener.accept().await.unwrap();
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
            let started = Instant::now();
            assert!(!health_ok(address, "/health/ready").await);
            assert!(started.elapsed() < Duration::from_secs(4));
            server.abort();
        });
    }

    #[test]
    fn startup_stage_messages_are_closed_and_non_sensitive() {
        for stage in [
            StartupStage::BasicInitialization,
            StartupStage::RuntimeInitialization,
            StartupStage::NetworkBind,
            StartupStage::Live,
            StartupStage::HistoryRestore,
            StartupStage::ModelReconciliation,
            StartupStage::Ready,
        ] {
            let message = startup_stage_message(stage);
            assert!(!message.is_empty());
            assert!(!message.contains(['/', '\\']));
        }
    }

    #[test]
    fn provider_secret_projection_is_deduplicated_and_path_safe() {
        let document = serde_json::json!({
            "providers": [
                { "api_key_env": "EXAMPLE_API_KEY" },
                { "api_key_env": "EXAMPLE_API_KEY" },
                { "api_key_env": "../../ESCAPE" },
                { "api_key_env": "SECONDARY_TOKEN" }
            ]
        });
        assert_eq!(
            provider_key_env_names(&document),
            vec!["EXAMPLE_API_KEY", "SECONDARY_TOKEN"]
        );

        let candidates = provider_secret_candidates(Path::new("/app/config"), "EXAMPLE_API_KEY");
        assert_eq!(
            candidates[0],
            Path::new("/app/config/secrets/EXAMPLE_API_KEY")
        );
        assert_eq!(
            candidates[1],
            Path::new("/app/config/secrets/example_api_key")
        );
    }
}
