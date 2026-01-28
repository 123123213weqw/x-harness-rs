mod state;

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::{sidecar, DesktopState};
pub(crate) use state::UpdateSession;
use state::{Action, Phase, Snapshot};

const UPDATE_ENDPOINT: Option<&str> = option_env!("XHARNESS_UPDATER_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("XHARNESS_UPDATER_PUBKEY");

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn valid_config(endpoint: Option<&str>, public_key: Option<&str>) -> bool {
    endpoint.is_some_and(|value| {
        Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
    }) && public_key.is_some_and(|value| !value.trim().is_empty())
}

pub fn configured() -> bool {
    valid_config(UPDATE_ENDPOINT, UPDATE_PUBLIC_KEY)
}

#[tauri::command]
pub fn desktop_update_status(state: State<'_, DesktopState>) -> Snapshot {
    snapshot(&state)
}

#[tauri::command]
pub async fn desktop_check_update(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Snapshot, String> {
    let _guard = acquire(&state.update_busy, &state.closing)?;
    {
        let mut session = state
            .update_session
            .lock()
            .expect("update session mutex poisoned");
        if !session.begin_check() {
            return Ok(session.snapshot.clone());
        }
    }
    publish(&app, snapshot(&state));
    let result = cancellable(&state.closing, check(&app)).await;
    match result {
        Ok(update) => {
            let version = update.as_ref().map(|update| update.version.clone());
            let notes = update.as_ref().and_then(|update| update.body.clone());
            state
                .update_session
                .lock()
                .expect("update session mutex poisoned")
                .checked(update, version, notes);
            Ok(publish(&app, snapshot(&state)))
        }
        Err(error) => fail(&app, &state, Action::Check, error),
    }
}

async fn check(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    if !configured() {
        return Err(not_configured());
    }
    let endpoint = Url::parse(UPDATE_ENDPOINT.ok_or_else(not_configured)?)
        .map_err(|error| format!("更新地址无效：{error}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("无法配置更新地址：{error}"))?
        .pubkey(UPDATE_PUBLIC_KEY.ok_or_else(not_configured)?)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法初始化更新器：{error}"))?;
    updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))
}

#[tauri::command]
pub async fn desktop_download_update(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Snapshot, String> {
    let _guard = acquire(&state.update_busy, &state.closing)?;
    let update = {
        let mut session = state
            .update_session
            .lock()
            .expect("update session mutex poisoned");
        if session.has_download() {
            return Ok(session.snapshot.clone());
        }
        session.begin_download()?
    };
    publish(&app, snapshot(&state));
    let progress_app = app.clone();
    let mut last_progress = std::time::Instant::now();
    // Bound total download time separately from the metadata check. A complete
    // signed package can take longer than a single small HTTP request.
    let mut update = update;
    update.timeout = Some(Duration::from_secs(30 * 60));
    let download = update.download(
        move |chunk, total| {
            let state = progress_app.state::<DesktopState>();
            let progress = state
                .update_session
                .lock()
                .expect("update session mutex poisoned")
                .progress(chunk, total);
            if last_progress.elapsed() >= Duration::from_millis(100) {
                publish(&progress_app, progress);
                last_progress = std::time::Instant::now();
            }
        },
        // The plugin calls this callback on transfer completion BEFORE signature
        // verification. Never display 'verified' here; only after await succeeds.
        || {},
    );
    let result = cancellable(&state.closing, async {
        download
            .await
            .map_err(|error| format!("下载或验证更新失败：{error}"))
    })
    .await;
    match result {
        Ok(bytes) => {
            let ready = state
                .update_session
                .lock()
                .expect("update session mutex poisoned")
                .verified(bytes);
            // Deliberately no Host shutdown, installation or restart here.
            Ok(publish(&app, ready))
        }
        Err(error) => fail(&app, &state, Action::Download, error),
    }
}

#[tauri::command]
pub async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, DesktopState>,
    confirm_stop: bool,
) -> Result<(), String> {
    let _guard = acquire(&state.update_busy, &state.closing)?;
    let (update, bytes) = state
        .update_session
        .lock()
        .expect("update session mutex poisoned")
        .install_payload(confirm_stop)?;
    transition(
        &app,
        &state,
        Phase::StoppingHost,
        Some("正在保存会话并停止 Agent、Tool 和 Job".to_owned()),
    );
    if let Err(error) = sidecar::graceful_stop(&app).await {
        transition(&app, &state, Phase::HostForceStopped, Some(error));
    }
    transition(&app, &state, Phase::Installing, None);
    if let Err(error) = update.install(bytes.as_slice()) {
        transition(
            &app,
            &state,
            Phase::RecoveringHost,
            Some("安装失败，正在尝试恢复 Host".to_owned()),
        );
        let recovery = sidecar::start(&app).await;
        let message = match recovery {
            Ok(()) => format!("安装更新失败，Host 已重新启动：{error}"),
            Err(recovery) => format!("安装更新失败：{error}；Host 恢复也失败：{recovery}"),
        };
        return fail(&app, &state, Action::Install, message).map(|_| ());
    }
    transition(&app, &state, Phase::Installed, None);
    app.restart();
}

fn acquire<'a>(busy: &'a AtomicBool, closing: &AtomicBool) -> Result<BusyGuard<'a>, String> {
    if busy.swap(true, Ordering::SeqCst) {
        return Err("已有更新操作或退出操作正在进行".to_owned());
    }
    let guard = BusyGuard(busy);
    if closing.load(Ordering::SeqCst) {
        return Err("应用正在退出，不能开始更新".to_owned());
    }
    Ok(guard)
}

