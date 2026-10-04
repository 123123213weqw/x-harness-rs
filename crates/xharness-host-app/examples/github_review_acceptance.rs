//! Isolated acceptance carrier: real Host RPC + owned UI, no model tools, user
//! histories, writes or deployment changes. GitHub credentials stay on the
//! workstation behind an authenticated loopback bridge over SSH. Not a shipped
//! authentication mode. See docs/github-code-review.md.
use async_trait::async_trait;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcError};
use xharness_host::{BasicHost, HostConfig, NoTools};
use xharness_host_app::github_service::{GitHubReader, NativeGitHub};
struct LoopbackReader {
    client: reqwest::Client,
    origin: String,
    nonce: String,
}
#[async_trait]
impl GitHubReader for LoopbackReader {
    async fn get(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        let request = async {
            let response = self
                .client
                .get(&self.origin)
                .bearer_auth(&self.nonce)
                .query(&[("route", route)])
                .send()
                .await
                .map_err(|_| RpcError::internal("Acceptance bridge unavailable"))?;
            if !response.status().is_success() {
                return Err(RpcError::internal("Acceptance bridge read failed"));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|_| RpcError::internal("Acceptance bridge body failed"))?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(RpcError::internal("Acceptance response exceeds limit"));
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| RpcError::internal("Acceptance response is not JSON"))
        };
        tokio::select! {_ = cancel.cancelled()=>Err(RpcError::internal("Acceptance read cancelled")),value=request=>value}
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let origin = std::env::var("XHARNESS_GITHUB_ACCEPTANCE_BRIDGE")?;
    let url = reqwest::Url::parse(&origin)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Bridge must be an explicit loopback HTTP URL".into());
    }
    let nonce = std::env::var("XHARNESS_GITHUB_ACCEPTANCE_NONCE")?;
    if nonce.len() < 32 {
        return Err("Acceptance nonce too short".into());
    }
    let static_dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Supply this checkout's ui/dist directory")?,
    );
    let workspace =
        std::env::temp_dir().join(format!("xharness-github-acceptance-{}", std::process::id()));
    std::fs::create_dir_all(&workspace)?;
    let host = BasicHost::new(HostConfig::new(&workspace), None, Arc::new(NoTools));
    host.install_github(Arc::new(NativeGitHub::new(Arc::new(LoopbackReader {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(40))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        origin,
        nonce,
    }))))?;
    let backend: Arc<dyn ApiBackend> = host;
    let router = xharness_server::web_router(backend, Some(static_dir));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:33942").await?;
    println!("Isolated Code Review acceptance ready on 127.0.0.1:33942");
    xharness_server::serve(listener, router, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    let _ = std::fs::remove_dir_all(workspace);
    Ok(())
}
