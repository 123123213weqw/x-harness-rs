use std::{env, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

mod config;

use config::{ModelDeployment, SingleModelDeployment};
use tokio::net::TcpListener;
use xharness_agent::FileLeaseManager;
use xharness_api::ApiBackend;
use xharness_compaction::CompactionConfig;
use xharness_control::{ControlStore, JsonlControlStore};
use xharness_core::ToolResultPruningContextPolicy;
use xharness_debug::{DebugEvent, DebugRecorder, DebugTraceConfig, DebugTraceMode};
use xharness_host::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, DurableQuestionHub, HostConfig,
};
use xharness_host_app::{ManagedAgentMarkdownSink, NativeToolFactory};
use xharness_provider_openai::OpenAiProtocol;
use xharness_schedule::ScheduleManager;
use xharness_server::{serve, web_router_with_debug};
use xharness_session::Store;
use xharness_session_jsonl::JsonlSessionStore;
use xharness_web::WebRuntime;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse()?;
    let (debug, trace) =
        DebugRecorder::open(DebugTraceConfig::new(args.debug_trace, &args.debug_dir)).await?;
    if let Some(trace) = trace {
        eprintln!("xharness full debug trace: {}", trace.directory.display());
    }
    let result = run(args, debug.clone()).await;
    let outcome = match &result {
        Ok(()) => serde_json::json!({"outcome": "success"}),
        Err(error) => serde_json::json!({"outcome": "failed", "error": error.to_string()}),
    };
    debug
        .record(DebugEvent::new("host", "exit", outcome))
        .await?;
    debug.flush().await?;
    result
}

