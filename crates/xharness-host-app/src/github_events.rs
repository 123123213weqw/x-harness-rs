//! Optional native bridge from a dedicated, authenticated HTTPS invalidation
//! stream to the existing Host/UI downlink. No Agent, session or GitHub mutation.
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

use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use xharness_host::BasicHost;
use xharness_server::github_webhook::{Hook, Receiver, Snapshot, Subscriber, MAX_FRAME_BYTES};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Configuration,
    Authentication,
    Transport,
    Protocol,
}
fn read_private(path: &Path, max: usize) -> Result<Vec<u8>, Failure> {
    if !path.is_absolute() {
        return Err(Failure::Configuration);
    }
    let metadata = path
        .symlink_metadata()
        .map_err(|_| Failure::Configuration)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max as u64 {
        return Err(Failure::Configuration);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Failure::Configuration);
        }
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| Failure::Configuration)?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Configuration)?;
    if bytes.len() > max {
        return Err(Failure::Configuration);
    }
    Ok(bytes)
}
fn secret(path: &Path) -> Result<Vec<u8>, Failure> {
    let bytes = read_private(path, 258)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Failure::Configuration)?
        .trim();
    if !(64..=256).contains(&text.len()) || !text.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(Failure::Configuration);
    }
    Ok(text.as_bytes().to_vec())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiverConfig {
    bind: SocketAddr,
    state_dir: PathBuf,
    hooks: Vec<HookConfig>,
    hosts: Vec<HostConfig>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HookConfig {
    route: String,
    repository_id: u64,
    secret_file: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostConfig {
    token_file: PathBuf,
    repository_ids: BTreeSet<u64>,
}
/// Standalone receiver only. This never attaches routes to the desktop Host.
pub async fn serve_receiver(path: &Path) -> Result<(), Failure> {
    let config: ReceiverConfig = serde_json::from_slice(&read_private(path, MAX_FRAME_BYTES)?)
        .map_err(|_| Failure::Configuration)?;
    if !config.bind.ip().is_loopback() || !config.state_dir.is_absolute() {
        return Err(Failure::Configuration);
    }
    if config
        .state_dir
        .symlink_metadata()
        .is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink())
    {
        return Err(Failure::Configuration);
    }
    let reserved = [
        config.state_dir.join("revisions.json"),
        config.state_dir.join("revisions.pending"),
        config.state_dir.join("revisions.lock"),
    ];
    if reserved.iter().any(|p| p == path)
        || config
            .hooks
            .iter()
            .any(|h| reserved.contains(&h.secret_file))
        || config
            .hosts
            .iter()
            .any(|h| reserved.contains(&h.token_file))
    {
        return Err(Failure::Configuration);
    }
    let hooks = config
        .hooks
        .into_iter()
        .map(|c| {
            Ok(Hook {
                route: c.route,
                repository_id: c.repository_id,
                secret: secret(&c.secret_file)?,
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    let hosts = config
        .hosts
        .into_iter()
        .map(|c| {
            Ok(Subscriber {
                token: secret(&c.token_file)?,
                repository_ids: c.repository_ids,
            })
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    let receiver = Receiver::open(config.state_dir.join("revisions.json"), hooks, hosts)
        .map_err(|_| Failure::Configuration)?;
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|_| Failure::Transport)?;
    axum::serve(listener, receiver.router())
        .await
        .map_err(|_| Failure::Transport)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientConfig {
    url: String,
    token_file: PathBuf,
}
struct Client {
    url: reqwest::Url,
    token: reqwest::header::HeaderValue,
    http: reqwest::Client,
}
impl Client {
    fn from_file(path: &Path) -> Result<Self, Failure> {
        let config: ClientConfig = serde_json::from_slice(&read_private(path, MAX_FRAME_BYTES)?)
            .map_err(|_| Failure::Configuration)?;
        Self::new(&config.url, &secret(&config.token_file)?)
    }
    fn new(raw: &str, token: &[u8]) -> Result<Self, Failure> {
        let url = reqwest::Url::parse(raw).map_err(|_| Failure::Configuration)?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/github/events"
            || !(url.scheme() == "https"
                || url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1")))
        {
            return Err(Failure::Configuration);
        }
        let text = std::str::from_utf8(token).map_err(|_| Failure::Configuration)?;
        if !(64..=256).contains(&text.len()) || !text.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(Failure::Configuration);
        }
        let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {text}"))
            .map_err(|_| Failure::Configuration)?;
        value.set_sensitive(true);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .user_agent("XHarness-GitHub-events")
            .build()
            .map_err(|_| Failure::Configuration)?;
        Ok(Self {
            url,
            token: value,
            http,
        })
    }
    async fn connect(&self, mut publish: impl FnMut(Vec<String>, bool)) -> Result<(), Failure> {
        let mut response = tokio::time::timeout(
            Duration::from_secs(15),
            self.http
                .get(self.url.clone())
                .header(reqwest::header::AUTHORIZATION, self.token.clone())
                .send(),
        )
        .await
        .map_err(|_| Failure::Transport)?
        .map_err(|_| Failure::Transport)?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => return Err(Failure::Authentication),
            _ => return Err(Failure::Transport),
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            != Some("application/x-ndjson")
        {
            return Err(Failure::Protocol);
        }
        let mut parser = Parser::default();
        let mut versions = BTreeMap::new();
        let mut first = true;
        loop {
            let bytes = tokio::time::timeout(Duration::from_secs(45), response.chunk())
                .await
                .map_err(|_| Failure::Transport)?
                .map_err(|_| Failure::Transport)?
                .ok_or(Failure::Transport)?;
            for snapshot in parser.push(&bytes)? {
                let current: BTreeMap<_, _> = snapshot
                    .repositories
                    .iter()
                    .map(|r| (r.repository_id, (r.node_id.clone(), r.revision)))
                    .collect();
                let changed = changed_nodes(&versions, &current);
                if first || !changed.is_empty() {
                    publish(changed, first)
                }
                versions = current;
                first = false;
            }
        }
    }
}
fn changed_nodes(
    previous: &BTreeMap<u64, (String, u64)>,
    next: &BTreeMap<u64, (String, u64)>,
) -> Vec<String> {
    let mut nodes = BTreeSet::new();
    for (id, value) in next {
        if previous.get(id) != Some(value) {
            nodes.insert(value.0.clone());
            if let Some(old) = previous.get(id) {
                nodes.insert(old.0.clone());
            }
        }
    }
    for (id, value) in previous {
        if !next.contains_key(id) {
            nodes.insert(value.0.clone());
        }
    }
    nodes.into_iter().collect()
}
#[derive(Default)]
struct Parser {
    pending: Vec<u8>,
}
impl Parser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Snapshot>, Failure> {
        let mut values = Vec::new();
        for piece in bytes.split_inclusive(|b| *b == b'\n') {
            if self.pending.len() + piece.len() > MAX_FRAME_BYTES {
                return Err(Failure::Protocol);
            }
            self.pending.extend_from_slice(piece);
            if piece.last() == Some(&b'\n') {
                self.pending.truncate(self.pending.len() - 1);
                if !self.pending.is_empty() {
                    let value: Snapshot =
                        serde_json::from_slice(&self.pending).map_err(|_| Failure::Protocol)?;
                    if !value.validate() {
                        return Err(Failure::Protocol);
                    }
                    // Each document is a complete revision snapshot. Retain
                    // only the newest per chunk; bursts never build a backlog.
                    values.clear();
                    values.push(value);
                }
                self.pending.clear();
            }
        }
        Ok(values)
    }
}
/// Polled inside the existing Host shutdown select, never detached. Dropping
/// this future closes the HTTP stream before Host drain. None does no IO.
/// Backoff reconnects the receiver only; it never periodically queries GitHub.
pub async fn run_configured(host: Arc<BasicHost>, config: Option<PathBuf>) {
    let Some(path) = config else {
        return std::future::pending().await;
    };
    let client = match Client::from_file(&path) {
        Ok(v) => v,
        Err(_) => {
            report_disconnect(&host);
            return std::future::pending().await;
        }
    };
    let mut delay = 1u64;
    let mut disconnected = false;
    loop {
        let mut connected = false;
        let result = client
            .connect(|ids, reset| {
                connected = true;
                if host
                    .publish_github_project_signal(&ids, reset, true)
                    .is_err()
                {
                    xharness_diagnostics::diagnostic_stderr!("GitHub event signal rejected");
                }
            })
            .await;
        if connected {
            delay = 1;
            disconnected = false;
        }
        if !disconnected {
            report_disconnect(&host);
            disconnected = true;
        }
        if matches!(
            result,
            Err(Failure::Authentication | Failure::Protocol | Failure::Configuration)
        ) {
            return std::future::pending().await;
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(30);
    }
}
fn report_disconnect(host: &BasicHost) {
    xharness_diagnostics::record_failure(xharness_diagnostics::FailureCode::Rpc);
    xharness_diagnostics::diagnostic_stderr!(
        "GitHub event connection unavailable; manual refresh remains available"
    );
    if host
        .publish_github_project_signal(&[], false, false)
        .is_err()
    {
        xharness_diagnostics::diagnostic_stderr!("GitHub disconnected signal rejected");
    }
}

#[cfg(test)]
#[path = "github_events_tests.rs"]
mod tests;
