//! Owner-configured READ-ONLY machine endpoint. No browser roots, apply, pair
//! registration, control-record reads, task migration or product enablement RPC.
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

use crate::workspace_inventory::{
    capture_workspace_inventory, policy_ref, WorkspaceInventoryError,
};
use axum::{
    body::Body,
    extract::{rejection::JsonRejection, DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Arc};
use xharness_cloud::{
    workspace_sync::{classify_capture_path, CapturePathClass},
    CloudError,
};
use xharness_fs::{inventory::InventoryLimits, workspace_apply::ApplyError, FsService};
use xharness_server::workspace_identity::{self, ProofError};
pub const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
#[derive(Debug)]
pub enum ExportError {
    Invalid,
    Native(ApplyError),
    Inventory(WorkspaceInventoryError),
    Domain(CloudError),
    Encoding(serde_json::Error),
    Proof(ProofError),
    Limit,
}
impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("native workspace read endpoint failed")
    }
}
impl std::error::Error for ExportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Native(e) => Some(e),
            Self::Inventory(e) => Some(e),
            Self::Domain(e) => Some(e),
            Self::Encoding(e) => Some(e),
            Self::Proof(e) => Some(e),
            _ => None,
        }
    }
}
impl From<ApplyError> for ExportError {
    fn from(e: ApplyError) -> Self {
        Self::Native(e)
    }
}
impl From<WorkspaceInventoryError> for ExportError {
    fn from(e: WorkspaceInventoryError) -> Self {
        Self::Inventory(e)
    }
}
impl From<CloudError> for ExportError {
    fn from(e: CloudError) -> Self {
        Self::Domain(e)
    }
}
impl From<serde_json::Error> for ExportError {
    fn from(e: serde_json::Error) -> Self {
        Self::Encoding(e)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportFile {
    pub path: String,
    pub exact: String,
    pub sha256: String,
    pub bytes: u64,
    pub executable: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub scope: String,
    pub manifest_sha256: String,
    pub files: Vec<ExportFile>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BlobRequest {
    pub path: String,
    pub exact: String,
    pub sha256: String,
    pub bytes: u64,
}
/// Intentionally no Debug/Serialize: bearer and root capabilities cannot leak
/// into generic logs or be reconstructed from a browser's metadata document.
#[derive(Clone)]
pub struct WorkspaceExport {
    service: FsService,
    token: Arc<String>,
    scope: String,
}
impl WorkspaceExport {
    pub fn new(service: FsService, token: String) -> Result<Self, ExportError> {
        if !hex64(&token) {
            return Err(ExportError::Invalid);
        }
        let lease = service.export_lease()?;
        let scope = format!(
            "{:x}",
            Sha256::digest(format!(
                "xh-workspace-read-scope/v1\n{}\n{}",
                lease.root_identity()?,
                serde_json::to_string(&policy_ref()?)?
            ))
        );
        drop(lease);
        Ok(Self {
            service,
            token: Arc::new(token),
            scope,
        })
    }
    pub fn scope(&self) -> &str {
        &self.scope
    }
    pub fn snapshot(&self) -> Result<Snapshot, ExportError> {
        let lease = self.service.export_lease()?;
        let limits = InventoryLimits {
            files: 256,
            entries: 4096,
            directories: 1024,
            metadata_bytes: 1024 * 1024,
            file_bytes: MAX_EXPORT_BYTES,
            total_bytes: MAX_EXPORT_BYTES as u64,
            ..InventoryLimits::default()
        };
        let captured = capture_workspace_inventory(lease.service(), limits)?;
        let mut files = Vec::new();
        for (path, file) in captured.manifest().files() {
            let native = lease.probe(path)?.ok_or(ExportError::Invalid)?;
            if native.sha256 != file.sha256.as_str()
                || native.bytes != file.bytes.0
                || native.executable != file.executable
            {
                return Err(ExportError::Invalid);
            }
            files.push(ExportFile {
                path: path.clone(),
                exact: native.exact,
                sha256: native.sha256,
                bytes: native.bytes,
                executable: native.executable,
            });
        }
        captured.revalidate(lease.service())?;
        let snapshot = Snapshot {
            scope: self.scope.clone(),
            manifest_sha256: captured.manifest().digest()?.as_str().into(),
            files,
        };
        if serde_json::to_vec(&snapshot)?.len() > MAX_RESPONSE_BYTES {
            return Err(ExportError::Limit);
        }
        Ok(snapshot)
    }
    pub fn blob(&self, request: &BlobRequest) -> Result<Vec<u8>, ExportError> {
        if !hex64(&request.exact)
            || !hex64(&request.sha256)
            || request.bytes > MAX_EXPORT_BYTES as u64
        {
            return Err(ExportError::Limit);
        }
        if classify_capture_path(&request.path)? != CapturePathClass::Include {
            return Err(ExportError::Invalid);
        }
        let lease = self.service.export_lease()?;
        let bytes = lease.export_bytes(&request.path, &request.exact, MAX_EXPORT_BYTES)?;
        if bytes.len() as u64 != request.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != request.sha256
        {
            return Err(ExportError::Invalid);
        }
        Ok(bytes)
    }
    /// Loopback only. Auth runs before JSON extraction; no cookie authority,
    /// CORS, ambient proxies or browser-selected root/environment is accepted.
    pub fn router(self, address: SocketAddr) -> Result<Router, ExportError> {
        if !address.ip().is_loopback() {
            return Err(ExportError::Invalid);
        }
        let state = Arc::new(HttpState {
            export: self,
            host: address.to_string(),
        });
        Ok(Router::new()
            .route("/identity", get(identity))
            .route("/snapshot", get(snapshot))
            .route("/blob", post(blob))
            .layer(DefaultBodyLimit::max(8192))
            .layer(middleware::from_fn_with_state(state.clone(), authorize))
            .with_state(state))
    }
}
fn hex64(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
struct HttpState {
    export: WorkspaceExport,
    host: String,
}
fn response_error(error: ExportError) -> Response {
    let (status, kind) = match &error {
        ExportError::Native(ApplyError::Busy) => (StatusCode::CONFLICT, "busy"),
        ExportError::Native(ApplyError::Changed) => (StatusCode::CONFLICT, "changed"),
        ExportError::Invalid
        | ExportError::Domain(_)
        | ExportError::Proof(ProofError::InvalidInput) => (StatusCode::BAD_REQUEST, "invalid"),
        ExportError::Limit | ExportError::Native(ApplyError::Limit) => {
            (StatusCode::PAYLOAD_TOO_LARGE, "limit")
        }
        _ => (StatusCode::SERVICE_UNAVAILABLE, "native_unavailable"),
    };
    // Owning API boundary only. Never print payloads, IDs, paths or raw causes.
    eprintln!("workspace read endpoint failed: {kind}");
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"error":kind})),
    )
        .into_response()
}
fn fixed_error(status: StatusCode) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"error":"request_rejected"})),
    )
        .into_response()
}
async fn authorize(
    State(state): State<Arc<HttpState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let headers = request.headers();
    if !valid_headers(headers, &state.host) {
        return fixed_error(StatusCode::FORBIDDEN);
    }
    if request.uri().path() != "/identity" {
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "));
        let Some(bearer) = bearer else {
            return fixed_error(StatusCode::UNAUTHORIZED);
        };
        if bearer.len() != state.export.token.len()
            || bearer
                .bytes()
                .zip(state.export.token.bytes())
                .fold(0u8, |a, (x, y)| a | (x ^ y))
                != 0
        {
            return fixed_error(StatusCode::UNAUTHORIZED);
        }
    }
    next.run(request).await
}
fn valid_headers(headers: &HeaderMap, host: &str) -> bool {
    headers.get_all(header::HOST).iter().count() == 1
        && headers.get_all(header::AUTHORIZATION).iter().count() <= 1
        && headers.get(header::HOST).and_then(|v| v.to_str().ok()) == Some(host)
        && !headers.contains_key(header::ORIGIN)
        && !headers.contains_key("sec-fetch-site")
        && !headers.contains_key("forwarded")
        && !headers.contains_key("x-forwarded-host")
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityQuery {
    nonce: String,
}
async fn identity(
    State(state): State<Arc<HttpState>>,
    query: Result<Query<IdentityQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return fixed_error(StatusCode::BAD_REQUEST);
    };
    match workspace_identity::proof(&state.export.token, &query.nonce, &state.export.scope) {
        Ok(proof) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"scope":state.export.scope,"proof":proof})),
        )
            .into_response(),
        Err(e) => response_error(ExportError::Proof(e)),
    }
}
// Dedicated probe/runtime only: bounded synchronous IO, no detached blocking
// workers whose panic/completion could be lost when an HTTP request is dropped.
// Integrating this into the shared Host requires its observed native work queue.
async fn snapshot(State(state): State<Arc<HttpState>>) -> Response {
    match state.export.snapshot() {
        Ok(value) => ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response(),
        Err(error) => response_error(error),
    }
}
async fn blob(
    State(state): State<Arc<HttpState>>,
    request: Result<Json<BlobRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = request else {
        return fixed_error(StatusCode::BAD_REQUEST);
    };
    match state.export.blob(&request) {
        Ok(bytes) => (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::CONTENT_TYPE, "application/octet-stream"),
            ],
            bytes,
        )
            .into_response(),
        Err(error) => response_error(error),
    }
}