async fn run(args: Args, debug: DebugRecorder) -> Result<(), Box<dyn std::error::Error>> {
    debug
        .record(DebugEvent::new(
            "host",
            "start",
            serde_json::json!({
                "bind": args.bind.to_string(),
                "workspace": args.workspace.to_string_lossy(),
                "stateDir": args.state_dir.to_string_lossy(),
                "provider": &args.provider,
                "model": &args.model,
                "baseUrl": diagnostic_base_url(&args.base_url),
                "protocol": format!("{:?}", args.protocol),
                "providersFile": args.providers_file.as_ref().map(|path| path.to_string_lossy()),
                "compaction": &args.compaction,
            }),
        ))
        .await?;
    let workspace = std::fs::canonicalize(&args.workspace)?;
    let deployment = match &args.providers_file {
        Some(path) => ModelDeployment::from_file_with_debug(path, debug.clone()).await?,
        None => {
            ModelDeployment::single_with_debug(
                SingleModelDeployment {
                    provider: args.provider.clone(),
                    model: args.model.clone(),
                    base_url: args.base_url.clone(),
                    api_key: args.api_key.clone(),
                    protocol: args.protocol,
                    context_window_tokens: args.context_window_tokens,
                    max_output_tokens: args.max_output_tokens,
                    minimum_output_tokens: args.minimum_output_tokens,
                    token_safety_margin: args.token_safety_margin,
                },
                debug.clone(),
            )
            .await?
        }
    };
    let mut config = HostConfig::new(&workspace);
    config.provider_id = deployment.default_route.provider.clone();
    config.provider_display_name = deployment.default_provider_display_name.clone();
    config.model_id = deployment.default_route.model.clone();
    config.reasoning_effort = deployment.default_route.reasoning_effort.clone();
    config.token_guard = deployment.default_token_guard.clone();
    let sessions_dir = args.state_dir.join("sessions");
    let leases_dir = args.state_dir.join("leases");
    let control_dir = args.state_dir.join("control");
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(sessions_dir)?);
    let questions = DurableQuestionHub::new(store.clone(), ManagedAgentMarkdownSink::new());
    let schedules = ScheduleManager::new(Arc::clone(&store));
    let web = WebRuntime::default().with_debug(debug.clone());
    let tools = NativeToolFactory::new_with_questions_and_schedules(
        web,
        debug.clone(),
        Arc::clone(&questions),
        Arc::clone(&schedules),
    );
    let control_store: Arc<dyn ControlStore> = Arc::new(JsonlControlStore::new(control_dir)?);
    let leases = Arc::new(FileLeaseManager::new(leases_dir)?);
    let runtime = Arc::new(
        DurableLoopAgentRuntime::from_registry(
            deployment.default_route,
            deployment.registry,
            tools,
            Arc::new(ToolResultPruningContextPolicy::default()),
            Arc::clone(&store),
            leases,
            config.event_capacity,
        )?
        .with_debug(debug.clone())
        .with_compaction(args.compaction.clone())
        .with_schedules(schedules),
    );
    let host_runtime: Arc<dyn AgentRuntime> = runtime.clone();
    let host = BasicHost::with_agent_runtime_control_and_questions(
        config,
        host_runtime,
        control_store,
        questions,
    );
    let restore = host.restore_from_store(store).await?;
    debug
        .record(DebugEvent::new(
            "host",
            "restore",
            serde_json::json!({
                "restoredSessions": restore.restored_sessions,
                "resumedPendingTurns": restore.resumed_pending_turns,
                "resumedPendingApprovals": restore.resumed_pending_approvals,
                "resumedUserQuestions": restore.resumed_user_questions,
                "issues": restore.issues.iter().map(|issue| serde_json::json!({
                    "sessionId": &issue.session_id,
                    "message": &issue.message,
                })).collect::<Vec<_>>(),
            }),
        ))
        .await?;
    eprintln!(
        "xharness restored {} sessions, resumed {} pending turns, {} approvals, and {} user questions ({} issues)",
        restore.restored_sessions,
        restore.resumed_pending_turns,
        restore.resumed_pending_approvals,
        restore.resumed_user_questions,
        restore.issues.len(),
    );
    for issue in &restore.issues {
        eprintln!(
            "xharness restore issue for session {}: {}",
            issue.session_id, issue.message
        );
    }
    let backend: Arc<dyn ApiBackend> = host;
    let router = web_router_with_debug(backend, args.static_dir, debug.clone());
    let listener = TcpListener::bind(args.bind).await?;
    let local_addr = listener.local_addr()?;
    debug
        .record(DebugEvent::new(
            "host",
            "listening",
            serde_json::json!({"address": local_addr.to_string()}),
        ))
        .await?;
    debug.flush().await?;
    eprintln!("xharness host listening on http://{}", local_addr);
    let (server_stop_tx, server_stop_rx) = tokio::sync::oneshot::channel::<()>();
    let mut server_task = tokio::spawn(serve(listener, router, async move {
        let _ = server_stop_rx.await;
    }));
    let mut signal_error = None;
    let early_server_result = tokio::select! {
        result = &mut server_task => Some(result),
        signal = shutdown_signal() => {
            signal_error = signal.err();
            None
        }
    };
    // Resolve Axum's graceful-shutdown future first so its accept loop closes
    // while the backend stops new Agent admission and joins active work.
    let _ = server_stop_tx.send(());
    let mut shutdown = runtime.shutdown(Duration::from_secs(10)).await;
    // Upgraded WebSockets are not terminated by Hyper's graceful shutdown.
    // After backend quiescence, bound transport drain and then abort only the
    // carrier task; no Provider, Tool, Process or PTY remains owned by it.
    let (server_result, transport_forced_close) = match early_server_result {
        Some(result) => (Some(result), false),
        None => match tokio::time::timeout(Duration::from_secs(1), &mut server_task).await {
            Ok(result) => (Some(result), false),
            Err(_) => {
                server_task.abort();
                let _ = server_task.await;
                (None, true)
            }
        },
    };
    if let Some(error) = signal_error {
        shutdown
            .cleanup_errors
            .push(format!("could not listen for shutdown signal: {error}"));
    }
    debug
        .record(DebugEvent::new(
            "host",
            "shutdown.completed",
            serde_json::json!({
                "workers": shutdown.workers,
                "graceful": shutdown.graceful,
                "forcedCleanup": shutdown.forced_cleanup,
                "cleanupErrors": &shutdown.cleanup_errors,
                "transportForcedClose": transport_forced_close,
            }),
        ))
        .await?;
    debug.flush().await?;
    if !shutdown.is_graceful() {
        return Err(std::io::Error::other(format!(
            "runtime shutdown was not graceful: {} forced worker(s), errors={:?}",
            shutdown.forced_cleanup, shutdown.cleanup_errors
        ))
        .into());
    }
    if let Some(result) = server_result {
        result.map_err(|error| std::io::Error::other(format!("server task failed: {error}")))??;
    }
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() -> std::io::Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() -> std::io::Result<()> {
    tokio::signal::ctrl_c().await
}

