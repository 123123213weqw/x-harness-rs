//! Personal environment carrier. Each immutable upstream has a distinct browser
//! origin: RPC, event streams, drafts and IndexedDB cannot switch underneath an
//! existing conversation. This is connection routing, NOT session migration.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

mod auth;
mod config;
mod upstream;
pub use config::{EnvironmentConfig, EnvironmentKind, GatewayConfig};

use axum::{extract::State, http::header, routing::get, Json, Router};
use serde_json::{json, Value};
use std::{io, path::PathBuf, sync::Arc, time::Duration};
use tokio::{net::TcpListener, task::JoinSet};
use tokio_util::sync::CancellationToken;
use upstream::Upstream;
use xharness_server::{serve, web_assets};

/// All listeners bind before any task is started. A broken configuration never
/// leaves a half-started set of personal environment listeners behind.
pub struct EnvironmentGateway {
    tasks: JoinSet<io::Result<()>>,
    stop: CancellationToken,
}
impl EnvironmentGateway {
    pub async fn start(config: GatewayConfig, static_dir: PathBuf) -> io::Result<Self> {
        config.validate()?;
        if !static_dir.join("index.html").is_file() {
            return Err(io::Error::other("environment UI directory is unavailable"));
        }
        let launch_token = config::read_token(&config.launch_token_file)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| io::Error::other("environment HTTP carrier unavailable"))?;
        let stop = CancellationToken::new();
        let mut pending = Vec::new();
        let catalogue: Vec<Value> = config
            .environments
            .iter()
            .map(|e| {
                json!({
                    "id":e.id,"label":e.label,"kind":e.kind,"href":format!("http://{}/",e.listen),
                })
            })
            .collect();
        for environment in config.environments {
            let token = config::read_token(&environment.token_file)?;
            let listener = TcpListener::bind(environment.listen).await?;
            let upstream = Arc::new(Upstream::new(
                client.clone(),
                environment.upstream.clone(),
                token,
                stop.clone(),
            ));
            let state = Catalogue {
                current: environment.id,
                entries: catalogue.clone(),
                workspace_profile: config.workspace_profile,
            };
            let extension = Router::new()
                .route("/api/environments", get(describe))
                .with_state(state);
            let router = upstream::routes(upstream)
                .merge(extension)
                .merge(web_assets(static_dir.clone()));
            let router = auth::protect(router, launch_token.clone(), environment.listen);
            pending.push((listener, router));
        }
        let mut tasks = JoinSet::new();
        for (listener, router) in pending {
            tasks.spawn(serve(listener, router, stop.clone().cancelled_owned()));
        }
        Ok(Self { tasks, stop })
    }
    /// Unexpected accept-loop completion is observed, not silently detached.
    pub async fn wait_failure(&mut self) -> io::Result<()> {
        match self.tasks.join_next().await {
            Some(Ok(Err(error))) => Err(error),
            Some(Err(_)) => Err(io::Error::other("environment carrier task failed")),
            _ => Err(io::Error::other("environment carrier stopped unexpectedly")),
        }
    }
    /// Gateway shutdown closes carriers only. It cannot stop, move or replay a
    /// task owned by either upstream Host.
    pub async fn shutdown(mut self) -> io::Result<()> {
        self.stop.cancel();
        let mut failed = false;
        if tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(result) = self.tasks.join_next().await {
                if !matches!(result, Ok(Ok(()))) {
                    failed = true;
                }
            }
        })
        .await
        .is_err()
        {
            // Upgraded downlinks may remain open. Observe every aborted carrier;
            // there are no Provider/Tool/process tasks in this JoinSet.
            self.tasks.abort_all();
            while let Some(result) = self.tasks.join_next().await {
                if !matches!(result, Err(ref e) if e.is_cancelled()) {
                    failed = true;
                }
            }
        }
        if failed {
            Err(io::Error::other("environment carrier cleanup failed"))
        } else {
            Ok(())
        }
    }
}
#[derive(Clone)]
struct Catalogue {
    current: String,
    entries: Vec<Value>,
    workspace_profile: Option<xharness_cloud::workspace_profile::WorkspaceProfile>,
}
async fn describe(
    State(state): State<Catalogue>,
) -> ([(header::HeaderName, &'static str); 1], Json<Value>) {
    let mut value = json!({"version":1,"current":state.current,"entries":state.entries,
        "sessionMigration":false,"workspaceSync":false});
    if let Some(profile) = state.workspace_profile {
        // Desired preset only, never a claim that cross-machine sync or task
        // execution has been installed. Old carriers keep the exact v1 shape.
        value["workspaceProfile"] = json!({"preset":profile,"state":"pending"});
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(value))
}
