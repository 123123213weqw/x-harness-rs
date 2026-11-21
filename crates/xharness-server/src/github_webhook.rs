//! Opt-in, metadata-only GitHub invalidation receiver. This is not a Host API,
//! OAuth proxy, scheduler or Agent trigger. The caller supplies private secrets
//! and exposes this dedicated loopback router through a verified HTTPS proxy.
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

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{watch, Semaphore};

pub const MAX_REPOSITORIES: usize = 64;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const DELIVERY_WINDOW: usize = 512;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

pub struct Hook {
    pub route: String,
    pub repository_id: u64,
    pub secret: Vec<u8>,
}
pub struct Subscriber {
    pub token: Vec<u8>,
    pub repository_ids: BTreeSet<u64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Revision {
    pub repository_id: u64,
    pub node_id: String,
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: u8,
    pub repositories: Vec<Revision>,
}
impl Snapshot {
    pub fn validate(&self) -> bool {
        self.schema == 1 && self.repositories.len() <= MAX_REPOSITORIES && {
            let mut ids = BTreeSet::new();
            let mut nodes = BTreeSet::new();
            self.repositories.iter().all(|r| {
                r.repository_id > 0
                    && valid_node_id(&r.node_id)
                    && r.revision > 0
                    && r.revision <= MAX_REVISION
                    && ids.insert(r.repository_id)
                    && nodes.insert(&r.node_id)
            })
        }
    }
}
pub fn valid_node_id(id: &str) -> bool {
    (8..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+' | b'/' | b'='))
}
fn valid_delivery(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn valid_secret(v: &[u8]) -> bool {
    (64..=256).contains(&v.len()) && v.iter().all(u8::is_ascii_graphic)
}
fn valid_route(v: &str) -> bool {
    (16..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn verify(secret: &[u8], bytes: &[u8], signature: &str) -> bool {
    let Some(hex) = signature.strip_prefix("sha256=").filter(|v| v.len() == 64) else {
        return false;
    };
    let mut expected = [0u8; 32];
    for (i, pair) in hex.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let Some(a) = char::from(pair[0]).to_digit(16) else {
            return false;
        };
        let Some(b) = char::from(pair[1]).to_digit(16) else {
            return false;
        };
        expected[i] = ((a << 4) | b) as u8;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret) else {
        return false;
    };
    mac.update(bytes);
    mac.verify_slice(&expected).is_ok()
}
fn token_matches(expected: &[u8], supplied: &[u8]) -> bool {
    if !valid_secret(supplied) {
        return false;
    }
    let (Ok(mut expected_mac), Ok(mut actual_mac)) = (
        Hmac::<Sha256>::new_from_slice(expected),
        Hmac::<Sha256>::new_from_slice(supplied),
    ) else {
        return false;
    };
    expected_mac.update(b"xharness-github-events-v1");
    actual_mac.update(b"xharness-github-events-v1");
    expected_mac
        .verify_slice(&actual_mac.finalize().into_bytes())
        .is_ok()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    node_id: String,
    revision: u64,
    deliveries: VecDeque<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    schema: u8,
    repositories: BTreeMap<u64, Row>,
}
struct LedgerState {
    ledger: Ledger,
    poisoned: bool,
}
struct Inner {
    hooks: Vec<Hook>,
    subscribers: Vec<Subscriber>,
    file: PathBuf,
    _lease: File,
    state: Mutex<LedgerState>,
    changes: watch::Sender<Option<Snapshot>>,
    connections: Arc<Semaphore>,
    ingress: Arc<Semaphore>,
    writer: Arc<Semaphore>,
}
#[derive(Clone)]
pub struct Receiver(Arc<Inner>);
fn config_error() -> std::io::Error {
    std::io::Error::other("GitHub receiver configuration or state is invalid")
}
fn private_file(path: &FsPath, create: bool) -> std::io::Result<File> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
    {
        return Err(config_error());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
fn snapshot(ledger: &Ledger) -> Snapshot {
    Snapshot {
        schema: 1,
        repositories: ledger
            .repositories
            .iter()
            .map(|(&id, r)| Revision {
                repository_id: id,
                node_id: r.node_id.clone(),
                revision: r.revision,
            })
            .collect(),
    }
}
impl Receiver {
    /// Local filesystem operations are intentionally synchronous and bounded.
    /// Run this small standalone receiver on a local durable volume, not in the
    /// model Host reactor or on a slow network filesystem. No detached writer
    /// can outlive request ownership or acknowledge before the durable rename.
    pub fn open(
        file: PathBuf,
        hooks: Vec<Hook>,
        subscribers: Vec<Subscriber>,
    ) -> std::io::Result<Self> {
        if !file.is_absolute()
            || hooks.is_empty()
            || hooks.len() > MAX_REPOSITORIES
            || subscribers.is_empty()
            || subscribers.len() > 32
        {
            return Err(config_error());
        }
        let mut ids = BTreeSet::new();
        let mut routes = BTreeSet::new();
        if !hooks.iter().all(|h| {
            h.repository_id > 0
                && valid_route(&h.route)
                && valid_secret(&h.secret)
                && ids.insert(h.repository_id)
                && routes.insert(&h.route)
        }) {
            return Err(config_error());
        }
        if !subscribers.iter().all(|s| {
            valid_secret(&s.token)
                && !s.repository_ids.is_empty()
                && s.repository_ids.is_subset(&ids)
                && hooks.iter().all(|h| !token_matches(&h.secret, &s.token))
        }) {
            return Err(config_error());
        }
        for (i, s) in subscribers.iter().enumerate() {
            if subscribers[..i]
                .iter()
                .any(|p| token_matches(&p.token, &s.token))
            {
                return Err(config_error());
            }
        }
        let parent = file.parent().ok_or_else(config_error)?;
        std::fs::create_dir_all(parent)?;
        let lease = private_file(&file.with_extension("lock"), true)?;
        lease.try_lock().map_err(|_| config_error())?;
        let pending = file.with_extension("pending");
        match pending.symlink_metadata() {
            Ok(m) if m.is_file() && !m.file_type().is_symlink() => std::fs::remove_file(&pending)?,
            Ok(_) => return Err(config_error()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let ledger = match file.symlink_metadata() {
            Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= MAX_BYTES as u64 => {
                let mut data = Vec::new();
                File::open(&file)?
                    .take(MAX_BYTES as u64 + 1)
                    .read_to_end(&mut data)?;
                if data.len() > MAX_BYTES {
                    return Err(config_error());
                }
                serde_json::from_slice::<Ledger>(&data).map_err(|_| config_error())?
            }
            Ok(_) => return Err(config_error()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ledger {
                schema: 1,
                repositories: BTreeMap::new(),
            },
            Err(e) => return Err(e),
        };
        if ledger.schema != 1
            || !snapshot(&ledger).validate()
            || !ledger.repositories.keys().all(|id| ids.contains(id))
            || ledger.repositories.values().any(|r| {
                r.deliveries.len() > DELIVERY_WINDOW
                    || r.deliveries.iter().any(|d| !valid_delivery(d))
                    || r.deliveries.iter().collect::<BTreeSet<_>>().len() != r.deliveries.len()
            })
        {
            return Err(config_error());
        }
        let (changes, _) = watch::channel(Some(snapshot(&ledger)));
        Ok(Self(Arc::new(Inner {
            hooks,
            subscribers,
            file,
            _lease: lease,
            state: Mutex::new(LedgerState {
                ledger,
                poisoned: false,
            }),
            changes,
            connections: Arc::new(Semaphore::new(32)),
            ingress: Arc::new(Semaphore::new(16)),
            writer: Arc::new(Semaphore::new(1)),
        })))
    }
    pub fn router(self) -> Router {
        Router::new()
            .route("/github/hooks/{route}", post(delivery))
            .route("/github/events", get(events))
            .layer(DefaultBodyLimit::max(MAX_BYTES))
            .layer(middleware::from_fn_with_state(self.clone(), bound_request))
            .with_state(self)
    }
    fn ingest(&self, route: &str, headers: &HeaderMap, bytes: &[u8]) -> Result<(), StatusCode> {
        let hook = self
            .0
            .hooks
            .iter()
            .find(|h| h.route == route)
            .ok_or(StatusCode::NOT_FOUND)?;
        let signature = headers
            .get("x-hub-signature-256")
            .and_then(|v| v.to_str().ok())
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if !verify(&hook.secret, bytes, signature) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            != Some("application/json")
        {
            return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
        let id = headers
            .get("x-github-delivery")
            .and_then(|v| v.to_str().ok())
            .filter(|v| valid_delivery(v))
            .ok_or(StatusCode::BAD_REQUEST)?;
        let event = headers
            .get("x-github-event")
            .and_then(|v| v.to_str().ok())
            .ok_or(StatusCode::BAD_REQUEST)?;
        let payload: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
        if payload["repository"]["id"].as_u64() != Some(hook.repository_id) {
            return Err(StatusCode::FORBIDDEN);
        }
        let node = payload["repository"]["node_id"]
            .as_str()
            .filter(|v| valid_node_id(v))
            .ok_or(StatusCode::BAD_REQUEST)?;
        let relevant = match event {
            "ping" => false,
            "pull_request" => matches!(
                payload["action"].as_str(),
                Some(
                    "opened"
                        | "reopened"
                        | "synchronize"
                        | "closed"
                        | "ready_for_review"
                        | "converted_to_draft"
                        | "edited"
                )
            ),
            "workflow_run" => matches!(
                payload["action"].as_str(),
                Some("requested" | "in_progress" | "completed")
            ),
            _ => false,
        };
        if !relevant {
            return Ok(());
        }
        let mut state = self
            .0
            .state
            .try_lock()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if state.poisoned {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        if state
            .ledger
            .repositories
            .get(&hook.repository_id)
            .is_some_and(|r| r.deliveries.iter().any(|d| d == id))
        {
            return Ok(());
        }
        let mut next = state.ledger.clone();
        let row = next
            .repositories
            .entry(hook.repository_id)
            .or_insert_with(|| Row {
                node_id: node.into(),
                revision: 0,
                deliveries: VecDeque::new(),
            });
        if row.node_id != node || row.revision >= MAX_REVISION {
            return Err(StatusCode::CONFLICT);
        }
        row.revision += 1;
        row.deliveries.push_front(id.into());
        row.deliveries.truncate(DELIVERY_WINDOW);
        let next_snapshot = snapshot(&next);
        if !next_snapshot.validate() {
            return Err(StatusCode::CONFLICT);
        }
        if persist(&self.0.file, &next).is_err() {
            state.poisoned = true;
            drop(self.0.changes.send_replace(None));
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        drop(self.0.changes.send_replace(Some(next_snapshot)));
        state.ledger = next;
        Ok(())
    }
}
fn persist(file: &FsPath, ledger: &Ledger) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(ledger).map_err(|_| config_error())?;
    if bytes.len() > MAX_BYTES {
        return Err(config_error());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let pending = file.with_extension("pending");
    let mut output = options.open(&pending)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);
    std::fs::rename(pending, file)?;
    #[cfg(unix)]
    File::open(file.parent().ok_or_else(config_error)?)?.sync_all()?;
    Ok(())
}
async fn bound_request(State(receiver): State<Receiver>, request: Request, next: Next) -> Response {
    let Ok(_permit) = receiver.0.ingress.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    next.run(request).await
}
async fn delivery(
    State(receiver): State<Receiver>,
    Path(route): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> StatusCode {
    // Bounded async admission BEFORE the synchronous durable write. A normal
    // burst waits rather than losing the last CI notification to a busy lock.
    let _writer = match tokio::time::timeout(
        Duration::from_secs(8),
        receiver.0.writer.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => return StatusCode::SERVICE_UNAVAILABLE,
    };
    match receiver.ingest(&route, &headers, &bytes) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(status) => status,
    }
}
async fn events(State(receiver): State<Receiver>, headers: HeaderMap) -> Response {
    // Native-only stream: no URL credential, cookie authentication or browser origin.
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(subscriber) = receiver
        .0
        .subscribers
        .iter()
        .find(|s| token_matches(&s.token, token.as_bytes()))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Ok(permit) = receiver.0.connections.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let changes = receiver.0.changes.subscribe();
    if changes.borrow().is_none() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let allowed = subscriber.repository_ids.clone();
    let stream = futures::stream::unfold(
        (changes, true, permit, allowed),
        |(mut rx, first, permit, allowed)| async move {
            if !first {
                tokio::select! { result=rx.changed()=>if result.is_err(){return None}, _=tokio::time::sleep(Duration::from_secs(15))=>return Some((Ok::<_,std::io::Error>(Bytes::from_static(b"\n")),(rx,false,permit,allowed)))}
            }
            let mut value = rx.borrow_and_update().clone()?;
            value
                .repositories
                .retain(|r| allowed.contains(&r.repository_id));
            let mut bytes = match serde_json::to_vec(&value) {
                Ok(v) => v,
                Err(_) => {
                    return Some((
                        Err(std::io::Error::other("event encoding failed")),
                        (rx, false, permit, allowed),
                    ))
                }
            };
            bytes.push(b'\n');
            Some((Ok(Bytes::from(bytes)), (rx, false, permit, allowed)))
        },
    );
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

#[cfg(test)]
#[path = "github_webhook_tests.rs"]
mod tests;
