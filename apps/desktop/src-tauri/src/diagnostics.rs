//! Desktop-owned evidence survives a Host crash. Failures here never abort an
//! Agent operation. Arbitrary stderr and error strings are intentionally absent.
use serde::Serialize;
#[cfg(windows)]
use std::time::Duration;
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use xharness_diagnostics::{DeepLease, DeepPreferences, Phase, Record, Recorder, PERSISTENT_DEEP};

pub struct Diagnostics {
    inner: Mutex<Inner>,
    pub(crate) root: PathBuf,
    pub(crate) control: PathBuf,
    preferences: PathBuf,
}
struct Inner {
    recorder: Option<Recorder>,
    storage_error: bool,
    incident: bool,
    deep: DeepLease,
    full_memory: bool,
    heap_check: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    available: bool,
    storage_error: bool,
    previous_abnormal_exit: bool,
    deep_remaining_seconds: u64,
    deep_active: bool,
    deep_persistent: bool,
    heap_check: bool,
    host_running: bool,
    version: &'static str,
    platform: &'static str,
    full_memory: bool,
    crash_dump_available: bool,
}
impl Diagnostics {
    pub fn new(root: PathBuf, preferences: PathBuf) -> Self {
        let control = root.join("deep.request");
        let mut recorder = Recorder::open(&root).ok();
        let loaded = DeepPreferences::load(&preferences);
        let selected = loaded.as_ref().copied().unwrap_or_default();
        let mut deep = DeepLease::default();
        let until = if selected.persistent {
            PERSISTENT_DEEP
        } else {
            0
        };
        let reset = std::fs::write(
            control.with_extension("heap"),
            if selected.heap_check { until } else { 0 }.to_string(),
        )
        .and_then(|_| std::fs::write(&control, until.to_string()));
        let activated = loaded.is_ok() && reset.is_ok() && selected.persistent;
        if activated {
            let _ = deep.enable_persistent(true); // persisted explicit consent
        } else if reset.is_err() {
            let _ = std::fs::write(&control, b"0");
            let _ = std::fs::write(control.with_extension("heap"), b"0");
        }
        let begin = recorder.as_mut().map(Recorder::begin_run);
        let incident = matches!(begin, Some(Ok(true)));
        let storage_error = !matches!(begin, Some(Ok(_))) || reset.is_err() || loaded.is_err();
        Self {
            inner: Mutex::new(Inner {
                recorder,
                storage_error,
                incident,
                deep,
                full_memory: activated && selected.full_memory,
                heap_check: activated && selected.heap_check,
            }),
            root,
            control,
            preferences,
        }
    }
    pub fn record(&self, mut record: Record) {
        let version: Vec<u32> = env!("CARGO_PKG_VERSION")
            .split('.')
            .filter_map(|part| part.parse().ok())
            .collect();
        record.version = version.try_into().ok();
        if let Ok(mut state) = self.inner.lock() {
            if let Some(recorder) = &mut state.recorder {
                if recorder.append(&record).is_err() {
                    state.storage_error = true;
                }
            }
        }
    }
    pub fn incident(&self) -> bool {
        self.inner
            .lock()
            .map(|state| state.incident)
            .unwrap_or(true)
    }
    pub fn mark_incident(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.incident = true;
            if state
                .recorder
                .as_ref()
                .is_some_and(|r| r.mark_incident().is_err())
            {
                state.storage_error = true;
            }
        }
    }
    pub fn finish(&self) {
        if let Ok(mut state) = self.inner.lock() {
            if state
                .recorder
                .as_mut()
                .is_some_and(|r| r.finish_run().is_err())
            {
                state.storage_error = true;
            }
        }
    }
    #[cfg(windows)]
    pub fn full_memory(&self) -> bool {
        self.inner
            .lock()
            .map(|state| state.deep.active() && state.full_memory)
            .unwrap_or(false)
    }
    #[cfg(windows)]
    pub fn interval(&self) -> Duration {
        Duration::from_secs(
            if self
                .inner
                .lock()
                .map(|state| state.deep.active())
                .unwrap_or(false)
            {
                2
            } else {
                10
            },
        )
    }
}

