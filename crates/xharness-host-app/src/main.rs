use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use tokio::net::TcpListener;
use xharness_api::ApiBackend;
use xharness_host::{BasicHost, HostConfig};
use xharness_host_app::NativeToolFactory;
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
use xharness_server::{serve, web_router};
use xharness_web::WebRuntime;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse()?;
    let workspace = std::fs::canonicalize(&args.workspace)?;
    let mut config = HostConfig::new(&workspace);
    config.provider_id = args.provider.clone();
    config.provider_display_name = args.provider.clone();
    config.model_id = args.model.clone();

    let provider = if args.model == "unconfigured" {
        None
    } else {
        Some(Arc::new(OpenAiProvider::new(OpenAiProviderConfig::new(
            args.protocol,
            args.base_url,
            args.api_key,
            &args.model,
        ))?) as Arc<dyn xharness_core::ModelProvider>)
    };
    let tools = NativeToolFactory::new(WebRuntime::default());
    let host = BasicHost::new(config, provider, tools);
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
        })
    }
}

fn env_value(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_owned())
}

fn parse_protocol(value: &str) -> Result<OpenAiProtocol, String> {
    match value {
        "chat" | "chat-completions" => Ok(OpenAiProtocol::ChatCompletions),
        "responses" => Ok(OpenAiProtocol::Responses),
        _ => Err(format!(
            "unsupported protocol {value:?}; use chat or responses"
        )),
    }
}
