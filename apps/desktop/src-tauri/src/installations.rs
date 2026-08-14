//! Optional installation metadata; entirely separate from Host and Agent execution.
//! HTTP never runs on the startup/IPC path. Only one worker owns delivery.
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;
use xharness_installation::{Kind, Outbox, BATCH_SIZE};

pub struct InstallationState {
    file: Option<PathBuf>,
    store: Mutex<Store>,
    wake: Notify,
    endpoint: Option<url::Url>,
    version: String,
}
struct Store {
    outbox: Outbox,
    error: Option<&'static str>,
    started: bool,
    blocked: bool,
    dirty_optout: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    notice_required: bool,
    configured: bool,
    pending_reports: usize,
    deletion_pending: bool,
    dropped_events: u64,
    error: Option<&'static str>,
}
fn endpoint(input: Option<&str>) -> Option<url::Url> {
    let url = url::Url::parse(input?).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/")
        .then_some(url)
}
impl InstallationState {
    pub fn initialize(app: &AppHandle) -> Self {
        let file = app
            .path()
            .app_config_dir()
            .ok()
            .map(|p| p.join("installation-outbox.json"));
        let loaded = file
            .as_ref()
            .ok_or("statistics_storage_unavailable")
            .and_then(|file| match std::fs::symlink_metadata(file) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Outbox::default()),
                Ok(meta)
                    if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 65536 =>
                {
                    let bytes =
                        std::fs::read(file).map_err(|_| "statistics_storage_unavailable")?;
                    let outbox: Outbox =
                        serde_json::from_slice(&bytes).map_err(|_| "statistics_storage_invalid")?;
                    outbox
                        .validate()
                        .map_err(|_| "statistics_storage_invalid")?;
                    Ok(outbox)
                }
                _ => Err("statistics_storage_invalid"),
            });
        let (outbox, error) = match loaded {
            Ok(o) => (o, None),
            Err(e) => (Outbox::default(), Some(e)),
        };
        Self {
            file,
            store: Mutex::new(Store {
                outbox,
                error,
                started: false,
                blocked: error.is_some(),
                dirty_optout: false,
            }),
            wake: Notify::new(),
            endpoint: endpoint(option_env!("XHARNESS_INSTALLATION_ENDPOINT")),
            version: app.package_info().version.to_string(),
        }
    }
    fn save(&self, outbox: &Outbox) -> Result<(), &'static str> {
        outbox
            .validate()
            .map_err(|_| "statistics_storage_invalid")?;
        let path = self.file.as_ref().ok_or("statistics_storage_unavailable")?;
        let parent = path.parent().ok_or("statistics_storage_unavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "statistics_storage_unavailable")?;
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("statistics_storage_invalid");
        }
        let bytes = serde_json::to_vec(outbox).map_err(|_| "statistics_storage_invalid")?;
        if bytes.len() > 65536 {
            return Err("statistics_storage_invalid");
        }
        // tempfile defaults to owner-only permissions, same directory + atomic replace.
        let mut temp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "statistics_storage_unavailable")?;
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|_| "statistics_storage_unavailable")?;
        temp.persist(path)
            .map_err(|_| "statistics_storage_unavailable")?;
        #[cfg(unix)]
        // Rename already committed: do not leave memory at the old consent if
        // directory syncing is unsupported. File contents were synced above.
        let _ = std::fs::File::open(parent).and_then(|dir| dir.sync_all());
        Ok(())
    }
    fn mutate(&self, f: impl FnOnce(&mut Outbox) -> Result<(), String>) -> Result<(), String> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| "statistics_storage_unavailable")?;
        if store.blocked {
            return Err(store.error.unwrap_or("statistics_storage_invalid").into());
        }
        let mut next = store.outbox.clone();
        f(&mut next)?;
        if let Err(e) = self.save(&next) {
            // Opt-out stops reports immediately, even on a full/read-only disk.
            // Keep an explicit unsaved warning; retry persistence / deletion.
            if !next.enabled {
                store.outbox = next;
                store.dirty_optout = true;
                self.wake.notify_one();
            }
            store.error = Some(e);
            return Err(e.into());
        }
        store.outbox = next;
        store.dirty_optout = false;
        store.error = None;
        drop(store);
        self.wake.notify_one();
        Ok(())
    }
    fn status(&self) -> Status {
        let store = self.store.lock().expect("installation mutex poisoned");
        Status {
            enabled: store.outbox.enabled,
            notice_required: self.endpoint.is_some()
                && !store.blocked
                && store.outbox.notice_required(),
            configured: self.endpoint.is_some(),
            pending_reports: store.outbox.events.len(),
            deletion_pending: store.outbox.deletion.is_some(),
            dropped_events: store.outbox.dropped_events,
            error: if store.dirty_optout {
                Some("statistics_optout_not_persisted")
            } else {
                store.error
            },
        }
    }
}
#[tauri::command]
pub fn desktop_installation_status(state: State<'_, InstallationState>) -> Status {
    state.status()
}
#[tauri::command]
pub fn desktop_set_installation_statistics(
    state: State<'_, InstallationState>,
    enabled: bool,
) -> Result<Status, String> {
    if enabled && state.endpoint.is_none() {
        return Err("statistics_not_configured".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "statistics_clock_unavailable")?
        .as_secs();
    state.mutate(|o| o.choose(enabled, &state.version, now))?;
    Ok(state.status())
}
pub fn started(app: &AppHandle) {
    let state = app.state::<InstallationState>();
    // Called after Host startup succeeds, not after a mere package download.
    if let Ok(mut store) = state.store.lock() {
        if store.started {
            return;
        }
        store.started = true;
    }
    if state.status().enabled {
        let _ = state.mutate(|o| o.started(&state.version));
    }
}
pub fn event(app: &AppHandle, kind: Kind, target: Option<&str>) {
    let state = app.state::<InstallationState>();
    if !state.status().enabled {
        return;
    }
    // Statistics cannot block an update on storage or network failure.
    let _ = state.mutate(|o| match kind {
        Kind::InstallStarted => o.installing(&state.version, target.ok_or("missing target")?),
        Kind::InstallFailed => o.failed(&state.version, target),
        _ => o.push(kind, &state.version, target),
    });
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ack {
    accepted_through: u64,
}
enum Delivered {
    Revoked,
    Registered,
    Reported(u64, u64),
}
async fn deliver(
    client: &reqwest::Client,
    origin: &url::Url,
    outbox: &Outbox,
    version: &str,
) -> Result<Delivered, &'static str> {
    let identity = outbox
        .deletion
        .as_ref()
        .or(outbox.identity.as_ref())
        .ok_or("statistics_identity_missing")?;
    let (method, path, body) = if outbox.deletion.is_some() {
        (
            reqwest::Method::DELETE,
            "api/installations",
            serde_json::json!({"installationId":identity.installation_id}),
        )
    } else if !outbox.registered {
        (
            reqwest::Method::POST,
            "api/installations/register",
            serde_json::json!({"installationId":identity.installation_id,
            "platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"channel":option_env!("XHARNESS_RELEASE_CHANNEL").unwrap_or("stable"),"version":version}),
        )
    } else {
        (
            reqwest::Method::POST,
            "api/installations/report",
            serde_json::json!({"installationId":identity.installation_id,"events":outbox.events.iter().take(BATCH_SIZE).collect::<Vec<_>>()}),
        )
    };
    let url = origin.join(path).map_err(|_| "statistics_not_configured")?;
    let mut response = client
        .request(method, url)
        .bearer_auth(&identity.secret)
        .json(&body)
        .send()
        .await
        .map_err(|_| "statistics_delivery_pending")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("statistics_registration_required");
    }
    if !response.status().is_success() {
        return Err("statistics_delivery_pending");
    }
    if outbox.deletion.is_some() {
        return if response.status() == reqwest::StatusCode::NO_CONTENT {
            Ok(Delivered::Revoked)
        } else {
            Err("statistics_invalid_ack")
        };
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "statistics_delivery_pending")?
    {
        if bytes.len() + chunk.len() > 4096 {
            return Err("statistics_invalid_ack");
        }
        bytes.extend_from_slice(&chunk);
    }
    if !outbox.registered {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct RegistrationAck {
            registered: bool,
        }
        let ack: RegistrationAck =
            serde_json::from_slice(&bytes).map_err(|_| "statistics_invalid_ack")?;
        return if ack.registered {
            Ok(Delivered::Registered)
        } else {
            Err("statistics_invalid_ack")
        };
    }
    let ack: Ack = serde_json::from_slice(&bytes).map_err(|_| "statistics_invalid_ack")?;
    let max = outbox
        .events
        .iter()
        .take(BATCH_SIZE)
        .next_back()
        .ok_or("statistics_invalid_ack")?
        .sequence;
    // Only a full batch ack permits removal. Lost replies are safely replayed.
    if ack.accepted_through != max {
        return Err("statistics_invalid_ack");
    }
    Ok(Delivered::Reported(ack.accepted_through, max))
}
fn retry_delay(backoff: u64) -> Duration {
    let base = backoff.clamp(2, 3600);
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    Duration::from_secs((base + u64::from_le_bytes(bytes) % (base / 4).max(1)).min(3600))
}
pub async fn worker(app: AppHandle) {
    let state = app.state::<InstallationState>();
    let Some(origin) = &state.endpoint else {
        return;
    };
    // Match the updater crypto backend; initialize before any optional update check.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
    else {
        return;
    };
    let mut heartbeat = tokio::time::Instant::now() + Duration::from_secs(86400);
    let mut retry = tokio::time::Instant::now();
    let mut backoff = 2u64;
    let mut deleting = false;
    loop {
        if app
            .state::<crate::DesktopState>()
            .closing
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let now = tokio::time::Instant::now();
        if now >= heartbeat {
            let ready = state.store.lock().is_ok_and(|s| s.started);
            if ready {
                let _ = state.mutate(|o| o.push(Kind::Heartbeat, &state.version, None));
            }
            heartbeat = now + Duration::from_secs(86400);
        }
        let snapshot = state
            .store
            .lock()
            .expect("installation mutex poisoned")
            .outbox
            .clone();
        let revoke = snapshot.deletion.is_some();
        if revoke && !deleting {
            retry = now;
            backoff = 2;
        }
        deleting = revoke;
        let pending =
            revoke || (snapshot.enabled && (!snapshot.registered || !snapshot.events.is_empty()));
        if pending && now >= retry {
            // The worker serializes requests. A toggle never waits for HTTP; stale
            // acks are ignored and DELETE follows any in-flight enrollment/report.
            let result = deliver(&client, origin, &snapshot, &state.version).await;
            let mut store = state.store.lock().expect("installation mutex poisoned");
            let same = if revoke {
                store.outbox.deletion.as_ref().map(|i| i.installation_id)
                    == snapshot.deletion.as_ref().map(|i| i.installation_id)
            } else {
                store.outbox.enabled
                    && store.outbox.identity.as_ref().map(|i| i.installation_id)
                        == snapshot.identity.as_ref().map(|i| i.installation_id)
            };
            if same {
                let mut next = store.outbox.clone();
                match result {
                    Ok(delivered) => {
                        let changed = match delivered {
                            Delivered::Revoked => {
                                next.deletion = None;
                                Ok(())
                            }
                            Delivered::Registered => {
                                next.registered = true;
                                Ok(())
                            }
                            Delivered::Reported(through, max) => next.acknowledge(through, max),
                        };
                        if changed.is_ok() {
                            match state.save(&next) {
                                Ok(()) => {
                                    store.outbox = next;
                                    store.error = None;
                                    store.dirty_optout = false;
                                    backoff = 2;
                                }
                                Err(e) => {
                                    store.error = Some(e);
                                    backoff = (backoff * 2).min(3600);
                                }
                            }
                        }
                        retry = tokio::time::Instant::now() + retry_delay(backoff);
                    }
                    Err(error) => {
                        if error == "statistics_registration_required" && !revoke {
                            next.registered = false;
                            if state.save(&next).is_ok() {
                                store.outbox = next;
                            }
                        }
                        store.error = Some(error);
                        retry = tokio::time::Instant::now() + retry_delay(backoff);
                        backoff = (backoff * 2).min(3600);
                    }
                }
            } else {
                retry = tokio::time::Instant::now();
            }
        }
        let delay = if pending {
            retry
                .saturating_duration_since(tokio::time::Instant::now())
                .min(Duration::from_secs(60))
        } else {
            Duration::from_secs(60)
        };
        tokio::select! { _ = state.wake.notified() => {}, _ = tokio::time::sleep(delay) => {} }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reporting_origin_is_immutable_https_without_credentials_or_path() {
        assert!(endpoint(Some("https://engine.xxdevs.com")).is_some());
        for value in [
            "http://engine.xxdevs.com",
            "https://user:pass@engine.xxdevs.com",
            "https://engine.xxdevs.com/?key=x",
            "https://engine.xxdevs.com/other",
        ] {
            assert!(endpoint(Some(value)).is_none());
        }
        assert!(endpoint(None).is_none());
    }
    fn test_state(file: PathBuf) -> InstallationState {
        InstallationState {
            file: Some(file),
            store: Mutex::new(Store {
                outbox: Outbox::default(),
                error: None,
                started: false,
                blocked: false,
                dirty_optout: false,
            }),
            wake: Notify::new(),
            endpoint: None,
            version: "1.0.0".into(),
        }
    }
    #[test]
    fn first_run_notice_is_native_configured_and_choice_is_local_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("outbox.json");
        let mut state = test_state(file.clone());
        assert!(!state.status().notice_required);
        state.endpoint = endpoint(Some("https://engine.xxdevs.com"));
        assert!(state.status().notice_required);
        state.mutate(|o| o.choose(false, "1.0.0", 123)).unwrap();
        assert!(!state.status().enabled && !state.status().notice_required);
        let restored: Outbox = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        assert!(
            !restored.notice_required()
                && restored.identity.is_none()
                && restored.events.is_empty()
        );
        assert_eq!(restored.consent.unwrap().decided_at_seconds, 123);
        let dto = serde_json::to_string(&state.status()).unwrap();
        assert!(!dto.contains("decidedAt") && !dto.contains("secret") && !dto.contains("consent"));
    }
    #[test]
    fn consent_and_ack_are_atomically_persisted_without_exposing_the_credential() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("outbox.json");
        let state = test_state(file.clone());
        state.mutate(|o| o.enable("1.0.0")).unwrap();
        let saved: Outbox = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        saved.validate().unwrap();
        let status = serde_json::to_string(&state.status()).unwrap();
        assert!(!status.contains(&saved.identity.unwrap().secret));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        state
            .mutate(|o| {
                o.disable();
                Ok(())
            })
            .unwrap();
        let saved: Outbox = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        assert!(saved.deletion.is_some() && !saved.enabled && saved.events.is_empty());
    }
    #[test]
    fn failed_storage_does_not_commit_consent_and_can_recover() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("invalid");
        std::fs::write(&parent, b"file").unwrap();
        let state = test_state(parent.join("outbox.json"));
        assert!(state.mutate(|o| o.enable("1.0.0")).is_err());
        assert!(!state.status().enabled);
        std::fs::remove_file(parent).unwrap();
        state.mutate(|o| o.enable("1.0.0")).unwrap();
        assert!(state.status().enabled);
    }
    #[cfg(unix)]
    #[test]
    fn storage_refuses_symlinks_and_leaves_target_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("private");
        std::fs::write(&target, b"private sentinel").unwrap();
        let file = dir.path().join("outbox.json");
        std::os::unix::fs::symlink(&target, &file).unwrap();
        assert!(test_state(file).mutate(|o| o.enable("1.0.0")).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"private sentinel");
    }
    async fn mock_response(
        body: &str,
        status: &str,
        outbox: &Outbox,
    ) -> Result<Delivered, &'static str> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let reply=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request).await;
            let _ = stream.write_all(reply.as_bytes()).await;
        });
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let result = deliver(&client, &origin, outbox, "1.0.0").await;
        task.await.unwrap();
        result
    }
    #[tokio::test]
    async fn native_delivery_rejects_fake_deletion_and_partial_or_oversized_ack() {
        let mut outbox = Outbox::default();
        outbox.enable("1.0.0").unwrap();
        assert!(matches!(
            mock_response(r#"{"registered":true}"#, "200 OK", &outbox).await,
            Ok(Delivered::Registered)
        ));
        assert!(mock_response("html fallback", "200 OK", &outbox)
            .await
            .is_err());
        outbox.registered = true;
        for body in [
            r#"{"acceptedThrough":0}"#,
            r#"{"acceptedThrough":2}"#,
            r#"{"acceptedThrough":1,"log":"private"}"#,
        ] {
            assert!(mock_response(body, "200 OK", &outbox).await.is_err());
        }
        assert!(matches!(
            mock_response(r#"{"acceptedThrough":1}"#, "200 OK", &outbox).await,
            Ok(Delivered::Reported(1, 1))
        ));
        assert!(mock_response(&"x".repeat(5000), "200 OK", &outbox)
            .await
            .is_err());
        outbox.disable();
        assert!(mock_response("html fallback", "200 OK", &outbox)
            .await
            .is_err());
        assert!(matches!(
            mock_response("", "204 No Content", &outbox).await,
            Ok(Delivered::Revoked)
        ));
        assert!(outbox.deletion.is_some()); // Transport alone never mutates durable state.
    }
    #[test]
    fn opt_out_stops_in_memory_reports_even_when_disk_is_unwritable() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("state");
        let file = parent.join("outbox.json");
        let state = test_state(file.clone());
        state.mutate(|o| o.enable("1.0.0")).unwrap();
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(&parent).unwrap();
        std::fs::write(&parent, b"not a directory").unwrap();
        assert!(state
            .mutate(|o| {
                o.disable();
                Ok(())
            })
            .is_err());
        let status = state.status();
        assert!(!status.enabled && status.deletion_pending && status.pending_reports == 0);
        assert_eq!(status.error, Some("statistics_optout_not_persisted"));
        std::fs::remove_file(&parent).unwrap();
        state
            .mutate(|o| {
                o.disable();
                Ok(())
            })
            .unwrap();
        assert!(state.status().error.is_none());
        for value in [0, 2, 8, 1800, 3600, u64::MAX] {
            let wait = retry_delay(value).as_secs();
            assert!((2..=3600).contains(&wait));
        }
        assert_eq!(retry_delay(3600).as_secs(), 3600);
    }
}