#[tauri::command]
pub fn desktop_diagnostics_status(state: State<'_, crate::DesktopState>) -> Result<Status, String> {
    let inner = state
        .diagnostics
        .inner
        .lock()
        .map_err(|_| "诊断状态不可用")?;
    Ok(Status {
        available: inner.recorder.is_some(),
        storage_error: inner.storage_error
            || state.diagnostics.root.join("host/write-failed").exists()
            || state.diagnostics.control.with_extension("failed").exists(),
        previous_abnormal_exit: inner.incident,
        deep_remaining_seconds: inner.deep.remaining_seconds(),
        deep_active: inner.deep.active(),
        deep_persistent: inner.deep.persistent(),
        heap_check: inner.deep.active() && inner.heap_check,
        host_running: state.running.load(std::sync::atomic::Ordering::SeqCst),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        full_memory: inner.deep.active() && inner.full_memory,
        crash_dump_available: state.diagnostics.root.join("crash-latest.dmp").is_file(),
    })
}

#[tauri::command]
pub async fn desktop_open_diagnostics(app: AppHandle) -> Result<(), String> {
    open(&app)
}
pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("diagnostics") {
        window.show().map_err(|_| "无法显示诊断窗口")?;
        return window
            .set_focus()
            .map_err(|_| "无法聚焦诊断窗口".to_owned());
    }
    WebviewWindowBuilder::new(
        app,
        "diagnostics",
        WebviewUrl::App("diagnostics.html".into()),
    )
    .title("XHarness · 运行诊断")
    .inner_size(660.0, 640.0)
    .min_inner_size(500.0, 540.0)
    .build()
    .map(|_| ())
    .map_err(|_| "无法创建诊断窗口".to_owned())
}

#[tauri::command]
pub fn desktop_diagnostics_acknowledge(
    state: State<'_, crate::DesktopState>,
) -> Result<(), String> {
    let mut inner = state
        .diagnostics
        .inner
        .lock()
        .map_err(|_| "诊断状态不可用")?;
    inner
        .recorder
        .as_ref()
        .ok_or("诊断目录不可用")?
        .acknowledge()
        .map_err(|_| "无法保存确认状态")?;
    inner.incident = false;
    Ok(())
}

/// Writes one bounded local metadata report. No arbitrary destination-path IPC,
/// no recursive archive and no browser download falsely reported as saved.
#[tauri::command]
pub async fn desktop_export_diagnostics(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::DesktopState>();
        let inner = state
            .diagnostics
            .inner
            .lock()
            .map_err(|_| "诊断状态不可用")?;
        let snapshot = inner
            .recorder
            .as_ref()
            .ok_or("诊断目录不可用")?
            .snapshot()
            .map_err(|_| "无法读取诊断记录，未导出")?;
        let host_root = state.diagnostics.root.join("host");
        let host = if host_root.exists() {
            Some(
                Recorder::open(host_root)
                    .and_then(|recorder| recorder.snapshot())
                    .map_err(|_| "无法读取后台诊断记录，未导出")?,
            )
        } else {
            None
        };
        let report = serde_json::to_vec(&serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"), "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH, "storageError": inner.storage_error || state.diagnostics.root.join("host/write-failed").exists() || state.diagnostics.control.with_extension("failed").exists(),
            "previousAbnormalExit": inner.incident, "metadata": snapshot, "hostMetadata": host,
            "privacy": "No chat, tool arguments, credentials, raw stderr or memory dumps included"
        }))
        .map_err(|_| "无法生成诊断包".to_owned())?;
        let path = inner
            .recorder
            .as_ref()
            .ok_or("诊断目录不可用")?
            .root()
            .join("export.json");
        use std::io::Write;
        let mut file = std::fs::File::create(&path).map_err(|_| "无法创建诊断包，未保存")?;
        file.write_all(&report)
            .and_then(|_| file.sync_all())
            .map_err(|_| "诊断包保存失败，请勿分享不完整文件")?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "诊断导出任务失败")?
}

