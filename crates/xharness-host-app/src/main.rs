use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

mod config;

use config::{ModelDeployment, SingleModelDeployment};
use tokio::net::TcpListener;
use xharness_agent::FileLeaseManager;
use xharness_api::ApiBackend;
use xharness_control::{ControlStore, JsonlControlStore};
use xharness_core::IdentityContextPolicy;
use xharness_host::{BasicHost, DurableLoopAgentRuntime, HostConfig};
use xharness_host_app::NativeToolFactory;
use xharness_provider_openai::OpenAiProtocol;
use xharness_server::{serve, web_router};
use xharness_session::Store;
use xharness_session_jsonl::JsonlSessionStore;
use xharness_web::WebRuntime;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse()?;
    let workspace = std::fs::canonicalize(&args.workspace)?;
    let deployment = match &args.providers_file {
        Some(path) => ModelDeployment::from_file(path)?,
        None => ModelDeployment::single(SingleModelDeployment {
            provider: args.provider.clone(),
            model: args.model.clone(),
            base_url: args.base_url.clone(),
            api_key: args.api_key.clone(),
            protocol: args.protocol,
            context_window_tokens: args.context_window_tokens,
            max_output_tokens: args.max_output_tokens,
            token_safety_margin: args.token_safety_margin,
        })?,
    };
    let mut config = HostConfig::new(&workspace);
    config.provider_id = deployment.default_route.provider.clone();
    config.provider_display_name = deployment.default_provider_display_name.clone();
    config.model_id = deployment.default_route.model.clone();
    config.token_guard = deployment.default_token_guard.clone();
    let tools = NativeToolFactory::new(WebRuntime::default());
    let sessions_dir = args.state_dir.join("sessions");
    let leases_dir = args.state_dir.join("leases");
    let control_dir = args.state_dir.join("control");
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(sessions_dir)?);
    let control_store: Arc<dyn ControlStore> = Arc::new(JsonlControlStore::new(control_dir)?);
    let leases = Arc::new(FileLeaseManager::new(leases_dir)?);
    let runtime = Arc::new(DurableLoopAgentRuntime::from_registry(
        deployment.default_route,
        deployment.registry,
        tools,
        Arc::new(IdentityContextPolicy),
        Arc::clone(&store),
        leases,
        config.event_capacity,
    )?);
    let host = BasicHost::with_agent_runtime_and_control_store(config, runtime, control_store);
    let restore = host.restore_from_store(store).await?;
    eprintln!(
        "xharness restored {} sessions and resumed {} pending turns ({} issues)",
        restore.restored_sessions,
        restore.resumed_pending_turns,
        restore.issues.len(),
    );
    for issue in &restore.issues {
        eprintln!(
            "xharness restore issue for session {}: {}",
            issue.session_id, issue.message
        );
    }
    let backend: Arc<dyn ApiBackend> = host;
    let router = web_router(backend, args.static_dir);
    let listener = TcpListener::bind(args.bind).await?;
    eprintln!(
        "xharness host listening on http://{}",
        listener.local_addr()?
    );
    serve(listener, router, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
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
    token_safety_margin: u64,
    providers_file: Option<PathBuf>,
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
        let mut token_safety_margin = env_u64("XHARNESS_TOKEN_SAFETY_MARGIN", 1_024)?;
        let mut providers_file = env::var_os("XHARNESS_PROVIDERS_FILE").map(PathBuf::from);

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
                "--token-safety-margin" => {
                    token_safety_margin = parse_u64("--token-safety-margin", &value)?
                }
                "--providers-file" => providers_file = Some(PathBuf::from(value)),
                _ => return Err(format!("unknown argument {argument:?}")),
            }
        }
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
            token_safety_margin,
            providers_file,
        })
    }
}

fn default_state_dir() -> PathBuf {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/XHarness")
    } else if let Some(data_home) = env::var_os("XDG_DATA_HOME") {
        PathBuf::from(data_home).join("xharness")
    } else {
        home.join(".local/share/xharness")
    }
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
}