struct Args {
    bind: SocketAddr,
    workspace: PathBuf,
    static_dir: Option<PathBuf>,
    provider: String,
    model: String,
    base_url: String,
    api_key: String,
    protocol: OpenAiProtocol,
    state_dir: PathBuf,
    context_window_tokens: Option<u64>,
    max_output_tokens: u64,
    minimum_output_tokens: Option<u64>,
    token_safety_margin: u64,
    providers_file: Option<PathBuf>,
    compaction: Option<CompactionConfig>,
    debug_trace: DebugTraceMode,
    debug_dir: PathBuf,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut bind = env_value("XHARNESS_BIND", "127.0.0.1:3080")
            .parse::<SocketAddr>()
            .map_err(|error| format!("invalid XHARNESS_BIND: {error}"))?;
        let mut workspace = PathBuf::from(env_value("XHARNESS_WORKSPACE", "."));
        let mut static_dir = env::var_os("XHARNESS_WEB_DIST").map(PathBuf::from);
        let mut provider = env_value("XHARNESS_PROVIDER", "openai-compatible");
        let mut model = env_value("XHARNESS_MODEL", "unconfigured");
        let mut base_url = env_value("XHARNESS_BASE_URL", "http://127.0.0.1:8000/v1");
        let mut api_key = env::var("XHARNESS_API_KEY")
            .or_else(|_| env::var("OPENAI_API_KEY"))
            .unwrap_or_default();
        let mut protocol = parse_protocol(&env_value("XHARNESS_PROTOCOL", "chat"))?;
        let mut state_dir = env::var_os("XHARNESS_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_state_dir);
        let mut context_window_tokens = optional_env_u64("XHARNESS_CONTEXT_WINDOW")?;
        let mut max_output_tokens = env_u64("XHARNESS_MAX_OUTPUT_TOKENS", 4_096)?;
        let mut minimum_output_tokens = optional_env_u64("XHARNESS_MINIMUM_OUTPUT_TOKENS")?;
        let mut token_safety_margin = env_u64("XHARNESS_TOKEN_SAFETY_MARGIN", 1_024)?;
        let mut providers_file = env::var_os("XHARNESS_PROVIDERS_FILE").map(PathBuf::from);
        let mut compaction =
            parse_compaction_setting(env::var("XHARNESS_COMPACTION_CONFIG").ok().as_deref())?;
        let mut debug_trace = env_value("XHARNESS_DEBUG_TRACE", "off")
            .parse::<DebugTraceMode>()
            .map_err(|error| error.to_string())?;
        let mut debug_dir = env::var_os("XHARNESS_DEBUG_DIR").map(PathBuf::from);

        let mut arguments = env::args().skip(1);
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| format!("missing value for {argument}"))?;
            match argument.as_str() {
                "--bind" => {
                    bind = value
                        .parse()
                        .map_err(|error| format!("invalid --bind value: {error}"))?;
                }
                "--workspace" => workspace = PathBuf::from(value),
                "--static-dir" => static_dir = Some(PathBuf::from(value)),
                "--provider" => provider = value,
                "--model" => model = value,
                "--base-url" => base_url = value,
                "--api-key" => api_key = value,
                "--protocol" => protocol = parse_protocol(&value)?,
                "--state-dir" => state_dir = PathBuf::from(value),
                "--context-window" => {
                    context_window_tokens = Some(parse_u64("--context-window", &value)?)
                }
                "--max-output-tokens" => {
                    max_output_tokens = parse_u64("--max-output-tokens", &value)?
                }
                "--minimum-output-tokens" => {
                    minimum_output_tokens = Some(parse_u64("--minimum-output-tokens", &value)?)
                }
                "--token-safety-margin" => {
                    token_safety_margin = parse_u64("--token-safety-margin", &value)?
                }
                "--providers-file" => providers_file = Some(PathBuf::from(value)),
                "--compaction-config" => compaction = parse_compaction_setting(Some(&value))?,
                "--debug-trace" => {
                    debug_trace = value
                        .parse::<DebugTraceMode>()
                        .map_err(|error| error.to_string())?
                }
                "--debug-dir" => debug_dir = Some(PathBuf::from(value)),
                _ => return Err(format!("unknown argument {argument:?}")),
            }
        }
        let debug_dir = debug_dir.unwrap_or_else(|| state_dir.join("debug"));
        Ok(Self {
            bind,
            workspace,
            static_dir,
            provider,
            model,
            base_url,
            api_key,
            protocol,
            state_dir,
            context_window_tokens,
            max_output_tokens,
            minimum_output_tokens,
            token_safety_margin,
            providers_file,
            compaction,
            debug_trace,
            debug_dir,
        })
    }
}

