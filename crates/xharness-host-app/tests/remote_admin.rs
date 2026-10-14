//! Real desktop extension transport + private journal/key interfaces. No live
//! platform/model/system-keychain credential is used in these fixtures.
use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use xharness_api::*;
use xharness_host_app::{
    channel_accounts::{AccountConnection, AccountConnector, ChannelFailure},
    model_settings::CredentialStore,
    remote_admin::*,
    remote_control::RemoteControl,
};
use xharness_remote::*;
const TOKEN: &str = "fixture-admin-desktop-only-0000000000000";
const SECRET: &str = "123456:fixture_PRIVATE_bot_token";
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "xh-remote-admin-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct ScopeHost;
#[async_trait]
impl ApiBackend for ScopeHost {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("admin cannot forward Agent/RPC calls");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("admin cannot answer arbitrary Host requests");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && (s == "s" || s == "other"))
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        let workspaces = ["w", "w2"]
            .into_iter()
            .filter(|w| q.workspaces.contains(*w))
            .map(|w| CatalogueWorkspace {
                id: w.into(),
                title: w.into(),
            })
            .collect();
        let mut sessions: Vec<_> = [("w", "s"), ("w", "other"), ("w2", "t")]
            .into_iter()
            .filter(|(w, s)| q.workspaces.contains(*w) && q.sessions.contains(*s))
            .map(|(w, s)| CatalogueSession {
                workspace: w.into(),
                id: s.into(),
                title: None,
                running: false,
                restoring: false,
            })
            .filter(|s| q.after.as_ref().is_none_or(|after| s.cursor() > *after))
            .collect();
        sessions.sort_by_key(CatalogueSession::cursor);
        Ok(ScopedCataloguePage {
            workspaces,
            sessions,
            next: None,
        })
    }
    fn mux_events(&self) -> EventStream {
        panic!("admin cannot subscribe global mux");
    }
    fn host_events(&self) -> EventStream {
        panic!("admin cannot subscribe global stream");
    }
}
struct Keys {
    values: Mutex<BTreeMap<String, String>>,
    writes: AtomicUsize,
}
#[async_trait]
impl CredentialStore for Keys {
    async fn get(&self, r: &str) -> Result<Option<String>, String> {
        Ok(self.values.lock().await.get(r).cloned())
    }
    async fn set(&self, r: &str, v: &str) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.values.lock().await.insert(r.into(), v.into());
        Ok(())
    }
    async fn delete(&self, r: &str) -> Result<(), String> {
        self.values.lock().await.remove(r);
        Ok(())
    }
}
struct NoConnect;
#[async_trait]
impl AccountConnector for NoConnect {
    async fn connect(
        &self,
        _: AccountSettings,
        _: Arc<Gateway>,
        _: String,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure> {
        panic!("disabled account cannot make provider requests");
    }
}
fn fixture() -> (
    Directory,
    RemoteControl,
    RemoteAdminState,
    Arc<Keys>,
    Router,
) {
    let d = Directory::new();
    let keys = Arc::new(Keys {
        values: Mutex::new(BTreeMap::new()),
        writes: AtomicUsize::new(0),
    });
    let service = RemoteControl::start_with_accounts(
        &d.0,
        Arc::new(ScopeHost),
        keys.clone(),
        Arc::new(NoConnect),
    )
    .unwrap();
    let state = RemoteAdminState::new(TOKEN).unwrap();
    state
        .bind_address("127.0.0.1:9000".parse().unwrap())
        .unwrap();
    state.install(&service).unwrap();
    let app = xharness_server::web_router_full(
        Arc::new(ScopeHost),
        None,
        xharness_debug::DebugRecorder::disabled(),
        Some(TOKEN.into()),
        xharness_server::StartupReadiness::ready(),
        remote_admin_routes(state.clone()),
    );
    (d, service, state, keys, app)
}
fn request(body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/remote-control/manage")
        .header("host", "127.0.0.1:9000")
        .header("content-type", "application/json")
        .header("x-xharness-desktop-token", TOKEN)
        .header("x-xharness-remote-admin", "v1")
        .body(Body::from(body.to_string()))
        .unwrap()
}
async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn configure(app: &Router) {
    assert_eq!(send(app,request(json!({"type":"configure_telegram","bot_id":"123456","expected_revision":0,"enabled":false,"token":SECRET}))).await.0,StatusCode::OK);
}
#[tokio::test]
async fn native_desktop_boundary_rejects_cross_site_and_host_rebinding_before_mutation() {
    let (_d, service, _state, keys, app) = fixture();
    for (header, value) in [
        ("origin", "https://attacker.invalid"),
        ("origin", "null"),
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-site", "same-site"),
        ("host", "rebind.invalid:9000"),
        ("x-xharness-remote-admin", "wrong"),
    ] {
        let mut r = request(
            json!({"type":"configure_telegram","bot_id":"123456","expected_revision":0,"enabled":false,"token":SECRET}),
        );
        r.headers_mut().insert(header, value.parse().unwrap());
        assert_eq!(send(&app, r).await.0, StatusCode::FORBIDDEN);
    }
    let mut r = request(json!({"type":"status"}));
    r.headers_mut().remove("x-xharness-remote-admin");
    assert_eq!(send(&app, r).await.0, StatusCode::FORBIDDEN);
    let mut r = request(json!({"type":"status"}));
    r.headers_mut().remove("x-xharness-desktop-token");
    let response = app.clone().oneshot(r).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 0);
    let mut r = request(json!({"type":"status"}));
    r.headers_mut()
        .insert("origin", "http://127.0.0.1:9000".parse().unwrap());
    r.headers_mut()
        .insert("sec-fetch-site", "same-origin".parse().unwrap());
    assert_eq!(send(&app, r).await.0, StatusCode::OK);
    // Browser path: HttpOnly desktop cookie, not a JS-exposed launch token.
    let mut r = request(json!({"type":"status"}));
    r.headers_mut().remove("x-xharness-desktop-token");
    r.headers_mut().insert(
        "cookie",
        format!("xharness_desktop={TOKEN}").parse().unwrap(),
    );
    assert_eq!(send(&app, r).await.0, StatusCode::OK);
    service.stop().await.unwrap();
}
#[tokio::test]
async fn credentials_are_native_only_closed_schema_bounded_and_not_in_full_debug_trace() {
    let (d, service, _state, keys, app) = fixture();
    configure(&app).await;
    let (_, status) = send(&app, request(json!({"type":"status"}))).await;
    assert!(!status.to_string().contains(SECRET));
    assert!(status["value"]["accounts"][0].get("credentials").is_none());
    assert_eq!(
        status["value"]["accounts"][0]["credential_reference_saved"],
        true
    );
    let (code,error)=send(&app,request(json!({"type":"configure_telegram","bot_id":"123456","expected_revision":1,"enabled":false,"token":SECRET,"endpoint":"https://attacker.invalid"}))).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(!error.to_string().contains(SECRET));
    assert_eq!(keys.writes.load(Ordering::SeqCst), 1);
    let response=app.clone().oneshot(request(json!({"type":"configure_telegram","bot_id":"123456","expected_revision":1,"enabled":false,"token":"x".repeat(70*1024)}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let g = service.gateway();
    let trace_dir = d.0.join("trace");
    let (debug, _) = xharness_debug::DebugRecorder::open(xharness_debug::DebugTraceConfig::new(
        xharness_debug::DebugTraceMode::Full,
        &trace_dir,
    ))
    .await
    .unwrap();
    let state = RemoteAdminState::new(TOKEN).unwrap();
    state
        .bind_address("127.0.0.1:9000".parse().unwrap())
        .unwrap();
    state.install(&service).unwrap();
    let app = xharness_server::web_router_full(
        Arc::new(ScopeHost),
        None,
        debug.clone(),
        Some(TOKEN.into()),
        xharness_server::StartupReadiness::ready(),
        remote_admin_routes(state),
    );
    assert_eq!(send(&app,request(json!({"type":"configure_telegram","bot_id":"123456","expected_revision":1,"enabled":false,"token":SECRET}))).await.0,StatusCode::OK);
    let disabled = xharness_server::web_router_full(
        Arc::new(ScopeHost),
        None,
        debug.clone(),
        None,
        xharness_server::StartupReadiness::ready(),
        remote_admin_disabled_routes(),
    );
    for body in [
        json!({"type":"configure_telegram","token":SECRET}),
        json!({"type":"client-request","rpcId":"fixture","method":"remote-control/manage","payload":{"token":SECRET}}),
    ] {
        let (code, body) = send(&disabled, request(body)).await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_enabled");
    }
    debug.flush().await.unwrap();
    for file in std::fs::read_dir(&trace_dir).unwrap() {
        let p = file.unwrap().path();
        if p.is_file() {
            let b = std::fs::read(p).unwrap();
            assert!(!b.windows(SECRET.len()).any(|s| s == SECRET.as_bytes()));
        }
    }
    service.stop().await.unwrap();
    assert!(g.account_settings().await.is_err());
}
#[tokio::test]
async fn native_scope_update_is_atomic_conflict_fenced_and_revocation_is_permanent() {
    let (_d, service, state, _keys, app) = fixture();
    configure(&app).await;
    let payload = json!({"type":"grant","account":{"channel":"telegram","id":"123456"},"user":"42","workspace":"w","session":"s"});
    let (code, first) = send(&app, request(payload.clone())).await;
    assert_eq!(code, StatusCode::OK);
    let p = &first["value"]["principal"];
    let b = &first["value"]["bindings"][0];
    assert_eq!(send(&app, request(payload)).await.0, StatusCode::CONFLICT);
    let update = json!({"type":"grant","account":{"channel":"telegram","id":"123456"},"user":"42","workspace":"w","session":"other","expected":{"principal":p["id"],"revision":1,"binding":b["id"],"generation":1}});
    assert_eq!(send(&app, request(update.clone())).await.0, StatusCode::OK);
    assert_eq!(send(&app, request(update)).await.0, StatusCode::CONFLICT);
    let (code, page) = send(&app, request(json!({"type":"grants"}))).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(page["value"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["value"]["items"][0]["bindings"][0]["session"], "other");
    let revoke = json!({"type":"revoke","principal":p["id"]});
    assert_eq!(send(&app, request(revoke.clone())).await.0, StatusCode::OK);
    assert_eq!(send(&app, request(revoke)).await.0, StatusCode::OK);
    let page = service.gateway().grant_page(None).await.unwrap();
    assert!(page.items[0].principal.revoked);
    assert_eq!(page.items[0].principal.revision, 3);
    state.clear();
    assert_eq!(
        send(&app, request(json!({"type":"status"}))).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn native_state_cannot_be_bound_to_external_listener_or_used_before_install() {
    let state = RemoteAdminState::new(TOKEN).unwrap();
    assert!(state.bind_address("0.0.0.0:9000".parse().unwrap()).is_err());
    assert!(RemoteAdminState::new("weak").is_err());
    state
        .bind_address("127.0.0.1:9000".parse().unwrap())
        .unwrap();
    let app = remote_admin_routes(state);
    assert_eq!(
        send(&app, request(json!({"type":"status"}))).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn desktop_complete_scope_receipt_creation_policy_and_all_cas_are_atomic() {
    let (d, service, _state, _keys, app) = fixture();
    configure(&app).await;
    let mut action = json!({"type":"grant_scopes","account":{"channel":"telegram","id":"123456"},"user":"42","workspaces":["w","w2"],"sessions":["s","other","t"],"workspace":"w","session":"s","create_workspaces":[],"expected_creation_generation":null});
    let (status, first) = send(&app, request(action.clone())).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let first = first["value"].clone();
    assert_eq!(first["principal"]["sessions"], json!(["other", "s", "t"]));
    assert_eq!(first["creation_policy"]["workspaces"], json!([]));
    action["expected"] = json!({"principal":first["principal"]["id"],"revision":1,"binding":first["bindings"][0]["id"],"generation":1});
    action["create_workspaces"] = json!(["w2"]);
    action["expected_creation_generation"] = json!(9);
    assert_eq!(
        send(&app, request(action.clone())).await.0,
        StatusCode::CONFLICT
    );
    action["expected_creation_generation"] = json!(1);
    for (key, value) in [
        ("sessions", json!(["s", "s"])),
        ("sessions", json!(["s", "foreign"])),
        ("create_workspaces", json!(["foreign"])),
        ("workspace", json!("w2")),
    ] {
        let mut bad = action.clone();
        bad[key] = value;
        assert_ne!(send(&app, request(bad)).await.0, StatusCode::OK);
        let page = send(&app, request(json!({"type":"grants"}))).await.1;
        assert_eq!(page["value"]["items"], json!([first.clone()]));
    }
    let (status, second) = send(&app, request(action)).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["value"]["principal"]["revision"], 2);
    assert_eq!(second["value"]["bindings"][0]["generation"], 2);
    assert_eq!(second["value"]["creation_policy"]["principal_revision"], 2);
    assert_eq!(second["value"]["creation_policy"]["generation"], 2);
    assert_eq!(
        second["value"]["creation_policy"]["workspaces"],
        json!(["w2"])
    );
    service.stop().await.unwrap();
    let reopened = RemoteControl::start(&d.0, Arc::new(ScopeHost)).unwrap();
    let page = reopened.gateway().grant_page(None).await.unwrap();
    assert_eq!(
        serde_json::to_value(&page.items[0]).unwrap(),
        second["value"]
    );
    reopened.stop().await.unwrap();
}

// Durable fault rows represent an interrupted controller effect. The native
// backend still panics on any command, proving that administration cannot replay.
async fn inbox_fixture() -> (Directory, RemoteControl, Router, Delivery) {
    let (dir, service, _, _, app) = fixture();
    configure(&app).await;
    let (_,granted)=send(&app,request(json!({"type":"grant","account":{"channel":"telegram","id":"123456"},"user":"42","workspace":"w","session":"s"}))).await;
    let p: Principal = serde_json::from_value(granted["value"]["principal"].clone()).unwrap();
    let b: Binding = serde_json::from_value(granted["value"]["bindings"][0].clone()).unwrap();
    let d = Delivery {
        sequence: 1,
        key: "a".repeat(64),
        principal: p.id,
        principal_revision: 1,
        binding: b.clone(),
        inbound: Inbound {
            request_id: "PRIVATE_REQUEST_ID".into(),
            binding: b.id,
            generation: 1,
            command: Command::Prompt {
                mode: PromptMode::Queue,
                content: vec![Content::Text {
                    text: "PRIVATE_INPUT".into(),
                }],
                client_time_zone: None,
            },
        },
        state: DeliveryState::Uncertain,
        result: None,
        reason: Some("PRIVATE_REASON".into()),
    };
    let db = rusqlite::Connection::open(dir.0.join("remote-control/remote.sqlite")).unwrap();
    db.execute(
        "INSERT INTO inbox(seq,key,session,state,body) VALUES(?1,?2,?3,'uncertain',?4)",
        rusqlite::params![
            d.sequence,
            d.key,
            d.binding.session,
            serde_json::to_string(&d).unwrap()
        ],
    )
    .unwrap();
    drop(db);
    (dir, service, app, d)
}
#[tokio::test]
async fn inbox_admin_is_metadata_only_exact_audited_idempotent_and_never_native_replay() {
    let (_dir, service, app, d) = inbox_fixture().await;
    let (code, page) = send(&app, request(json!({"type":"uncertain_inbox","after":0}))).await;
    assert_eq!(code, StatusCode::OK);
    assert!(!page.to_string().contains("PRIVATE_"));
    let e = &page["value"]["items"][0];
    assert_eq!(e["command"], "prompt");
    assert_eq!(e["identity"]["key"], d.key);
    assert!(e["observed_accepted_allowed"].as_bool().unwrap());
    let action = json!({"type":"resolve_inbox","expected":e["identity"],"evidence_sha256":"b".repeat(64),"resolution":"observed_accepted"});
    let (code, receipt) = send(&app, request(action.clone())).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(receipt["value"]["identity"], e["identity"]);
    assert_eq!(
        receipt["value"]["audit"]["review"]["actor"],
        "authenticated-desktop"
    );
    assert_eq!(receipt["value"]["audit"]["current"], "completed");
    assert_eq!(send(&app, request(action)).await.1, receipt);
    assert_eq!(
        service
            .gateway()
            .recovery_audit(&d.key)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        send(&app, request(json!({"type":"uncertain_inbox","after":0})))
            .await
            .1["value"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        service.gateway().dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn inbox_admin_rejects_stale_identity_extra_scope_actor_bad_evidence_and_cross_origin() {
    let (_dir, service, app, d) = inbox_fixture().await;
    let page = send(&app, request(json!({"type":"uncertain_inbox","after":0})))
        .await
        .1;
    let e = &page["value"]["items"][0]["identity"];
    let action = json!({"type":"resolve_inbox","expected":e,"evidence_sha256":"b".repeat(64),"resolution":"abandon_without_replay"});
    for (path, value, status) in [
        (
            vec!["expected", "principal_revision"],
            json!(2),
            StatusCode::CONFLICT,
        ),
        (
            vec!["expected", "binding", "session"],
            json!("foreign"),
            StatusCode::CONFLICT,
        ),
        (
            vec!["expected", "binding", "cwd"],
            json!("PRIVATE_PATH"),
            StatusCode::BAD_REQUEST,
        ),
        (vec!["actor"], json!("controller"), StatusCode::BAD_REQUEST),
        (vec!["resolution"], json!("retry"), StatusCode::BAD_REQUEST),
        (
            vec!["evidence_sha256"],
            json!("PRIVATE_EVIDENCE"),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let mut bad = action.clone();
        let mut dest = &mut bad;
        for key in path {
            dest = &mut dest[key];
        }
        *dest = value;
        let (code, result) = send(&app, request(bad)).await;
        assert_eq!(code, status);
        assert!(!result.to_string().contains("PRIVATE_"));
    }
    let mut cross = request(action.clone());
    cross
        .headers_mut()
        .insert("origin", "https://foreign.invalid".parse().unwrap());
    assert_eq!(send(&app, cross).await.0, StatusCode::FORBIDDEN);
    let mut anonymous = request(action);
    anonymous.headers_mut().remove("x-xharness-desktop-token");
    // The outer desktop authentication middleware rejects this request before
    // the extension can produce its JSON/no-store response. Assert that boundary
    // directly rather than assuming the authenticated administration envelope.
    let denied = app.clone().oneshot(anonymous).await.unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let denied_body = to_bytes(denied.into_body(), 8 * 1024 * 1024).await.unwrap();
    assert_eq!(&denied_body[..], b"desktop authentication required");
    assert!(service
        .gateway()
        .recovery_audit(&d.key)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(service.gateway().inspect(&d.key).await.unwrap().unwrap(), d);
    assert_eq!(
        send(&app, request(json!({"type":"uncertain_inbox","after":-1})))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    service.stop().await.unwrap();
}
