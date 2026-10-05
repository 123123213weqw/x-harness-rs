//! Opt-in local/SSH loopback acceptance only. Credentials remain on the workstation.
//! No changes to production auth origins; native service/request routing is exercised.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;
use xharness_api::RpcError;
use xharness_core::IdentityContextPolicy;
use xharness_host::{
    BasicHost, DurableLoopAgentRuntime, HostConfig, ModelDescriptor, ModelRegistry, ModelRoute,
    NoTools, RegisteredModel,
};
use xharness_host_app::github_service::{GitHubReader, NativeGitHub};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};
struct Relay {
    client: reqwest::Client,
    url: String,
    nonce: String,
}
impl Relay {
    async fn call(
        &self,
        route: &str,
        body: Option<Value>,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let request = self
            .client
            .post(&self.url)
            .bearer_auth(&self.nonce)
            .json(&json!({"route":route,"body":body}));
        tokio::select! {_=cancel.cancelled()=>Err(RpcError::internal("Acceptance cancelled")),value=async{let r=request.send().await.map_err(|e|RpcError::internal(format!("Acceptance relay unavailable: {e}")))?;if !r.status().is_success(){return Err(RpcError::internal(format!("Acceptance relay returned {}",r.status())));}r.json().await.map_err(|_|RpcError::internal("Invalid acceptance relay response"))}=>value}
    }
}
#[async_trait]
impl GitHubReader for Relay {
    async fn get(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        self.call(route, None, cancel).await
    }
    async fn graphql(
        &self,
        query: &str,
        variables: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        self.call(
            "/graphql",
            Some(json!({"query":query,"variables":variables})),
            cancel,
        )
        .await
    }
    async fn logs(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        self.call(route, None, cancel).await
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let nonce = std::env::var("XHARNESS_REVIEW_NONCE")?;
    let model = std::env::var("XHARNESS_REVIEW_MODEL")?;
    let root = PathBuf::from(std::env::var("XHARNESS_REVIEW_STATE")?);
    let mut config = OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        "http://127.0.0.1:34944",
        nonce.clone(),
        model.clone(),
    );
    config.reasoning = Some(OpenAiReasoningProfile::new(
        Some("off".into()),
        vec![("off".into(), json!({"thinking":{"type":"disabled"}}))],
    )?);
    let provider = Arc::new(OpenAiProvider::new(config)?);
    let mut registry = ModelRegistry::new();
    registry.register(RegisteredModel::new(
        ModelDescriptor::new("acceptance", "Local configured DeepSeek", &model, &model),
        provider,
    ))?;
    let runtime = Arc::new(DurableLoopAgentRuntime::from_registry(
        ModelRoute::new("acceptance", &model),
        registry,
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        Arc::new(xharness_session::MemorySessionStore::default()),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        64,
    )?);
    let host = BasicHost::with_agent_runtime(HostConfig::new(&root), runtime);
    host.install_github(Arc::new(
        NativeGitHub::new(Arc::new(Relay {
            client: reqwest::Client::builder()
                .no_proxy()
                .pool_max_idle_per_host(0)
                .timeout(std::time::Duration::from_secs(110))
                .build()?,
            url: "http://127.0.0.1:34944/github".into(),
            nonce,
        }))
        .with_review_directory(root.join("reviews")),
    ))?;
    let router = xharness_server::web_router(host, Some(PathBuf::from("ui/dist")));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:34557").await?;
    eprintln!("Read-only acceptance ready on 34557");
    xharness_server::serve(listener, router, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