#[tauri::command]
pub fn desktop_set_deep_diagnostics(
    state: State<'_, crate::DesktopState>,
    enabled: bool,
    consent: bool,
    full_memory: bool,
    heap_check: bool,
    persistent: Option<bool>,
) -> Result<(), String> {
    let mut inner = state
        .diagnostics
        .inner
        .lock()
        .map_err(|_| "诊断状态不可用")?;
    if enabled && !consent {
        return Err("请先确认深度诊断提示".to_owned());
    }
    let persistent = enabled && persistent.unwrap_or(false);
    let until = if persistent {
        PERSISTENT_DEEP
    } else if enabled {
        xharness_diagnostics::now_ms() + xharness_diagnostics::DEEP_SECONDS * 1000
    } else {
        0
    };
    let selected = if persistent {
        DeepPreferences {
            persistent,
            full_memory,
            heap_check,
        }
    } else {
        DeepPreferences::default()
    };
    // Any partial failure disables the in-memory mode and attempts to revoke
    // both persisted consent and Host controls. Never report partial success.
    let saved = selected
        .save(&state.diagnostics.preferences)
        .and_then(|_| {
            std::fs::write(
                state.diagnostics.control.with_extension("heap"),
                if enabled && heap_check { until } else { 0 }.to_string(),
            )
        })
        .and_then(|_| std::fs::write(&state.diagnostics.control, until.to_string()));
    if saved.is_err() {
        inner.deep.disable();
        inner.full_memory = false;
        inner.heap_check = false;
        inner.storage_error = true;
        let _ = DeepPreferences::default().save(&state.diagnostics.preferences);
        let _ = std::fs::write(&state.diagnostics.control, b"0");
        let _ = std::fs::write(state.diagnostics.control.with_extension("heap"), b"0");
        return Err("诊断设置保存失败，未确认启用或关闭成功，请检查目录权限和磁盘空间".into());
    }
    if persistent {
        inner
            .deep
            .enable_persistent(consent)
            .map_err(|_| "请先确认深度诊断提示")?;
    } else if enabled {
        inner
            .deep
            .enable(consent)
            .map_err(|_| "请先确认深度诊断提示")?;
    } else {
        inner.deep.disable();
    }
    inner.full_memory = enabled && full_memory;
    inner.heap_check = enabled && heap_check;
    drop(inner);
    state.diagnostics.record(Record::new(if enabled {
        Phase::DeepEnabled
    } else {
        Phase::DeepDisabled
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_options_restore_but_invalid_preferences_fail_closed() {
        let root = std::env::temp_dir().join(format!(
            "xh-persistent-{}-{}",
            std::process::id(),
            xharness_diagnostics::now_ms()
        ));
        std::fs::create_dir(&root).unwrap();
        let settings = root.join("diagnostics.json");
        let selected = DeepPreferences {
            persistent: true,
            full_memory: true,
            heap_check: false,
        };
        selected.save(&settings).unwrap();
        {
            let diagnostics = Diagnostics::new(root.join("logs"), settings.clone());
            let inner = diagnostics.inner.lock().unwrap();
            assert!(inner.deep.active() && inner.deep.persistent() && inner.full_memory);
            assert!(!inner.heap_check);
            assert!(!inner.storage_error);
            assert_eq!(
                std::fs::read_to_string(&diagnostics.control).unwrap(),
                PERSISTENT_DEEP.to_string()
            );
            assert_eq!(
                std::fs::read_to_string(diagnostics.control.with_extension("heap")).unwrap(),
                "0"
            );
        }
        DeepPreferences::default().save(&settings).unwrap();
        {
            let diagnostics = Diagnostics::new(root.join("logs"), settings.clone());
            assert!(!diagnostics.inner.lock().unwrap().deep.active());
            assert_eq!(std::fs::read_to_string(&diagnostics.control).unwrap(), "0");
        }
        std::fs::write(&settings, b"{partial").unwrap();
        {
            let diagnostics = Diagnostics::new(root.join("logs"), settings);
            let inner = diagnostics.inner.lock().unwrap();
            assert!(!inner.deep.active() && !inner.full_memory);
            assert!(inner.storage_error);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
