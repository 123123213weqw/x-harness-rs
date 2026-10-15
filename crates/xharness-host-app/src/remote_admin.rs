//! Loopback desktop administration extension. No Bot/mobile credential is valid
//! here; no request bodies/secrets are sent through the RPC debug recorder.
use crate::{
    channel_accounts::{AccountManager, ChannelFailure, ConnectionState},
    remote_control::RemoteControl,
};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    net::SocketAddr,
    sync::{Arc, RwLock},
};
use xharness_remote::*;

#[derive(Clone)]
pub struct RemoteAdminState {
    token_hash: [u8; 32],
    address: Arc<RwLock<Option<SocketAddr>>>,
    active: Arc<RwLock<Option<Admin>>>,
}
#[derive(Clone)]
struct Admin {
    gateway: Arc<Gateway>,
    accounts: Arc<AccountManager>,
    mobile: Option<Arc<xharness_mobile::MobileHost>>,
    mobile_public_url: Option<String>,
}
impl RemoteAdminState {
    pub fn new(desktop_token: &str) -> Result<Self, String> {
        if desktop_token.len() < 32 || desktop_token.len() > 512 {
            return Err("Remote administration requires a strong desktop launch token".into());
        }
        Ok(Self {
            token_hash: Sha256::digest(desktop_token.as_bytes()).into(),
            address: Arc::new(RwLock::new(None)),
            active: Arc::new(RwLock::new(None)),
        })
    }
    pub fn bind_address(&self, address: SocketAddr) -> Result<(), String> {
        if !address.ip().is_loopback() {
            return Err("Remote administration is desktop-loopback only".into());
        }
        *self
            .address
            .write()
            .map_err(|_| "Remote administration unavailable")? = Some(address);
        Ok(())
    }
    pub fn install(&self, service: &RemoteControl) -> Result<(), String> {
        *self
            .active
            .write()
            .map_err(|_| "Remote administration unavailable")? = Some(Admin {
            gateway: service.gateway(),
            accounts: service.accounts(),
            mobile: service.mobile(),
            mobile_public_url: service.mobile_public_url(),
        });
        Ok(())
    }
    pub fn clear(&self) {
        if let Ok(mut active) = self.active.write() {
            *active = None;
        }
    }
}
/// Reserve the private setup path even when disabled. Otherwise the generic
/// dynamic-RPC matcher would parse (and potentially trace) credential-shaped
/// requests and return a misleading HTTP 200 RPC error.
pub fn remote_admin_disabled_routes() -> Router {
    Router::new().route(
        "/api/remote-control/manage",
        any(|| async { failure(StatusCode::NOT_FOUND, "not_enabled") }),
    )
}
pub fn remote_admin_routes(state: RemoteAdminState) -> Router {
    Router::new()
        .route("/api/remote-control/manage", post(manage))
        .with_state(state.clone())
        .layer(DefaultBodyLimit::max(64 * 1024))
        .route_layer(middleware::from_fn_with_state(state, guard))
}
fn failure(status: StatusCode, code: &str) -> Response {
    let mut response = (status, Json(json!({"ok":false,"error":{"code":code}}))).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn guard(State(state): State<RemoteAdminState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let candidate = headers
        .get("x-xharness-desktop-token")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get(header::COOKIE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| {
                    s.split(';').find_map(|c| {
                        let (key, value) = c.trim().split_once('=')?;
                        (key == "xharness_desktop").then_some(value)
                    })
                })
        });
    if !candidate
        .is_some_and(|token| <[u8; 32]>::from(Sha256::digest(token.as_bytes())) == state.token_hash)
    {
        return failure(StatusCode::UNAUTHORIZED, "desktop_auth_required");
    }
    if headers
        .get("x-xharness-remote-admin")
        .and_then(|v| v.to_str().ok())
        != Some("v1")
    {
        return failure(StatusCode::FORBIDDEN, "same_origin_required");
    }
    let address = match state.address.read().ok().and_then(|v| *v) {
        Some(a) => a,
        None => return failure(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    };
    let hosts = [address.to_string(), format!("localhost:{}", address.port())];
    if !headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| hosts.iter().any(|h| h == host))
    {
        return failure(StatusCode::FORBIDDEN, "same_origin_required");
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origin
            .to_str()
            .ok()
            .is_some_and(|o| hosts.iter().any(|h| o == format!("http://{h}")))
        {
            return failure(StatusCode::FORBIDDEN, "same_origin_required");
        }
    }
    if let Some(site) = headers.get("sec-fetch-site") {
        if !site
            .to_str()
            .ok()
            .is_some_and(|s| s == "same-origin" || s == "none")
        {
            return failure(StatusCode::FORBIDDEN, "same_origin_required");
        }
    }
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.split(';').next() == Some("application/json"))
    {
        return failure(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required");
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
// No Debug/Serialize derive: a setup token must never enter a trace/response.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Status,
    Grants {
        after: Option<String>,
    },
    ConfigureTelegram {
        bot_id: String,
        expected_revision: u64,
        enabled: bool,
        token: String,
    },
    SetEnabled {
        account: Account,
        expected_revision: u64,
        enabled: bool,
    },
    Grant {
        account: Account,
        user: String,
        workspace: String,
        session: String,
        expected: Option<GrantVersion>,
    },
    GrantScopes {
        account: Account,
        user: String,
        workspaces: Vec<String>,
        sessions: Vec<String>,
        workspace: String,
        session: String,
        create_workspaces: Vec<String>,
        expected_creation_generation: Option<u64>,
        expected: Option<GrantVersion>,
    },
    Revoke {
        principal: String,
    },
    CleanupCredentials,
    MobileStatus,
    MobilePair {
        workspaces: BTreeSet<String>,
        sessions: BTreeSet<String>,
        workspace: String,
        session: String,
        #[serde(default)]
        create_workspaces: BTreeSet<String>,
        ttl_seconds: u16,
    },
    MobileRevoke {
        device: String,
    },
    UncertainInbox {
        after: i64,
    },
    ResolveInbox {
        expected: InboxRecoveryIdentity,
        evidence_sha256: String,
        resolution: RecoveryResolution,
    },
    UncertainReplies {
        after: i64,
    },
    ResolveReply {
        key: String,
        evidence_sha256: String,
        resolution: ReplyResolution,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantVersion {
    principal: String,
    revision: u64,
    binding: String,
    generation: u64,
}
fn numeric_id(value: &str) -> Option<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n <= i64::MAX as u64 && n.to_string() == value)
}
fn new_id(prefix: &str) -> Result<String, Error> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| Error::WorkerFailed)?;
    Ok(format!("{prefix}-{:x}", Sha256::digest(nonce)))
}
async fn manage(State(state): State<RemoteAdminState>, body: Bytes) -> Response {
    let action = match serde_json::from_slice::<Action>(&body) {
        Ok(a) => a,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "invalid_input"),
    };
    let admin = match state.active.read().ok().and_then(|a| a.clone()) {
        Some(a) => a,
        None => return failure(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    };
    match execute(admin, action).await {
        Ok(value) => Json(json!({"ok":true,"value":value})).into_response(),
        Err((status, code)) => failure(status, code),
    }
}
fn remote_error(error: Error) -> (StatusCode, &'static str) {
    match error {
        Error::IdentityConflict | Error::StaleLease | Error::CursorConflict => {
            (StatusCode::CONFLICT, "conflict")
        }
        Error::Unauthorized => (StatusCode::FORBIDDEN, "scope_denied"),
        Error::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_input"),
        Error::Capacity => (StatusCode::TOO_MANY_REQUESTS, "capacity"),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    }
}
fn mobile_error(error: xharness_mobile::protocol::ErrorCode) -> (StatusCode, &'static str) {
    use xharness_mobile::protocol::ErrorCode;
    match error {
        ErrorCode::Unauthorized => (StatusCode::FORBIDDEN, "scope_denied"),
        ErrorCode::InvalidRequest => (StatusCode::BAD_REQUEST, "invalid_input"),
        ErrorCode::Conflict | ErrorCode::PairConsumed => (StatusCode::CONFLICT, "conflict"),
        ErrorCode::PairExpired => (StatusCode::GONE, "pair_expired"),
        ErrorCode::Capacity => (StatusCode::TOO_MANY_REQUESTS, "capacity"),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    }
}
fn channel_error(error: ChannelFailure) -> (StatusCode, &'static str) {
    match error {
        ChannelFailure::SettingConflict => (StatusCode::CONFLICT, "conflict"),
        ChannelFailure::InvalidConfiguration
        | ChannelFailure::InvalidCredentials
        | ChannelFailure::Unsupported => (StatusCode::BAD_REQUEST, "invalid_input"),
        ChannelFailure::NativeCredentialUnavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "native_credentials_unavailable",
        ),
        ChannelFailure::JournalCleanupRequired => {
            (StatusCode::SERVICE_UNAVAILABLE, "cleanup_required")
        }
        _ => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    }
}
async fn execute(admin: Admin, action: Action) -> Result<Value, (StatusCode, &'static str)> {
    let g = &admin.gateway;
    let a = &admin.accounts;
    match action {
        Action::MobileStatus => {
            let devices = match &admin.mobile {
                Some(mobile) => mobile.devices().await.map_err(mobile_error)?,
                None => Vec::new(),
            };
            Ok(
                json!({"available":admin.mobile.is_some(),"host":g.host_id(),"relay_url":admin.mobile_public_url,"devices":devices}),
            )
        }
        Action::MobilePair {
            workspaces,
            sessions,
            workspace,
            session,
            create_workspaces,
            ttl_seconds,
        } => {
            let mobile = admin
                .mobile
                .as_ref()
                .ok_or((StatusCode::SERVICE_UNAVAILABLE, "mobile_not_configured"))?;
            let offer = mobile
                .create_pairing(
                    xharness_mobile::PairingScopes {
                        workspaces,
                        sessions,
                        workspace,
                        session,
                        create_workspaces,
                    },
                    ttl_seconds,
                )
                .await
                .map_err(mobile_error)?;
            let link = admin
                .mobile_public_url
                .as_ref()
                .map(|base| {
                    let mut url = reqwest::Url::parse(base)
                        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_input"))?;
                    // Pair secrets are fragments, never HTTP query parameters.
                    let encoded = reqwest::Url::parse_with_params(
                        "https://pair.invalid/",
                        [("host", g.host_id()), ("code", offer.code.expose())],
                    )
                    .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_input"))?;
                    url.set_fragment(encoded.query());
                    Ok::<_, (StatusCode, &'static str)>(url.to_string())
                })
                .transpose()?;
            let qr_svg = link
                .as_ref()
                .map(|link| {
                    qrcode::QrCode::new(link.as_bytes())
                        .map(|qr| {
                            qr.render::<qrcode::render::svg::Color>()
                                .min_dimensions(256, 256)
                                .build()
                        })
                        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid_input"))
                })
                .transpose()?;
            Ok(
                json!({"host":g.host_id(),"code":offer.code,"expires_at_ms":offer.expires_at_ms,"relay_url":admin.mobile_public_url,"link":link,"qr_svg":qr_svg}),
            )
        }
        Action::MobileRevoke { device } => {
            let mobile = admin
                .mobile
                .as_ref()
                .ok_or((StatusCode::SERVICE_UNAVAILABLE, "mobile_not_configured"))?;
            mobile.revoke(&device).await.map_err(mobile_error)?;
            Ok(json!({"device":device,"revoked":true}))
        }
        Action::Status => {
            let settings = g.account_settings().await.map_err(remote_error)?;
            let statuses = a.status().await;
            let accounts=settings.into_iter().map(|s| {
                let connection=statuses.iter().find(|v|v.account==s.account&&v.revision==s.revision).map(|v|v.connection.clone())
                    .unwrap_or(if s.enabled {ConnectionState::Starting} else {ConnectionState::Disabled});
                json!({"account":s.account,"enabled":s.enabled,"revision":s.revision,"credential_reference_saved":!s.credentials.is_empty(),"connection":connection})
            }).collect::<Vec<_>>();
            Ok(
                json!({"host":g.host_id(),"manager":a.health().await,"accounts":accounts,"credential_cleanup_pending":!g.pending_credential_cleanup().await.map_err(remote_error)?.is_empty()}),
            )
        }
        Action::Grants { after } => Ok(json!(g.grant_page(after).await.map_err(remote_error)?)),
        Action::ConfigureTelegram {
            bot_id,
            expected_revision,
            enabled,
            token,
        } => {
            let bot = numeric_id(&bot_id).ok_or((StatusCode::BAD_REQUEST, "invalid_input"))?;
            let saved = a
                .configure_telegram(bot, expected_revision, enabled, token)
                .await
                .map_err(channel_error)?;
            Ok(
                json!({"account":saved.settings.account,"revision":saved.settings.revision,"credential_cleanup_pending":saved.credential_cleanup_pending}),
            )
        }
        Action::SetEnabled {
            account,
            expected_revision,
            enabled,
        } => {
            let saved = a
                .set_enabled(account, expected_revision, enabled)
                .await
                .map_err(channel_error)?;
            Ok(json!({"account":saved.account,"revision":saved.revision,"enabled":saved.enabled}))
        }
        Action::Grant {
            account,
            user,
            workspace,
            session,
            expected,
        } => {
            if account.channel != Channel::Telegram
                || numeric_id(&account.id).is_none()
                || numeric_id(&user).is_none()
            {
                return Err((StatusCode::BAD_REQUEST, "invalid_input"));
            }
            if !g
                .account_settings()
                .await
                .map_err(remote_error)?
                .iter()
                .any(|s| s.account == account)
            {
                return Err((StatusCode::BAD_REQUEST, "unconfigured_account"));
            }
            let (principal, revision, binding, generation) = match expected {
                Some(e) => (
                    e.principal,
                    e.revision
                        .checked_add(1)
                        .ok_or((StatusCode::CONFLICT, "conflict"))?,
                    e.binding,
                    e.generation
                        .checked_add(1)
                        .ok_or((StatusCode::CONFLICT, "conflict"))?,
                ),
                None => (
                    new_id("controller").map_err(remote_error)?,
                    1,
                    new_id("binding").map_err(remote_error)?,
                    1,
                ),
            };
            let p = Principal {
                id: principal.clone(),
                host: g.host_id().into(),
                sender: Sender {
                    channel: account.channel,
                    account: account.id,
                    user: user.clone(),
                },
                workspaces: BTreeSet::from([workspace.clone()]),
                sessions: BTreeSet::from([session.clone()]),
                revision,
                revoked: false,
            };
            let b = Binding {
                id: binding,
                principal,
                conversation: user,
                workspace,
                session,
                generation,
            };
            g.configure_private_grant(p.clone(), b.clone())
                .await
                .map_err(remote_error)?;
            Ok(json!({"principal":p,"bindings":[b]}))
        }
        Action::GrantScopes {
            account,
            user,
            workspaces,
            sessions,
            workspace,
            session,
            create_workspaces,
            expected_creation_generation,
            expected,
        } => {
            if account.channel != Channel::Telegram
                || numeric_id(&account.id).is_none()
                || numeric_id(&user).is_none()
            {
                return Err((StatusCode::BAD_REQUEST, "invalid_input"));
            }
            if !g
                .account_settings()
                .await
                .map_err(remote_error)?
                .iter()
                .any(|s| s.account == account)
            {
                return Err((StatusCode::BAD_REQUEST, "unconfigured_account"));
            }
            let unique = |ids: Vec<String>,
                          max: usize|
             -> Result<BTreeSet<String>, (StatusCode, &'static str)> {
                let len = ids.len();
                let set: BTreeSet<_> = ids.into_iter().collect();
                if len > max || set.len() != len {
                    return Err((StatusCode::BAD_REQUEST, "invalid_input"));
                }
                Ok(set)
            };
            let workspaces = unique(workspaces, 256)?;
            let sessions = unique(sessions, 4096)?;
            let create_workspaces = unique(create_workspaces, 256)?;
            let (principal, revision, binding, generation) = match expected {
                Some(e) => (
                    e.principal,
                    e.revision
                        .checked_add(1)
                        .ok_or((StatusCode::CONFLICT, "conflict"))?,
                    e.binding,
                    e.generation
                        .checked_add(1)
                        .ok_or((StatusCode::CONFLICT, "conflict"))?,
                ),
                None => (
                    new_id("controller").map_err(remote_error)?,
                    1,
                    new_id("binding").map_err(remote_error)?,
                    1,
                ),
            };
            let p = Principal {
                id: principal.clone(),
                host: g.host_id().into(),
                sender: Sender {
                    channel: account.channel,
                    account: account.id,
                    user: user.clone(),
                },
                workspaces,
                sessions,
                revision,
                revoked: false,
            };
            let b = Binding {
                id: binding,
                principal: principal.clone(),
                conversation: user,
                workspace,
                session,
                generation,
            };
            let policy = xharness_remote::CreationPolicy {
                principal,
                principal_revision: revision,
                generation: expected_creation_generation
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or((StatusCode::CONFLICT, "conflict"))?,
                workspaces: create_workspaces,
            };
            Ok(json!(g
                .configure_private_scopes(p, b, Some(policy))
                .await
                .map_err(remote_error)?))
        }
        Action::Revoke { principal } => {
            g.revoke(&principal).await.map_err(remote_error)?;
            Ok(json!({"revoked":true,"principal":principal}))
        }
        Action::CleanupCredentials => {
            Ok(json!({"credential_cleanup_pending":a.cleanup_credentials().await}))
        }
        Action::UncertainInbox { after } => Ok(json!(g
            .uncertain_inbox(after)
            .await
            .map_err(remote_error)?)),
        Action::ResolveInbox {
            expected,
            evidence_sha256,
            resolution,
        } => {
            let review = RecoveryReview {
                delivery_key: expected.key.clone(),
                actor: "authenticated-desktop".into(),
                evidence_sha256,
                resolution,
            };
            Ok(json!(g
                .resolve_inbox(expected, review)
                .await
                .map_err(remote_error)?))
        }
        Action::UncertainReplies { after } => {
            let replies = g.uncertain_replies(after).await.map_err(remote_error)?;
            // Explicit recovery metadata; never echo private output body.
            let items=replies.iter().map(|r|json!({"key":r.key,"sequence":r.sequence,"account":r.account,"sender":r.sender,"principal":r.principal,"binding":r.binding,"failure":r.failure,"expected_message":r.expected_message})).collect::<Vec<_>>();
            let next = if items.len() == 25 {
                replies.last().map(|r| r.sequence)
            } else {
                None
            };
            Ok(json!({"items":items,"next":next}))
        }
        Action::ResolveReply {
            key,
            evidence_sha256,
            resolution,
        } => Ok(json!(g
            .resolve_reply(ReplyReview {
                key,
                actor: "authenticated-desktop".into(),
                evidence_sha256,
                resolution
            })
            .await
            .map_err(remote_error)?)),
    }
}
