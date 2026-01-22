use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::{sidecar, DesktopState};

const UPDATE_ENDPOINT: Option<&str> = option_env!("XHARNESS_UPDATER_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("XHARNESS_UPDATER_PUBKEY");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    available: bool,
    version: Option<String>,
    current_version: String,
    notes: Option<String>,
    published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    phase: &'static str,
    downloaded: Option<u64>,
    total: Option<u64>,
    message: Option<String>,
}

struct BusyGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub const fn configured() -> bool {
    UPDATE_ENDPOINT.is_some() && UPDATE_PUBLIC_KEY.is_some()
}

#[tauri::command]
pub async fn desktop_check_update(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<UpdateMetadata, String> {
    let _guard = acquire(&state)?;
    let endpoint = UPDATE_ENDPOINT.ok_or_else(not_configured)?;
    let public_key = UPDATE_PUBLIC_KEY.ok_or_else(not_configured)?;
    emit(&app, "checking", None, None, None);
    let updater = app
        .updater_builder()
        .endpoints(vec![
            Url::parse(endpoint).map_err(|error| format!("更新地址无效：{error}"))?
        ])
        .map_err(|error| format!("无法配置更新地址：{error}"))?
        .pubkey(public_key)
        .build()
        .map_err(|error| format!("无法初始化更新器：{error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;
    let metadata = match update.as_ref() {
        Some(update) => UpdateMetadata {
            available: true,
            version: Some(update.version.clone()),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
            published_at: update.date.map(|date| date.to_string()),
        },
        None => UpdateMetadata {
            available: false,
            version: None,
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            notes: None,
            published_at: None,
        },
    };
    *state
        .pending_update
        .lock()
        .expect("pending update mutex poisoned") = update;
    emit(
        &app,
        if metadata.available {
            "available"
        } else {
            "up-to-date"
        },
        None,
        None,
        metadata.version.clone(),
    );
    Ok(metadata)
}

#[tauri::command]
pub async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let _guard = acquire(&state)?;
    let update = state
        .pending_update
        .lock()
        .expect("pending update mutex poisoned")
        .clone()
        .ok_or_else(|| "没有待安装的更新，请先检查更新".to_owned())?;

    emit(&app, "downloading", Some(0), None, None);
    let progress_app = app.clone();
    let mut downloaded = 0_u64;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                emit(&progress_app, "downloading", Some(downloaded), total, None);
            },
            {
                let app = app.clone();
                move || emit(&app, "verified", None, None, None)
            },
        )
        .await
        .map_err(|error| format!("下载或验证更新失败：{error}"))?;

    emit(
        &app,
        "stopping-host",
        None,
        None,
        Some("正在保存会话并停止后台任务".to_owned()),
    );
    if let Err(error) = sidecar::graceful_stop(&app).await {
        // The Host's own shutdown path already bounds and force-cleans workers.
        // Surface the fallback in diagnostics, but a downloaded, verified
        // update must not be stranded solely because final process reaping
        // needed the desktop shell's hard stop.
        emit(&app, "host-force-stopped", None, None, Some(error));
    }
    emit(&app, "installing", None, None, None);
    if let Err(error) = update.install(&bytes) {
        emit(
            &app,
            "recovering-host",
            None,
            None,
            Some("安装失败，正在恢复当前版本的 Host".to_owned()),
        );
        let recovery = sidecar::start(&app).await;
        return Err(match recovery {
            Ok(()) => format!("安装更新失败，当前版本已恢复：{error}"),
            Err(recovery) => format!("安装更新失败：{error}；Host 恢复也失败：{recovery}"),
        });
    }
    *state
        .pending_update
        .lock()
        .expect("pending update mutex poisoned") = None;
    emit(&app, "installed", None, None, None);
    app.restart();
}

fn acquire(state: &DesktopState) -> Result<BusyGuard<'_>, String> {
    if state.update_busy.swap(true, Ordering::SeqCst) {
        Err("已有更新操作正在进行".to_owned())
    } else {
        Ok(BusyGuard(&state.update_busy))
    }
}

fn emit(
    app: &AppHandle,
    phase: &'static str,
    downloaded: Option<u64>,
    total: Option<u64>,
    message: Option<String>,
) {
    let _ = app.emit(
        "xharness-update",
        UpdateEvent {
            phase,
            downloaded,
            total,
            message,
        },
    );
}

fn not_configured() -> String {
    "此开发构建未配置签名更新源；正式发布 CI 需要提供 XHARNESS_UPDATER_ENDPOINT 和 XHARNESS_UPDATER_PUBKEY".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_requires_both_immutable_build_inputs() {
        assert_eq!(
            configured(),
            UPDATE_ENDPOINT.is_some() && UPDATE_PUBLIC_KEY.is_some()
        );
    }
}