async fn cancellable<T>(
    closing: &AtomicBool,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let mut future = Box::pin(future);
    loop {
        if closing.load(Ordering::SeqCst) {
            return Err("应用正在退出，检查或下载已取消".to_owned());
        }
        // Only the borrow times out: the same HTTP future continues next poll.
        // Returning above drops it, cancelling the request without a detached task.
        if let Ok(result) = tokio::time::timeout(Duration::from_millis(50), future.as_mut()).await {
            return result;
        }
    }
}

fn snapshot(state: &DesktopState) -> Snapshot {
    state
        .update_session
        .lock()
        .expect("update session mutex poisoned")
        .snapshot
        .clone()
}

fn publish(app: &AppHandle, snapshot: Snapshot) -> Snapshot {
    let _ = app.emit("xharness-update", &snapshot);
    snapshot
}

fn transition(app: &AppHandle, state: &DesktopState, phase: Phase, message: Option<String>) {
    let snapshot = state
        .update_session
        .lock()
        .expect("update session mutex poisoned")
        .transition(phase, message);
    publish(app, snapshot);
}

fn fail(
    app: &AppHandle,
    state: &DesktopState,
    action: Action,
    error: String,
) -> Result<Snapshot, String> {
    let snapshot = state
        .update_session
        .lock()
        .expect("update session mutex poisoned")
        .fail(action, error.clone());
    publish(app, snapshot);
    Err(error)
}

fn not_configured() -> String {
    "此开发构建未配置签名更新源；请安装带 HTTPS 更新源和公钥的正式版本".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_requires_both_nonempty_immutable_build_inputs_and_https() {
        assert!(!valid_config(None, Some("key")));
        assert!(!valid_config(Some("https://example.com/latest.json"), None));
        assert!(!valid_config(
            Some("https://example.com/latest.json"),
            Some("  ")
        ));
        assert!(!valid_config(
            Some("http://example.com/latest.json"),
            Some("key")
        ));
        assert!(!valid_config(
            Some("https://token@example.com/latest.json"),
            Some("key")
        ));
        assert!(valid_config(
            Some("https://example.com/latest.json"),
            Some("key")
        ));
        assert_eq!(
            configured(),
            valid_config(UPDATE_ENDPOINT, UPDATE_PUBLIC_KEY)
        );
    }

    #[test]
    fn update_gate_blocks_duplicate_clicks_and_releases_on_error() {
        let busy = AtomicBool::new(false);
        let closing = AtomicBool::new(false);
        let first = acquire(&busy, &closing).unwrap();
        assert!(acquire(&busy, &closing).is_err());
        assert!(busy.load(Ordering::SeqCst));
        drop(first);
        assert!(acquire(&busy, &closing).is_ok());
        closing.store(true, Ordering::SeqCst);
        assert!(acquire(&busy, &closing).is_err());
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn close_cancels_a_pending_transfer_without_waiting_for_network_timeout() {
        tauri::async_runtime::block_on(async {
            let closing = std::sync::Arc::new(AtomicBool::new(false));
            let signal = closing.clone();
            let setter = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                signal.store(true, Ordering::SeqCst);
            });
            let outcome = tokio::time::timeout(
                Duration::from_secs(2),
                cancellable(&closing, std::future::pending::<Result<(), String>>()),
            )
            .await
            .expect("close must not wait for HTTP timeout");
            assert!(outcome.unwrap_err().contains("取消"));
            setter.await.unwrap();
        });
    }

    #[test]
    fn transfer_continues_across_polling_timeouts_and_propagates_errors() {
        tauri::async_runtime::block_on(async {
            let closing = AtomicBool::new(false);
            assert_eq!(
                cancellable(&closing, async {
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    Ok(42)
                })
                .await
                .unwrap(),
                42
            );
            assert_eq!(
                cancellable::<()>(&closing, async { Err("bad signature".into()) })
                    .await
                    .unwrap_err(),
                "bad signature"
            );
        });
    }
}