#[cfg(target_os = "macos")]
fn default_state_dir() -> PathBuf {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Library/Application Support/XHarness")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_state_dir() -> PathBuf {
    if let Some(data_home) = env::var_os("XDG_DATA_HOME") {
        PathBuf::from(data_home).join("xharness")
    } else {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".local/share/xharness")
    }
}

#[cfg(windows)]
fn default_state_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|home| home.join("AppData").join("Local"))
        })
        .unwrap_or_else(|| PathBuf::from("."))
        .join("XHarness")
}

fn env_value(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_owned())
}

fn optional_env_u64(name: &str) -> Result<Option<u64>, String> {
    env::var(name)
        .ok()
        .map(|value| parse_u64(name, &value))
        .transpose()
}

fn env_u64(name: &str, fallback: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(value) => parse_u64(name, &value),
        Err(_) => Ok(fallback),
    }
}

fn parse_u64(name: &str, value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|error| format!("invalid {name} value {value:?}: {error}"))
}

fn parse_protocol(value: &str) -> Result<OpenAiProtocol, String> {
    config::parse_protocol(value)
}

/// `default` preserves the production policy, `off` provides a true no-
/// compaction ablation, and every other value is a JSON file containing the
/// provider-neutral [`CompactionConfig`].
fn parse_compaction_setting(value: Option<&str>) -> Result<Option<CompactionConfig>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Some(CompactionConfig::default()));
    };
    if value.eq_ignore_ascii_case("default") || value.eq_ignore_ascii_case("auto") {
        return Ok(Some(CompactionConfig::default()));
    }
    if value.eq_ignore_ascii_case("off")
        || value.eq_ignore_ascii_case("none")
        || value.eq_ignore_ascii_case("disabled")
    {
        return Ok(None);
    }
    let bytes = std::fs::read(value)
        .map_err(|error| format!("could not read compaction config {value:?}: {error}"))?;
    let config = serde_json::from_slice::<CompactionConfig>(&bytes)
        .map_err(|error| format!("invalid compaction config {value:?}: {error}"))?;
    config
        .validate()
        .map_err(|error| format!("invalid compaction config {value:?}: {error}"))?;
    Ok(Some(config))
}

fn diagnostic_base_url(value: &str) -> String {
    let end = value.find(['?', '#']).unwrap_or(value.len());
    let without_query = &value[..end];
    let Some(scheme_end) = without_query.find("://") else {
        return without_query.to_owned();
    };
    let authority_start = scheme_end + 3;
    let authority_end = without_query[authority_start..]
        .find('/')
        .map(|offset| authority_start + offset)
        .unwrap_or(without_query.len());
    let authority = &without_query[authority_start..authority_end];
    let Some(at) = authority.rfind('@') else {
        return without_query.to_owned();
    };
    format!(
        "{}[REDACTED]@{}",
        &without_query[..authority_start],
        &without_query[authority_start + at + 1..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_parser_remains_cli_compatible() {
        assert_eq!(
            parse_protocol("chat").unwrap(),
            OpenAiProtocol::ChatCompletions
        );
        assert_eq!(
            parse_protocol("responses").unwrap(),
            OpenAiProtocol::Responses
        );
    }

    #[test]
    fn debug_base_url_drops_query_fragment_and_userinfo() {
        assert_eq!(
            diagnostic_base_url("https://user:pass@example.test/v1?token=no#fragment"),
            "https://[REDACTED]@example.test/v1"
        );
        assert_eq!(
            diagnostic_base_url("http://127.0.0.1:8000/v1"),
            "http://127.0.0.1:8000/v1"
        );
    }

    #[test]
    fn compaction_ablation_accepts_off_default_and_a_valid_json_policy() {
        assert!(parse_compaction_setting(Some("off")).unwrap().is_none());
        assert_eq!(
            parse_compaction_setting(None).unwrap(),
            Some(CompactionConfig::default())
        );

        let path = std::env::temp_dir().join(format!(
            "xharness-compaction-config-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let policy = CompactionConfig {
            auto: false,
            threshold_ratio: 0.7,
            ..CompactionConfig::default()
        };
        std::fs::write(&path, serde_json::to_vec(&policy).unwrap()).unwrap();
        let parsed = parse_compaction_setting(Some(path.to_string_lossy().as_ref()))
            .unwrap()
            .unwrap();
        assert!(!parsed.auto);
        assert_eq!(parsed.threshold_ratio, 0.7);
        let _ = std::fs::remove_file(path);
    }
}
